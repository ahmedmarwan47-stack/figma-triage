// Daily Figma comment triage — unattended reporter.
//
//   discover (Figma REST) → classify + draft (Claude) → Slack digest + jobs file
//
// Runs in GitHub Actions. Never writes design content to Figma and never
// auto-posts comment replies — it only reports and publishes apply-ready jobs
// for the companion plugin.

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  getMe,
  resolveFiles,
  getFileComments,
  getFileAnnotations,
  getFileStyles,
  getNode,
  getNodeImage,
} from "./figma.mjs";
import { classifyAndDraft } from "./llm.mjs";
import { postSlack, postSlackBot } from "./slack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONFIG_PATH = join(ROOT, "config.json");
const STATE_PATH = join(HERE, "state.json");
const JOBS_DIR = join(ROOT, "jobs");
const CLAR_DIR = join(ROOT, "clarifications");

const FORCE = !!process.env.FORCE_RUN;

// ---- Slack clarification loop (written by worker/, consumed here) -----------

// Each file is clarifications/<commentId>.json: { commentId, fileKey, text,
// author, ts } — Ahmed's Slack thread reply to a "needs clarification" item.
// Presence of a file forces the comment to be re-triaged with the reply as
// extra context, then the file is deleted (the workflow commits the removal).
async function readClarifications() {
  const map = new Map();
  let files = [];
  try {
    files = await readdir(CLAR_DIR);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await readFile(join(CLAR_DIR, f), "utf8"));
      if (data.commentId && data.text) map.set(String(data.commentId), data);
    } catch (err) {
      console.warn(`[clarify] bad file ${f}: ${err.message}`);
    }
  }
  return map;
}

// ---- time helpers (timezone-aware, DST-safe) -------------------------------

function cairoParts(tz, at = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).format(at),
  );
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(at);
  return { date, hour, weekday };
}

// ---- comment threading + filtering -----------------------------------------

function buildThreads(comments) {
  const heads = comments.filter((c) => !c.parent_id);
  const repliesByParent = new Map();
  for (const c of comments) {
    if (c.parent_id) {
      const list = repliesByParent.get(c.parent_id) ?? [];
      list.push(c);
      repliesByParent.set(c.parent_id, list);
    }
  }
  return heads.map((head) => ({
    head,
    replies: (repliesByParent.get(head.id) ?? []).sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    ),
  }));
}

function mentionsUser(thread, handles) {
  const haystack = [thread.head.message, ...thread.replies.map((r) => r.message)]
    .join(" ")
    .toLowerCase();
  return handles.some((h) => h && haystack.includes(`@${h.toLowerCase()}`));
}

function latestActivity(thread) {
  const times = [
    Date.parse(thread.head.created_at),
    ...thread.replies.map((r) => Date.parse(r.created_at)),
  ];
  return Math.max(...times);
}

function fileLink(fileKey, nodeId) {
  const base = `https://www.figma.com/design/${fileKey}/`;
  return nodeId ? `${base}?node-id=${encodeURIComponent(nodeId)}` : base;
}

// ---- digest formatting (Slack mrkdwn) --------------------------------------

const HEADINGS = {
  mechanical: "🔧 Mechanical — apply-ready in the plugin",
  creative: "🎨 Creative — direction options to choose",
  clarification: "❓ Needs clarification — drafted reply to review",
  not_for_ahmed: "🙈 Not for you — flagged and skipped",
};

