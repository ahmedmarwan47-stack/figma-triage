# figma-triage worker — two-way Slack bridge

Lets you **reply to a "Needs your input" message in Slack** and have the tool
re-triage that Figma comment with your answer as context — no copy-paste, and
nothing gets posted to the Figma thread. Your reply is context for Claude, not
a comment.

```
Slack thread reply
   → this worker (verifies Slack signature, finds the ref marker on the parent)
   → commits clarifications/<commentId>.json to the repo
   → dispatches the triage workflow (force)
   → reporter re-triages the comment with your clarification
   → new draft lands in the digest + the plugin (usually as a mechanical job)
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
The digest arrives as before. Any "❓ Needs your input" message — just reply in
its thread in your own words ("they mean the pricing CTA, make it Amber/600").
The worker ✅-reacts, re-runs triage with your answer, and the re-drafted job
shows up in the plugin a couple of minutes later.
