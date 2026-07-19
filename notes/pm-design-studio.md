# Recon: Mitch PM design-studio (`pm.mitchdesigns.com/design-studio`)

Done from a **local** `claude` session on Ahmed's Mac, 2026-07-19, signed into the PM in his own
browser. READ-ONLY: no create/edit/resolve/delete actions were taken. No PM token/credential is
committed here (see "Auth" below — the session value stays in the browser only).

> ⚠️ **This repo is public.** The board shows real client names, internal comments, and task data.
> Screenshots were intentionally **not** committed to avoid leaking client data to a public repo.
> One local screenshot was captured for Ahmed's reference only. If we ever want visuals in-repo,
> redact first, or move this whole recon to a private repo.

## TL;DR — verdict
The PM **already does, server-side, everything the reporter's Figma-REST layer does by hand** — and
does it better: whole-team file discovery, mention→person resolution, and open/resolved tracking, all
exposed as clean JSON behind a bearer token. This is a strong candidate to **replace `config.json →
fileKeys` and the REST heuristics** with a single `GET /api/design-tasks` call. The one thing it does
**not** give us is real-time push (no webhook/SSE/websocket) — freshness is poll + a manual "Sync
Figma" button — so event-driven triage is not available today; we'd still poll, just against the PM
instead of Figma REST.

---

## 1. What design-studio does
- **Overview:** A kanban board — "Every design task for the team — support issues and in-build tasks
  you're assigned to, plus tasks you add here." Four columns: **Design backlog** (55), **Design in
  progress** (16), **Delivered to dev** (8), **Resolved / Closed on Figma** (118). Header count "80",
  "197 shown". An "Intense mode · 79" badge.
- **Whole-team file list:** Yes — a client filter enumerates all 14 clients with stable ids, e.g.
  `Axton Robotics` = `cl-a9cd1485`, `CIFC` = `cli-412e3a3e`, `Mountain View EG` = `cli-86d748cd`,
  `Rihlati` = `cli-b90fc0b0`, `Mitch Designs Co.` = `cl-9c3f0760`, `FAM Beef` = `cl-fambeef`,
  `NTG` = `cl-ntg`, `Kemetland` = `cl-0e0533e4`, `Geely` = `cli-cf8c25dc`, `Tank` = `cli-0996110e`,
  `Alsson School (New)` = `cli-d7658e9a`, `Biography` = `cli-18db2ecf`, `Ecral` = `cli-65fbced5`,
  `ICAUR (Ghabbour Auto)` = `cli-2ec1ae95`. A **source** filter: `figma | support | build | manual`.
- **Comment sync:** Not a live feed — a **"Sync Figma"** button (tooltip: *"Pull new & resolved Figma
  comments now"*) triggers a server-side pull. Each Figma comment becomes a **task card** (title
  `Figma #NN`, the comment text, "Comment by <author>", client/project, an age chip, a "No designer"
  slot). It's presented per-file-grouped as cards, not one raw feed.

## 2. Per-comment (task) data available
- **Open vs resolved:** Yes. Task `status` enum includes `resolved` (+ `resolvedOn` timestamp); the
  UI's 4th column is literally "Resolved / Closed on Figma". Other statuses map to the columns
  (backlog / in-progress / delivered-to-dev). So the PM tracks the exact open/closed signal the
  reporter currently guesses from Figma REST.
