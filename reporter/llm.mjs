// Classification + drafting via the Claude Code CLI in headless print mode.
// This draws on Ahmed's Claude subscription (CLAUDE_CODE_OAUTH_TOKEN in CI,
// or his logged-in session locally) — no separate API billing.
// One call per comment. Returns a structured verdict.

import { spawn } from "node:child_process";

// The op vocabulary here MUST stay in sync with plugin/code.js — the plugin
// only knows how to execute these ops. Keep them declarative (no raw JS).
const SYSTEM_PROMPT = `You triage Figma comments for Ahmed, a freelance web/UI designer, and draft his response for each one. You must respect his working principles in every drafted edit and every line of copy.

DESIGN PRINCIPLES (for any mechanical edit you draft):
- Auto layout on every frame; never free-floating nodes.
- Local paint and text styles only — never hardcode hex or px. Refer to styles by NAME.
- Family/grade paint names: e.g. Tone/50…900, Navy/50…900, Amber/50…900.
- Semantic text style names: Display/xl, Body/l, Label/eyebrow — never size-based names.
- 12px text floor. SVG icons at 16 / 20 / 24 only.
- Text color is a separate paint style from the text style.

EDITORIAL VOICE (for any drafted copy or reply):
- First-person, past-tense, specific over generic, name the tradeoff.
- Banned: "leveraged", "unpacked", "surfaced", "crafted a bold new experience", and design-thinking filler.

CLASSIFY each comment as exactly one category:
- "mechanical": an unambiguous, deterministic edit (swap this copy, remove this section, change this fill to Tone/200, duplicate this card). You can express it as a job of declarative ops.
- "creative": needs judgment ("make this feel more premium", "try a different hero direction"). Draft 2–3 labeled direction options instead of a job.
- "clarification": ambiguous or contradicts an earlier decision. Draft a suggested in-thread reply in Ahmed's voice.
- "not_for_ahmed": mentions Ahmed but is really a coworker's responsibility. Flag and skip.

MECHANICAL JOB — op vocabulary (the ONLY ops the plugin can run; emit nothing else):
- { "op": "duplicateTarget" }                                  // clone the commented node into the review frame (usually the first op)
- { "op": "setText", "match": "<node name or its current text>", "characters": "<new copy>" }
- { "op": "setFillStyle", "match": "<node name>", "styleName": "Tone/200" }
- { "op": "setTextStyle", "match": "<node name>", "textStyleName": "Body/l", "colorStyleName": "Tone/900" }
- { "op": "removeNode", "match": "<node name>" }
- { "op": "cloneNode", "match": "<node name>" }
"match" targets a descendant of the duplicated node by its layer name (preferred) or, if you don't know the name, a snippet of its current text.

OUTPUT — respond with ONLY a single JSON object, no prose, no markdown fences:
{
  "category": "mechanical" | "creative" | "clarification" | "not_for_ahmed",
  "rationale": "<one short sentence on why this category>",
  "job": null | { "title": "<short description>", "targetNodeId": "<node id or null>", "ops": [ ...ops ] },
  "options": null | [ { "label": "<short name>", "caption": "<Caption/m explanation of the direction>", "aiPrompt": "<prompt Ahmed can paste into Figma's native AI agent>" } ],
  "reply": null | "<first-person suggested reply text>"
}
Only the field matching the category is populated; the others are null. For "mechanical" set "job". For "creative" set "options". For "clarification" set "reply". For "not_for_ahmed" leave all three null.`;

function buildUserPrompt({ fileName, comment, node, thread }) {
  const replies = (thread ?? [])
    .map((r) => `  - ${r.user?.handle ?? "someone"}: ${r.message}`)
    .join("\n");

  const nodeSummary = node
    ? `name="${node.name}", type=${node.type}, children=${(node.children ?? [])
        .map((c) => `${c.name}(${c.type})`)
        .slice(0, 20)
        .join(", ")}`
    : "no node attached (general/canvas comment)";

  return `FILE: ${fileName}
COMMENT (${comment.user?.handle ?? "someone"}): ${comment.message}
ATTACHED NODE: ${nodeSummary}
TARGET NODE ID: ${comment.client_meta?.node_id ?? "none"}
THREAD REPLIES:
${replies || "  (none)"}

Classify and draft per your instructions. Respond with only the JSON object.`;
}

function parseVerdict(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object in model output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

// Headless call to Claude Code. --output-format json wraps the answer in a
// result envelope; we pull `.result` then extract our JSON from it.
// stdin is set to /dev/null ("ignore") so the CLI doesn't sit waiting on a
// non-TTY pipe in CI (which otherwise fails the call).
function callClaude(userPrompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", userPrompt, "--output-format", "json", "--system-prompt", SYSTEM_PROMPT],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 400)}`));
      }
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) {
          return reject(new Error(envelope.result || "claude returned an error"));
        }
        resolve(envelope.result ?? "");
      } catch (e) {
        reject(new Error(`bad claude json: ${e.message} :: ${out.slice(0, 200)}`));
      }
    });
  });
}

export async function classifyAndDraft(input) {
  try {
    const text = await callClaude(buildUserPrompt(input));
    return parseVerdict(text);
  } catch (err) {
    // Never crash the whole run on one bad call — degrade to a clarification.
    return {
      category: "clarification",
      rationale: `Auto-triage failed for this one (${err.message}).`,
      job: null,
      options: null,
      reply: "I couldn't auto-triage this one — flagging it for a manual look.",
    };
  }
}
