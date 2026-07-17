# figma-triage worker — two-way Slack bridge

Lets you **reply to a "Needs your input" message in Slack** and route your
answer one of two ways:

| You type | What happens |
|---|---|
| `they mean the pricing CTA, make it Amber/600` | **Clarify to Claude** — the comment is re-triaged with your answer as context and the edit gets drafted. Nothing is posted to Figma. |
| `figma: Good catch — fixing this today` | **Reply in Figma** — everything after `figma:` is posted verbatim as your reply in the actual Figma comment thread. No re-triage. |

```
Slack thread reply
   → this worker (verifies Slack signature, finds the ref marker on the parent)
   ├─ plain reply:  commits clarifications/<commentId>.json → dispatches the
   │                triage workflow → re-drafted job lands in digest + plugin
   └─ figma: reply: POST /v1/files/:key/comments (comment_id=…) — posts as you
```

## One-time setup (~10 minutes)

### 1. Create the Slack app
1. Go to https://api.slack.com/apps → **Create New App** → *From scratch*.
   Name: `Figma Triage`, workspace: yours.
2. **OAuth & Permissions** → *Bot Token Scopes*, add:
   - `chat:write` (post digest + confirmations)
   - `channels:history` and `groups:history` (read thread replies)
   - `reactions:write` (✅ on your reply)
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information** → copy the **Signing Secret**.
5. Invite the bot to your triage channel: `/invite @Figma Triage`.
6. Get the channel ID: channel name → *About* tab → Channel ID (`C0…`).

### 2. Create a GitHub fine-grained token
GitHub → Settings → Developer settings → Fine-grained tokens → New:
- Repository access: only `figma-triage`.
- Permissions: **Contents: Read and write**, **Actions: Read and write**.

### 3. Deploy the worker
```bash
cd worker
npm i -g wrangler            # once
wrangler login               # once
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put GITHUB_TOKEN
wrangler secret put FIGMA_TOKEN     # same token as the Actions secret — needs comment write
wrangler deploy
```
Copy the deployed URL (e.g. `https://figma-triage-worker.<you>.workers.dev`).

### 4. Point Slack at the worker
Slack app → **Event Subscriptions** → Enable:
- Request URL: `https://<worker-url>/slack/events` (Slack verifies instantly).
- **Subscribe to bot events**: `message.channels`, `message.groups`.
- Save; reinstall the app if Slack prompts.

### 5. Switch the reporter to bot posting
Repo → Settings → Secrets and variables → Actions, add:
- `SLACK_BOT_TOKEN` — same `xoxb-…` token.
- `SLACK_CHANNEL_ID` — the `C0…` id.

When both are set the reporter posts through the bot (and each clarification
becomes its own threadable message). The old `SLACK_WEBHOOK_URL` remains as a
fallback if the bot vars are absent.

## Daily use
The digest arrives as before. Any "❓ Needs your input" message — reply in its
thread:

- **Plain reply** ("they mean the pricing CTA, make it Amber/600") → the worker
  ✅-reacts, re-runs triage with your answer, and the re-drafted job shows up
  in the plugin a couple of minutes later.
- **`figma:` reply** ("figma: Did you mean the hero or the footer CTA?") → the
  worker 💬-reacts and your text appears as a reply in the Figma comment
  thread, posted as you. Only text you typed is ever posted — drafts are never
  auto-sent.
