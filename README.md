# Figma comment triage

An external, self-firing Figma comment triage — no Claude Code session required for the daily runs.

Every weekday at **14:00 Africa/Cairo** a cloud job discovers new unresolved Figma comments, classifies + drafts a response to each with Claude, posts a **Slack digest**, and publishes **apply-ready jobs** that a companion **Figma plugin** executes on a `Claude Comments` page with one click per edit. Ambiguous comments become two-way Slack threads: reply in Slack to either clarify to Claude (re-triage) or post your reply into the Figma thread.

A **web dashboard** (`dashboard/index.html`, deployed to GitHub Pages) sits on top of all this: monitor every run, trigger triage on demand, and clarify-to-Claude or reply-in-Figma per comment — from any machine you're signed into GitHub on. See [Dashboard](#dashboard-dashboardindexhtml).

```
reporter/        GitHub Action, cron @ 14:00 Cairo (weekdays), also workflow_dispatch (force)
   discover (Figma REST) → classify+draft (claude CLI) → Slack digest → jobs/latest.json
plugin/          Figma plugin "Claude Comments", installed once, confirm-then-apply
   fetches jobs/latest.json → Apply buttons execute drafted ops on a "Claude Comments" page
worker/          Cloudflare Worker (two-way Slack bridge)  ⚠️ NOT YET DEPLOYED — see Status
   Slack thread reply → clarifications/<id>.json + re-triage  |  "figma:" prefix → posts reply in Figma thread
clarifications/  written by worker, consumed + deleted by reporter
jobs/            per-day triage output + latest.json (the plugin's feed)
dashboard/       read-only web dashboard over jobs/ + state.json + config.json (see Dashboard)
```

## Why it's split this way
Figma has **no REST API for creating design content** — an unattended job physically cannot draw into a file. So the cloud job only *drafts*; the plugin (running inside Figma, where the Plugin API can write) *applies*. The only REST write that exists is posting a comment reply — used exclusively for text the user typed themself (the `figma:` route), never for model-drafted content.

## How comments are classified
Claude triages each unresolved comment into exactly one category (prompt in `reporter/llm.mjs`; biased toward mechanical — quoted text is authoritative, no second-guessing user wording):

- **mechanical** — clear action + clear target → a job of declarative ops, one Apply in the plugin.
- **creative** — needs visual judgment → 2–3 direction options, **each compiled to its own op list** (10–40 ops for a recolor is normal) with its own Apply button; each lands on its own labeled clone for side-by-side comparison. An `aiPrompt` for Figma's native AI ships as an *alternative* route, and is the only route when ops can't express the direction (option ships `ops: []`).
- **clarification** — truly ambiguous → posted to Slack as its own threadable "❓ Needs your input" message (bot transport only). Reply plain to clarify to Claude → auto re-triage; reply `figma: <text>` to post `<text>` into the Figma comment thread.
- **not_for_ahmed** — flagged and skipped.

## Which comments a run scans (date range)
By default a run scans comments with activity **since the last run's cursor**
(`reporter/state.json → lastRunAt`; ~24 h on a fresh state via
`config.json → lookbackHoursFirstRun`) — the daily cadence. You can override the
window for an on-demand run to re-scan **older** comments, via `workflow_dispatch`
inputs on `triage.yml` (mapped to env vars read in `reporter/index.mjs →
resolveWindow`):
- **`lookback_days`** = N → the last N **Cairo** days (`1` = today only, `2` =
  today + yesterday, …).
- **`since`** / **`until`** = `YYYY-MM-DD` (Cairo, whole day inclusive) or an ISO
  timestamp → an explicit range. `since` overrides `lookback_days`; `until` blank
  means now. Locally: `TRIAGE_LOOKBACK_DAYS` / `TRIAGE_SINCE` / `TRIAGE_UNTIL`.

Any of these **implies force** (bypasses the 2 pm-Cairo / already-ran-today
guards) and, crucially, **does NOT advance `state.json`** — an ad-hoc scan of
older comments must not move the daily cursor forward, or the next scheduled run
would skip everything in between. It still writes `jobs/<date>.json` +
`latest.json` so the drafts reach the plugin. The dashboard's **Run triage now**
button opens a small picker (Since last run / Today only / Today & yesterday /
Last N days / Custom range) that fills these inputs.

