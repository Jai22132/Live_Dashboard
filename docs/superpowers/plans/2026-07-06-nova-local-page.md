# Nova Local page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `nova-local.html`, a page that chats with local Ollama when reachable (live mode) or queues questions into the batch-owned `nova_questions` row when not (queued mode), and surfaces `nova_context` wardrobe knowledge in both modes.

**Architecture:** One self-contained HTML page following the repo's per-page pattern (loads `lock.js`, `/api/config`, the Supabase CDN, and `topbar.js`; NOT `sync.js`). All logic is inline in a classic-script IIFE so it works over `file://` (the live-mode case) as well as https. It talks to Supabase directly via `window.supabase.createClient` for the two batch-owned rows, and to `http://localhost:11434` for live generation. Visual "blend": nova-lite orb + chat bubbles, dashboard glass cards for context/queue, indigo Nova accent `#818CF8`.

**Tech Stack:** Vanilla HTML/CSS/JS (ES2017, classic script), `@supabase/supabase-js@2` (CDN, realtime), Ollama `qwen2.5:14b` via `/api/generate`, `/api/tags` for detection.

---

## Conventions for this plan (read first)

- **Not a git repo.** This working copy is not under git. Wherever a step says **Checkpoint**, it means *save and verify* — there is no commit. If you want version control, run `git init` first and turn each Checkpoint into a commit; otherwise just proceed.
- **No browser test harness exists.** Every page in this repo is a self-contained HTML file verified by driving it in a browser (there are no frontend unit tests; the only tests are Node tests under `nova-batch/`). This plan is therefore **verification-driven**: each task ends by loading the page and observing behavior, plus DevTools console/Network and Supabase Table Editor checks. The one pure port (the live prompt) is additionally checked for **parity against the already-tested `nova-batch/lib.mjs`** in Task 6.
- **Do not touch:** `nova-lite.html`, anything under `/nova-batch/`, and the Calendar/Finance/Training/To-Do/Reading/Wardrobe-CRUD/biweekly features. The only existing file modified is `index.html` (one new hub tile).
- **Data contracts** (owned by the batch):
  - `nova_context` = `{ summary_text: string, wardrobe_descriptions: { [id]: { category, description } }, last_updated: string }`
  - `nova_questions` = `{ queue: [ { id, question, status: 'pending'|'answered', answer, asked_at, answered_at } ] }`

---

## File structure

- **Create:** `nova-local.html` — the entire page (styles + markup + inline classic-script logic).
- **Modify:** `index.html` — add one bento hub tile (`·10 Nova Local`).

The page's inline script is organized into clearly-commented sections so later tasks fill marked slots:
`/* == CONFIG == */`, `/* == HELPERS == */`, `/* == SUPABASE == */`, `/* == CONTEXT+WARDROBE == */`, `/* == QUEUED == */`, `/* == LIVE == */`, `/* == MODE == */`, `/* == BOOT == */`.

---

## Task 1: Page skeleton — chrome, styles, containers, mode detection

Creates the whole file with the design system, the blend styles, empty containers, and working live/queued **mode detection** wired to a badge. Live/queued content bodies are stubbed and filled in later tasks.

**Files:**
- Create: `nova-local.html`

- [ ] **Step 1: Create `nova-local.html` with full skeleton**

Create `nova-local.html` with exactly this content:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<script src="lock.js"></script>
<script src="/api/config"></script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#050506">
<title>Nova Local · AI (live or queued)</title>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="topbar.js" defer></script>

<style>
/* ===== Shared dashboard tokens (match template.html) ===== */
:root {
  --text-primary: #FAFAFA;
  --text-secondary: #B8B6B0;
  --text-tertiary: #76746E;
  --success: #6BE3A4;
  --warning: #F2C063;
  --danger:  #FF6B6B;
  --accent:  #818CF8;   /* Nova Local indigo */
  --font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; background: #050506; color: var(--text-secondary);
  font-family: var(--font); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
}
body { min-height: 100vh; position: relative; overflow-x: hidden; padding: max(28px, env(safe-area-inset-top)) 20px 60px; }
body::before {
  content: ''; position: fixed; inset: 0;
  background: radial-gradient(circle at 82% 14%, rgba(129,140,248,0.16), transparent 45%),
              radial-gradient(circle at 18% 90%, rgba(180,180,200,0.06), transparent 50%);
  filter: blur(40px); pointer-events: none; z-index: -2; animation: drift 36s ease-in-out infinite alternate;
}
body::after {
  content: ''; position: fixed; inset: 0;
  background-image: radial-gradient(rgba(255,255,255,0.014) 1px, transparent 1px);
  background-size: 3px 3px; pointer-events: none; z-index: -1;
}
@keyframes drift { 0%{transform:translate3d(0,0,0)} 100%{transform:translate3d(-22px,14px,0)} }

