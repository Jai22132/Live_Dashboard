// ============================================================
// GET /api/finance-sync
// Finance module: mirrors Toshl Finance (toshl.com) entries into
// the shared Supabase app_state table.
//
//   1. authenticates to the Toshl API with HTTP Basic Auth —
//      TOSHL_API_TOKEN as the username, empty password. The token
//      is a server-side Vercel env var and NEVER reaches the
//      browser (same standard as GOOGLE_CLIENT_SECRET).
//   2. fetches /accounts and /tags once to resolve the IDs that
//      entries reference into human names
//   3. fetches /entries for a date window (default: last 90 days;
//      override with ?from=YYYY-MM-DD&to=YYYY-MM-DD), following
//      Toshl's Link-header pagination
//   4. merges into app_state.'finance_transactions' keyed by
//      Toshl's entry id — idempotent: re-runs never duplicate,
//      edits update in place. Inside the fetched window the API
//      response is authoritative, so entries deleted in Toshl are
//      dropped; stored transactions OUTSIDE the window are kept.
//
// Modes (nothing is EVER written except in write mode):
//   ?mode=diagnose  → show window, counts, account/tag names and
//                     sample raw + mapped entries. Never writes.
//   (default)       → dry run: fetch + diff, report what WOULD be
//                     written, write nothing.
//   ?write=1        → actually upsert into app_state.
//   Vercel Cron     → detected via its user-agent / CRON_SECRET
//                     header and treated as write mode.
// ============================================================
import { readAppState, writeAppState } from './_google-calendar.js';

export const FINANCE_KEY = 'finance_transactions';

// Keep the jsonb row bounded: newest N transactions are stored.
const MAX_STORED_TRANSACTIONS = 2000;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_PAGES = 20; // pagination safety valve (20 × 500 entries)

const TOSHL_BASE = 'https://api.toshl.com';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const mode = q.mode === 'diagnose' ? 'diagnose' : isWriteRequest(req, q) ? 'write' : 'dryrun';

  const token = process.env.TOSHL_API_TOKEN;
  if (!token) {
    return res.status(200).json({
      error: 'not_configured',
      hint: 'Set the TOSHL_API_TOKEN env var in Vercel (Toshl → Settings → Developer → personal access token) and redeploy.',
    });
  }

  try {
    const window = dateWindow(q);
    const [accounts, tags] = await Promise.all([
      toshlGetAll('/accounts', token),
      toshlGetAll('/tags', token),
    ]);
    const entries = await toshlGetAll(
      '/entries?from=' + window.from + '&to=' + window.to,
      token
    );

    const parsed = mapToshl(entries, accounts, tags);

    if (mode === 'diagnose') {
      return res.status(200).json({
        mode,
        window,
        counts: { accounts: accounts.length, tags: tags.length, entries: entries.length },
        accounts: parsed.accounts,
        tags: parsed.allTagNames.slice(0, 100),
        sampleEntriesRaw: entries.slice(0, 3),
        sampleMapped: parsed.transactions.slice(0, 3),
        note: 'Nothing was written to Supabase. Run without mode for a dry run, and with ?write=1 to store.',
      });
    }

    const existing = await readAppState(FINANCE_KEY);
    const { doc, counts } = mergeTransactions(existing, parsed, window);

    if (mode === 'write') await writeAppState(FINANCE_KEY, doc);

    return res.status(200).json({
      mode,
      written: mode === 'write',
      window,
      counts,
      accounts: doc.accounts,
      tags: doc.tags.slice(0, 100),
      sample: doc.transactions.slice(0, 3),
    });
  } catch (e) {
    if (e && e.code === 'toshl_auth_failed') {
      return res.status(200).json({
        error: 'toshl_auth_failed',
        hint: 'Toshl rejected the token (HTTP ' + e.status + '). Check TOSHL_API_TOKEN in Vercel.',
      });
    }
    return res.status(200).json({ error: 'server_error', message: String((e && e.message) || e) });
  }
}

// Vercel Cron invokes the plain path: detect it via its user-agent,
// or via the Authorization header Vercel adds when CRON_SECRET is set.
function isWriteRequest(req, q) {
  if (q.write === '1') return true;
  const h = req.headers || {};
  if (process.env.CRON_SECRET && h.authorization === 'Bearer ' + process.env.CRON_SECRET) return true;
  return String(h['user-agent'] || '').indexOf('vercel-cron') !== -1;
}

