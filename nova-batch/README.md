# Nova batch processor (local only — never deployed to Vercel)

A Node script that runs on the PC with the 24 GB GPU, on a Windows Task Scheduler
interval. Each run it:

1. **Wardrobe photos** — for any item in `app_state` row `wardrobe` without a cached
   description (or whose `photo_paths` changed), downloads the photo(s) from the public
   `wardrobe-photos` bucket, asks the vision model (`qwen2.5vl:7b`) for a plain-text
   description, and caches it on the item (`description` + `described_photos`). Items
   whose photos haven't changed are never re-analyzed. Max 10 items per run
   (`NOVA_MAX_PHOTO_ITEMS`); the rest queue for the next run.
2. **Context summary** — reads `finance_transactions`, `workout_log` and `goals`, builds
   a concise text summary (spending by category last 30 days, workout frequency last
   4 weeks, open to-dos with tags) and writes it to `app_state` row **`nova_context`**:
   `{ summary_text, wardrobe_descriptions, last_updated }`. This step is plain string
   building — the data is already structured, so an LLM would only add latency and
   made-up numbers.
3. **Queued questions** — reads `app_state` row **`nova_questions`**
   (`{ queue: [{ id, question, status: 'pending'|'answered', answer, asked_at, answered_at }] }`),
   answers each `pending` question with `qwen2.5:14b` using the context summary,
   writes the answer back and flips the status. Strictly one question at a time.

Data contract: **reads** `wardrobe`, `finance_transactions`, `workout_log`, `goals`;
**writes** `wardrobe` (description fields only), `nova_context`, `nova_questions`.
Nothing else is touched. All rows are optional — missing/empty rows are skipped
gracefully, so it's safe to run before the wardrobe or training modules have data.

## Files

| File | What it is |
|---|---|
| `index.mjs` | The processor. `node index.mjs` runs everything once. `--dry-run` = read + call Ollama but write nothing. |
| `lib.mjs` | Pure logic (summaries, cache keys, prompts) — no network. |
| `lib.test.mjs` | Unit tests: `node --test` (run from this folder). |
| `run-nova-batch.ps1` | Wrapper Task Scheduler calls: finds node, logs, forwards the exit code. |
| `logs/` | Created at runtime. `nova-batch-YYYY-MM-DD.log` (script) + `wrapper-YYYY-MM-DD.log` (wrapper). Pruned after 30 days. Gitignored. |

## Requirements

- Node 18+ (uses built-in `fetch`; no npm install needed — zero dependencies).
- Ollama reachable at `http://localhost:11434` with `qwen2.5vl:7b` and `qwen2.5:14b`
  pulled. If a model is missing the log says exactly which `ollama pull` to run.

## Configuration (env vars, all optional)

| Variable | Default |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | The project URL/key hardcoded in `sync.js` |
| `SUPABASE_SERVICE_ROLE_KEY` | unset — **required once RLS requires sign-in** (the anon key can no longer read/write `app_state`); set it in the Task Scheduler environment, never commit it |
| `OLLAMA_URL` | `http://localhost:11434` |
| `NOVA_VISION_MODEL` | `qwen2.5vl:7b` |
| `NOVA_TEXT_MODEL` | `qwen2.5:14b` |
| `NOVA_MAX_PHOTO_ITEMS` | `10` per run |
| `NOVA_LOG_DIR` | `nova-batch/logs` |

## Crash safety / idempotency

- A question's answer, status and `answered_at` are written in **one** upsert onto a
  freshly re-read row. Crash before the write → still `pending`, re-answered next run.
  Crash after → `answered`, skipped. Never double-marked or lost.
- Wardrobe descriptions are written the same way: re-read, patch one item, write. If an
  item was deleted or its photos changed while the model was thinking, the stale
  description is discarded.
- A lock file (`.nova-batch.lock`, auto-expires after 60 min) stops overlapping runs.
- Any phase failing is logged loudly and the run continues to the next phase; the
  process exits non-zero so Task Scheduler's *Last Run Result* shows the failure.

## Task Scheduler setup (every 15 minutes)

### Option A — one PowerShell command (recommended)

Open **PowerShell as your normal user** (no admin needed) and paste:

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\jaime\Documents\Live_Dashboard-main\nova-batch\run-nova-batch.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Nova Batch Processor' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Wardrobe photo analysis + Nova context + queued questions via local Ollama.'
```

That's it — it starts within a minute and repeats every 15 minutes. Useful commands:

```powershell
Start-ScheduledTask   -TaskName 'Nova Batch Processor'   # run right now
Get-ScheduledTaskInfo -TaskName 'Nova Batch Processor'   # last run time + result (0 = ok)
Unregister-ScheduledTask -TaskName 'Nova Batch Processor' -Confirm:$false   # remove
```

### Option B — Task Scheduler GUI

1. Start menu → **Task Scheduler** → right panel **Create Task…** (not "Basic Task").
2. **General** tab: Name `Nova Batch Processor`. Leave "Run only when user is logged on"
   selected (simplest; Ollama/Docker runs in your session anyway).
3. **Triggers** tab → New… → Begin the task **On a schedule**, **One time**, starting now.
   Tick **Repeat task every:** `15 minutes`, **for a duration of:** `Indefinitely` → OK.
4. **Actions** tab → New… →
   - Program/script: `powershell.exe`
   - Add arguments:
     `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\jaime\Documents\Live_Dashboard-main\nova-batch\run-nova-batch.ps1"`
5. **Settings** tab: tick **Run task as soon as possible after a scheduled start is
   missed**; set **Stop the task if it runs longer than:** `1 hour`; at the bottom choose
   **Do not start a new instance**.
6. OK to save. Right-click the task → **Run** to test, then check
   `nova-batch\logs\` for today's log files.

> Every 15 min is fine: runs with nothing to do finish in ~2 s and only touch
> `nova_context`. If the PC is asleep the run is skipped (or catches up once, with
> "run after missed start" enabled).

## Notes / limitations

- The dashboard syncs whole rows last-write-wins. If the wardrobe page is open **and
  actively editing** at the exact moment a description is written, one side can
  overwrite the other; the processor minimizes the window by re-reading immediately
  before each small write, and a lost description simply regenerates next run.
- The `nova_questions` row is created empty on first run. The dashboard UI that queues
  questions into it (and shows answers) is a separate, future piece — until then you
  can inspect answers in Supabase → Table Editor → `app_state` → `nova_questions`.
- First vision call after idle is slow (model loads into VRAM); later calls are fast.
