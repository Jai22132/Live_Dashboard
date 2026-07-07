// =============================================================
// Nova batch processor — runs LOCALLY on the PC with Ollama.
// Never deployed to Vercel. Scheduled via Windows Task Scheduler
// (see README.md in this folder).
//
// Each run, in order:
//   1. wardrobe  — describe new/changed wardrobe photos with the
//                  vision model, cache descriptions in app_state
//   2. context   — summarize finance / training / goals into the
//                  'nova_context' row (plain string building — the
//                  data is already structured, no LLM needed)
//   3. questions — answer 'pending' questions in 'nova_questions'
//                  with the text model, one at a time
//
// Data contract (public.app_state, key → data):
//   reads  : wardrobe, finance_transactions, workout_log, goals
//   writes : wardrobe (adds description/described_photos per item),
//            nova_context, nova_questions — NOTHING else.
//
// Usage:  node index.mjs [--dry-run]
//   --dry-run: read + call Ollama, but write nothing to Supabase.
// =============================================================
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildContextSummary,
  buildQuestionPrompt,
  buildWardrobeDescriptions,
  needsDescription,
  normalizeQuestionsDoc,
  pendingQuestions,
  photoKey,
  summarizeFinance,
  summarizeGoals,
  summarizeWorkouts,
  truncate,
  visionPrompt,
} from './lib.mjs';

// ---------- config (env-overridable, defaults match the dashboard) ----------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = {
  supabaseUrl: process.env.SUPABASE_URL || 'https://awytpwgorebhjewlqlhs.supabase.co',
  // Prefer the service-role (secret) key: it bypasses RLS, which is required
  // once app_state's policies demand the `authenticated` role — this script
  // runs headless with no user session. This machine-local env var never
  // ships anywhere; the anon-key fallback only works before RLS tightening.
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY || 'sb_publishable_iyTy90Bi9Ct9ZMY0nu9hjA_N5BFmlFN',
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  visionModel: process.env.NOVA_VISION_MODEL || 'qwen2.5vl:7b',
  textModel: process.env.NOVA_TEXT_MODEL || 'qwen2.5:14b',
  // Bound each run so a big photo backlog can't outlive the schedule
  // interval; leftovers are picked up on the next run.
  maxPhotoItemsPerRun: Number(process.env.NOVA_MAX_PHOTO_ITEMS) || 10,
  supabaseTimeoutMs: 30_000,
  ollamaTimeoutMs: 300_000, // vision on a cold model can take minutes
  logDir: process.env.NOVA_LOG_DIR || join(SCRIPT_DIR, 'logs'),
  logRetentionDays: 30,
  lockFile: join(SCRIPT_DIR, '.nova-batch.lock'),
  lockStaleMinutes: 60,
};
const DRY_RUN = process.argv.includes('--dry-run');

const BUCKET_URL = CONFIG.supabaseUrl + '/storage/v1/object/public/wardrobe-photos/';

// ---------- logging (console + daily file; Task Scheduler is headless) ----------
let logFile = null;
let errorCount = 0;

function initLog() {
  mkdirSync(CONFIG.logDir, { recursive: true });
  logFile = join(CONFIG.logDir, 'nova-batch-' + new Date().toISOString().slice(0, 10) + '.log');
  // prune old logs
  try {
    const cutoff = Date.now() - CONFIG.logRetentionDays * 86400000;
    for (const f of readdirSync(CONFIG.logDir)) {
      if (!/^(nova-batch|wrapper)-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const full = join(CONFIG.logDir, f);
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    }
  } catch (e) { /* pruning is best-effort */ }
}

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { if (logFile) appendFileSync(logFile, line + '\n'); } catch (e) {}
}

function logError(msg, err) {
  errorCount++;
  const detail = err ? ' :: ' + (err.stack || err.message || String(err)) : '';
  const line = new Date().toISOString() + ' ERROR ' + msg + detail;
  console.error(line);
  try { if (logFile) appendFileSync(logFile, line + '\n'); } catch (e) {}
}