.page { max-width: 720px; margin: 0 auto; }
.dash-title {
  margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.025em;
  background: linear-gradient(180deg, #FFFFFF 0%, #C7C4BC 120%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent;
}
@media (max-width: 480px) { .dash-title { font-size: 22px; } }
.section-title {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-tertiary); display: flex; align-items: center; gap: 12px; margin: 18px 0 12px;
}
.section-title::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(255,255,255,0.08), transparent); }
.gm-card {
  position: relative; background: rgba(255,255,255,0.04); border-radius: 16px; padding: 20px; margin-bottom: 14px;
  backdrop-filter: blur(24px) saturate(1.2); -webkit-backdrop-filter: blur(24px) saturate(1.2);
  box-shadow: 0 12px 40px rgba(0,0,0,0.45); overflow: hidden;
}
.empty-state { text-align: center; font-size: 12px; font-style: italic; color: var(--text-tertiary); padding: 14px 0; }
.gm-input {
  flex: 1; min-width: 0; padding: 11px 14px; border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; background: rgba(0,0,0,0.28); color: var(--text-primary);
  font-family: inherit; font-size: 14px; outline: none; transition: border-color 0.2s, background 0.2s;
}
.gm-input::placeholder { color: var(--text-tertiary); }
.gm-input:focus { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: rgba(0,0,0,0.36); }
.gm-add {
  padding: 11px 20px; border: 0; border-radius: 12px;
  background: linear-gradient(180deg, #FFFFFF 0%, #E8E5DD 100%); color: #0A0A0B;
  font-family: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 8px rgba(0,0,0,0.35), 0 8px 22px rgba(0,0,0,0.25);
  transition: transform 0.1s, filter 0.15s;
}
.gm-add:hover { filter: brightness(1.06); transform: translateY(-1px); }
.gm-add:active { transform: translateY(0); }
.gm-ghost {
  padding: 8px 14px; border: 1px solid rgba(255,255,255,0.10); border-radius: 10px;
  background: rgba(255,255,255,0.04); color: var(--text-primary);
  font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.gm-ghost:hover { background: rgba(255,255,255,0.07); }

/* ===== Header row: orb + title + mode badge ===== */
.nl-head { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
.orb {
  width: 52px; height: 52px; border-radius: 50%; position: relative; flex-shrink: 0;
  background: radial-gradient(circle at 32% 28%, #eef0ff, var(--accent) 45%, #3730a3 100%);
  box-shadow: 0 0 22px -2px var(--accent), inset 0 -6px 14px rgba(0,0,0,.25);
  animation: orbFloat 4s ease-in-out infinite;
}
.orb::before, .orb::after {
  content: ''; position: absolute; top: 38%; width: 8px; height: 8px; border-radius: 50%;
  background: #10102b; box-shadow: 0 0 6px rgba(0,0,0,.4); transition: height .15s;
}
.orb::before { left: 30%; } .orb::after { right: 30%; }
.orb.think { animation: orbFloat 1.1s ease-in-out infinite, orbPulse 1.1s ease-in-out infinite; }
.orb.happy::before, .orb.happy::after { height: 3px; border-radius: 0 0 8px 8px; }
@keyframes orbFloat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
@keyframes orbPulse { 0%,100%{box-shadow:0 0 22px -2px var(--accent)} 50%{box-shadow:0 0 34px 2px var(--accent)} }
.nl-badge {
  margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.10);
  background: rgba(255,255,255,0.04); font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; color: var(--text-secondary); white-space: nowrap;
}
.nl-badge .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex-shrink: 0; }
.nl-badge.live .dot { background: var(--success); box-shadow: 0 0 8px var(--success); }
.nl-badge.queued .dot { background: var(--warning); }
.nl-recheck { background: none; border: 0; color: var(--accent); font: inherit; font-size: 11px; cursor: pointer; padding: 0 2px; text-decoration: underline; }
.nl-hint { font-size: 11.5px; color: var(--text-tertiary); line-height: 1.5; margin: 0 0 8px; }

/* ===== Chat (live) ===== */
.nl-feed { display: flex; flex-direction: column; gap: 12px; margin: 4px 0 14px; }
.msg { max-width: 92%; }
.msg.user { align-self: flex-end; }
.msg.coach { align-self: flex-start; width: 100%; }
.bubble { border-radius: 14px; padding: 12px 15px; font-size: 14.5px; line-height: 1.55; }
.msg.user .bubble { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.10); color: var(--text-primary); }
.msg.coach .bubble { background: rgba(255,255,255,0.04); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-left: 3px solid var(--accent); }
.tag { display: inline-block; margin-bottom: 8px; font-family: var(--font-mono); font-size: 9.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #0A0A0B; background: var(--accent); padding: 3px 9px; border-radius: 999px; }
.bubble b, .pill { color: var(--accent); font-weight: 700; }
.pill { background: color-mix(in srgb, var(--accent) 18%, transparent); padding: 1px 7px; border-radius: 6px; font-weight: 600; }
.reply-list { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 6px; }
.dots { display: inline-flex; gap: 5px; } .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); opacity: .4; animation: d 1.2s ease-in-out infinite; }
.dots i:nth-child(2){animation-delay:.2s} .dots i:nth-child(3){animation-delay:.4s}
@keyframes d { 0%,100%{opacity:.35;transform:scale(1)} 50%{opacity:1;transform:scale(1.4)} }
.composer { display: flex; gap: 9px; }