## Op vocabulary (MUST stay in sync in two places)
Prompt in `reporter/llm.mjs` (what Claude may emit) ↔ interpreter in `plugin/code.js` (`runOps`, what executes):
`duplicateTarget`, `setText`, `setFillStyle`, `setFillColor` (hex fallback when no local style fits), `setTextStyle` (textStyleName / colorStyleName independently optional), `removeNode`, `cloneNode` (`count` clones for galleries), `resizeNode` (`width`/`height` or `scale`), `setLayout` (auto-layout `mode` / `itemSpacing` / `layoutWrap` / `padding` — grid = HORIZONTAL + WRAP).
Add any new op to **both** files. The layout/sizing ops (`resizeNode`, `setLayout`, `cloneNode count`) exist so creative directions like "make the photos bigger", "gallery of photos", and section re-flows compile to real ops and apply with one click instead of degrading to an aiPrompt.

## Context Claude gets per comment (all in `reporter/llm.mjs` + `index.mjs`)
- Text-layer inventory of the commented node, **sorted by distance to the comment pin** (computed from `client_meta.node_offset` + bounding boxes) with each layer's ancestor chain (`inside: "Hero Form"(FRAME) → "Button"(FRAME)`) so container fills target the frame, not the label text.
- Local paint/text style names — file-level plus **node-scoped styles from the nodes endpoint** (the only REST source that surfaces unpublished local styles; `/v1/files/:key/styles` lists published only, and the file-level `styles` map is truncated by `?depth`). A sanitizer strips any op referencing a nonexistent style before publishing.
- Thread replies, plus any consumed Slack clarification as a pseudo-reply.
- Slack screenshots use the **smallest frame containing the pin** (`pickImageNode`), not the whole page.

## Plugin behavior (`plugin/`)
- Confirm-then-apply only. No polling, no auto-apply (deliberately removed).
- One container clone **per target node** — multiple mechanical comments on the same frame stack into one clone; per-comment idempotency via plugin-data (`Already applied` toast on re-click). Apply calls are **serialized through a queue** (concurrent applies used to race and duplicate containers).
- Creative: one Apply per direction, dedup per comment+option.
- "Apply all" = mechanicals only.
- Cross-file inbox: "Other files with pending drafts" panel lists other files' draft counts with open links.
- After editing plugin files, **re-import** in Figma (Plugins → Development → Import plugin from manifest…).

## Reliability measures (hard-won, don't remove)
- `claude` CLI: `/dev/null` stdin (hangs on non-TTY pipe otherwise), 3 attempts with backoff (transient exit-1 with empty stderr happens in CI).
- Figma REST: 429s retried honoring `Retry-After` (image renders trip rate limits routinely).
- Workflow: cron fires 11:00 + 12:00 UTC to bracket Cairo DST; a local-hour guard in `index.mjs` runs the work exactly once. `git pull --rebase` before push (worker clarification commits can land mid-run).

## Secrets (repo → Settings → Secrets and variables → Actions)
- `FIGMA_TOKEN` — Figma PAT (expires! a run failing with `403 Token expired` means re-mint + update).
- `CLAUDE_CODE_OAUTH_TOKEN` — from `claude setup-token`; draws on the Claude subscription, no metered API.
- `SLACK_WEBHOOK_URL` — legacy one-way transport (fallback).
- `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` — bot transport; **required** for the clarification loop. ⚠️ Not yet added (see Status).

## Test findings 2026-07-17/18 (READ FIRST next session)

Tested 8 genuinely complex comments on the Wellth file (which **has real local
styles**). Run `1a007e6` is the clean result. What we learned:

**What works well ✅**
- **Node-scoped style discovery works.** File-level fetch still logs
  `0 paint, 0 text` (Wellth's styles are unpublished + `?depth=1` truncates the
  doc), but the per-node path surfaces them: `[figma] node 40:723 styles: 1
  paint, 0 text → 1/0 available to Claude`. Claude sees the styles used in the
  commented subtree — which is what it needs. **Leave the file-level 0/0 log
  alone; it's expected and harmless.**
- **Light-mode creative compiled to 21 real ops** (+10, +11 for the other two
  directions) — the plugin-executable creative path holds up on a full recolor.
- **Honest degradation, not hallucination.** "black gradient overlay should
  follow the same style as the section below" → clarification (couldn't find a
  gradient node or identify "section below"). "add a statement 'Mountain View
  Hospitality'" → clean mechanical duplicate+setText. The classifier reasons
  about targets it can/can't resolve instead of faking edits.

**Concrete gaps found (next-session work) ⚠️**
1. **No resize/scale op.** "I need the photos a little bit bigger" is
   mechanical in spirit but degraded to clarification because the op vocabulary
   can't resize a node. **Add a `resize`/`scale` op to BOTH `reporter/llm.mjs`
   (prompt) and `plugin/code.js` (`runOps`)** — highest-value gap.
2. **Layout/creation directions produce 0 ops** (gallery-of-photos,
   photo-layout, button-repositioning). These need creating/duplicating/moving
   nodes that the current ops can't express, so they fall back to aiPrompt
   (correct, but not one-click). A `duplicateInto`/`appendClone`/reflow op set
   would make some of these applyable; others genuinely need Figma AI.