// ---------- overlap guard ----------
// Task Scheduler is set to not start overlapping instances, but a lock
// file guards manual runs and scheduler misconfiguration too.
function acquireLock() {
  try {
    if (existsSync(CONFIG.lockFile)) {
      const ageMin = (Date.now() - statSync(CONFIG.lockFile).mtimeMs) / 60000;
      if (ageMin < CONFIG.lockStaleMinutes) {
        log('Another run appears to be in progress (lock is ' + ageMin.toFixed(1) + ' min old) — exiting.');
        return false;
      }
      log('Ignoring stale lock file (' + ageMin.toFixed(0) + ' min old).');
    }
    writeFileSync(CONFIG.lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    return true;
  } catch (e) {
    logError('Could not manage lock file', e);
    return true; // don't let the guard itself block work
  }
}
function releaseLock() {
  try { unlinkSync(CONFIG.lockFile); } catch (e) {}
}

// ---------- Supabase app_state helpers (same REST pattern as api/_google-calendar.js) ----------
async function readRow(rowKey) {
  const res = await fetch(
    CONFIG.supabaseUrl + '/rest/v1/app_state?select=data&key=eq.' + encodeURIComponent(rowKey),
    {
      headers: { apikey: CONFIG.supabaseKey, Authorization: 'Bearer ' + CONFIG.supabaseKey },
      signal: AbortSignal.timeout(CONFIG.supabaseTimeoutMs),
    }
  );
  if (!res.ok) throw new Error('Supabase read of "' + rowKey + '" failed: HTTP ' + res.status);
  const rows = await res.json();
  return rows && rows[0] ? rows[0].data : null;
}

async function writeRow(rowKey, data) {
  if (DRY_RUN) { log('[dry-run] would write app_state row "' + rowKey + '"'); return; }
  const res = await fetch(CONFIG.supabaseUrl + '/rest/v1/app_state?on_conflict=key', {
    method: 'POST',
    headers: {
      apikey: CONFIG.supabaseKey,
      Authorization: 'Bearer ' + CONFIG.supabaseKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: rowKey, data, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(CONFIG.supabaseTimeoutMs),
  });
  if (!res.ok) throw new Error('Supabase write of "' + rowKey + '" failed: HTTP ' + res.status);
}

// ---------- Ollama ----------
async function ollamaGenerate({ model, prompt, images, temperature, maxTokens }) {
  const body = {
    model,
    prompt,
    stream: false,
    options: { temperature: temperature ?? 0.4, num_predict: maxTokens ?? 500 },
  };
  if (images && images.length) body.images = images;
  const res = await fetch(CONFIG.ollamaUrl + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CONFIG.ollamaTimeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 404 && /not found/i.test(text)) {
      throw new Error('Ollama model "' + model + '" is not installed — run: ollama pull ' + model);
    }
    throw new Error('Ollama request failed (' + model + '): HTTP ' + res.status + ' ' + truncate(text, 300));
  }
  const data = await res.json();
  const answer = (data && data.response ? String(data.response) : '').trim();
  if (!answer) throw new Error('Ollama returned an empty response for model ' + model);
  return answer;
}

async function fetchImageBase64(path) {
  const url = BUCKET_URL + path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(url, { signal: AbortSignal.timeout(CONFIG.supabaseTimeoutMs) });
  if (!res.ok) throw new Error('Photo download failed (HTTP ' + res.status + '): ' + path);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('Photo unexpectedly large (' + buf.length + ' bytes): ' + path);
  return buf.toString('base64');
}

// ---------- phase 1: wardrobe photo analysis ----------
async function runWardrobePhase() {
  const data = await readRow('wardrobe');
  const items = data && data.wardrobe_items && Array.isArray(data.wardrobe_items.items)
    ? data.wardrobe_items.items
    : [];
  if (!items.length) {
    log('[wardrobe] No wardrobe items in app_state — nothing to describe.');
    return 0;
  }

  const candidates = items.filter(needsDescription);
  log('[wardrobe] ' + items.length + ' items, ' + candidates.length + ' need a description.');
  const batch = candidates.slice(0, CONFIG.maxPhotoItemsPerRun);
  if (candidates.length > batch.length) {
    log('[wardrobe] Processing ' + batch.length + ' this run; the rest queue for the next run.');
  }

  let described = 0;
  for (const item of batch) {
    const analyzedKey = photoKey(item);
    try {
      const paths = item.photo_paths.filter(Boolean);
      const images = [];
      for (const p of paths) images.push(await fetchImageBase64(p));
      const description = truncate(
        await ollamaGenerate({
          model: CONFIG.visionModel,
          prompt: visionPrompt(item, images.length),
          images,
          temperature: 0.3,
          maxTokens: 250,
        }),
        600
      );

      // Re-read right before writing so a dashboard edit made while the
      // vision model was running isn't clobbered; only the matched item
      // gains fields, everything else is written back untouched.
      if (DRY_RUN) {
        log('[dry-run] would cache description for item ' + item.id + ': ' + truncate(description, 120));
        described++;
        continue;
      }
      const fresh = await readRow('wardrobe');
      const freshItems = fresh && fresh.wardrobe_items && Array.isArray(fresh.wardrobe_items.items)
        ? fresh.wardrobe_items.items
        : null;
      const target = freshItems && freshItems.find((it) => it && it.id === item.id);
      if (!target || photoKey(target) !== analyzedKey) {
        log('[wardrobe] Item ' + item.id + ' was removed or its photos changed mid-run — discarding this description.');
        continue;
      }
      target.description = description;
      target.described_photos = analyzedKey;
      await writeRow('wardrobe', fresh);
      described++;
      log('[wardrobe] Described item ' + item.id + ' (' + (item.category || 'uncategorised') + ', ' +
          paths.length + ' photo' + (paths.length === 1 ? '' : 's') + '): ' + truncate(description, 100));
    } catch (e) {
      logError('[wardrobe] Failed to describe item ' + item.id, e);
    }
  }
  return described;
}

// ---------- phase 2: context summary ----------
async function runContextPhase() {
  const [finance, workouts, goals, wardrobe] = await Promise.all([
    readRow('finance_transactions'),
    readRow('workout_log'),
    readRow('goals'),
    readRow('wardrobe'),
  ]);

  const summaryText = buildContextSummary({
    finance: summarizeFinance(finance),
    workouts: summarizeWorkouts(workouts),
    goals: summarizeGoals(goals),
  });
  const wardrobeDescriptions = buildWardrobeDescriptions(
    wardrobe && wardrobe.wardrobe_items ? wardrobe.wardrobe_items.items : []
  );

  const doc = {
    summary_text: summaryText,
    wardrobe_descriptions: wardrobeDescriptions,
    last_updated: new Date().toISOString(),
  };
  await writeRow('nova_context', doc);
  log('[context] Summary refreshed (' + summaryText.length + ' chars, ' +
      Object.keys(wardrobeDescriptions).length + ' wardrobe descriptions).');
  return doc;
}

// ---------- phase 3: queued questions ----------
async function runQuestionsPhase(context) {
  const raw = await readRow('nova_questions');
  const doc = normalizeQuestionsDoc(raw);
  if (raw === null) {
    // First run: create the row so the dashboard has a shape to write into.
    await writeRow('nova_questions', { queue: [] });
    log('[questions] Initialised empty nova_questions row.');
    return 0;
  }

  const pending = pendingQuestions(doc);
  if (!pending.length) {
    log('[questions] No pending questions.');
    return 0;
  }
  log('[questions] ' + pending.length + ' pending question' + (pending.length === 1 ? '' : 's') + '.');

  let answered = 0;
  // Strictly sequential — one Ollama call at a time.
  for (const q of pending) {
    try {
      const answer = await ollamaGenerate({
        model: CONFIG.textModel,
        prompt: buildQuestionPrompt(String(q.question), context.summary_text, context.wardrobe_descriptions),
        temperature: 0.5,
        maxTokens: 600,
      });

      if (DRY_RUN) {
        log('[dry-run] would answer question ' + q.id + ': ' + truncate(answer, 120));
        answered++;
        continue;
      }
      // Idempotency: answer + status flip in ONE write, applied to a fresh
      // copy of the row. A crash before this write leaves the question
      // 'pending' (re-answered next run); after it, 'answered' (skipped).
      const fresh = normalizeQuestionsDoc(await readRow('nova_questions'));
      const target = fresh.queue.find((x) => x.id === q.id);
      if (!target || target.status !== 'pending') {
        log('[questions] Question ' + q.id + ' vanished or was answered elsewhere — skipping.');
        continue;
      }
      target.answer = answer;
      target.status = 'answered';
      target.answered_at = new Date().toISOString();
      await writeRow('nova_questions', fresh);
      answered++;
      log('[questions] Answered ' + q.id + ' ("' + truncate(String(q.question), 80) + '") → ' + truncate(answer, 100));
    } catch (e) {
      logError('[questions] Failed to answer question ' + q.id + ' — left as pending for the next run', e);
    }
  }
  return answered;
}

// ---------- main ----------
async function main() {
  initLog();
  log('=== Nova batch run starting' + (DRY_RUN ? ' (DRY RUN — no writes)' : '') + ' ===');
  log('Config: ollama=' + CONFIG.ollamaUrl + ' vision=' + CONFIG.visionModel +
      ' text=' + CONFIG.textModel + ' supabase=' + CONFIG.supabaseUrl);

  if (!acquireLock()) return 0;
  let described = 0;
  let answered = 0;
  try {
    try {
      described = await runWardrobePhase();
    } catch (e) {
      logError('[wardrobe] Phase failed', e);
    }

    let context = { summary_text: '', wardrobe_descriptions: {} };
    try {
      context = await runContextPhase();
    } catch (e) {
      logError('[context] Phase failed — questions will be answered with reduced context', e);
    }

    try {
      answered = await runQuestionsPhase(context);
    } catch (e) {
      logError('[questions] Phase failed', e);
    }
  } finally {
    releaseLock();
  }

  log('=== Run finished: ' + described + ' photo item(s) described, ' + answered +
      ' question(s) answered, ' + errorCount + ' error(s). ===');
  return errorCount > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    logError('Fatal error', e);
    releaseLock();
    process.exit(1);
  }
);
