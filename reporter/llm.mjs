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
  IMPORTANT: setFillStyle changes the fill of whatever node "match" resolves to.
  To change a BUTTON or CARD background, "match" MUST be the CONTAINER frame
  (from the "inside:" chain of the label text — e.g. "Primary CTA" or "Button"),
  NOT the label text inside it. Never pass a text-content snippet like "ENQUIRE
  NOW" as match for a button-fill change — that hits the label's own fill and
  leaves the button background untouched. Use setTextStyle (colorStyleName) for
  the label's color, and setFillStyle on the container frame for the background.
- { "op": "setTextStyle", "match": "<node name>", "textStyleName": "Body/l" | null, "colorStyleName": "Tone/900" | null }
  Either field may be null — supply ONLY what the comment actually asks for.
  If the comment only mentions color, contrast, tone, or "make it lighter/darker",
  set textStyleName to null and supply just colorStyleName. Do NOT restyle typography
  unless the comment explicitly asks to change the font, size, weight, or hierarchy.
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

// Walk the node subtree and collect every TEXT descendant so Claude can target
// real layer names for setText / setTextStyle instead of guessing. When we know
// where the comment pin lives (client_meta.node_offset + the parent node's
// absoluteBoundingBox), sort nearest-first — Figma frames often contain many
// titles/labels, and without spatial context Claude picks the wrong one.
function nodeCenter(node) {
  const b = node?.absoluteBoundingBox;
  if (!b) return null;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function collectTextLayers(node, out = [], chain = []) {
  if (!node) return out;
  if (node.type === "TEXT") {
    out.push({
      name: node.name,
      characters: (node.characters ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      center: nodeCenter(node),
      // ancestor chain root→leaf, excluding the TEXT node itself. Used to help
      // Claude distinguish a button FRAME from the LABEL text inside it —
      // otherwise setFillStyle match="ENQUIRE NOW" ends up on the label, not
      // the button background.
      chain: [...chain],
    });
  }
  if (Array.isArray(node.children)) {
    const nextChain =
      node.type !== "TEXT" ? [...chain, `"${node.name}"(${node.type})`] : chain;
    for (const c of node.children) collectTextLayers(c, out, nextChain);
  }
  return out;
}

function pinAbsolutePosition(comment, node) {
  const nb = node?.absoluteBoundingBox;
  const off = comment.client_meta?.node_offset;
  if (!nb || !off) return null;
  return { x: nb.x + off.x, y: nb.y + off.y };
}

function distanceRounded(a, b) {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
}

function buildUserPrompt({ fileName, comment, node, thread, localStyles }) {
  const replies = (thread ?? [])
    .map((r) => `  - ${r.user?.handle ?? "someone"}: ${r.message}`)
    .join("\n");

  const nodeSummary = node
    ? `name="${node.name}", type=${node.type}, children=${(node.children ?? [])
        .map((c) => `${c.name}(${c.type})`)
        .slice(0, 20)
        .join(", ")}`
    : "no node attached (general/canvas comment)";

  const pin = node ? pinAbsolutePosition(comment, node) : null;
  const layers = node ? collectTextLayers(node) : [];

  let ranked = layers;
  if (pin) {
    ranked = layers
      .map((l) => ({ ...l, dist: l.center ? distanceRounded(pin, l.center) : Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.dist - b.dist);
  }
  ranked = ranked.slice(0, 25);

  const textInventory = ranked.length
    ? ranked
        .map((t) => {
          const distStr = pin && Number.isFinite(t.dist) ? ` (${t.dist}px from pin)` : "";
          // Include the last 3 ancestors so Claude can target a button FRAME
          // or CARD by name instead of misdirecting setFillStyle at the
          // label text inside it.
          const chain = (t.chain || []).slice(-3).join(" → ");
          const chainStr = chain ? `\n      inside: ${chain}` : "";
          return `  - "${t.name}" — current text: "${t.characters}"${distStr}${chainStr}`;
        })
        .join("\n")
    : "  (no text layers found in this node)";

  const inventoryHeader = pin
    ? `TEXT LAYERS INSIDE THIS NODE (SORTED BY DISTANCE TO THE COMMENT PIN — the FIRST entry is the one the pin is anchored to; prefer it for setText/setTextStyle "match" UNLESS the comment explicitly names a different layer or text). Use the layer's EXACT name from this list — never invent names like "Title" or "Heading":`
    : `TEXT LAYERS INSIDE THIS NODE (for setText/setTextStyle "match", use these EXACT layer names — do not invent generic names like "Title" or "Heading"):`;

  const pinLine = pin
    ? `COMMENT PIN POSITION (canvas coords): x=${Math.round(pin.x)}, y=${Math.round(pin.y)}`
    : "COMMENT PIN POSITION: unknown";

  const paintList = (localStyles?.paint ?? []).map((n) => `  - ${n}`).join("\n") || "  (none)";
  const textList = (localStyles?.text ?? []).map((n) => `  - ${n}`).join("\n") || "  (none)";
  const hasStyles = (localStyles?.paint?.length ?? 0) + (localStyles?.text?.length ?? 0) > 0;

  const stylesBlock = hasStyles
    ? `LOCAL PAINT STYLES (the ONLY valid values for setFillStyle "styleName" and setTextStyle "colorStyleName" — if the perfect one isn't here, pick the CLOSEST match by family/number, never invent):
${paintList}
LOCAL TEXT STYLES (the ONLY valid values for setTextStyle "textStyleName" — omit textStyleName entirely if none of these fit):
${textList}`
    : `LOCAL PAINT / TEXT STYLES: (none fetched — pick names cautiously from Ahmed's principles, and prefer to omit style-driven ops if unsure)`;

  return `FILE: ${fileName}
COMMENT (${comment.user?.handle ?? "someone"}): ${comment.message}
ATTACHED NODE: ${nodeSummary}
TARGET NODE ID: ${comment.client_meta?.node_id ?? "none"}
${pinLine}
${inventoryHeader}
${textInventory}
${stylesBlock}
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

// Belt-and-braces guard: if Claude still names a style that isn't in the file
// (rare with the tightened prompt, but possible), strip the offending field
// rather than emit a job that will throw at apply time. The plugin's ops treat
// missing fields as no-ops.
function sanitizeAgainstStyles(verdict, localStyles) {
  if (!verdict?.job?.ops || !localStyles) return verdict;
  const paint = new Set(localStyles.paint ?? []);
  const text = new Set(localStyles.text ?? []);
  const kept = [];
  const dropped = [];
  for (const op of verdict.job.ops) {
    if (op.op === "setFillStyle" && op.styleName && paint.size && !paint.has(op.styleName)) {
      dropped.push(`setFillStyle→"${op.styleName}"`);
      continue;
    }
    if (op.op === "setTextStyle") {
      if (op.textStyleName && text.size && !text.has(op.textStyleName)) {
        dropped.push(`textStyle→"${op.textStyleName}"`);
        op.textStyleName = null;
      }
      if (op.colorStyleName && paint.size && !paint.has(op.colorStyleName)) {
        dropped.push(`colorStyle→"${op.colorStyleName}"`);
        op.colorStyleName = null;
      }
      if (!op.textStyleName && !op.colorStyleName) continue;
    }
    kept.push(op);
  }
  if (dropped.length) {
    console.warn(`[llm] dropped ops referencing missing styles: ${dropped.join(", ")}`);
    verdict.job.ops = kept;
    if (verdict.rationale) {
      verdict.rationale += ` (dropped ops for missing local styles: ${dropped.join(", ")})`;
    }
  }
  return verdict;
}

export async function classifyAndDraft(input) {
  try {
    const text = await callClaude(buildUserPrompt(input));
    const verdict = parseVerdict(text);
    return sanitizeAgainstStyles(verdict, input.localStyles);
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
