// =============================================================
// Nova batch processor — pure logic (no I/O).
// Everything here is a plain function of its inputs so it can be
// unit-tested with `node --test` without touching Supabase/Ollama.
// index.mjs owns all network calls and orchestration.
// =============================================================

// ---------- small utilities ----------

export function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// Local-time YYYY-MM-DD (the dashboard's goals: keys use local dates,
// so UTC-based toISOString() would be off around midnight).
export function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

export function daysBefore(n, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return d;
}

function daysBetween(ymdOlder, ymdNewer) {
  const a = new Date(ymdOlder + 'T00:00:00');
  const b = new Date(ymdNewer + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// ---------- wardrobe: description cache ----------

// The cache key for an item's description is its photo set. If
// photo_paths change (photo added/replaced), the description is stale.
export function photoKey(item) {
  return (item && Array.isArray(item.photo_paths) ? item.photo_paths : [])
    .filter(Boolean)
    .join('|');
}

export function needsDescription(item) {
  if (!item || typeof item !== 'object') return false;
  const key = photoKey(item);
  if (!key) return false; // nothing to look at
  if (!item.description) return true;
  return item.described_photos !== key;
}

export function visionPrompt(item, photoCount) {
  const what =
    photoCount === 2
      ? 'The two photos show the SAME clothing item from different angles.'
      : 'The photo shows one clothing item.';
  const hint = item && item.category ? ' The owner filed it under "' + item.category + '".' : '';
  return (
    'You are cataloguing a wardrobe for outfit planning. ' + what + hint +
    ' Describe the garment in 2-3 plain sentences covering: garment type, ' +
    'main colour(s), material or pattern if visible, style/formality ' +
    '(casual, smart-casual, formal, sporty), and any distinctive details. ' +
    'Write only the description — no preamble, no bullet points.'
  );
}

// ---------- context summaries (plain string building, no LLM) ----------
// Deliberate choice: these are aggregations of already-structured data.
// A model adds latency and non-determinism here for zero gain; string
// building is instant, always fits the prompt budget, and never
// hallucinates a number.

export function summarizeFinance(doc, now = new Date()) {
  const tx = doc && Array.isArray(doc.transactions) ? doc.transactions : [];
  if (!tx.length) return 'Finance: no transaction data synced yet.';

  const cutoff = localDateStr(daysBefore(30, now));
  const recent = tx.filter((t) => t && t.date && t.date >= cutoff);
  if (!recent.length) return 'Finance: ' + tx.length + ' transactions on record, none in the last 30 days.';

  // Group by currency so we never add EUR to GBP.
  const byCur = new Map();
  for (const t of recent) {
    const cur = t.currency || '?';
    if (!byCur.has(cur)) byCur.set(cur, { spent: 0, income: 0, byCat: new Map(), count: 0 });
    const g = byCur.get(cur);
    g.count++;
    const amt = Number(t.amount) || 0;
    if (amt < 0) {
      g.spent += -amt;
      const cat = (Array.isArray(t.tags) && t.tags[0]) || 'untagged';
      g.byCat.set(cat, (g.byCat.get(cat) || 0) + -amt);
    } else {
      g.income += amt;
    }
  }

  const lines = ['Finance (last 30 days):'];
  for (const [cur, g] of byCur) {
    lines.push(
      '- ' + g.count + ' transactions in ' + cur + ': spent ' + g.spent.toFixed(2) +
      ', income ' + g.income.toFixed(2) + '.'
    );
    const top = Array.from(g.byCat.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) {
      lines.push('  Top spending: ' + top.map(([c, v]) => c + ' ' + v.toFixed(0)).join(', ') + '.');
    }
  }
  return lines.join('\n');
}

export function summarizeWorkouts(doc, now = new Date()) {
  const entries = doc && Array.isArray(doc.entries) ? doc.entries : [];
  if (!entries.length) return 'Training: no workouts logged yet.';

  const cutoff = localDateStr(daysBefore(28, now));
  const recent = entries.filter((e) => e && e.date && e.date >= cutoff);
  const dates = Array.from(new Set(recent.map((e) => e.date))).sort();
  const lastDate = entries.map((e) => e.date).filter(Boolean).sort().pop();

  const lines = ['Training (last 4 weeks):'];
  if (!recent.length) {
    lines.push('- No sessions in the last 4 weeks (' + entries.length + ' logged all-time).');
  } else {
    lines.push(
      '- ' + recent.length + ' sessions on ' + dates.length + ' days (~' +
      (recent.length / 4).toFixed(1) + '/week).'
    );
    const byRoutine = new Map();
    for (const e of recent) {
      const name = e.routineName || 'ad hoc';
      byRoutine.set(name, (byRoutine.get(name) || 0) + 1);
    }
    const top = Array.from(byRoutine.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
    lines.push('- Routines: ' + top.map(([n, c]) => n + ' ×' + c).join(', ') + '.');
  }
  if (lastDate) {
    const ago = daysBetween(lastDate, localDateStr(now));
    lines.push('- Last workout: ' + lastDate + (ago === 0 ? ' (today).' : ' (' + ago + ' day' + (ago === 1 ? '' : 's') + ' ago).'));
  }
  return lines.join('\n');
}

export function summarizeGoals(data, now = new Date()) {
  const dayKeys = Object.keys(data || {})
    .filter((k) => /^goals:\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  if (!dayKeys.length) return 'Goals: no to-do data yet.';

  const today = localDateStr(now);
  const cutoff = localDateStr(daysBefore(14, now));
  let total = 0;
  let done = 0;
  const tagCounts = new Map();
  const openToday = [];

  for (const k of dayKeys) {
    const day = k.slice('goals:'.length);
    if (day < cutoff || day > today) continue;
    const list = Array.isArray(data[k]) ? data[k] : [];
    for (const g of list) {
      if (!g || typeof g !== 'object') continue;
      total++;
      if (g.done) done++;
      for (const t of Array.isArray(g.tags) ? g.tags : []) {
        if (t) tagCounts.set(String(t), (tagCounts.get(String(t)) || 0) + 1);
      }
      if (day === today && !g.done && g.text) {
        openToday.push({ text: String(g.text), tags: Array.isArray(g.tags) ? g.tags : [] });
      }
    }
  }

  if (!total) return 'Goals: no to-do items in the last 2 weeks.';

  const lines = ['Goals / to-dos (last 2 weeks): ' + done + ' of ' + total + ' completed.'];
  if (openToday.length) {
    lines.push('Open today:');
    for (const g of openToday.slice(0, 20)) {
      const tags = g.tags.length ? ' [' + g.tags.join(', ') + ']' : '';
      lines.push('- ' + truncate(g.text, 120) + tags);
    }
    if (openToday.length > 20) lines.push('- …and ' + (openToday.length - 20) + ' more.');
  } else {
    lines.push('Nothing open today.');
  }
  const topTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topTags.length) {
    lines.push('Active tags: ' + topTags.map(([t, c]) => t + ' ×' + c).join(', ') + '.');
  }
  return lines.join('\n');
}

const SUMMARY_MAX_CHARS = 6000;

export function buildContextSummary({ finance, workouts, goals }, now = new Date()) {
  const text = [
    'Snapshot of the user\'s dashboard as of ' + localDateStr(now) + ':',
    '',
    finance,
    '',
    workouts,
    '',
    goals,
  ].join('\n');
  return truncate(text, SUMMARY_MAX_CHARS);
}

// Map of item id → { category, description } for every described item.
export function buildWardrobeDescriptions(items) {
  const out = {};
  for (const it of Array.isArray(items) ? items : []) {
    if (it && it.id && it.description) {
      out[it.id] = {
        category: it.category || '',
        description: truncate(it.description, 400),
      };
    }
  }
  return out;
}

// ---------- question answering ----------

const WARDROBE_PROMPT_MAX_CHARS = 2500;

export function buildQuestionPrompt(question, summaryText, wardrobeDescriptions) {
  const parts = [
    'You are Nova, a personal mentor living inside the user\'s life-tracking dashboard. ' +
    'You are direct, warm and practical. Answer in a few short paragraphs at most, ' +
    'and give the user something concrete to act on.',
    '',
    summaryText || 'No dashboard context is available yet.',
  ];

  const entries = Object.values(wardrobeDescriptions || {});
  if (entries.length) {
    let block = 'Wardrobe (' + entries.length + ' catalogued items):\n';
    for (const e of entries) {
      const line = '- [' + (e.category || 'item') + '] ' + e.description + '\n';
      if (block.length + line.length > WARDROBE_PROMPT_MAX_CHARS) {
        block += '- …more items omitted.\n';
        break;
      }
      block += line;
    }
    parts.push('', block.trimEnd());
  }

  parts.push(
    '',
    'Using the context above where relevant, answer the user\'s question. ' +
    'If the context does not cover the question, say so briefly and answer from general knowledge.',
    '',
    'Question: ' + question
  );
  return parts.join('\n');
}

// Coerce whatever is stored in the nova_questions row into a safe shape,
// preserving any extra fields the dashboard may add later.
export function normalizeQuestionsDoc(raw) {
  const doc = raw && typeof raw === 'object' ? { ...raw } : {};
  doc.queue = Array.isArray(doc.queue)
    ? doc.queue.filter((q) => q && typeof q === 'object' && q.id != null)
    : [];
  return doc;
}

export function pendingQuestions(doc) {
  return doc.queue
    .filter((q) => q.status === 'pending' && q.question)
    .sort((a, b) => String(a.asked_at || '').localeCompare(String(b.asked_at || '')));
}
