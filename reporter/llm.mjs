// Classification + drafting via the official Anthropic SDK (Claude Opus 4.8).
// One call per comment. Returns a structured verdict the reporter turns into
// a Slack digest and apply-ready plugin jobs.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";

// Lazily constructed so importing this module doesn't require ANTHROPIC_API_KEY
// (lets index.mjs surface its own friendly env-var error first).
let _client = null;
function client() {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

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
  // The model is instructed to return only JSON; be defensive and extract the
  // first {...} block in case it adds anything around it.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object in model output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export async function classifyAndDraft(input) {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    return parseVerdict(text);
  } catch (err) {
    // Never crash the whole run on one bad parse — degrade to a clarification.
    return {
      category: "clarification",
      rationale: `Could not parse the model's verdict (${err.message}).`,
      job: null,
      options: null,
      reply:
        "I couldn't auto-triage this one — flagging it for a manual look.",
    };
  }
}