function formatDigest({ date, buckets, filesScanned }) {
  const lines = [`*Figma triage — ${date}*  (${filesScanned} file(s) scanned)`];

  // Files-with-drafts summary: shows at a glance which files have mechanical
  // drafts to apply, so you don't have to guess which file to open.
  const perFile = new Map(); // fileName → { link, mechanical, creative, clarify }
  for (const cat of ["mechanical", "creative", "clarification"]) {
    for (const it of buckets[cat]) {
      const entry = perFile.get(it.fileName) || {
        fileLink: fileLink(it.fileKey || "", null),
        mechanical: 0,
        creative: 0,
        clarify: 0,
      };
      if (cat === "mechanical") entry.mechanical++;
      else if (cat === "creative") entry.creative++;
      else entry.clarify++;
      perFile.set(it.fileName, entry);
    }
  }
  if (perFile.size) {
    lines.push("", "*📥 Files with drafts today*");
    for (const [name, e] of perFile) {
      const parts = [];
      if (e.mechanical) parts.push(`${e.mechanical} mechanical`);
      if (e.creative) parts.push(`${e.creative} creative`);
      if (e.clarify) parts.push(`${e.clarify} to clarify`);
      lines.push(`• <${e.fileLink}|${name}> — ${parts.join(", ")}`);
    }
  }

  for (const cat of ["mechanical", "creative", "clarification", "not_for_ahmed"]) {
    const items = buckets[cat];
    if (!items.length) continue;
    lines.push("", `*${HEADINGS[cat]}*`);
    for (const it of items) {
      lines.push(
        `• <${it.link}|${it.fileName}> — ${it.commentAuthor}: "${truncate(it.commentText, 140)}"`,
      );
      lines.push(`   _${it.rationale}_`);
      if (cat === "mechanical" && it.verdict.job) {
        lines.push(`   → ${it.verdict.job.title} (${it.verdict.job.ops.length} op(s))`);
      }
      if (cat === "creative" && it.verdict.options) {
        // Bare URL on its own line — Slack unfurls S3 image URLs into an
        // inline preview so the reviewer sees the source frame alongside the
        // drafted directions.
        if (it.imageUrl) lines.push(`   📸 ${it.imageUrl}`);
        for (const opt of it.verdict.options) {
          const applyNote = Array.isArray(opt.ops) && opt.ops.length
            ? ` _(apply-ready in the plugin — ${opt.ops.length} ops)_`
            : "";
          lines.push(`   ▸ *${opt.label}* — ${truncate(opt.caption, 160)}${applyNote}`);
          if (opt.aiPrompt) {
            lines.push(`      \`AI prompt (alternative):\` ${truncate(opt.aiPrompt, 220)}`);
          }
        }
      }
      if (cat === "clarification" && it.verdict.reply) {
        lines.push(`   💬 _Draft reply:_ ${truncate(it.verdict.reply, 260)}`);
      }
    }
  }

  const total =
    buckets.mechanical.length +
    buckets.creative.length +
    buckets.clarification.length;
  if (total > 0) {
    lines.push(
      "",
      "_Open a file above, run *Claude Comments*, and click Apply on each drafted card. Creative directions each have their own Apply button in the plugin — pick the one you like (the AI prompt is an alternative route). Nothing applies without your click._",
    );
  }
  return lines.join("\n");
}

// One standalone Slack message per needs-clarification comment. The trailing
// ref line is what worker/ parses to route your thread reply back to the
// right Figma comment — keep its format in sync with worker/index.js.
function formatClarificationMessage(it) {
  const lines = [
    `❓ *Needs your input* — <${it.link}|${it.fileName}>`,
    `> ${it.commentAuthor}: "${truncate(it.commentText, 200)}"`,
    `_${it.rationale}_`,
  ];
  if (it.imageUrl) lines.push(`📸 ${it.imageUrl}`);
  if (it.verdict.reply) lines.push(`💬 _Suggested thread reply:_ ${truncate(it.verdict.reply, 260)}`);
  lines.push(
    "",
    "*Reply in this thread:*",
    "• *Plain reply* → clarifies to Claude; the comment is re-triaged with your answer and the edit gets drafted. Nothing is posted to Figma.",
    "• *Start with* `figma:` → everything after it is posted as your reply in the Figma comment thread (e.g. `figma: Good catch — fixing this today`).",
    `\`ref:cmt_${it.commentId} file:${it.fileKey}\``,
  );
  return lines.join("\n");
}

function truncate(s, n) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---- image-node picker -----------------------------------------------------

// Given a node subtree and a comment, find the smallest FRAME/COMPONENT/SECTION
// whose bounding box contains the comment pin. Whole-page pins otherwise
// produce a full-landing-page screenshot that dominates the Slack message.
const CONTAINER_TYPES = new Set([
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "SECTION",
]);

function pinAbsolute(comment, node) {
  const nb = node?.absoluteBoundingBox;
  const off = comment?.client_meta?.node_offset;
  if (!nb || !off) return null;
  return { x: nb.x + off.x, y: nb.y + off.y };
}

function boxContains(box, pt) {
  if (!box || !pt) return false;
  return (
    pt.x >= box.x &&
    pt.x <= box.x + box.width &&
    pt.y >= box.y &&
    pt.y <= box.y + box.height
  );
}

function boxArea(box) {
  return box ? box.width * box.height : Number.POSITIVE_INFINITY;
}

function pickImageNode(node, comment) {
  const pin = pinAbsolute(comment, node);
  if (!pin) return null;
  let best = null;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (
      CONTAINER_TYPES.has(n.type) &&
      boxContains(n.absoluteBoundingBox, pin) &&
      (!best || boxArea(n.absoluteBoundingBox) < boxArea(best.absoluteBoundingBox))
    ) {
      best = n;
    }
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
  }
  return best?.id ?? null;
}

