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

// Offset (ms) between `tz` wall-clock and UTC at instant `at`, i.e.
// localWallClock - utc. Cairo in summer (UTC+3) → +3h. DST-correct because it
// asks Intl what the wall clock actually reads at that instant.
function tzOffsetMs(tz, at) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - at.getTime();
}

// Epoch ms of local (tz) midnight beginning `dateStr` (YYYY-MM-DD), shifted by
// `dayShift` whole days. dayShift=1 gives the start of the *next* day, i.e. the
// exclusive upper edge of `dateStr` when you want the whole day included.
function localDayStartMs(tz, dateStr, dayShift = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d + dayShift, 0, 0, 0);
  const off = tzOffsetMs(tz, new Date(guess));
  return guess - off;
}

// A single window edge from user input: a bare "YYYY-MM-DD" is read as a
// tz-local day boundary (upper edges cover the whole day); anything else is
// parsed as an ISO timestamp.
function parseWindowEdge(val, tz, isUpper) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return localDayStartMs(tz, val, isUpper ? 1 : 0);
  }
  const ms = Date.parse(val);
  if (Number.isNaN(ms)) {
    throw new Error(`Bad date "${val}" — use YYYY-MM-DD (Cairo) or an ISO timestamp.`);
  }
  return ms;
}

// Resolve the activity window to scan. Default (no env override) reproduces the
// old behaviour: everything since the last run's cursor (or lookbackHoursFirstRun
// on a fresh state), unbounded upper edge. Any of TRIAGE_LOOKBACK_DAYS /
// TRIAGE_SINCE / TRIAGE_UNTIL switches to an explicit ad-hoc window: guards are
// bypassed (like FORCE_RUN) and the state cursor is left untouched so the daily
// cadence isn't disturbed by scanning older comments.
//
//   TRIAGE_LOOKBACK_DAYS=N  → the last N Cairo days (1 = today only,
//                             2 = today + yesterday, …)
//   TRIAGE_SINCE=YYYY-MM-DD  (or ISO)  → inclusive start; overrides lookback
//   TRIAGE_UNTIL=YYYY-MM-DD  (or ISO)  → inclusive end (whole day); default now
function resolveWindow(tz, now, defaultSinceTs) {
  const sinceEnv = (process.env.TRIAGE_SINCE || "").trim();
  const untilEnv = (process.env.TRIAGE_UNTIL || "").trim();
  const daysEnv = (process.env.TRIAGE_LOOKBACK_DAYS || "").trim();

  if (!sinceEnv && !untilEnv && !daysEnv) {
    return { sinceTs: defaultSinceTs, untilTs: now.getTime(), custom: false, label: null };
  }

  const { date: today } = cairoParts(tz, now);
  const labelParts = [];
  let sinceTs = null;
  let untilTs = now.getTime();

  if (daysEnv) {
    const n = Number(daysEnv);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`TRIAGE_LOOKBACK_DAYS must be a positive integer, got "${daysEnv}".`);
    }
    sinceTs = localDayStartMs(tz, today, -(n - 1));
    labelParts.push(n === 1 ? "today only" : `last ${n} days`);
  }
  if (sinceEnv) {
    sinceTs = parseWindowEdge(sinceEnv, tz, false);
    labelParts.push(`since ${sinceEnv}`);
  }
  if (untilEnv) {
    untilTs = parseWindowEdge(untilEnv, tz, true);
    labelParts.push(`until ${untilEnv}`);
  }
  if (sinceTs == null) sinceTs = 0; // until given alone → from the beginning

  if (untilTs <= sinceTs) {
    throw new Error(
      `Empty date range: until ${new Date(untilTs).toISOString()} is not after ` +
        `since ${new Date(sinceTs).toISOString()}.`,
    );
  }
  return { sinceTs, untilTs, custom: true, label: labelParts.join(", ") };
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

