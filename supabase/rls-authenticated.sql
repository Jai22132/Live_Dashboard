-- =============================================================
-- RLS tightening: anon → authenticated
-- Companion to the lock.js → Supabase Auth swap.
--
-- HOW TO APPLY (Supabase Dashboard → SQL Editor):
--   Step 0  Run the inspection queries and confirm the existing
--           policy names match the ones dropped in Step 2.
--   Step 1  Run the CREATE POLICY block. Purely additive — the app
--           keeps working before, during and after.
--   Step 2  ONLY after login/logout/session persistence is tested
--           on every page AND the service-role key env vars are in
--           place (see PREREQUISITES), run the DROP POLICY block.
--           This is the moment the anon key stops working.
--
-- PREREQUISITES for Step 2 (things that write with NO user session):
--   • Vercel env: add SUPABASE_SERVICE_ROLE_KEY (Project Settings →
--     API → service_role secret). Used by /api/finance-sync (Toshl)
--     and the Google Calendar token store; both fall back to the
--     anon key until this exists, and the anon key dies in Step 2.
--   • nova-batch (local PC): set SUPABASE_SERVICE_ROLE_KEY in the
--     Task Scheduler / shell environment for the same reason.
--
-- DESIGN CHOICE — role check, not per-row ownership:
--   Policies below use `to authenticated ... (true)` rather than a
--   user_id = auth.uid() column. This is a single-user app with one
--   manually created account: every authenticated request IS that
--   user, so per-row ownership adds a schema migration (user_id
--   column, backfill, changed upsert payloads in sync.js/nova-batch/
--   api/*) for zero security gain. If a second account is ever
--   created it would see the same data — revisit then.
-- =============================================================


-- ============ STEP 0 — inspect current policies ==============
-- Expected on app_state (from SETUP.md): "anon full access app_state"
-- Expected on storage.objects (from WARDROBE_SETUP.md):
--   "anon read wardrobe-photos", "anon insert wardrobe-photos",
--   "anon update wardrobe-photos", "anon delete wardrobe-photos"

select schemaname, tablename, policyname, roles, cmd
from pg_policies
where (schemaname = 'public'  and tablename = 'app_state')
   or (schemaname = 'storage' and tablename = 'objects')
order by tablename, policyname;

-- Also check the bucket's public flag (see note at the bottom):
select id, public from storage.buckets where id = 'wardrobe-photos';


-- ============ STEP 1 — additive: authenticated policies ======
-- Safe to run immediately; anon policies still exist so nothing breaks.

-- app_state: any signed-in user (i.e. the single account) gets full access.
create policy "authenticated full access app_state"
  on public.app_state for all
  to authenticated using (true) with check (true);

-- wardrobe-photos bucket: same four operations the anon policies granted.
create policy "authenticated read wardrobe-photos"
  on storage.objects for select
  to authenticated using ( bucket_id = 'wardrobe-photos' );

create policy "authenticated insert wardrobe-photos"
  on storage.objects for insert
  to authenticated with check ( bucket_id = 'wardrobe-photos' );

create policy "authenticated update wardrobe-photos"
  on storage.objects for update
  to authenticated using ( bucket_id = 'wardrobe-photos' )
  with check ( bucket_id = 'wardrobe-photos' );

create policy "authenticated delete wardrobe-photos"
  on storage.objects for delete
  to authenticated using ( bucket_id = 'wardrobe-photos' );


-- ============ STEP 2 — destructive: drop the anon policies ===
-- Run ONLY after the new auth flow is confirmed working everywhere
-- and the service-role env vars are set (see PREREQUISITES above).
-- If Step 0 showed different policy names, drop those instead.

drop policy "anon full access app_state" on public.app_state;

drop policy "anon read wardrobe-photos"   on storage.objects;
drop policy "anon insert wardrobe-photos" on storage.objects;
drop policy "anon update wardrobe-photos" on storage.objects;
drop policy "anon delete wardrobe-photos" on storage.objects;


-- ============ NOTES ==========================================
-- • Realtime: with the anon SELECT policy gone, postgres_changes
--   events are only delivered to sockets authenticated as the user.
--   The dashboard now routes realtime through the shared signed-in
--   client from auth.js, so live sync keeps working after login.
--
-- • PUBLIC BUCKET CAVEAT: wardrobe-photos was created with
--   public = true, so direct object URLs
--   (/storage/v1/object/public/wardrobe-photos/...) stay readable
--   WITHOUT auth regardless of the SELECT policy — that flag
--   bypasses RLS for downloads. The policy changes above still
--   protect uploads, deletes and listing. Both wardrobe.html
--   (getPublicUrl) and nova-batch (vision fetch) render photos via
--   those public URLs, so KEEP the bucket public for now. Locking
--   reads down for real means public = false + signed URLs in both
--   places — a separate follow-up, not part of this auth swap.
