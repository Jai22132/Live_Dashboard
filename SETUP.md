# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **password screen** — the default password is in
[`lock.js`](lock.js) (`var PASSWORD = "qwer"`). Change it to whatever you want.

---

## 2. Supabase (cross-device sync) — required for sync

Create a free project at **supabase.com**, then run **both** SQL blocks in
**SQL Editor → New query → Run**.

### SQL #1 — `app_state` (all dashboard sync)
```sql
create table if not exists public.app_state (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The browser uses the ANON key, so allow it to read/write:
alter table public.app_state enable row level security;
create policy "anon full access app_state"
  on public.app_state for all
  to anon using (true) with check (true);

-- Instant cross-device updates:
alter publication supabase_realtime add table public.app_state;
```

### Connect YOUR Supabase — pick ONE way
Supabase → **Project Settings → API**. Copy the **Project URL** and the **anon / publishable** key.

**Way A — Vercel env vars (easiest, no code edits):**
In Vercel → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |

Redeploy. The app reads these automatically via `/api/config`.

**Way B — edit the files:**
Replace the old URL/key in these files:
- [`sync.js`](sync.js)
- [`topbar.js`](topbar.js)
- [`gym.html`](gym.html)

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

---

## 3. Finance (Cashew → Google Drive → Supabase) — optional

Mirrors your [Cashew](https://cashewapp.web.app) budget transactions into the dashboard's
**Finances → Transactions** tab. Reuses the same Google OAuth app as the Calendar module.

1. In **Google Cloud Console** (same project as the Calendar module):
   - Enable the **Google Drive API**.
   - Add the scope `https://www.googleapis.com/auth/drive.appdata` to the OAuth consent screen.
2. In **Cashew** (signed into the **same** Google account): Settings → Backups →
   back up to Google Drive. Cashew stores the backup in Drive's hidden `appDataFolder`.
3. **Reconnect Google once** from the dashboard (the Connect button, or open
   `/api/google-auth-start`) so the stored token gains Drive access.
4. Confirm the parser reads your backup correctly **before anything is written**:
   - `/api/finance-sync?mode=diagnose` → lists the Drive files + every table/column
     found in the backup + sample rows. Writes nothing.
   - `/api/finance-sync` → dry run: shows exactly what would be stored. Writes nothing.
   - `/api/finance-sync?write=1` → actually upserts into `app_state.finance_transactions`.
     If the backup doesn't match the expected Cashew schema, it aborts with a diagnostic
     instead of writing.
5. `vercel.json` schedules a daily cron (05:30 UTC) that runs the sync automatically.
   Optionally set a `CRON_SECRET` env var in Vercel to authenticate cron calls.

Idempotency: transactions are keyed by Cashew's own `transaction_pk`, so repeated runs
never duplicate entries; edits update in place and deletions in Cashew disappear here too.

---

## 4. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`,
   `topbar.js`, `gym.html`.
3. Change the password in `lock.js`. Done.