// Who a single message mentions. `me` = it @-mentions Ahmed (possibly ALONGSIDE
// others in the same message). `others` = it @-mentions at least one person who
// isn't Ahmed. Both can be true ("@Ahmed @Mark do X"). We count "@" that begins
// a mention token and compare against how many of those are Ahmed's — so a
// message naming other people but not Ahmed reads as others-only.
function mentionMeta(text, handles) {
  const t = (text || "").toLowerCase();
  // Positions of every "@" that begins a mention token.
  const atPositions = [];
  const re = /@(?=[\w])/g;
  for (let m; (m = re.exec(t)) !== null; ) atPositions.push(m.index);
  // Positions that are MINE. A set, so overlapping aliases ("Ahmed Marwan" and
  // "Ahmed") both resolving to the same "@Ahmed Marwan" count once — otherwise
  // a co-mention like "@Ahmed Marwan @Mark" would wrongly read as me-only.
  const mine = new Set();
  for (const h of handles) {
    if (!h) continue;
    const needle = `@${h.toLowerCase()}`;
    for (let i = t.indexOf(needle); i !== -1; i = t.indexOf(needle, i + needle.length)) mine.add(i);
  }
  return { me: mine.size > 0, others: atPositions.length > mine.size };
}

// A thread is Ahmed's if he's mentioned in the head OR any reply.
function mentionsUser(thread, handles) {
  if (mentionMeta(thread.head.message, handles).me) return true;
  return thread.replies.some((r) => mentionMeta(r.message, handles).me);
}

