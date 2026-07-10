# Wardrobe — Storage setup & module notes

The **Wardrobe** catalog ([`wardrobe.html`](wardrobe.html)) is the first module that stores
real files instead of JSON. Photos live in a **Supabase Storage bucket**; only the file
*paths* (plus category + date) are kept in `app_state`, never the image bytes.

You said the bucket is already set up — this page documents exactly what the page code
**assumes** so you can confirm your bucket + policies match. If uploads or deletes fail
silently, it's almost always one of these policies missing.

---

## What the code expects

- A Storage bucket named **`wardrobe-photos`**, set to **public** (public-read).
- The browser's **anon / publishable key** (the same one [`sync.js`](sync.js) already uses)
  is allowed to **INSERT, SELECT, UPDATE and DELETE** objects *in that bucket only* —
  mirroring how `app_state` is fully open to the anon key.

Images are served via each object's **public URL** (`getPublicUrl`), so reads need no signed
links. The page itself is behind the Supabase Auth gate in [`auth.js`](auth.js).

---

## SQL to create / verify it

Run in Supabase → **SQL Editor → New query → Run**. It's idempotent — safe to re-run to
confirm an existing bucket matches.

```sql
-- 1. The bucket, public-read. (If you made it in the dashboard, just ensure "Public" is ON.)
insert into storage.buckets (id, name, public)
values ('wardrobe-photos', 'wardrobe-photos', true)
on conflict (id) do update set public = true;

-- 2. Let the ANON key manage objects in this one bucket (same model as app_state).
--    RLS is already enabled on storage.objects by default in Supabase.
create policy "anon read wardrobe-photos"
  on storage.objects for select
  to anon using ( bucket_id = 'wardrobe-photos' );

create policy "anon insert wardrobe-photos"
  on storage.objects for insert
  to anon with check ( bucket_id = 'wardrobe-photos' );

create policy "anon update wardrobe-photos"
  on storage.objects for update
  to anon using ( bucket_id = 'wardrobe-photos' )
  with check ( bucket_id = 'wardrobe-photos' );

create policy "anon delete wardrobe-photos"
  on storage.objects for delete
  to anon using ( bucket_id = 'wardrobe-photos' );
```

> If a policy already exists you'll get a "policy already exists" error — that's fine, it
> means it's in place. (To replace one, `drop policy "…" on storage.objects;` first.)

No new `app_state` SQL is needed — the Wardrobe reuses the existing `app_state` table under
a new row key, `wardrobe`.

---

## How it works

- **Compression (hard requirement):** every photo is resized client-side to **800px on the
  longest side** and re-encoded as **JPEG quality 0.72** *before* upload, via a `<canvas>`.
  EXIF orientation from phone cameras is honoured (`createImageBitmap … imageOrientation`).
  This is what keeps each item small against the 1 GB free tier.
- **Two photos per item:** two upload slots. Photo 1 is required, Photo 2 is optional and can
  be added later via Edit. Both go through the same compression.
- **Data model** (`app_state` row `wardrobe` → key `wardrobe_items`):
  ```json
  {
    "items": [
      { "id": "…", "category": "t-shirt", "photo_paths": ["items/…_0_….jpg", "items/…_1_….jpg"], "added_date": "2026-07-06" }
    ],
    "categories": ["t-shirt", "trousers", "shoes", "trainers"]
  }
  ```
  Custom categories you add are stored alongside and sync across devices.
- **Delete removes the files too:** deleting an item calls `storage.remove([...paths])` for
  both photos *before* dropping the reference, so nothing is orphaned in the bucket.
  Replacing a photo deletes the file it supersedes, and a failed upload rolls back any files
  it managed to write.

---

## Modularity — add / remove independently

The module is self-contained and touches nothing else (Calendar, Finance, Training,
To-Do/Goals, Reading, biweekly list, Nova are all untouched):

- **Added:** [`wardrobe.html`](wardrobe.html), one tile in [`index.html`](index.html) (`·09`),
  and this doc. Reuses `auth.js`, `sync.js`, `topbar.js`, `/api/config` unchanged.
- **To remove it completely:** delete `wardrobe.html`, remove the `·09` tile from
  `index.html`, delete the `wardrobe` row from `app_state`, and delete the `wardrobe-photos`
  bucket (and its policies).
