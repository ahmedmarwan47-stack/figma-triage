// figma-triage worker — the two-way Slack bridge.
//
// Receives Slack Events API callbacks. When Ahmed replies in the thread of a
// "Needs your input" message (posted by the reporter with a trailing
// `ref:cmt_<id> file:<key>` line), the reply is routed one of two ways:
//
//   1. DEFAULT — clarify to Claude: the reply is written to
//      clarifications/<commentId>.json in the repo and the triage workflow is
//      dispatched, so the comment is re-triaged with the clarification as
//      context (usually promoting it to an apply-ready mechanical draft).
//      Nothing is posted to Figma.
//
//   2. PREFIXED with "figma:" — reply in Figma: everything after the prefix
//      is posted verbatim as a reply in the Figma comment thread (as Ahmed,
//      via his FIGMA_TOKEN). No re-triage.
//
// Secrets (wrangler secret put <NAME>):
//   SLACK_SIGNING_SECRET  Slack app → Basic Information → Signing Secret
//   SLACK_BOT_TOKEN       Slack app → OAuth → Bot User OAuth Token (xoxb-…)
//   GITHUB_TOKEN          fine-grained PAT: contents read/write + actions write
//   FIGMA_TOKEN           Figma personal access token (comments: write)
// Vars (wrangler.toml):
//   GITHUB_REPO           e.g. "ahmedmarwan47-stack/figma-triage"
//   GITHUB_BRANCH         e.g. "main"

const REF_RE = /ref:cmt_(\S+) file:(\S+)/;
const FIGMA_PREFIX_RE = /^\s*figma:\s*/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/slack/events" && request.method === "POST") {
      return handleSlackEvent(request, env, ctx);
    }
    return new Response("figma-triage worker: OK", { status: 200 });
  },
};

async function handleSlackEvent(request, env, ctx) {
  const rawBody = await request.text();

  if (!(await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET))) {
    return new Response("bad signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // Slack's one-time endpoint handshake.
  if (payload.type === "url_verification") {
    return new Response(payload.challenge, { status: 200 });
  }

  if (payload.type === "event_callback") {
    const ev = payload.event ?? {};
    // Human thread replies only — ignore bot echoes (including our own posts)
    // and message edits/deletes (subtypes).
    if (ev.type === "message" && ev.thread_ts && !ev.bot_id && !ev.subtype) {
      // Ack Slack within 3s; do the real work after the response.
      ctx.waitUntil(processThreadReply(ev, env));
    }
  }

  return new Response("ok", { status: 200 });
}

async function processThreadReply(ev, env) {
  try {
    // The parent message holds the ref marker.
    const parent = await slackApi(env, "conversations.replies", {
      channel: ev.channel,
      ts: ev.thread_ts,
      limit: 1,
    });
    const parentText = parent.messages?.[0]?.text ?? "";
    const m = REF_RE.exec(parentText);
    if (!m) return; // reply on some other message — not ours

    const [, commentId, fileKey] = m;

    // Route 2: "figma:" prefix — post the reply into the Figma comment thread.
    const figmaMatch = FIGMA_PREFIX_RE.exec(ev.text ?? "");
    if (figmaMatch) {
      const replyText = ev.text.slice(figmaMatch[0].length).trim();
      if (!replyText) return;
      await postFigmaReply(env, fileKey, commentId, replyText);
      await slackApi(env, "reactions.add", {
        channel: ev.channel,
        timestamp: ev.ts,
        name: "speech_balloon",
      }).catch(() => {});
      await slackApi(env, "chat.postMessage", {
        channel: ev.channel,
        thread_ts: ev.thread_ts,
        text: "Posted to the Figma comment thread. (Not sent to Claude — reply without the `figma:` prefix if you also want a re-triage.)",
      }).catch(() => {});
      return;
    }

    // Route 1 (default): clarification context for Claude → re-triage.
    const clarification = {
      commentId,
      fileKey,
      text: ev.text,
      author: ev.user,
      ts: new Date(Number(ev.ts.split(".")[0]) * 1000).toISOString(),
    };

    await commitClarification(env, commentId, clarification);
    await dispatchWorkflow(env);

    // Confirm receipt where Ahmed can see it.
    await slackApi(env, "reactions.add", {
      channel: ev.channel,
      timestamp: ev.ts,
      name: "white_check_mark",
    }).catch(() => {});
    await slackApi(env, "chat.postMessage", {
      channel: ev.channel,
      thread_ts: ev.thread_ts,
      text: "Got it — re-triaging this comment with your clarification. The new draft will land in the next digest + the plugin (~2 min).",
    }).catch(() => {});
  } catch (err) {
    console.error("processThreadReply failed:", err);
  }
}

// ---- Figma ------------------------------------------------------------------

// The one write Figma's REST API allows: replying in a comment thread. Posts
// as the owner of FIGMA_TOKEN (i.e. as Ahmed) — only ever with text he typed
// himself after the figma: prefix, never model-drafted content.
async function postFigmaReply(env, fileKey, commentId, message) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
    method: "POST",
    headers: {
      "X-Figma-Token": env.FIGMA_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, comment_id: commentId }),
  });
  if (!res.ok) {
    throw new Error(`figma reply POST → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---- Slack ------------------------------------------------------------------

async function slackApi(env, method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`slack ${method} → ${data.error}`);
  return data;
}

async function verifySlackSignature(request, rawBody, signingSecret) {
  const ts = request.headers.get("x-slack-request-timestamp");
  const sig = request.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  // Reject replays older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `v0=${hex}`;
  // Constant-time-ish compare.
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// ---- GitHub -----------------------------------------------------------------

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "figma-triage-worker",
  };
}

async function commitClarification(env, commentId, clarification) {
  const path = `clarifications/${commentId}.json`;
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;

  // If a clarification for this comment already exists, we need its sha to
  // overwrite (Ahmed replied twice — last one wins).
  let sha;
  const existing = await fetch(`${url}?ref=${env.GITHUB_BRANCH}`, { headers: ghHeaders(env) });
  if (existing.ok) sha = (await existing.json()).sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify({
      message: `clarify: comment ${commentId} via Slack`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(clarification, null, 2)))),
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`github contents PUT → ${res.status} ${await res.text()}`);
}

async function dispatchWorkflow(env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/triage.yml/dispatches`,
    {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({ ref: env.GITHUB_BRANCH, inputs: { force: "true" } }),
    },
  );
  if (res.status !== 204) throw new Error(`workflow dispatch → ${res.status} ${await res.text()}`);
}
