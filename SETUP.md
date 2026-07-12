# Dashboard — Setup Guide (fork → deploy in ~5 min)

This is a static dashboard (plain HTML/JS) that deploys on **Vercel** and syncs across your
devices with **Supabase**.

---

## 1. Fork & deploy

1. **Fork** this repo to your GitHub.
2. Go to **vercel.com → Add New → Project → Import** your fork.
3. Framework Preset: **Other**. Root Directory: **`./`**. Build/output: leave blank (static).
4. **Deploy.** You'll get a URL like `https://your-app.vercel.app`.

The dashboard opens to a **sign-in screen** ([`login.html`](login.html)), backed by
**Supabase Auth** (email + password). There is no self-signup: create your user in
Supabase → **Authentication → Users → Add user**. Every page loads
[`auth.js`](auth.js), which hides the page until a valid session exists.

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

> The `anon` policy above is still what's live. Once you've verified sign-in works,
> [`supabase/rls-authenticated.sql`](supabase/rls-authenticated.sql) tightens `app_state`
> so only **authenticated** users can read/write it.

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

> ⚠️ Only the **anon** key (public) is used here. **Never** put the `service_role` key in code
> or in these env vars.

---

## 3. Finance (Toshl Finance → Supabase) — optional

Mirrors your [Toshl Finance](https://toshl.com) entries into the dashboard's
**Finances → Transactions** tab.

1. In Toshl: **Settings → Developer → Personal access token** — create one.
2. In Vercel → **Settings → Environment Variables**, add:

   | Variable | Value |
   |---|---|
   | `TOSHL_API_TOKEN` | your Toshl personal access token |

   This is a **server-side secret** (used only inside `/api/finance-sync` via HTTP
   Basic Auth) — it never reaches the browser. Redeploy after adding it.
3. Confirm the sync reads your data correctly **before anything is written**:
   - `/api/finance-sync?mode=diagnose` → shows the date window, account/tag names and
     sample raw + mapped entries. Writes nothing.
   - `/api/finance-sync` → dry run: shows exactly what would be stored. Writes nothing.
   - `/api/finance-sync?write=1` → actually upserts into `app_state.finance_transactions`.
   - Optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` on any mode to sync a manual range
     (default: last 90 days).
4. `vercel.json` schedules a daily cron (05:30 UTC) that runs the sync automatically.
   Optionally set a `CRON_SECRET` env var in Vercel to authenticate cron calls.

Idempotency: transactions are keyed by Toshl's entry id, so repeated runs never duplicate
entries; edits update in place, entries deleted in Toshl are dropped from the synced
window, and older transactions outside the window are preserved.

---

## 4. Nova (AI mentor / gym coach) — optional

No setup or key in the repo. Each user **pastes their own Anthropic API key** on the
**Nova** tile; it's stored only in their browser and sent straight to Anthropic. Get a key at
console.anthropic.com.

---

## TL;DR
1. Fork → import to Vercel → deploy.
2. New Supabase → run the **SQL** above → paste your **URL + anon key** into `sync.js`
   and `topbar.js`.
3. Supabase → **Authentication → Users → Add user** — that's your dashboard login. Done.