// ---- main ------------------------------------------------------------------

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const state = JSON.parse(await readFile(STATE_PATH, "utf8"));

  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error("FIGMA_TOKEN is not set.");
  // The Claude brain runs via the `claude` CLI — authenticated by
  // CLAUDE_CODE_OAUTH_TOKEN in CI, or a logged-in session locally.

  const tz = config.timezone ?? "Africa/Cairo";
  const now = new Date();
  const { date: today, hour, weekday } = cairoParts(tz, now);

  // Fire only at the configured local hour (the UTC cron fires twice to bracket
  // DST; this guard picks the right one). FORCE_RUN bypasses for manual runs.
  if (!FORCE) {
    if (["Sat", "Sun"].includes(weekday)) {
      console.log(`[skip] ${weekday} is a weekend in ${tz}.`);
      return;
    }
    if (hour !== (config.runAtHour ?? 14)) {
      console.log(
        `[skip] local hour is ${hour} in ${tz}, waiting for ${config.runAtHour ?? 14}:00.`,
      );
      return;
    }
    if (state.lastRunDate === today) {
      console.log(`[skip] already ran on ${today}.`);
      return;
    }
  }

  const me = await getMe(token);
  const myHandle = me.handle;
  const handles = [myHandle, ...(config.figma.extraHandles ?? [])];
  console.log(`[triage] running as ${myHandle} for ${today}`);

  const sinceTs = state.lastRunAt
    ? Date.parse(state.lastRunAt)
    : now.getTime() - (config.lookbackHoursFirstRun ?? 24) * 3600 * 1000;

  const files = await resolveFiles(token, {
    teamIds: config.figma.teamIds ?? [],
    fileKeys: config.figma.fileKeys ?? [],
  });
  console.log(`[triage] scanning ${files.length} file(s)`);

  const buckets = {
    mechanical: [],
    creative: [],
    clarification: [],
    not_for_ahmed: [],
  };
  const jobs = [];

  // Slack thread replies routed back by the worker — force those comments
  // through re-triage with the reply as context, even if "old".
  const clarifications = await readClarifications();
  if (clarifications.size) {
    console.log(`[clarify] ${clarifications.size} clarification(s) to consume`);
  }

  for (const file of files) {
    let comments;
    try {
      comments = await getFileComments(token, file.key);
    } catch (err) {
      console.warn(`[warn] comments for ${file.key}: ${err.message}`);
      continue;
    }

    // Annotations (Dev Mode). getFileAnnotations returns [] on 403/404 or
    // parse failure, so a plan that doesn't expose the endpoint is a silent
    // no-op — comments still flow through as normal.
    const annotations = await getFileAnnotations(token, file.key);

    // Local paint + text styles — so Claude can't emit names that don't
    // actually exist in this file (kills the "no local text style 'Label/l'"
    // class of apply-time failures).
    let localStyles = { paint: [], text: [] };
    try {
      localStyles = await getFileStyles(token, file.key);
      console.log(
        `[figma] styles for ${file.key}: ${localStyles.paint.length} paint, ${localStyles.text.length} text`,
      );
    } catch (err) {
      console.warn(`[warn] styles for ${file.key}: ${err.message}`);
    }

    const threads = [
      ...buildThreads(comments),
      ...annotations.map((a) => ({ head: a, replies: [] })),
    ]
      .filter((t) => !t.head.resolved_at)
      .filter(
        (t) =>
          t.head._isAnnotation ||
          config.figma.includeAllUnresolved ||
          mentionsUser(t, handles),
      )
      .filter(
        (t) => latestActivity(t) > sinceTs || clarifications.has(String(t.head.id)),
      );

    for (const thread of threads) {
      const nodeId = thread.head.client_meta?.node_id ?? null;
      let node = null;
      let imageUrl = null;
      // Styles Claude may reference = file-level styles ∪ styles referenced in
      // the commented subtree (the nodes endpoint is the only REST source that
      // reliably lists unpublished local styles).
      let threadStyles = localStyles;
      if (nodeId) {
        try {
          const nodeData = await getNode(token, file.key, nodeId);
          node = nodeData.document;
          threadStyles = {
            paint: [...new Set([...(localStyles.paint ?? []), ...nodeData.styles.paint])].sort(),
            text: [...new Set([...(localStyles.text ?? []), ...nodeData.styles.text])].sort(),
          };
          // Whole-page pins produce huge Slack screenshots. Walk the tree
          // and find the smallest FRAME whose bounding box contains the
          // pin — that's the section the reviewer actually needs to see.
          const imageNodeId = pickImageNode(node, thread.head) || nodeId;
          imageUrl = await getNodeImage(token, file.key, imageNodeId);
        } catch (err) {
          console.warn(`[warn] node ${nodeId} in ${file.key}: ${err.message}`);
        }
      }

      // Ahmed's Slack-thread clarification (if any) becomes thread context so
      // Claude re-triages with the ambiguity resolved — usually promoting the
      // comment to mechanical.
      const clar = clarifications.get(String(thread.head.id));
      const replies = clar
        ? [
            ...thread.replies,
            {
              user: { handle: "Ahmed (clarified via Slack)" },
              message: clar.text,
              created_at: clar.ts || now.toISOString(),
            },
          ]
        : thread.replies;

      const verdict = await classifyAndDraft({
        fileName: file.name,
        comment: thread.head,
        node,
        thread: replies,
        localStyles: threadStyles,
      });

      // Clarification consumed — remove the file (the workflow commits the
      // deletion) so the next run doesn't re-process it.
      if (clar) {
        await unlink(join(CLAR_DIR, `${thread.head.id}.json`)).catch(() => {});
        clarifications.delete(String(thread.head.id));
      }

      const category = HEADINGS[verdict.category]
        ? verdict.category
        : "clarification";

      buckets[category].push({
        commentId: thread.head.id,
        fileName: file.name,
        fileKey: file.key,
        link: fileLink(file.key, nodeId),
        commentAuthor: thread.head.user?.handle ?? "someone",
        commentText: thread.head.message,
        rationale: verdict.rationale ?? "",
        imageUrl,
        verdict,
      });

      // Mechanical jobs AND creative directions are plugin-executable now:
      // each creative option carries its own compiled ops, applied per-option
      // on an explicit click (never in bulk). The Slack digest stays the
      // decision surface; the aiPrompt remains an alternative route.
      if (category === "mechanical" || category === "creative") {
        jobs.push({
          commentId: thread.head.id,
          fileKey: file.key,
          fileName: file.name,
          nodeId,
          imageUrl,
          category,
          commentText: thread.head.message,
          link: fileLink(file.key, nodeId),
          job: verdict.job ?? null,
          options: verdict.options ?? null,
        });
      }
    }
  }

  const totalActionable =
    buckets.mechanical.length +
    buckets.creative.length +
    buckets.clarification.length;

  const digestText =
    totalActionable === 0 && buckets.not_for_ahmed.length === 0
      ? `*Figma triage — ${today}*\nNo new mentions today.`
      : formatDigest({ date: today, buckets, filesScanned: files.length });

  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (botToken && channelId) {
    // Bot transport: digest first, then each clarification as its OWN message
    // carrying a ref marker. A thread reply on that message is routed back to
    // the matching Figma comment by worker/ and consumed on the next run.
    await postSlackBot(botToken, channelId, digestText);
    for (const it of buckets.clarification) {
      await postSlackBot(botToken, channelId, formatClarificationMessage(it));
    }
  } else {
    await postSlack(process.env.SLACK_WEBHOOK_URL, digestText);
  }

  // Full triage record (all categories, including the drafts that don't become
  // plugin jobs — clarification replies, creative options). The plugin ignores
  // `report` and only reads `jobs`; this is for inspection + a durable record.
  const report = [];
  for (const cat of ["mechanical", "creative", "clarification", "not_for_ahmed"]) {
    for (const it of buckets[cat]) {
      report.push({
        category: cat,
        file: it.fileName,
        author: it.commentAuthor,
        comment: it.commentText,
        rationale: it.rationale,
        jobTitle: it.verdict.job?.title ?? null,
        options: (it.verdict.options ?? []).map((o) => o.label),
        reply: it.verdict.reply ?? null,
      });
    }
  }

  const payload = { date: today, generatedAt: now.toISOString(), jobs, report };
  await mkdir(JOBS_DIR, { recursive: true });
  await writeFile(join(JOBS_DIR, `${today}.json`), JSON.stringify(payload, null, 2));
  await writeFile(join(JOBS_DIR, "latest.json"), JSON.stringify(payload, null, 2));

  // Advance state (committed back by the Action).
  await writeFile(
    STATE_PATH,
    JSON.stringify(
      { lastRunAt: now.toISOString(), lastRunDate: today },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `[done] ${jobs.length} apply-ready job(s); ` +
      `mechanical=${buckets.mechanical.length} creative=${buckets.creative.length} ` +
      `clarify=${buckets.clarification.length} skip=${buckets.not_for_ahmed.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