// ---------- date window ----------
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export function dateWindow(q) {
  const today = new Date().toISOString().slice(0, 10);
  const past = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  let from = YMD.test(q.from || '') ? q.from : past;
  let to = YMD.test(q.to || '') ? q.to : today;
  if (from > to) { const t = from; from = to; to = t; }
  return { from, to };
}

// ---------- Toshl API ----------
// GET a collection, following Link: <...>; rel="next" pagination.
async function toshlGetAll(path, token) {
  const auth = 'Basic ' + Buffer.from(token + ':').toString('base64');
  let url = TOSHL_BASE + path + (path.indexOf('?') !== -1 ? '&' : '?') + 'per_page=500';
  const out = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) {
      const err = new Error('toshl auth failed');
      err.code = 'toshl_auth_failed';
      err.status = r.status;
      throw err;
    }
    if (!r.ok) throw new Error('toshl_request_failed: ' + r.status + ' on ' + path);
    const data = await r.json();
    if (Array.isArray(data)) out.push(...data);
    url = nextLink(r.headers.get('link'));
  }
  return out;
}

function nextLink(header) {
  if (!header) return null;
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(header);
  return m ? m[1] : null;
}

// ---------- mapping ----------
// Toshl entry: { id, amount (expenses negative), currency:{code},
//               date:'YYYY-MM-DD', desc, account:<id>, category:<id>,
//               tags:[<id>...], modified, ... }
export function mapToshl(entries, accounts, tags) {
  const acctById = {};
  for (const a of accounts || []) {
    acctById[a.id] = {
      name: a.name != null ? String(a.name) : 'Unknown',
      currency: a.currency && a.currency.code ? String(a.currency.code).toUpperCase() : null,
    };
  }
  const tagById = {};
  for (const t of tags || []) tagById[t.id] = t.name != null ? String(t.name) : null;

  const transactions = (entries || []).map((e) => {
    const acct = acctById[e.account] || null;
    return {
      id: String(e.id),
      name: e.desc ? String(e.desc) : '',
      amount: Number(e.amount) || 0,
      income: Number(e.amount) > 0,
      currency: e.currency && e.currency.code ? String(e.currency.code).toUpperCase() : null,
      date: e.date && YMD.test(e.date) ? e.date : null,
      account: acct ? acct.name : 'Unknown',
      tags: (e.tags || []).map((id) => tagById[id]).filter(Boolean),
    };
  });

  return {
    transactions,
    accounts: Object.values(acctById),
    allTagNames: Object.values(tagById).filter(Boolean).sort(),
  };
}

// ---------- merge into the app_state document ----------
// The fetch covers only a window, so unlike a full-database backup we
// merge instead of rebuild: transactions outside the window are kept
// as-is; inside the window the Toshl response is the source of truth
// (upsert by entry id, drop ids that no longer exist there).
export function mergeTransactions(existing, parsed, window) {
  const prev = existing && Array.isArray(existing.transactions) ? existing.transactions : [];
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const fetchedIds = new Set(parsed.transactions.map((t) => t.id));
  const inWindow = (t) => t.date && t.date >= window.from && t.date <= window.to;

  let added = 0, updated = 0, unchanged = 0, removed = 0;
  for (const t of parsed.transactions) {
    const old = prevById.get(t.id);
    if (!old) added++;
    else if (JSON.stringify(old) !== JSON.stringify(t)) updated++;
    else unchanged++;
  }

  const keptOutside = prev.filter((t) => {
    if (fetchedIds.has(t.id)) return false;      // replaced by the fresh copy
    if (inWindow(t)) { removed++; return false; } // deleted in Toshl
    return true;
  });

  const merged = keptOutside.concat(parsed.transactions);
  merged.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const capped = merged.slice(0, MAX_STORED_TRANSACTIONS);

  // Dropdown source: tags actually present in what we store.
  const tagSet = new Set();
  for (const t of capped) for (const tag of t.tags || []) tagSet.add(tag);

  return {
    doc: {
      synced_at: new Date().toISOString(),
      window,
      accounts: parsed.accounts,
      tags: Array.from(tagSet).sort(),
      transactions: capped,
    },
    counts: {
      fetched: parsed.transactions.length,
      added,
      updated,
      unchanged,
      removed,
      keptOutsideWindow: keptOutside.length,
      stored: capped.length,
    },
  };
}