// The replies that belong to Ahmed's view of a thread. Kept: replies mentioning
// him (even with others) and replies mentioning nobody (a follow-up on his
// comment). Dropped: replies that mention only OTHER people — those are notes to
// developers, not for Ahmed. This runs before inclusion + activity checks, so a
// thread doesn't get re-surfaced just because a dev note landed in it.
function forAhmedReplies(replies, handles) {
  return replies.filter((r) => {
    const m = mentionMeta(r.message, handles);
    return m.me || !m.others;
  });
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

// Compact digest as Block Kit: one section block per comment (grouped by
// file), each carrying the node screenshot as a small right-side thumbnail —
// enough to verify the draft targeted the right node without unfurled
// full-size images. Full details (rationales, ops, AI prompts) live in the
// plugin and the jobs file — the digest is a scannable index, not the record.
// Clarifications get their own threadable messages in bot mode; in
// webhook-only mode their draft replies are inlined here.
function mrkdwnSection(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function formatDigest({ date, buckets, clarificationsInline }) {
  const mech = buckets.mechanical.length;
  const crea = buckets.creative.length;
  const clar = buckets.clarification.length;
  const skip = buckets.not_for_ahmed.length;

  const counts = [];
  if (mech) counts.push(`${mech} apply-ready`);
  if (crea) counts.push(`${crea} direction set${crea > 1 ? "s" : ""}`);
  if (clar) counts.push(`${clar} need${clar === 1 ? "s" : ""} input`);
  if (skip) counts.push(`${skip} skipped`);
  const header = `*Figma triage — ${date}* · ${counts.join(" · ") || "nothing new"}`;

  const blocks = [mrkdwnSection(header)];

  // Group actionable items by file, one block each.
  const byFile = new Map();
  for (const cat of ["mechanical", "creative", "clarification"]) {
    for (const it of buckets[cat]) {
      const list = byFile.get(it.fileName) ?? [];
      list.push({ cat, it });
      byFile.set(it.fileName, list);
    }
  }

  for (const [fileName, items] of byFile) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*${fileName}*` }],
    });
    for (const { cat, it } of items) {
      let line;
      if (cat === "mechanical") {
        const label = it.verdict.job?.title || truncate(it.commentText, 80);
        line = `⚙️ <${it.link}|${truncate(label, 90)}>`;
      } else if (cat === "creative") {
        const n = (it.verdict.options ?? []).length;
        line = `🎨 <${it.link}|${truncate(it.commentText, 80)}> — ${n} direction${n === 1 ? "" : "s"} in the plugin`;
      } else {
        line = `❓ <${it.link}|${truncate(it.commentText, 80)}>`;
        if (clarificationsInline && it.verdict.reply) {
          // Webhook-only mode has no per-item thread, so show the full drafted
          // reply here (bot mode shows it in the item's own message instead).
          line += `\n💬 *Suggested reply:*\n>${truncate(it.verdict.reply, 1200).replace(/\n/g, "\n>")}`;
        }
      }
      const block = mrkdwnSection(line);
      if (it.imageUrl) {
        block.accessory = {
          type: "image",
          image_url: it.imageUrl,
          alt_text: "commented node preview",
        };
      }
      blocks.push(block);
    }
  }

  if (mech + crea + clar > 0) {
    const clarNote =
      !clarificationsInline && clar > 0
        ? " ❓ items follow as separate messages — reply in their threads."
        : "";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `⚙️ + 🎨 are apply-ready in the *Claude Comments* plugin.${clarNote}`,
        },
      ],
    });
  }

  // `text` is the notification-preview fallback; blocks are the rendered body.
  return { text: header.replace(/\*/g, ""), blocks };
}

// Slack caps a message at 50 blocks — chunk busy days into several messages.
async function sendDigest({ botMode, botToken, channelId, payload }) {
  const parts =
    typeof payload === "string" || (payload.blocks?.length ?? 0) <= 48
      ? [payload]
      : Array.from({ length: Math.ceil(payload.blocks.length / 48) }, (_, i) => ({
          text: payload.text,
          blocks: payload.blocks.slice(i * 48, i * 48 + 48),
        }));
  for (const part of parts) {
    if (botMode) await postSlackBot(botToken, channelId, part);
    else await postSlack(process.env.SLACK_WEBHOOK_URL, part);
  }
}

// One standalone Slack message per needs-clarification comment. The trailing
// ref line is what worker/ parses to route your thread reply back to the
// right Figma comment — keep its format in sync with worker/index.js.
function formatClarificationMessage(it) {
  const lines = [
    `❓ *Needs your input* — <${it.link}|${it.fileName}>`,
    `> ${it.commentAuthor}: "${truncate(it.commentText, 400)}"`,
    `_${it.rationale}_`,
  ];
  if (it.imageUrl) lines.push(`📸 ${it.imageUrl}`);
  // Full drafted reply so you can judge/edit it before sending — capped only
  // to stay well under Slack's per-message limit.
  if (it.verdict.reply) lines.push(`💬 *Suggested reply to review:*\n>${truncate(it.verdict.reply, 1500).replace(/\n/g, "\n>")}`);
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

  // Default window: everything since the last run's cursor (or the first-run
  // lookback on a fresh state). An explicit date range via env overrides this.
  const defaultSinceTs = state.lastRunAt
    ? Date.parse(state.lastRunAt)
    : now.getTime() - (config.lookbackHoursFirstRun ?? 24) * 3600 * 1000;
  const scanWindow = resolveWindow(tz, now, defaultSinceTs);
  const CUSTOM_WINDOW = scanWindow.custom;

  // Fire only at the configured local hour (the UTC cron fires twice to bracket
  // DST; this guard picks the right one). FORCE_RUN — and any explicit date
  // range — bypasses for manual runs.
  if (!FORCE && !CUSTOM_WINDOW) {
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

  if (CUSTOM_WINDOW) {
    console.log(
      `[triage] custom window (${scanWindow.label}): ` +
        `${new Date(scanWindow.sinceTs).toISOString()} → ${new Date(scanWindow.untilTs).toISOString()} ` +
        `— state cursor will NOT advance`,
    );
  } else {
    console.log(`[triage] window: comments active since ${new Date(scanWindow.sinceTs).toISOString()}`);
  }

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
  let processed = 0;
  let autoFailed = 0; // classifications that fell to the error fallback

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
      // Strip developer-note replies (mention only other people, not Ahmed)
      // up front, so both the inclusion + activity checks below and the context
      // fed to Claude see only what's actually for Ahmed. Annotations have no
      // replies, so this is a no-op for them.
      .map((t) =>
        t.head._isAnnotation
          ? t
          : { head: t.head, replies: forAhmedReplies(t.replies, handles) },
      )
      .filter((t) => !t.head.resolved_at)
      .filter(
        (t) =>
          t.head._isAnnotation ||
          config.figma.includeAllUnresolved ||
          mentionsUser(t, handles),
      )
      .filter((t) => {
        const active = latestActivity(t);
        return (
          (active > scanWindow.sinceTs && active <= scanWindow.untilTs) ||
          clarifications.has(String(t.head.id))
        );
      });

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
          if (nodeData.styles.paint.length || nodeData.styles.text.length) {
            console.log(
              `[figma] node ${nodeId} styles: ${nodeData.styles.paint.length} paint, ${nodeData.styles.text.length} text → ${threadStyles.paint.length}/${threadStyles.text.length} available to Claude`,
            );
          }
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
        models: config.models ?? {},
      });

      processed++;
      if (verdict._autoFailed) autoFailed++;

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
        project: file.project ?? null,
        link: fileLink(file.key, nodeId),
        commentAuthor: thread.head.user?.handle ?? "someone",
        commentText: thread.head.message,
        createdAt: thread.head.created_at ?? null,
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
          project: file.project ?? null,
          nodeId,
          imageUrl,
          category,
          commentText: thread.head.message,
          commentAuthor: thread.head.user?.handle ?? "someone",
          createdAt: thread.head.created_at ?? null,
          link: fileLink(file.key, nodeId),
          job: verdict.job ?? null,
          options: verdict.options ?? null,
        });
      }
    }
  }

  // Total-outage guard: if we processed comments and EVERY one fell to the
  // error fallback (e.g. a Claude rate-limit/outage made all CLI calls exit 1),
  // do NOT overwrite the good jobs file or advance state with garbage. Bail so
  // a later run reprocesses cleanly. A partial failure (some succeeded) still
  // publishes — those are real.
  if (processed > 0 && autoFailed === processed) {
    console.error(
      `[abort] all ${processed} classification(s) failed (likely a Claude outage/rate-limit). ` +
        `Leaving jobs + state untouched so a later run retries.`,
    );
    process.exitCode = 1;
    return;
  }
  if (autoFailed > 0) {
    console.warn(`[warn] ${autoFailed}/${processed} classification(s) auto-failed and degraded to clarification.`);
  }

  const totalActionable =
    buckets.mechanical.length +
    buckets.creative.length +
    buckets.clarification.length;

  // Slack is opt-in. When disabled (config.slack.enabled === false) we're in
  // dashboard-only mode: still classify, draft, and write jobs/ below — just
  // skip every Slack post. Default true keeps back-compat if the flag is absent.
  const slackEnabled = config.slack?.enabled !== false;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  const botMode = !!(botToken && channelId);

  if (slackEnabled) {
    const digestPayload =
      totalActionable === 0 && buckets.not_for_ahmed.length === 0
        ? `*Figma triage — ${today}*\nNo new mentions today.`
        : formatDigest({
            date: today,
            buckets,
            clarificationsInline: !botMode,
          });
    await sendDigest({ botMode, botToken, channelId, payload: digestPayload });
    if (botMode) {
      // Each clarification gets its OWN message carrying a ref marker. A thread
      // reply on that message is routed back to the matching Figma comment by
      // worker/ and consumed on the next run.
      for (const it of buckets.clarification) {
        await postSlackBot(botToken, channelId, formatClarificationMessage(it));
      }
    }
  } else {
    console.log(
      `[slack] disabled (config.slack.enabled=false) — dashboard-only. ` +
        `${totalActionable} actionable item(s) written to jobs/, no Slack post.`,
    );
  }

  // Full triage record (all categories, including the drafts that don't become
  // plugin jobs — clarification replies, creative options). The plugin ignores
  // `report` and only reads `jobs`; this is for inspection + a durable record.
  const report = [];
  for (const cat of ["mechanical", "creative", "clarification", "not_for_ahmed"]) {
    for (const it of buckets[cat]) {
      report.push({
        category: cat,
        commentId: it.commentId,
        file: it.fileName,
        fileKey: it.fileKey,
        project: it.project ?? null,
        author: it.commentAuthor,
        comment: it.commentText,
        createdAt: it.createdAt ?? null,
        rationale: it.rationale,
        // The node screenshot for EVERY comment (jobs already carry it; this
        // makes clarification + skipped comments show a preview too).
        imageUrl: it.imageUrl ?? null,
        link: it.link ?? null,
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

  // Advance state (committed back by the Action) — but NOT for an ad-hoc date
  // range. A custom window (e.g. re-scanning older comments) must not move the
  // daily cadence cursor, or the next scheduled run would skip everything in
  // between.
  if (CUSTOM_WINDOW) {
    console.log("[state] custom-window run — leaving state.json cursor untouched.");
  } else {
    await writeFile(
      STATE_PATH,
      JSON.stringify(
        { lastRunAt: now.toISOString(), lastRunDate: today },
        null,
        2,
      ) + "\n",
    );
  }

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
