# Figma comment triage

An external, self-firing Figma comment triage — no Claude Code session required for the daily runs.

Every weekday at **14:00 Africa/Cairo** a cloud job discovers new unresolved Figma comments, classifies + drafts a response to each with Claude, posts a **Slack digest**, and publishes **apply-ready jobs** that a companion **Figma plugin** executes on a `Claude Comments` page with one click per edit. Ambiguous comments become two-way Slack threads: reply in Slack to either clarify to Claude (re-triage) or post your reply into the Figma thread.

```
reporter/        GitHub Action, cron @ 14:00 Cairo (weekdays), also workflow_dispatch (force)
   discover (Figma REST) → classify+draft (claude CLI) → Slack digest → jobs/latest.json
plugin/          Figma plugin "Claude Comments", installed once, confirm-then-apply
   fetches jobs/latest.json → Apply buttons execute drafted ops on a "Claude Comments" page
worker/          Cloudflare Worker (two-way Slack bridge)  ⚠️ NOT YET DEPLOYED — see Status
   Slack thread reply → clarifications/<id>.json + re-triage  |  "figma:" prefix → posts reply in Figma thread
clarifications/  written by worker, consumed + deleted by reporter
jobs/            per-day triage output + latest.json (the plugin's feed)
```

## Why it's split this way
Figma has **no REST API for creating design content** — an unattended job physically cannot draw into a file. So the cloud job only *drafts*; the plugin (running inside Figma, where the Plugin API can write) *applies*. The only REST write that exists is posting a comment reply — used exclusively for text the user typed themself (the `figma:` route), never for model-drafted content.

## How comments are classified
Claude triages each unresolved comment into exactly one category (prompt in `reporter/llm.mjs`; biased toward mechanical — quoted text is authoritative, no second-guessing user wording):

- **mechanical** — clear action + clear target → a job of declarative ops, one Apply in the plugin.
- **creative** — needs visual judgment → 2–3 direction options, **each compiled to its own op list** (10–40 ops for a recolor is normal) with its own Apply button; each lands on its own labeled clone for side-by-side comparison. An `aiPrompt` for Figma's native AI ships as an *alternative* route, and is the only route when ops can't express the direction (option ships `ops: []`).
- **clarification** — truly ambiguous → posted to Slack as its own threadable "❓ Needs your input" message (bot transport only). Reply plain to clarify to Claude → auto re-triage; reply `figma: <text>` to post `<text>` into the Figma comment thread.
- **not_for_ahmed** — flagged and skipped.

## Op vocabulary (MUST stay in sync in two places)
Prompt in `reporter/llm.mjs` (what Claude may emit) ↔ interpreter in `plugin/code.js` (`runOps`, what executes):
`duplicateTarget`, `setText`, `setFillStyle`, `setFillColor` (hex fallback when no local style fits), `setTextStyle` (textStyleName / colorStyleName independently optional), `removeNode`, `cloneNode`.
Add any new op to **both** files.

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

## Test findings 2026-07-17 (READ FIRST next session)

Ahmed added a new comment set to the Wellth file (which **has real local text
+ color styles**) to test style-awareness. That run (`27ba575`) exposed two things:

1. **Every LLM call failed** — `claude exited 1` (empty stderr) on all 8
   comments, all retries. Almost certainly the Claude **subscription hit a
   rate/usage limit** after ~16 heavy test runs that day (or a transient
   outage). All 8 degraded to the error-fallback "clarification", and the run
   **overwrote the good jobs file with garbage + advanced state.** That data
   loss is now prevented (see below) but the run itself proves nothing about
   styles — **re-run first thing next session when the limit has reset.**

   Mitigation shipped: `classifyAndDraft` marks the fallback `_autoFailed`, and
   `main()` now **aborts (exit 1, no write, no state advance) if every
   processed comment auto-failed** — a Claude outage can no longer clobber the
   record. Partial failures still publish the ones that succeeded. The good
   jobs data was restored from `main` and `state.json` rewound to 2026-07-15 so
   the next run reprocesses the new comments.

2. **Style discovery STILL logs `0 paint, 0 text`** at file level even though
   Wellth has styles. Root cause understood: `/v1/files/:key/styles` lists
   only *published* styles (Wellth's are local/unpublished → 0), and
   `/v1/files/:key?depth=1` truncates the document so its top-level `styles`
   map is empty. The **node-scoped path** (`getNode` → per-subtree `styles`
   map, merged into `threadStyles` in `index.mjs`) is the reliable source and
   is wired in — but it was never verified because every LLM call died. New
   logging (`[figma] node <id> styles: N paint, M text → …available to Claude`)
   will confirm it on the next successful run. **If node-scoped still returns
   0**, the fallback is to fetch the file at full depth (large but correct) or
   read the `styles` map from the already-fetched node subtree document.

**First action next session:** reset `state.json` (already done → 2026-07-15),
dispatch the workflow with force, and check the log for the new
`[figma] node … styles` line + whether mechanical/creative drafts reference
Wellth's real style names. Then continue the complex-comment testing.

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
- **Branches:** development happened on `claude/tool-dev-markdown-files-f1716j`, fast-forwarded into `main` after each verified run. `main` is the source of truth; the plugin fetches `jobs/latest.json` from `main`'s raw URL.
- **Trigger a run:** Actions → "Figma comment triage" → Run workflow → force. To re-scan already-processed comments first reset `reporter/state.json` to `{ "lastRunAt": null, "lastRunDate": null }` (the run commits new state + jobs back — pull before continuing).
- **Local run:** `FORCE_RUN=1 FIGMA_TOKEN=… npm run triage` (prints digest to stdout without Slack vars).
- **Plugin changes** must be re-imported by Ahmed in Figma desktop — send him `plugin/code.js` / `ui.html` after edits.
- The user is Ahmed, a freelance web/UI designer (design principles are embedded in the `llm.mjs` system prompt: auto layout everywhere, styles by name never hex, 12px floor, first-person past-tense voice, banned buzzwords).

## Post a drafted reply manually (gated)
```bash
FIGMA_TOKEN=… node reporter/reply-figma.mjs <fileKey> <commentId> "your reviewed reply"
```
