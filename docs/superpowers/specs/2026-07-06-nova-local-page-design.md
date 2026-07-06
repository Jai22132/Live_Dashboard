# Nova Local page — design

**Date:** 2026-07-06
**File to build:** `nova-local.html` (new page)
**Also edited:** `index.html` (one new hub tile)
**Do not touch:** Calendar, Finance, Training, To-Do/Goals, Reading Vault, Wardrobe core CRUD, the biweekly list, `nova-lite.html`, anything in `/nova-batch/`.

## Purpose

A user-facing page that reads/writes the two batch-owned `app_state` rows the Nova batch
processor (`/nova-batch/`) maintains:

- **`nova_context`** — `{ summary_text, wardrobe_descriptions, last_updated }`
  where `wardrobe_descriptions` is a map `{ [itemId]: { category, description } }`.
- **`nova_questions`** — `{ queue: [{ id, question, status: 'pending'|'answered', answer, asked_at, answered_at }] }`.

The page adapts to whether the browser can reach the local Ollama server:

- **Live mode** — browser is on the same machine as Ollama: chat straight to
  `qwen2.5:14b`, using `nova_context` as prompt context. No queue involved.
- **Queued mode** — no local Ollama: submit questions into the `nova_questions`
  queue for the batch script to answer, and show answers as they arrive.

This page does **not** call Ollama for the queued path — the batch script owns that.
It is a separate feature from `nova-lite.html` (which stays untouched).

## Visual direction — "Blend"

- Orb + bubble **chat** header/feed, echoing `nova-lite.html`'s aesthetic.
- Wardrobe context and the question queue live in dashboard **glass cards**
  (`.gm-card`) using the shared design tokens from `template.html`.
- Standard dashboard **chrome** (`topbar.js` top bar + bottom tab nav).
- Nova-family accent: indigo `#818CF8` (sibling to `nova-lite`'s `#A78BFA`).

## Architecture

Single self-contained `nova-local.html`, following the existing per-page modularity
(each page is one HTML file that loads the shared cross-cutting scripts).

**Head loads, in order:**

```html
<script src="lock.js"></script>
<script src="/api/config"></script>   <!-- serves window.DASH_SUPABASE_* like index.html -->
<meta ...>
<title>Nova Local · AI (live or queued)</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="topbar.js" defer></script>
```

**Deliberately NOT loaded: `sync.js`.** `initCloudSync` mirrors *localStorage* keys into
an `app_state` row. The `nova_context` / `nova_questions` rows are batch-owned structured
rows, not localStorage mirrors — using `initCloudSync` would make the page overwrite whole
rows from localStorage and fight the batch. Instead the page talks to Supabase directly.

**Supabase client** — reuse the exact resolution `sync.js`/`topbar.js` use:

```js
const SUPABASE_URL = (window.DASH_SUPABASE_URL) || 'https://awytpwgorebhjewlqlhs.supabase.co';
const SUPABASE_KEY = (window.DASH_SUPABASE_KEY) || 'sb_publishable_iyTy90Bi9Ct9ZMY0nu9hjA_N5BFmlFN';
const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
```

Reads: `supa.from('app_state').select('data').eq('key', <row>).maybeSingle()`.
Writes: re-read then `supa.from('app_state').upsert({ key, data, updated_at }, { onConflict: 'key' })`.

## Component 1 — Mode detection

On load, probe Ollama:

```js
fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) })
```

- Resolves OK → **live mode**.
- Rejects / times out → **queued mode**.

UI: a small badge — `● live · qwen2.5:14b` or `● queued` — with a **"recheck"** link that
re-runs the probe, so if Ollama starts after page load the user can switch to live without a
full reload. A one-line hint sits under the badge in queued mode explaining that live mode
needs the page opened locally on the Ollama PC.

**CORS reality (by design, not a bug):** a page served from the Vercel origin (https) calling
`http://localhost:11434` is rejected by Ollama's default origins (and browser mixed-content
rules), so the probe fails and the page falls back to queued — exactly the intended graceful
degradation. Live mode connects when the page is opened locally (`file://` or a localhost
server) on the same machine as Ollama, or when Ollama is started with `OLLAMA_ORIGINS`
including the page's origin.

## Component 2 — Live mode (chat)

- Orb + bubble chat feed (nova-lite style), with `think`/`happy` orb states.
- Input row submits a question. Flow:
  1. Ensure `nova_context` is loaded (`summary_text`, `wardrobe_descriptions`).
  2. Build the prompt as a faithful JS port of the batch's `buildQuestionPrompt`
     (`nova-batch/lib.mjs`): Nova persona line + `summary_text` + a wardrobe block
     (`- [category] description`, capped ~2500 chars) + `Question: <text>`.
  3. `POST http://localhost:11434/api/generate` with
     `{ model: 'qwen2.5:14b', prompt, stream: false, options: { temperature: 0.4, num_predict: 600 } }`.
  4. Render `data.response` in a Nova bubble.
