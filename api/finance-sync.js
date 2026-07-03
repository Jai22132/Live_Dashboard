// ============================================================
// GET /api/finance-sync
// Finance module: mirrors the Cashew budget app into Supabase.
//
// Cashew periodically uploads its whole SQLite database to the
// hidden `appDataFolder` of the connected Google Drive account.
// This function (reusing the Calendar module's stored OAuth
// tokens + refresh flow from _google-calendar.js):
//   1. lists the appDataFolder, picks the newest file
//   2. downloads it and opens it with sql.js (pure-WASM SQLite,
//      no native binary — safe on Vercel serverless)
//   3. maps transactions / wallets (accounts) / categories
//   4. rebuilds app_state.'finance_transactions' keyed by
//      Cashew's own transaction_pk — inherently idempotent:
//      re-running never duplicates a transaction, edits update
//      it, and deletions in Cashew disappear here too.
//
// Modes (nothing is EVER written except in write mode):
//   ?mode=diagnose  → dump Drive file list + every table with its
//                     columns/row counts + sample transaction rows.
//                     Run this first to confirm the schema.
//   (default)       → dry run: parse + diff, report what WOULD be
//                     written, write nothing.
//   ?write=1        → parse, validate, upsert into app_state.
//   Vercel Cron     → detected via its user-agent / CRON_SECRET
//                     header and treated as write mode.
//
// If the backup's schema doesn't match the expected Cashew table/
// column names, the sync ABORTS with a full diagnostic instead of
// writing garbage.
//
// SECURITY: like the Calendar module, GOOGLE_CLIENT_SECRET and all
// Google tokens live only in server-side env vars / the token row.
// Responses contain finance data only — never tokens.
// ============================================================
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import {
  readAppState,
  writeAppState,
  refreshAccessToken,
  GOOGLE_TOKENS_KEY,
} from './_google-calendar.js';

export const FINANCE_KEY = 'finance_transactions';