3. **Reliability guard shipped and untested-in-anger.** A total-LLM-outage run
   earlier (`27ba575`, Claude subscription rate-limit after ~16 heavy runs that
   day) had overwritten the good jobs file with 8 garbage clarifications.
   `main()` now **aborts (exit 1, no write, no state advance) when every
   processed comment auto-failed** (`verdict._autoFailed`); partial failures
   still publish. If you hammer it again and hit the rate limit, expect a red
   run that leaves data intact — that's correct.

**Process gotcha for the operator:** a rebase once silently dropped a
`state.json` rewind, so a run processed 0 comments (cursor sat past the new
batch). After editing `reporter/state.json`, `git show HEAD:reporter/state.json`
to confirm the commit actually holds the value before dispatching.

## Status as of 2026-07-18 (dashboard shipped)
**New: a full web dashboard + control surface** (`dashboard/index.html`, documented below)
is built, verified in Chromium (light + dark), and **deployed to GitHub Pages** via
`.github/workflows/pages.yml` → `https://ahmedmarwan47-stack.github.io/figma-triage/`
(enable once: Settings → Pages → Source = GitHub Actions). It's a single self-contained file —
no build, no deps, no committed secrets.

What it adds on top of the pipeline:
- **Monitoring** — status strip, stat tiles, per-run activity chart, and a filterable inbox of
  every triaged comment (mechanical ops as readable steps, creative directions, clarifications).
- **Theme toggle** — System / Light / Dark, remembered per browser.
- **Live actions from the browser** — *Run triage now* (dispatches `triage.yml` and opens a
  dedicated **run page** that watches the run and shows its drafts), plus a per-comment
  *Reply / clarify* composer (*Send to Claude* re-triages via a committed `clarifications/<id>.json`;
  *Post in Figma* posts your reply through the new `figma-reply.yml` workflow). These use a
  fine-grained **GitHub token the user pastes once, stored only in that browser**; the Figma
  token stays server-side in Actions secrets. No token → each button falls back to GitHub's own
  UI, so it still works on any machine you're signed into.
- **This collapses most of the un-deployed worker's job into the page.** The worker (Slack
  two-way loop) is still optional and still works in parallel if/when deployed.

Still true from before: applying drafts happens only in the Figma plugin; `config.json →
figma.includeAllUnresolved` is still `true` (test mode — flip to `false` for mention-only).

## Status as of 2026-07-17 (pause point)
**Working and verified end-to-end:** daily discovery → classification → digest (webhook transport) → plugin applies for mechanical AND creative directions; spatial pin targeting; style-aware ops; clarification messages formatted (bot transport code in place).

**Pending — the worker is written but NOT deployed** (`worker/index.js` complete, syntax-checked; Ahmed will deploy from his Mac):
1. `cd worker && wrangler login && wrangler deploy`, then `wrangler secret put` × 4: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `GITHUB_TOKEN` (fine-grained PAT: Contents r/w + Actions r/w), `FIGMA_TOKEN`. Values exist in the Slack app config / token pages; the ones shared in the 2026-07-17 session transcript should be **rotated after deploy**.
2. Slack app (already created, scopes `chat:write`, `channels:history`, `groups:history`, `reactions:write` + needs **`im:history`** since the chosen channel `D…` is the app DM): enable App Home **Messages Tab**, then Event Subscriptions → Request URL `https://<worker-url>/slack/events` → bot event **`message.im`** → Save.
3. Add repo secrets `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` (the D… id).
4. Test: dispatch the workflow with force, reply to a "❓ Needs your input" thread both ways.

**Also outstanding:**
- `config.json` → `figma.includeAllUnresolved` is still `true` (test mode). Flip to `false` for mention-only triage.
- Annotations: no REST endpoint exists (`/v1/files/:key/annotations` → 404, verified). If wanted, the path is plugin-side reading of `figma.annotations` POSTed to the worker.
- Possible next upgrades discussed: Figma `FILE_COMMENT` webhooks into the worker for near-real-time triage (needs paid team plan); batching all comments into one claude call per run (token efficiency).