- **Ephemeral**: no queue write, in-session history only (matches spec).
- Errors (Ollama unreachable mid-session, model missing, timeout) render an inline error
  bubble and offer "recheck / switch to queued".
- Non-streaming (matches the batch; simpler and robust). Streaming is a possible later
  enhancement, out of scope here.

## Component 3 — Queued mode (queue)

- Submit form (`.gm-input` + `.gm-add`) appends a new question:

  ```js
  { id: crypto.randomUUID(), question, status: 'pending',
    answer: null, asked_at: new Date().toISOString(), answered_at: null }
  ```

- **Write = re-read then upsert:** read the current `nova_questions` row, normalize
  (`{ queue: [...] }`, tolerate missing/empty), append, write the whole row back. This mirrors
  the batch's re-read-before-write discipline to shrink the whole-row last-write-wins race
  window. First submit creates the row if absent.
- Queue renders **newest-first**: each item shows the question, a status pill
  (pending / answered), and the answer once the batch fills it in.
- **Freshness (chosen approach):** Supabase **realtime subscription** on
  `app_state` filtered to `key=eq.nova_questions` (primary, instant), **plus** a manual
  **Refresh** button, **plus** a 30s poll as a safety-net fallback. Any of the three
  re-fetches + re-renders the queue.

## Component 4 — Wardrobe context (both modes)

- A collapsible **"What Nova knows · wardrobe"** glass card, visible in both modes.
- Lists `nova_context.wardrobe_descriptions`: one row per item — `[category] description` —
  with the item count in the header.
- Shows a "knowledge updated {last_updated}" line so freshness is clear.
- Empty state when the batch has not populated descriptions yet (expected initially — as of
  2026-07-06 the project has no wardrobe rows yet).

## Component 5 — Navigation

Add one **bento hub tile** to `index.html` (after the existing tiles, `·10`):

```
label:  "Nova Local"
sub:    "Local AI · live or queued"
emoji:  💻
accent: #818CF8   (indigo — Nova family, distinct from 🧠 Nova #A78BFA)
href:   nova-local.html
size:   small tile
```

**Why a hub tile, not a topbar entry:** the `topbar.js` bottom bar is a fixed 3-tab core
(Main / Health / Fitness) for high-frequency navigation; every *feature* page is reached from
the bento hub grid, alongside the existing "Nova" tile. A hub tile is the consistent home and
keeps the topbar untouched. Editing `index.html` (the hub) is outside the do-not-touch list.

## Error handling / edge cases

- `nova_context` missing/empty → live prompt uses a "no context yet" fallback line; wardrobe
  card shows its empty state.
- `nova_questions` missing → treated as empty queue; first submit creates the row.
- Ollama probe/generate failure → graceful fallback to queued / inline error, never a hard crash.
- Supabase read/write failure → non-fatal; a small status note; realtime + poll recover.
- All network calls use `AbortSignal.timeout(...)`.
- HTML-escape all user/model text before insertion (reuse nova-lite's `esc` + light markdown
  render for bullets/**bold**).

## Verification plan

Static page against external services, so verify by driving it:

1. **Detection** — with Ollama reachable vs not, confirm the badge and mode switch (and
   "recheck" flips live↔queued).
2. **Queued path** — submit a question; confirm a `pending` item lands in the `nova_questions`
   row (Supabase) and renders; simulate the batch writing an answer and confirm realtime updates
   the pill + answer without reload.
3. **Live path** — with Ollama up locally, confirm a prompt built from `nova_context` returns a
   rendered answer and writes nothing to the queue. (Full live e2e requires Ollama running.)
4. **Wardrobe card** — renders `wardrobe_descriptions` in both modes; empty state when absent.
5. **Nav** — new tile appears in the hub and links to `nova-local.html`; `nova-lite.html`,
   topbar, and all other pages unchanged.

## Out of scope / YAGNI

- No streaming responses in live mode.
- No editing/deleting queue items from the UI (avoids extra race surface with the batch).
- No new shared JS module — the page is the only consumer of these two rows, so logic stays
  inline (the batch's `buildQuestionPrompt` is ported, not imported).
- No changes to `nova-lite.html` or anything under `/nova-batch/`.

## Notes

- The working copy is not a git repo, so this spec is written but not committed. Offer
  `git init` if version control is wanted.