/* ===== Queue (queued) ===== */
.q-row { padding: 12px 14px; margin-bottom: 8px; background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; }
.q-top { display: flex; align-items: flex-start; gap: 10px; justify-content: space-between; }
.q-question { font-size: 14px; color: var(--text-primary); line-height: 1.45; }
.q-status { flex-shrink: 0; font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; }
.q-status.pending { color: var(--warning); background: color-mix(in srgb, var(--warning) 16%, transparent); }
.q-status.answered { color: var(--success); background: color-mix(in srgb, var(--success) 16%, transparent); }
.q-answer { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); font-size: 13.5px; color: var(--text-secondary); line-height: 1.55; }
.q-meta { margin-top: 6px; font-size: 10.5px; color: var(--text-tertiary); font-family: var(--font-mono); }

/* ===== Wardrobe accordion ===== */
.wc summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.wc summary::-webkit-details-marker { display: none; }
.wc summary .chev { transition: transform 0.2s; color: var(--text-tertiary); }
.wc[open] summary .chev { transform: rotate(90deg); }
.wc-count { margin-left: auto; font-size: 11px; color: var(--text-tertiary); font-weight: 600; }
.wc-updated { font-size: 10.5px; color: var(--text-tertiary); font-family: var(--font-mono); margin: 8px 0 4px; }
.wc-item { padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.06); font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.wc-item .cat { display: inline-block; font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); padding: 2px 8px; border-radius: 999px; margin-right: 8px; }

@media (max-width: 480px) {
  body { padding: max(20px, env(safe-area-inset-top)) 14px 50px; }
  .gm-card { padding: 16px; }
}
</style>
</head>
<body>
<div class="page">

  <div class="nl-head">
    <div class="orb" id="orb"></div>
    <h1 class="dash-title">Nova Local</h1>
    <span class="nl-badge queued" id="badge">
      <span class="dot"></span><span id="badgeText">checking…</span>
    </span>
  </div>
  <p class="nl-hint" id="modeHint"></p>

  <!-- LIVE mode body -->
  <div id="liveBody" style="display:none">
    <div class="nl-feed" id="feed"></div>
    <div class="composer">
      <input class="gm-input" id="liveInput" placeholder="ask Nova anything…" autocomplete="off">
      <button class="gm-add" id="liveSend" type="button">→</button>
    </div>
  </div>

  <!-- QUEUED mode body -->
  <div id="queuedBody" style="display:none">
    <div class="gm-card">
      <div class="composer">
        <input class="gm-input" id="queueInput" placeholder="ask Nova — the local batch will answer…" autocomplete="off">
        <button class="gm-add" id="queueSend" type="button">Queue</button>
      </div>
    </div>
    <div class="section-title">
      Question queue
      <button class="gm-ghost" id="queueRefresh" type="button" style="text-transform:none;letter-spacing:0">↻ Refresh</button>
    </div>
    <div id="queueList"><div class="empty-state">Loading…</div></div>
  </div>

  <!-- Wardrobe context (both modes) -->
  <div class="section-title">What Nova knows</div>
  <div class="gm-card">
    <details class="wc" id="wardrobeCard">
      <summary>
        <span class="chev">▸</span> Wardrobe context
        <span class="wc-count" id="wardrobeCount"></span>
      </summary>
      <div class="wc-updated" id="wardrobeUpdated"></div>
      <div id="wardrobeItems"><div class="empty-state">Loading…</div></div>
    </details>
  </div>

</div><!-- /.page -->

<script>
(function () {
  'use strict';

  /* == CONFIG == */
  var SUPABASE_URL = (window.DASH_SUPABASE_URL) || 'https://awytpwgorebhjewlqlhs.supabase.co';
  var SUPABASE_KEY = (window.DASH_SUPABASE_KEY) || 'sb_publishable_iyTy90Bi9Ct9ZMY0nu9hjA_N5BFmlFN';
  var OLLAMA = 'http://localhost:11434';
  var TEXT_MODEL = 'qwen2.5:14b';

  var el = function (id) { return document.getElementById(id); };
  var state = { mode: null, ctx: null };
  var supa = null;

  /* == HELPERS == */
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function setOrb(s){ var o = el('orb'); if (o) o.className = 'orb' + (s ? ' ' + s : ''); }
  /* == SUPABASE == */
  /* == CONTEXT+WARDROBE == */
  /* == QUEUED == */
  /* == LIVE == */

  /* == MODE == */
  async function detectMode() {
    try {
      var res = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(1500) });
      return res.ok ? 'live' : 'queued';
    } catch (e) { return 'queued'; }
  }
  function applyMode(mode) {
    state.mode = mode;
    var badge = el('badge'), text = el('badgeText'), hint = el('modeHint');
    badge.className = 'nl-badge ' + mode;
    if (mode === 'live') {
      text.textContent = 'live · ' + TEXT_MODEL;
      hint.textContent = '';
      el('liveBody').style.display = '';
      el('queuedBody').style.display = 'none';
    } else {
      text.textContent = 'queued';
      hint.innerHTML = 'No local Ollama reachable — questions are queued for the batch script. ' +
        'Live chat works when this page is opened on the machine running Ollama. ' +
        '<button class="nl-recheck" id="recheck2">recheck</button>';
      el('liveBody').style.display = 'none';
      el('queuedBody').style.display = '';
      var r2 = el('recheck2'); if (r2) r2.addEventListener('click', recheck);
    }
  }
  async function recheck() {
    el('badge').className = 'nl-badge queued';
    el('badgeText').textContent = 'checking…';
    applyMode(await detectMode());
    if (typeof afterModeApplied === 'function') afterModeApplied();
  }
  function afterModeApplied() { /* filled in later tasks (load queue / wardrobe) */ }

  /* == BOOT == */
  (async function boot() {
    try { supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); } catch (e) { supa = null; }
    applyMode(await detectMode());
    var badgeRecheck = document.createElement('button');
    badgeRecheck.className = 'nl-recheck'; badgeRecheck.textContent = 'recheck';
    badgeRecheck.addEventListener('click', recheck);
    el('badge').appendChild(badgeRecheck);
    afterModeApplied();
  })();
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Verify skeleton + detection (Ollama NOT running)**