## For the next Claude Code session
- **Branches:** the daily pipeline work happened on `claude/tool-dev-markdown-files-f1716j`; the
  dashboard + Pages deploy + live actions landed on `claude/dashboard-build-features-na7kfp`
  (PRs #1–#3, all merged). `main` is the source of truth — the plugin fetches `jobs/latest.json`
  from `main`'s raw URL, and GitHub Pages deploys `dashboard/` from `main`.
- **Trigger a run:** the dashboard's **Run triage now** (with a token connected) — its picker also
  chooses the date range — or Actions → "Figma comment triage" → Run workflow → force (with optional
  `lookback_days` / `since` / `until`). To re-scan **older** comments prefer a date-range run (see
  [Which comments a run scans](#which-comments-a-run-scans-date-range)) — it leaves `state.json`
  untouched. Resetting `reporter/state.json` to `{ "lastRunAt": null, "lastRunDate": null }` still
  works to rewind the daily cursor itself (the run commits new state + jobs back — pull before continuing).
- **Local run:** `FORCE_RUN=1 FIGMA_TOKEN=… npm run triage` (prints digest to stdout without Slack vars).
  Add `TRIAGE_LOOKBACK_DAYS=2` (or `TRIAGE_SINCE=…` / `TRIAGE_UNTIL=…`) to scan a specific date range.
- **Plugin changes** must be re-imported by Ahmed in Figma desktop — send him `plugin/code.js` / `ui.html` after edits.
- The user is Ahmed, a freelance web/UI designer (design principles are embedded in the `llm.mjs` system prompt: auto layout everywhere, styles by name never hex, 12px floor, first-person past-tense voice, banned buzzwords).

## Dashboard (`dashboard/index.html`)
A single self-contained HTML file (no build, no deps, no secrets) that gives a read-only
view over everything the pipeline publishes:

- **Status strip** — last run (Cairo time), next scheduled run, cursor from `reporter/state.json`,
  watched-file count, and a ⚠ banner while `config.json → figma.includeAllUnresolved` is true.
- **Stat tiles** — pending drafts in `jobs/latest.json`, open clarifications, all-time comments
  triaged, ops drafted.
- **Activity chart** — comments per run day stacked by category, with tooltips and a table view.
  Clicking a bar filters the inbox to that run.
- **Inbox** — every triaged comment grouped by file, filterable by run / category / file / free
  text (filters sync to the URL hash, so views are shareable). Mechanical cards show the drafted
  ops as readable steps; creative cards show each direction with its op count and a
  **Copy AI prompt** button; clarification cards show the drafted reply. "Pending in plugin"
  marks what `latest.json` is currently serving to the plugin.
- **Theme toggle** — System / Light / Dark, remembered per browser (stamps `data-theme`, wins
  over the OS setting both ways).
- **Live actions** — a **Run triage now** button (opens a date-range picker — *Since last run* /
  *Today only* / *Today & yesterday* / *Last N days* / *Custom range* — before dispatching) and, on
  every comment, a **Reply / clarify**
  composer: *Send to Claude* re-triages that comment with your note (writes
  `clarifications/<id>.json` + dispatches the workflow, exactly like the Slack route);
  *Post in Figma* replies as you in the thread (via the `figma-reply.yml` workflow, so
  `FIGMA_TOKEN` stays in Actions secrets). See **Live actions & auth** below.
- **Run page** — hitting *Run triage now* opens a dedicated run view that watches the
  workflow (polling `main`'s `latest.json` for a fresh `generatedAt`, plus the Actions run
  status when a token is connected) and, when it lands, shows a per-category summary and
  exactly the drafts that run produced. Back returns to the dashboard with the new run merged in.

**How to open:** it works from anywhere — double-click the file (it then reads `main` via
`raw.githubusercontent.com`), serve the repo root (`npx serve` / `python3 -m http.server` →
`/dashboard/`, reads the local checkout), or use the deployed **GitHub Pages** site
(`.github/workflows/pages.yml` publishes `dashboard/` + data to
`https://<owner>.github.io/figma-triage/`; enable once via Settings → Pages → Source =
GitHub Actions). `?repo=owner/name` overrides the source repo.

### Live actions & auth
A static page can't hold secrets, so the action buttons authenticate with a **GitHub token
the user pastes once** ("Connect GitHub"), stored **only in that browser's localStorage**,
scoped to this repo (fine-grained: *Actions* r/w + *Contents* r/w). With it connected:
Run triage dispatches `triage.yml`; *Send to Claude* commits a clarification and re-triages;
*Post in Figma* dispatches `figma-reply.yml` (which runs `reporter/reply-figma.mjs` with the
repo's `FIGMA_TOKEN` — the Figma token never touches the browser). **Without a token**, each
button falls back to GitHub's own UI / copy-to-clipboard, so the dashboard still works on any
machine you're signed into GitHub on. Applying drafts still happens only in the Figma plugin.
This collapses most of the un-deployed worker's job into the page; the Slack two-way loop
still works in parallel if/when the worker is deployed.

## Post a drafted reply manually (gated)
```bash
FIGMA_TOKEN=… node reporter/reply-figma.mjs <fileKey> <commentId> "your reviewed reply"
```
