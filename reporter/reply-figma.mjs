// Posting a comment reply is "sending a message on Ahmed's behalf" — it is
// NEVER done automatically by the daily run. This helper exists so an EXPLICIT,
// per-comment approval step (a manual GitHub Actions workflow_dispatch, or a
// deliberate local invocation) can post a single drafted reply after Ahmed has
// reviewed it. The daily reporter only ever DRAFTS replies into the digest.

const BASE = "https://api.figma.com";

/**
 * Post one reply into an existing comment thread.
 * @param {string} token   FIGMA_TOKEN
 * @param {string} fileKey
 * @param {string} commentId  the comment being replied to
 * @param {string} message    the reply text (already reviewed by Ahmed)
 */
export async function postCommentReply(token, fileKey, commentId, message) {
  const res = await fetch(`${BASE}/v1/files/${fileKey}/comments`, {
    method: "POST",
    headers: {
      "X-Figma-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, comment_id: commentId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Figma reply POST → ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

// Allow: node reporter/reply-figma.mjs <fileKey> <commentId> "reply text"
if (import.meta.url === `file://${process.argv[1]}`) {
  const [fileKey, commentId, ...rest] = process.argv.slice(2);
  const message = rest.join(" ");
  const token = process.env.FIGMA_TOKEN;
  if (!token || !fileKey || !commentId || !message) {
    console.error(
      'Usage: FIGMA_TOKEN=... node reporter/reply-figma.mjs <fileKey> <commentId> "reply text"',
    );
    process.exit(1);
  }
  postCommentReply(token, fileKey, commentId, message)
    .then(() => console.log("Reply posted."))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