Ensure Ollama is stopped, then open `nova-local.html` in a browser (double-click / `file://`, or via your local static server). 
Expected: page loads with the orb + "Nova Local" title; badge shows amber **queued** after ~1.5s; the queued body (input + "Question queue" + Loading) and the "What Nova knows" card are visible; the live body is hidden. No console errors except possibly the Supabase realtime not-yet-used.

- [ ] **Step 3: Verify detection flips to live (Ollama running)**

Start Ollama (`ollama serve` / Docker) on the same machine and open the page **locally** (`file://` or `http://localhost`). 
Expected: badge shows green **live · qwen2.5:14b**; the live chat body (feed + composer) is visible; queued body hidden. Click **recheck** after stopping Ollama → flips back to queued. 
(If you open the page from the Vercel https URL, expect it to stay **queued** — Ollama rejects the cross-origin probe by default. That is the intended fallback.)

- [ ] **Step 4: Checkpoint**

Save. (Not a git repo — see Conventions. If using git: `git add nova-local.html && git commit -m "feat(nova-local): page skeleton + mode detection"`.)

---

## Task 2: Supabase read + wardrobe context card (both modes)

Fills the `/* == SUPABASE == */` and `/* == CONTEXT+WARDROBE == */` slots and wires `afterModeApplied` to load context.

**Files:**
- Modify: `nova-local.html`

- [ ] **Step 1: Add the Supabase read helper**

Replace the line `  /* == SUPABASE == */` with:

```javascript
  /* == SUPABASE == */
  // Returns the `data` JSON column of an app_state row, or null.
  async function readRow(key) {
    if (!supa) return null;
    try {
      var res = await supa.from('app_state').select('data').eq('key', key).maybeSingle();
      if (res && res.data && res.data.data) return res.data.data;
      return null;
    } catch (e) { return null; }
  }
```

- [ ] **Step 2: Add context load + wardrobe render**

Replace the line `  /* == CONTEXT+WARDROBE == */` with:

```javascript
  /* == CONTEXT+WARDROBE == */
  async function loadContext() {
    state.ctx = (await readRow('nova_context')) || { summary_text: '', wardrobe_descriptions: {}, last_updated: '' };
    renderWardrobe();
  }
  function renderWardrobe() {
    var ctx = state.ctx || {};
    var map = ctx.wardrobe_descriptions || {};
    var ids = Object.keys(map);
    el('wardrobeCount').textContent = ids.length ? (ids.length + ' item' + (ids.length === 1 ? '' : 's')) : 'none yet';
    el('wardrobeUpdated').textContent = ctx.last_updated ? ('knowledge updated ' + ctx.last_updated) : '';
    var box = el('wardrobeItems');
    if (!ids.length) {
      box.innerHTML = '<div class="empty-state">Nova has not catalogued any wardrobe items yet — the batch script fills this in.</div>';
      return;
    }
    box.innerHTML = ids.map(function (id) {
      var e = map[id] || {};
      return '<div class="wc-item"><span class="cat">' + esc(e.category || 'item') + '</span>' + esc(e.description || '') + '</div>';
    }).join('');
  }
```

- [ ] **Step 3: Load context on boot / recheck**

Replace the whole `afterModeApplied` stub:

```javascript
  function afterModeApplied() { /* filled in later tasks (load queue / wardrobe) */ }
```

with:

```javascript
  function afterModeApplied() { loadContext(); }
```

- [ ] **Step 4: Verify wardrobe card**

Open the page. Expand **Wardrobe context**. 
- With no `nova_context` row (current state per project notes): count shows "none yet" and the empty-state text appears; no "knowledge updated" line.
- To verify the populated path, in Supabase → Table Editor → `app_state`, temporarily upsert a `nova_context` row with
  `{"summary_text":"test","wardrobe_descriptions":{"a":{"category":"Shirt","description":"Blue linen shirt."}},"last_updated":"2026-07-06 12:00"}`,
  reload: count shows "1 item", the item row renders with a "Shirt" pill and the description, and the "knowledge updated 2026-07-06 12:00" line shows. Remove the test row afterward.

- [ ] **Step 5: Checkpoint** — save (or commit `feat(nova-local): load nova_context + wardrobe card`).

---

