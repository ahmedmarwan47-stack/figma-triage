// Posts the daily digest to a Slack incoming webhook. The webhook URL points
// at a single channel and needs no scopes — the whole payload is { text } in
// Slack mrkdwn.

export async function postSlack(webhookUrl, text) {
  if (!webhookUrl) {
    console.warn("[slack] SLACK_WEBHOOK_URL not set — printing digest instead:\n");
    console.log(text);
    return;
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack POST → ${res.status} ${res.statusText} ${body}`);
  }
}