- **Assignee / "is this Ahmed's" signal:** Two layers —
  - **task-level:** `assigneeId`, `assignees[]`, `assigneeName` (heavily used — 140+ refs).
  - **project-level:** `primaryDesigner` (the project's default designer). Ahmed is `primaryDesigner`
    on projects assigned to him.
  This replaces the reporter's fragile `@handle` substring match with real, structured assignment.
- **Fields visible per task** (from the frontend's task mapper): `id`, `ref` (e.g. `ISS-1010`,
  `Figma #NN`), `source` (`figma|support|build|manual`), `status` + `resolvedOn`, `clientId` +
  `clientName`, `projectId`, `fileKey`, `figmaFileName`, `figmaUrl`, `figmaAuthor`, `assigneeId` /
  `assignees` / `assigneeName`, `due`/`dueOn`, `hidden`, `notTaskReason`, `archived`.
- **Maps back to a Figma comment / file?** `fileKey` is exposed as a **clean field** (this is the big
  one — it's exactly what `config.json → fileKeys` holds today, but sourced automatically per task).
  `figmaUrl` is stored per task and rendered as a deep link (`<a href={figmaUrl} target=_blank>`).
  A discrete `figmaCommentId` field was **not** observed in the frontend payload — the comment id, if
  needed for reply-routing, would have to be parsed out of `figmaUrl` (not verified this session;
  cards only reveal the link when expanded and I didn't want to click through). For **discovery +
  open/resolved + assignment**, we don't need the comment id at all; `fileKey` + `figmaUrl` suffice.

## 3. Integration surface (the important part)
- **Auth:** Bearer token. The app stores a session id in `localStorage.mdpm_session` and sends
  `Authorization: Bearer <mdpm_session>` on every `/api/*` call (confirmed by static-reading the JS
  bundle: 13 `Authorization`/`Bearer` sites, all `Bearer ${session}`). **No cookies** are used
  (`document.cookie` is empty). ⇒ For our tool to call these endpoints unattended we'd need a
  **service token** the PM issues — a browser session id is per-login and not suitable for CI.
  (The value itself is deliberately not recorded here.)
- **Endpoints seen** (all under `https://pm.mitchdesigns.com/api/`, from the bundle):
  - **Read the board:** `GET /api/design-tasks` ← the money endpoint. `GET /api/design-board-columns`,
    `GET /api/projects/all`, `GET /api/clients`, `GET /api/users`, `GET /api/people`,
    `GET /api/config`, `GET /api/auth/me`, `GET /api/presence`, `GET /api/team-sync/status`
    (returns `lastSyncedAt`).
  - **Trigger a Figma pull:** `POST /api/design-tasks/sync` → returns `{ created, closed, files }`
    ("Figma sync — N new, M closed across K file(s)."). This is server-side; it uses the PM's own
    stored Figma token.
  - **Figma integration config:** `POST /api/integrations/figma/connect` (body `{ token, teamId }`),
    `POST /api/integrations/figma/team` (`{ teamId }`), `.../figma/disconnect`. ⇒ The PM holds a
    **team-scoped** Figma token and enumerates the whole team's files by `teamId` — same mechanism the
    reporter would use, already configured here.
  - Also present (not needed for triage): Slack (`/api/integrations/slack/*`, inbound
    `/api/slack/events`), Resend email, WhatsApp, AI (`/api/integrations/ai/connect`,
    `/api/ai/issue-title`), invoices, hosting, leads, sitemaps, audit.
- **Auth style:** bearer token in `Authorization` header (see above). No API-key header, no cookie.
- **Real-time push:** **None.** No `EventSource`/SSE, no `WebSocket` in the bundle. The only `/events`
  path is `/api/slack/events` (an inbound Slack webhook receiver, unrelated). "Real-time" in the
  product pitch = the **manual Sync button** + light polling (`/api/team-sync/status`,
  `/api/presence` on ~60s `setInterval`). ⇒ We cannot subscribe to "new unresolved comment" events.
- **Export:** No CSV/JSON export UI, but `GET /api/design-tasks` **is** effectively the JSON export.

## 4. Verdict — what's worth wiring into the triage pipeline
1. **Replace `config.json → fileKeys` with the PM's task feed — RECOMMENDED, high value.**
   `GET /api/design-tasks` returns every team task already carrying `fileKey`, `clientName`,
   `source`, `status`, and assignment. We stop hardcoding file keys and stop maintaining the team file
   list — the PM (via its team-scoped Figma token) does discovery for us.
2. **Replace the REST "is this Ahmed's / still open" heuristic — RECOMMENDED, high value.**
   Swap `@handle` substring matching for `assigneeId == Ahmed` (or `primaryDesigner == Ahmed`), and
   swap Figma-REST resolved-guessing for `status === 'resolved'`. Both are structured and reliable.
   Filter the feed to `source==='figma' && status!=='resolved' && assignedToAhmed`.
3. **Event-driven trigger on a new comment — NOT available today.** No webhook/SSE. Keep the daily
   poll, but poll `/api/design-tasks` (optionally `POST /api/design-tasks/sync` first to force a fresh
   pull, then read) instead of Figma REST. `/api/team-sync/status.lastSyncedAt` lets us tell if data
   is stale.
4. **Blockers before we can build this:**
   - **Service token.** Endpoints require `Authorization: Bearer <session>`; a browser session id is
     per-login, not a CI credential. Ahmed needs to get an API/service token from the PM (or the PM
     needs to expose one). Until then this only runs in an attended/local browser context, not CI.
   - **Cloud egress allowlist.** `pm.mitchdesigns.com` is **blocked** in the cloud env (403 at the
     proxy) — it's not GitHub/Figma/npm. A cloud reporter run can't reach the PM at all. Either run
     the PM-sourced step locally/attended, or get the host allowlisted, or have the plugin/dashboard
     (which runs in Ahmed's browser) do the PM read and hand data to the reporter.
   - **Comment-id for reply routing.** If we keep the "draft a Figma reply" feature, confirm whether
     `figmaUrl` contains a parseable comment id, or keep using Figma REST just for the reply step.

## Screenshots
- Not committed (public repo — would leak client data). One local screenshot of the board was
  captured for reference only. Redact before adding any visual to this repo, or move recon to a
  private repo.