## Task 3: Queued mode — submit + queue render (re-read-then-upsert)

Fills `/* == QUEUED == */`, wires the submit button, refresh button, and renders the queue newest-first.

**Files:**
- Modify: `nova-local.html`

- [ ] **Step 1: Add queued logic**

Replace the line `  /* == QUEUED == */` with:

```javascript
  /* == QUEUED == */
  function genId() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }
  // Port of nova-batch/lib.mjs normalizeQuestionsDoc — keep in sync with the batch.
  function normalizeQuestionsDoc(raw) {
    var doc = (raw && typeof raw === 'object') ? Object.assign({}, raw) : {};
    doc.queue = Array.isArray(doc.queue)
      ? doc.queue.filter(function (q) { return q && typeof q === 'object' && q.id != null; })
      : [];
    return doc;
  }
  async function submitQueued(question) {
    // Re-read then upsert the whole row to shrink the last-write-wins window with the batch.
    var doc = normalizeQuestionsDoc(await readRow('nova_questions'));
    doc.queue.push({
      id: genId(), question: question, status: 'pending',
      answer: null, asked_at: new Date().toISOString(), answered_at: null
    });
    var up = await supa.from('app_state').upsert(
      { key: 'nova_questions', data: doc, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (up && up.error) throw up.error;
    renderQueue(doc);
  }
  function fmtTime(iso) {
    if (!iso) return '';
    try { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(); } catch (e) { return ''; }
  }
  function renderQueue(doc) {
    var d = normalizeQuestionsDoc(doc);
    var list = el('queueList');
    if (!d.queue.length) { list.innerHTML = '<div class="empty-state">No questions yet — ask one above.</div>'; return; }
    var items = d.queue.slice().sort(function (a, b) {
      return String(b.asked_at || '').localeCompare(String(a.asked_at || ''));
    });
    list.innerHTML = items.map(function (q) {
      var status = q.status === 'answered' ? 'answered' : 'pending';
      var answer = (status === 'answered' && q.answer)
        ? '<div class="q-answer">' + renderMd(q.answer) + '</div>' : '';
      var meta = 'asked ' + fmtTime(q.asked_at) + (q.answered_at ? ' · answered ' + fmtTime(q.answered_at) : '');
      return '<div class="q-row"><div class="q-top">' +
        '<div class="q-question">' + esc(q.question) + '</div>' +
        '<span class="q-status ' + status + '">' + status + '</span></div>' +
        answer + '<div class="q-meta">' + esc(meta) + '</div></div>';
    }).join('');
  }
  async function refreshQueue() { renderQueue(await readRow('nova_questions')); }
  function wireQueued() {
    var input = el('queueInput'), send = el('queueSend');
    async function go() {
      var t = (input.value || '').trim(); if (!t) return;
      send.disabled = true; input.value = '';
      try { await submitQueued(t); } catch (e) { input.value = t; alert('Could not queue the question — check your connection.'); }
      send.disabled = false; input.focus();
    }
    send.addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    el('queueRefresh').addEventListener('click', refreshQueue);
  }
```

Note: `renderMd` is defined in Task 5 (`/* == LIVE == */`). Since queued answers may contain bullets/bold, add a minimal `renderMd` now in the HELPERS slot so this task works standalone. Replace the line `  function setOrb(s){ var o = el('orb'); if (o) o.className = 'orb' + (s ? ' ' + s : ''); }` with:

```javascript
  function setOrb(s){ var o = el('orb'); if (o) o.className = 'orb' + (s ? ' ' + s : ''); }
  function inlineMarks(s){ return esc(s).replace(/\*\*(.+?)\*\*/g, '<span class="pill">$1</span>'); }
  function renderMd(text){
    var lines = String(text == null ? '' : text).split(/\r?\n/).map(function(l){ return l.trim(); }).filter(Boolean);
    var items = [], loose = [];
    lines.forEach(function(l){
      if (/^[-•*]\s+/.test(l)) items.push('<li>' + inlineMarks(l.replace(/^[-•*]\s+/, '')) + '</li>');
      else loose.push(inlineMarks(l));
    });
    var html = loose.join('<br>');
    if (items.length) html += (html ? '<br>' : '') + '<ul class="reply-list">' + items.join('') + '</ul>';
    return html;
  }
```

- [ ] **Step 2: Wire queued mode + initial render into `afterModeApplied`**

Replace:

```javascript
  function afterModeApplied() { loadContext(); }
```

with:

```javascript
  var queuedWired = false;
  function afterModeApplied() {
    loadContext();
    if (state.mode === 'queued') {
      if (!queuedWired) { wireQueued(); queuedWired = true; }
      refreshQueue();
    }
  }
```

- [ ] **Step 3: Verify submit + render**

With Ollama stopped (queued mode), open the page. Type a question, click **Queue**.
Expected: it clears the input and a `q-row` appears with a **pending** pill and an "asked …" meta line. In Supabase → Table Editor → `app_state` → `nova_questions`, confirm the `queue` array has your item with `status:"pending"`, a UUID `id`, and `asked_at`. Submit a second question → both show, newest on top. Click **↻ Refresh** → no duplication, list re-renders.

