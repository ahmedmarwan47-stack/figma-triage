// Posts the daily digest to Slack. Two transports:
//  - Incoming webhook (SLACK_WEBHOOK_URL): zero-setup, one-way.
//  - Bot token (SLACK_BOT_TOKEN + SLACK_CHANNEL_ID): required for the two-way
//    clarification loop — each clarification is posted as its own message so
//    a thread reply on it can be routed back to the right Figma comment by
//    the worker (see worker/README.md).

/** payload: a plain string, or { text, blocks } (Block Kit). */
export async function postSlack(webhookUrl, payload) {
  const body = typeof payload === "string" ? { text: payload } : payload;
  if (!webhookUrl) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set — printing digest instead:\n");
    console.log(body.text ?? JSON.stringify(body.blocks, null, 2));
    return;
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Slack POST → ${res.status} ${res.statusText} ${errBody}`);
  }
}

/** chat.postMessage via bot token. payload: string or { text, blocks }. */
export async function postSlackBot(botToken, channel, payload) {
  const body = typeof payload === "string" ? { text: payload } : payload;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, unfurl_links: false, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage → ${data.error || res.status}`);
  }
  return data;
}