// Keep the jsonb row bounded: newest N transactions are stored.
const MAX_STORED_TRANSACTIONS = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// ---------- sql.js (WASM) ----------
// require.resolve keeps the .wasm traceable by Vercel's bundler;
// vercel.json additionally forces it in via includeFiles.
const require = createRequire(import.meta.url);
let sqlJsPromise = null;
function getSqlJs() {
  if (!sqlJsPromise) {
    const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    sqlJsPromise = initSqlJs({ wasmBinary });
  }
  return sqlJsPromise;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const mode = q.mode === 'diagnose' ? 'diagnose' : isWriteRequest(req, q) ? 'write' : 'dryrun';

  let db = null;
  try {
    const auth = await getDriveAccessToken();
    if (!auth.accessToken) return res.status(200).json(auth);

    const files = await listAppDataFiles(auth.accessToken);
    if (files.error) return res.status(200).json(files);
    if (!files.length) {
      return res.status(200).json({
        connected: true,
        error: 'no_backups_found',
        hint: 'The Drive appDataFolder is empty. In Cashew, run Settings → Backups → Google Drive backup first, and make sure Cashew is signed into the same Google account you connected here.',
      });
    }

    // Most recent by modifiedTime (the list is already sorted desc);
    // ?fileId= lets you sync a specific file after checking diagnose.
    const file = (q.fileId && files.find((f) => f.id === q.fileId)) || files[0];
    if (Number(file.size || 0) > MAX_FILE_BYTES) {
      return res.status(200).json({ connected: true, error: 'backup_too_large', file: publicFileInfo(file) });
    }

    const bytes = await downloadFile(auth.accessToken, file.id);
    if (!isSqlite(bytes)) {
      return res.status(200).json({
        connected: true,
        error: 'not_a_sqlite_file',
        file: publicFileInfo(file),
        hint: 'The newest appDataFolder file is not a SQLite database. Run ?mode=diagnose to see all files, then retry with ?fileId=<id> of the actual backup.',
        allFiles: files.slice(0, 20).map(publicFileInfo),
      });
    }

    const SQL = await getSqlJs();
    db = new SQL.Database(new Uint8Array(bytes));

    if (mode === 'diagnose') {
      return res.status(200).json({
        connected: true,
        mode,
        pickedFile: publicFileInfo(file),
        allFiles: files.slice(0, 20).map(publicFileInfo),
        schema: introspect(db),
        sampleTransactions: sampleTransactionRows(db),
        note: 'Nothing was written to Supabase. Confirm the table/column names above match what the sync maps (transactions / wallets / categories), then run without mode for a dry run, and with ?write=1 to store.',
      });
    }

    // Throws { code: 'schema_mismatch', ... } if the backup doesn't
    // look like a Cashew database — nothing gets written in that case.
    const parsed = mapCashew(db);
    const existing = await readAppState(FINANCE_KEY);
    const { doc, counts } = mergeTransactions(existing, parsed, file);

    if (mode === 'write') await writeAppState(FINANCE_KEY, doc);

    return res.status(200).json({
      connected: true,
      mode,
      written: mode === 'write',
      file: publicFileInfo(file),
      counts,
      accounts: doc.accounts,
      categories: doc.categories.slice(0, 50),
      sample: doc.transactions.slice(0, 3),
    });
  } catch (e) {
    if (e && e.code === 'schema_mismatch') {
      return res.status(200).json({
        connected: true,
        error: 'schema_mismatch',
        missing: e.missing,
        schema: e.schema,
        note: 'The backup did not match the expected Cashew schema, so NOTHING was written. Share this output so the column mapping can be fixed.',
      });
    }
    return res.status(200).json({ error: 'server_error', message: String((e && e.message) || e) });
  } finally {
    if (db) try { db.close(); } catch (e) {}
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

// ---------- Google auth (same flow as google-calendar-events.js) ----------
async function getDriveAccessToken() {
  const tokens = await readAppState(GOOGLE_TOKENS_KEY);
  if (!tokens || !tokens.refresh_token) return { connected: false };

  let accessToken = tokens.access_token;
  const stillValid = accessToken && tokens.expires_at && Date.now() < tokens.expires_at - 60000;
  if (!stillValid) {
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      accessToken = refreshed.access_token;
      await writeAppState(GOOGLE_TOKENS_KEY, {
        refresh_token: tokens.refresh_token,
        access_token: accessToken,
        expires_at: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : 0,
      });
    } catch (e) {
      if (e.status === 400 || e.status === 401) return { connected: false, revoked: true };
      throw e;
    }
  }
  return { accessToken };
}

// ---------- Google Drive ----------
async function listAppDataFiles(accessToken) {
  const url =
    'https://www.googleapis.com/drive/v3/files' +
    '?spaces=appDataFolder&pageSize=100&orderBy=modifiedTime%20desc' +
    '&fields=' + encodeURIComponent('files(id,name,size,modifiedTime,mimeType)');
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (r.status === 401) return { error: 'unauthorized', connected: false, revoked: true };
  if (r.status === 403) {
    // Token predates the drive.appdata scope → user must reconnect once.
    return {
      connected: true,
      error: 'drive_scope_missing',
      reconnect: '/api/google-auth-start',
      hint: 'The stored Google connection was granted before Drive access was added. Open /api/google-auth-start and approve again.',
    };
  }
  if (!r.ok) return { error: 'drive_list_failed', status: r.status };
  const data = await r.json();
  return data.files || [];
}

async function downloadFile(accessToken, fileId) {
  const r = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media',
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  if (!r.ok) throw new Error('drive_download_failed: ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function publicFileInfo(f) {
  return { id: f.id, name: f.name, size: f.size, modifiedTime: f.modifiedTime };
}

function isSqlite(buf) {
  return buf.length > 16 && buf.toString('latin1', 0, 15) === 'SQLite format 3';
}

// ---------- SQLite helpers ----------
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function rowsToObjects(db, sql) {
  const out = [];
  const stmt = db.prepare(sql);
  try {
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

export function introspect(db) {
  const tables = rowsToObjects(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return tables.map((t) => {
    const cols = rowsToObjects(db, 'PRAGMA table_info(' + quoteIdent(t.name) + ')');
    let rows = null;
    try {
      rows = rowsToObjects(db, 'SELECT COUNT(*) AS n FROM ' + quoteIdent(t.name))[0].n;
    } catch (e) {}
    return { table: t.name, rows, columns: cols.map((c) => c.name + ' (' + (c.type || '?') + ')') };
  });
}

function findTable(db, wanted) {
  const tables = rowsToObjects(db, "SELECT name FROM sqlite_master WHERE type='table'");
  const hit = tables.find((t) => String(t.name).toLowerCase() === wanted);
  return hit ? hit.name : null;
}

function tableColumns(db, table) {
  return rowsToObjects(db, 'PRAGMA table_info(' + quoteIdent(table) + ')').map((c) =>
    String(c.name)
  );
}

function sampleTransactionRows(db) {
  const table =
    findTable(db, 'transactions') ||
    (introspect(db).find((t) => t.table.toLowerCase().indexOf('transaction') !== -1) || {}).table;
  if (!table) return { note: 'no table with "transaction" in its name found' };
  try {
    return { table, rows: rowsToObjects(db, 'SELECT * FROM ' + quoteIdent(table) + ' LIMIT 3') };
  } catch (e) {
    return { table, error: String(e.message || e) };
  }
}

// ---------- Cashew schema mapping ----------
// Expected Drift/SQLite schema (Cashew ≥ 5.x). Verified at runtime:
//   transactions: transaction_pk, name, amount, note, category_fk,
//                 sub_category_fk, wallet_fk, date_created, income, paid
//   wallets:      wallet_pk, name, currency
//   categories:   category_pk, name
// Any missing required piece aborts with a schema_mismatch diagnostic.
export function mapCashew(db) {
  const missing = [];
  const tTx = findTable(db, 'transactions');
  const tWal = findTable(db, 'wallets');
  const tCat = findTable(db, 'categories');
  if (!tTx) missing.push('table: transactions');
  if (!tWal) missing.push('table: wallets');
  if (!tCat) missing.push('table: categories');

  const need = (table, cols, required) => {
    const have = table ? tableColumns(db, table) : [];
    for (const c of required) if (have.indexOf(c) === -1) missing.push('column: ' + cols + '.' + c);
    return have;
  };
  const txCols = need(tTx, 'transactions', ['transaction_pk', 'amount', 'date_created']);
  need(tWal, 'wallets', ['wallet_pk', 'name']);
  need(tCat, 'categories', ['category_pk', 'name']);

  if (missing.length) {
    const err = new Error('Cashew schema mismatch');
    err.code = 'schema_mismatch';
    err.missing = missing;
    err.schema = introspect(db);
    throw err;
  }

  const walCols = tableColumns(db, tWal);
  const wallets = {};
  for (const w of rowsToObjects(db, 'SELECT * FROM ' + quoteIdent(tWal))) {
    wallets[w.wallet_pk] = {
      name: w.name != null ? String(w.name) : 'Unknown',
      currency:
        walCols.indexOf('currency') !== -1 && w.currency ? String(w.currency).toUpperCase() : null,
    };
  }

  const categories = {};
  for (const c of rowsToObjects(db, 'SELECT * FROM ' + quoteIdent(tCat))) {
    categories[c.category_pk] = { name: c.name != null ? String(c.name) : 'Uncategorized' };
  }

  const has = (c) => txCols.indexOf(c) !== -1;
  const transactions = [];
  for (const r of rowsToObjects(db, 'SELECT * FROM ' + quoteIdent(tTx))) {
    const wallet = wallets[r.wallet_fk] || null;
    const cat = has('category_fk') ? categories[r.category_fk] : null;
    const sub = has('sub_category_fk') && r.sub_category_fk ? categories[r.sub_category_fk] : null;
    transactions.push({
      id: String(r.transaction_pk),
      name: has('name') && r.name != null ? String(r.name) : '',
      amount: Number(r.amount) || 0,
      income: has('income') ? !!r.income : Number(r.amount) > 0,
      paid: has('paid') ? !!r.paid : true,
      date: driftDateToIso(r.date_created),
      account: wallet ? wallet.name : 'Unknown',
      currency: wallet ? wallet.currency : null,
      category: cat ? cat.name : null,
      subCategory: sub ? sub.name : null,
      note: has('note') && r.note ? String(r.note) : null,
    });
  }

  return {
    transactions,
    accounts: Object.values(wallets),
    categories: Object.values(categories).map((c) => c.name),
  };
}

// Drift stores DateTime as unix SECONDS by default; tolerate ms too.
function driftDateToIso(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- merge into the app_state document ----------
// Each Cashew backup is the COMPLETE database, so the stored list is
// rebuilt from it keyed by Cashew's transaction_pk. The diff against
// the previous row is computed only for reporting.
export function mergeTransactions(existing, parsed, file) {
  const prev =
    existing && Array.isArray(existing.transactions) ? existing.transactions : [];
  const prevById = new Map(prev.map((t) => [t.id, t]));

  let added = 0, updated = 0, unchanged = 0;
  for (const t of parsed.transactions) {
    const old = prevById.get(t.id);
    if (!old) added++;
    else if (JSON.stringify(old) !== JSON.stringify(t)) updated++;
    else unchanged++;
  }
  const newIds = new Set(parsed.transactions.map((t) => t.id));
  const removed = prev.filter((t) => !newIds.has(t.id)).length;

  const sorted = parsed.transactions
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const capped = sorted.slice(0, MAX_STORED_TRANSACTIONS);

  return {
    doc: {
      synced_at: new Date().toISOString(),
      source_file: file ? { id: file.id, name: file.name, modifiedTime: file.modifiedTime } : null,
      accounts: parsed.accounts,
      categories: parsed.categories,
      transactions: capped,
    },
    counts: {
      parsed: parsed.transactions.length,
      added,
      updated,
      unchanged,
      removed,
      stored: capped.length,
    },
  };
}