- [ ] **Step 4: Verify answered rendering**

In Supabase, edit the `nova_questions` row: set one item's `status` to `"answered"`, `answer` to `"- Test answer\n- Do this **today**."`, and `answered_at` to an ISO time. Click **↻ Refresh**.
Expected: that row now shows a green **answered** pill, the answer rendered as a bullet list with "today" as an indigo pill, and an "answered …" meta.

- [ ] **Step 5: Checkpoint** — save (or commit `feat(nova-local): queued submit + queue render`).

---

## Task 4: Queued mode freshness — realtime + poll fallback

Adds a Supabase realtime subscription and a 30s poll so batch answers appear without a manual refresh.

**Files:**
- Modify: `nova-local.html`

- [ ] **Step 1: Add subscription + poll, guarded to run once**

In `wireQueued`, replace:

```javascript
    el('queueRefresh').addEventListener('click', refreshQueue);
  }
```

with:

```javascript
    el('queueRefresh').addEventListener('click', refreshQueue);
    startQueueSync();
  }
  var queueSyncStarted = false;
  function startQueueSync() {
    if (queueSyncStarted || !supa) return;
    queueSyncStarted = true;
    try {
      supa.channel('app_state_nova_questions')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.nova_questions' },
          function (payload) { if (payload && payload.new && payload.new.data) renderQueue(payload.new.data); })
        .subscribe();
    } catch (e) {}
    setInterval(function () { if (state.mode === 'queued') refreshQueue(); }, 30000);
  }
```

- [ ] **Step 2: Verify realtime update**

Open the page in queued mode (leave it open). In another window (Supabase Table Editor, or a second browser tab hitting the page and queuing), modify the `nova_questions` row so an item flips to `answered` with an `answer`.
Expected: the open page updates the pill to **answered** and shows the answer **within ~1–2 seconds, without clicking Refresh**. If realtime is disabled on the project, the 30s poll still updates it within 30s.

- [ ] **Step 3: Checkpoint** — save (or commit `feat(nova-local): realtime + poll queue sync`).

---

## Task 5: Live mode — chat + prompt port + generate call

Fills `/* == LIVE == */`, wires the chat composer, ports the batch's `buildQuestionPrompt`, and calls Ollama `/api/generate`.

**Files:**
- Modify: `nova-local.html`

- [ ] **Step 1: Add live logic**

Replace the line `  /* == LIVE == */` with:

```javascript
  /* == LIVE == */
  // Port of nova-batch/lib.mjs buildQuestionPrompt — keep in sync with the batch.
  var WARDROBE_PROMPT_MAX_CHARS = 2500;
  function buildLivePrompt(question, summaryText, wardrobeDescriptions) {
    var parts = [
      "You are Nova, a personal mentor living inside the user's life-tracking dashboard. " +
      "You are direct, warm and practical. Answer in a few short paragraphs at most, " +
      "and give the user something concrete to act on.",
      "",
      summaryText || "No dashboard context is available yet."
    ];
    var entries = Object.keys(wardrobeDescriptions || {}).map(function (k) { return wardrobeDescriptions[k]; });
    if (entries.length) {
      var block = "Wardrobe (" + entries.length + " catalogued items):\n";
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i] || {};
        var line = "- [" + (e.category || 'item') + "] " + (e.description || '') + "\n";
        if (block.length + line.length > WARDROBE_PROMPT_MAX_CHARS) { block += "- …more items omitted.\n"; break; }
        block += line;
      }
      parts.push("", block.replace(/\s+$/, ''));
    }
    parts.push(
      "",
      "Using the context above where relevant, answer the user's question. " +
      "If the context does not cover the question, say so briefly and answer from general knowledge.",
      "",
      "Question: " + question
    );
    return parts.join("\n");
  }
  async function askLive(question) {
    var ctx = state.ctx || {};
    var prompt = buildLivePrompt(question, ctx.summary_text, ctx.wardrobe_descriptions || {});
    var res = await fetch(OLLAMA + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TEXT_MODEL, prompt: prompt, stream: false, options: { temperature: 0.4, num_predict: 600 } }),
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
      var t = ''; try { t = await res.text(); } catch (e) {}
      if (res.status === 404 && /not found/i.test(t)) throw new Error('Model ' + TEXT_MODEL + ' not installed — run: ollama pull ' + TEXT_MODEL);
      throw new Error('Ollama HTTP ' + res.status);
    }
    var data = await res.json();
    var answer = (data && data.response ? String(data.response) : '').trim();
    if (!answer) throw new Error('Ollama returned an empty response.');
    return answer;
  }
  function addUser(t) { var e = document.createElement('div'); e.className = 'msg user'; e.innerHTML = '<div class="bubble">' + esc(t) + '</div>'; el('feed').appendChild(e); e.scrollIntoView({ block: 'end' }); }
  function addCoach(html) { var e = document.createElement('div'); e.className = 'msg coach'; e.innerHTML = '<div class="bubble"><span class="tag">Nova</span><div>' + html + '</div></div>'; el('feed').appendChild(e); e.scrollIntoView({ block: 'end' }); return e; }
  var liveBusy = false;
  function wireLive() {
    var input = el('liveInput'), send = el('liveSend');
    async function go() {
      var t = (input.value || '').trim(); if (!t || liveBusy) return;
      liveBusy = true; addUser(t); input.value = ''; setOrb('think');
      var loading = addCoach('<span class="dots"><i></i><i></i><i></i></span>');
      try {
        var answer = await askLive(t);
        loading.querySelector('.bubble div:last-child').innerHTML = renderMd(answer);
        setOrb('happy'); setTimeout(function () { setOrb(''); }, 2200);
      } catch (err) {
        loading.querySelector('.bubble div:last-child').innerHTML = renderMd('- ' + (err && err.message ? err.message : 'Could not reach Ollama.'));
        setOrb('');
      }
      liveBusy = false; input.focus();
    }
    send.addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }
```

