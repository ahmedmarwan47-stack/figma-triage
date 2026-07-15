# Figma comment triage

An external, self-firing version of the daily Figma comment triage — no Claude Code session required.

Every weekday at **14:00 Africa/Cairo** a cloud job:

1. **discovers** new unresolved Figma comments that mention you,
2. **classifies + drafts** each one with Claude (mechanical / creative / clarification / not-for-you),
3. posts a **Slack digest**, and
4. publishes **apply-ready jobs** that a companion **Figma plugin** turns into real edits on a `Claude Comments` page when you click Apply.

```
reporter/  ── GitHub Action, cron @ 14:00 Cairo (weekdays)
   discover (Figma REST) → classify+draft (Claude API) → Slack digest → jobs/latest.json
plugin/    ── Figma plugin, installed once
   fetches jobs/latest.json → applies drafted edits on a "Claude Comments" page
```

## Why it's split this way

Figma has **no REST API for creating design content** — an unattended job physically cannot draw into your file. So the cloud job only *drafts*; the plugin (which runs inside Figma, where the Plugin API can write) *applies*. Posting a **comment reply** is possible via REST, but that is never done automatically — replies are drafted into the digest and you post them yourself (or via the gated `reporter/reply-figma.mjs`).

## One-time setup

### 1. Put this in a GitHub repo
The repo can be **public** — it holds no secrets (those live in Actions secrets). The plugin fetches `jobs/latest.json` from the repo's raw URL.

### 2. Fill in `config.json`
- `figma.teamIds` — team IDs (the number in `figma.com/files/team/<ID>/…`); auto-discovers every file in the team. **or**
- `figma.fileKeys` — specific file keys (`figma.com/design/<KEY>/…`). Seeded with the El Alsson case-study file.
- `jobsBaseRawUrl` — replace `OWNER/REPO` with yours, e.g. `https://raw.githubusercontent.com/ahmed/figma-triage/main/jobs`.

### 3. Add three GitHub Actions secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:
- `FIGMA_TOKEN` — Figma → Settings → Security → Personal access tokens.
- `ANTHROPIC_API_KEY` — a Claude API key.
- `SLACK_WEBHOOK_URL` — see next step.

### 4. Slack incoming webhook
Create a private channel (e.g. `#figma-triage`), add the **Incoming Webhooks** app to it, copy the webhook URL → that's `SLACK_WEBHOOK_URL`. No scopes to manage.

### 5. Install the Figma plugin (once)
Figma desktop → menu → **Plugins → Development → Import plugin from manifest…** → pick `plugin/manifest.json`. It now lives in your plugins menu permanently. First run: paste your `jobsBaseRawUrl` into the plugin's field (it's remembered).

## Daily flow
1. The Action runs at 14:00 Cairo, posts the digest to Slack, commits `jobs/<date>.json` + `jobs/latest.json`.
2. Open the file in Figma → run **Claude Comments** → it auto-loads today's drafts for that file → **Apply all** (or per-card Apply). ~10 seconds.
3. For clarification comments, copy the drafted reply from Slack into the thread yourself.

## Run it locally
```bash
cd figma-triage
npm install
FORCE_RUN=1 FIGMA_TOKEN=… ANTHROPIC_API_KEY=… SLACK_WEBHOOK_URL=… npm run triage
```
`FORCE_RUN=1` bypasses the 2pm-Cairo and already-ran-today guards. Without `SLACK_WEBHOOK_URL` the digest prints to stdout.

Trigger the cloud job on demand: Actions → **Figma comment triage** → Run workflow → tick *force*.

## Post a drafted reply (gated, manual)
```bash
FIGMA_TOKEN=… node reporter/reply-figma.mjs <fileKey> <commentId> "your reviewed reply"
```

## Extending what the plugin can apply
The op vocabulary is defined in **two places that must stay in sync**: the prompt in `reporter/llm.mjs` (what Claude may emit) and the interpreter in `plugin/code.js` (what actually runs). Current ops: `duplicateTarget`, `setText`, `setFillStyle`, `setTextStyle`, `removeNode`, `cloneNode`. Add a new op to both.

## DST note
GitHub cron is UTC-only, so the workflow fires at both 11:00 and 12:00 UTC (bracketing Cairo's summer/winter offset) and the reporter's local-hour guard runs the work exactly once, at 14:00 Cairo.
