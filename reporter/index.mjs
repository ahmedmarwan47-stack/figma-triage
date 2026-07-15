// Daily Figma comment triage — unattended reporter.
//
//   discover (Figma REST) → classify + draft (Claude) → Slack digest + jobs file
//
// Runs in GitHub Actions. Never writes design content to Figma and never
// auto-posts comment replies — it only reports and publishes apply-ready jobs
// for the companion plugin.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  getMe,
  resolveFiles,
  getFileComments,
  getNode,
  getNodeImage,
} from "./figma.mjs";
import { classifyAndDraft } from "./llm.mjs";
import { postSlack } from "./slack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONFIG_PATH = join(ROOT, "config.json");
const STATE_PATH = join(HERE, "state.json");
const JOBS_DIR = join(ROOT, "jobs");

const FORCE = !!process.env.FORCE_RUN;

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
        for (const opt of it.verdict.options) {
          lines.push(`   ▸ *${opt.label}* — ${truncate(opt.caption, 160)}`);
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
      "_Open the *Claude Comments* plugin in the file to apply mechanical + creative drafts. Replies are drafts only — post them yourself after a glance._",
    );
  }
  return lines.join("\n");
}

function truncate(s, n) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
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

  for (const file of files) {
    let comments;
    try {
      comments = await getFileComments(token, file.key);
    } catch (err) {
      console.warn(`[warn] comments for ${file.key}: ${err.message}`);
      continue;
    }

    const threads = buildThreads(comments)
      .filter((t) => !t.head.resolved_at)
      .filter(
        (t) => config.figma.includeAllUnresolved || mentionsUser(t, handles),
      )
      .filter((t) => latestActivity(t) > sinceTs);

    for (const thread of threads) {
      const nodeId = thread.head.client_meta?.node_id ?? null;
      let node = null;
      let imageUrl = null;
      if (nodeId) {
        try {
          node = await getNode(token, file.key, nodeId);
          imageUrl = await getNodeImage(token, file.key, nodeId);
        } catch (err) {
          console.warn(`[warn] node ${nodeId} in ${file.key}: ${err.message}`);
        }
      }

      const verdict = await classifyAndDraft({
        fileName: file.name,
        comment: thread.head,
        node,
        thread: thread.replies,
      });

      const category = HEADINGS[verdict.category]
        ? verdict.category
        : "clarification";

      buckets[category].push({
        fileName: file.name,
        link: fileLink(file.key, nodeId),
        commentAuthor: thread.head.user?.handle ?? "someone",
        commentText: thread.head.message,
        rationale: verdict.rationale ?? "",
        verdict,
      });

      // Mechanical + creative become apply-ready jobs for the plugin.
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

  if (totalActionable === 0 && buckets.not_for_ahmed.length === 0) {
    await postSlack(process.env.SLACK_WEBHOOK_URL, `*Figma triage — ${today}*\nNo new mentions today.`);
  } else {
    await postSlack(
      process.env.SLACK_WEBHOOK_URL,
      formatDigest({ date: today, buckets, filesScanned: files.length }),
    );
  }

  // Publish the day's jobs for the plugin to fetch.
  await mkdir(JOBS_DIR, { recursive: true });
  await writeFile(
    join(JOBS_DIR, `${today}.json`),
    JSON.stringify({ date: today, generatedAt: now.toISOString(), jobs }, null, 2),
  );
  await writeFile(
    join(JOBS_DIR, "latest.json"),
    JSON.stringify({ date: today, generatedAt: now.toISOString(), jobs }, null, 2),
  );

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