- [ ] **Step 2: Wire live mode in `afterModeApplied`**

Replace:

```javascript
  var queuedWired = false;
  function afterModeApplied() {
    loadContext();
    if (state.mode === 'queued') {
      if (!queuedWired) { wireQueued(); queuedWired = true; }
      refreshQueue();
    }
  }
```

with:

```javascript
  var queuedWired = false, liveWired = false, greeted = false;
  function afterModeApplied() {
    loadContext();
    if (state.mode === 'queued') {
      if (!queuedWired) { wireQueued(); queuedWired = true; }
      refreshQueue();
    } else if (state.mode === 'live') {
      if (!liveWired) { wireLive(); liveWired = true; }
      if (!greeted) { addCoach('Hey — I’m <b>Nova</b>, running on your local model. Ask me about training, spending, your to-dos, or what to wear. I can see your dashboard context and wardrobe.'); greeted = true; }
    }
  }
```

- [ ] **Step 3: Verify live chat (Ollama running, page opened locally)**

Start Ollama with `qwen2.5:14b` pulled; open the page locally so the badge is **live**. Ask "What should I focus on today?".
Expected: your message appears right-aligned; the orb enters "think"; a Nova bubble replaces the dots with a rendered answer; orb briefly goes "happy". In DevTools → Network, confirm a `POST http://localhost:11434/api/generate` with body `model:"qwen2.5:14b"`, `stream:false`. No write to `nova_questions` occurs (check Supabase — queue unchanged).

- [ ] **Step 4: Verify error path**

Stop Ollama mid-session (without rechecking) and ask another question.
Expected: the Nova bubble shows a graceful "Could not reach Ollama." (or the model-missing hint), and the orb resets — no uncaught console error.

- [ ] **Step 5: Checkpoint** — save (or commit `feat(nova-local): live chat via local Ollama`).

---

## Task 6: Prompt-parity check against the tested batch logic

De-risks the `buildLivePrompt` port by proving it matches the already-unit-tested `buildQuestionPrompt` in `nova-batch/lib.mjs`. Uses a throwaway script in the scratchpad — **no repo file is added**.

**Files:**
- (temporary) scratchpad script only

- [ ] **Step 1: Write the parity script in the scratchpad**

Create `C:/Users/jaime/AppData/Local/Temp/claude/c--Users-jaime-Documents-Live-Dashboard-main/255a5810-af26-4714-81f2-e18a539a718e/scratchpad/parity.mjs`:

```javascript
import { buildQuestionPrompt } from 'c:/Users/jaime/Documents/Live_Dashboard-main/nova-batch/lib.mjs';

// Inline copy of the page's buildLivePrompt (must be character-identical in output).
const WARDROBE_PROMPT_MAX_CHARS = 2500;
function buildLivePrompt(question, summaryText, wardrobeDescriptions) {
  const parts = [
    "You are Nova, a personal mentor living inside the user's life-tracking dashboard. " +
    "You are direct, warm and practical. Answer in a few short paragraphs at most, " +
    "and give the user something concrete to act on.",
    "",
    summaryText || "No dashboard context is available yet."
  ];
  const entries = Object.keys(wardrobeDescriptions || {}).map((k) => wardrobeDescriptions[k]);
  if (entries.length) {
    let block = "Wardrobe (" + entries.length + " catalogued items):\n";
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] || {};
      const line = "- [" + (e.category || 'item') + "] " + (e.description || '') + "\n";
      if (block.length + line.length > WARDROBE_PROMPT_MAX_CHARS) { block += "- …more items omitted.\n"; break; }
      block += line;
    }
    parts.push("", block.replace(/\s+$/, ''));
  }
  parts.push(
    "",
    "Using the context above where relevant, answer the user's question. " +
    "If the context does not cover the question, say so briefly and answer from general knowledge.",
    "",
    "Question: " + question
  );
  return parts.join("\n");
}

const cases = [
  ['No wardrobe', 'What now?', 'Summary here.', {}],
  ['With wardrobe', 'What should I wear?', 'Summary here.',
    { a: { category: 'Shirt', description: 'Blue linen shirt.' }, b: { category: 'Jeans', description: 'Dark slim jeans.' } }],
  ['Empty summary', 'Hi', '', {}]
];
let ok = true;
for (const [name, q, s, w] of cases) {
  const mine = buildLivePrompt(q, s, w);
  const theirs = buildQuestionPrompt(q, s, w);
  const same = mine === theirs;
  if (!same) { ok = false; console.log('MISMATCH:', name); console.log('--- page ---\n' + mine); console.log('--- batch ---\n' + theirs); }
  else console.log('OK:', name);
}
console.log(ok ? '\nALL MATCH' : '\nDIFFERENCES FOUND');
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `node "C:/Users/jaime/AppData/Local/Temp/claude/c--Users-jaime-Documents-Live-Dashboard-main/255a5810-af26-4714-81f2-e18a539a718e/scratchpad/parity.mjs"`
Expected: `OK:` for all three cases and `ALL MATCH` (exit 0).

- [ ] **Step 3: If it differs, fix `buildLivePrompt` in `nova-local.html`**

If any case prints `MISMATCH`, adjust the page's `buildLivePrompt` string-building to match `buildQuestionPrompt` exactly (whitespace included), reload, and re-run until `ALL MATCH`. Then the live-mode prompt is guaranteed consistent with the batch's tested behavior.

- [ ] **Step 4: Checkpoint** — save. (Scratchpad script is temporary; nothing to commit.)

---

## Task 7: Navigation — add the Nova Local hub tile

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the tile after the Wardrobe tile**

In `index.html`, find the Wardrobe tile block (the small tile with `href="wardrobe.html"`, ending in its closing `</a>`) — it is the last `<a class="tile" ...>` before the `</div>` that closes `.bento`. Insert this immediately after that Wardrobe `</a>`:

```html
    <!-- Small tile -->
    <a class="tile" href="nova-local.html" style="--accent:#818CF8">
      <div class="tile-top">
        <span class="tile-num">·10</span>
        <span class="tile-emoji">💻</span>
      </div>
      <div class="tile-spacer"></div>
      <h2 class="tile-title">Nova Local</h2>
      <div class="tile-foot">
        <span class="tile-sub">Local AI · live or queued</span>
        <span class="tile-arrow">→</span>
      </div>
    </a>
