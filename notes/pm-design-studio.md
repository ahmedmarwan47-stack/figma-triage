# Recon: Mitch PM design-studio (`pm.mitchdesigns.com/design-studio`)

> Fill this in from a **local** `claude` session (see README → "OPEN TASK — evaluate Mitch's
> PM as a comment source"). READ-ONLY recon — capture, never change anything in the PM.
> Put screenshots alongside this file in `notes/`. Do NOT commit any PM token/credential.

## 1. What design-studio does
- Overview (what the page shows, what it's for):
- Whole-team file list? (how files are listed, can we enumerate them):
- Real-time open/resolved comment sync — how it presents (per file? one feed?):

## 2. Per-comment data available
- Open vs resolved state shown? how fresh (real-time?):
- Assignee / "primary designer" per comment? (the signal a comment is Ahmed's):
- Fields visible per comment (author, file, node/frame link, text, timestamps, thread):
- Maps back to a Figma comment id / file key?:

## 3. Integration surface (the important part)
- API / Developer / API-keys / Integrations / Webhooks page exists? URL:
- Endpoints seen (paths, methods):
- Auth style (session cookie only? bearer token? API key header?):
- Real-time push? (webhook / SSE / websocket) — how to subscribe:
- Any export (CSV/JSON) of files or comments:

## 4. Verdict — what's worth wiring into the triage pipeline
- Replace `config.json → fileKeys` with the team file list? (feasible? how):
- Replace REST-heuristic "is this Ahmed's / still open" with the PM's assignment + resolved feed?:
- Trigger triage on a new/unresolved comment (event-driven) vs the daily poll?:
- Blockers (auth, needs host allowlisted in the cloud env, needs a token, paid tier):

## Screenshots
- (list the screenshot files you saved in notes/)