```

- [ ] **Step 2: Verify the tile**

Open `index.html`. 
Expected: a new "Nova Local" tile (💻, indigo glow, `·10`, sub "Local AI · live or queued") appears after Wardrobe; the existing "Nova" tile (·07, 🧠) is unchanged. Click it → navigates to `nova-local.html`. Resize to phone width → tiles collapse correctly, no layout break.

- [ ] **Step 3: Checkpoint** — save (or commit `feat: add Nova Local hub tile`).

---

## Task 8: Final verification pass (spec coverage + regression)

**Files:** none (verification only)

- [ ] **Step 1: Spec coverage walkthrough**

Confirm each spec requirement, driving the page:
1. **Detection** — badge flips live↔queued on `/api/tags` reachability and via **recheck** (Task 1).
2. **Live mode** — direct `/api/generate` to `qwen2.5:14b` with `nova_context.summary_text` + wardrobe in the prompt; answer shown immediately, no queue write (Task 5).
3. **Queued mode** — form appends `pending` to `nova_questions`; queue shows status + answer; realtime + refresh + 30s poll (Tasks 3–4).
4. **Wardrobe visible in both modes** — accordion renders `wardrobe_descriptions` in live and queued (Task 2).
5. **Navigation** — labeled "Nova Local", distinct from "Nova"; hub tile (Task 7).
6. **Modularity** — self-contained page loading the shared chrome; direct Supabase for batch rows; no `sync.js` mis-use.

- [ ] **Step 2: Regression check — nothing forbidden was touched**

Confirm unchanged (open each; spot-check it still loads and behaves): `nova-lite.html` (still the ·07 "Nova" experience), `topbar.js`/bottom nav on other pages, and that `/nova-batch/` files are untouched. Only `nova-local.html` (new) and `index.html` (one tile) changed.

- [ ] **Step 3: Cross-mode + edge cases**

- Open with no `nova_context` and no `nova_questions` rows: queued shows empty queue; wardrobe shows empty state; first queued submit creates the `nova_questions` row.
- Open from the Vercel https URL: stays queued (CORS fallback), queue still works over https.
- Rapid double-submit in queued mode does not create malformed rows (button disables during write).

- [ ] **Step 4: Done**

All tasks complete and verified. If the user wants version control, run `git init` and commit the two changed files.

---

## Self-review notes (author)

- **Spec coverage:** detection (T1), live chat + prompt port (T5) + parity (T6), queued submit/render (T3) + freshness (T4), wardrobe both modes (T2), nav tile (T7), modularity/no-sync.js (T1). All spec sections map to a task.
- **Type/name consistency:** `state.ctx`, `state.mode`, `readRow`, `normalizeQuestionsDoc`, `renderQueue`, `renderMd`, `buildLivePrompt`, `afterModeApplied` are defined once and reused with identical names across tasks. `renderMd` is introduced in T3 (needed by queued answers) and reused in T5. `afterModeApplied` is progressively replaced (T1→T2→T3→T5) with each version shown in full.
- **No placeholders:** every code step shows complete code; every verify step states expected output.
- **TDD adaptation:** no browser test harness exists in this repo (pages are verification-driven); the one pure port is proven against the tested `nova-batch/lib.mjs` (T6). This is the honest local equivalent of red/green here.
