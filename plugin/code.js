// Claude Comments — applies the reporter's drafted edits onto a dedicated
// "Claude Comments" page. Never touches the source page. Executes only the
// declarative op vocabulary the reporter emits (kept in sync with llm.mjs).
//
// Ahmed's principles enforced here: auto layout on every frame, local styles
// resolved BY NAME (never hardcoded hex/px), text color applied as a separate
// paint style, the resize→HUG dance for wrapping text.

const PAGE_NAME = "Claude Comments";
const STORE_KEY = "jobsBaseUrl";

figma.showUI(__html__, { width: 380, height: 620 });

(async () => {
  const jobsBaseUrl = await figma.clientStorage.getAsync(STORE_KEY);
  figma.ui.postMessage({ type: "init", fileKey: figma.fileKey, jobsBaseUrl });
})();

figma.ui.onmessage = async (msg) => {
  if (msg.type === "saveBase") {
    await figma.clientStorage.setAsync(STORE_KEY, msg.jobsBaseUrl);
    return;
  }
  if (msg.type === "apply") {
    const optLabel =
      msg.optionIndex != null ? msg.job.options?.[msg.optionIndex]?.label : null;
    const title =
      optLabel || msg.job.job?.title || (msg.job.category === "creative" ? "Direction options" : "Edit");
    enqueueApply(msg.job, title, msg.optionIndex);
  }
};

// Serialize apply operations so back-to-back Applies (from "Apply all" or
// two clicks in a row) don't race inside ensureContainerForTarget. Without
// this, apply #2's findOne fires BEFORE apply #1's newly-created container
// has been fully set up, so both create separate containers and you end up
// with N duplicated source subtrees on the Claude Comments page.
const applyQueue = [];
let queueRunning = false;

function enqueueApply(job, title, optionIndex) {
  applyQueue.push({ job, title, optionIndex });
  runQueue();
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (applyQueue.length) {
      const { job, title, optionIndex } = applyQueue.shift();
      try {
        await applyJob(job, optionIndex);
        figma.ui.postMessage({ type: "applied", ok: true, title });
        figma.notify(`Applied: ${title}`);
      } catch (err) {
        const errMsg = errorMessage(err);
        console.error("[Claude Comments] apply failed:", err);
        figma.ui.postMessage({ type: "applied", ok: false, title, error: errMsg });
        figma.notify(`Failed: ${errMsg}`, { error: true });
      }
    }
  } finally {
    queueRunning = false;
  }
}

function errorMessage(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

// ---- style + font resolution ----------------------------------------------

async function paintStyleMap() {
  const styles = await figma.getLocalPaintStylesAsync();
  const map = new Map();
  for (const s of styles) map.set(s.name, s.id);
  return map;
}

async function textStyleMap() {
  const styles = await figma.getLocalTextStylesAsync();
  const map = new Map();
  for (const s of styles) map.set(s.name, s.id);
  return map;
}

async function loadFontsForNode(node) {
  const texts = node.type === "TEXT" ? [node] : node.findAllWithCriteria
    ? node.findAllWithCriteria({ types: ["TEXT"] })
    : [];
  const seen = new Set();
  for (const t of texts) {
    const fonts = t.getRangeAllFontNames(0, Math.max(t.characters.length, 1));
    for (const f of fonts) {
      const key = `${f.family}__${f.style}`;
      if (!seen.has(key)) {
        seen.add(key);
        await figma.loadFontAsync(f);
      }
    }
  }
}

// ---- page + frame plumbing -------------------------------------------------

async function ensureClaudePage() {
  await figma.loadAllPagesAsync();
  let page = figma.root.children.find((p) => p.name === PAGE_NAME);
  if (!page) {
    page = figma.createPage();
    page.name = PAGE_NAME;
  }
  await figma.setCurrentPageAsync(page);
  return page;
}

function makeAutoFrame(name) {
  const frame = figma.createFrame();
  frame.name = name;
  frame.layoutMode = "VERTICAL";
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "AUTO";
  frame.itemSpacing = 16;
  frame.paddingTop = frame.paddingBottom = 24;
  frame.paddingLeft = frame.paddingRight = 24;
  return frame;
}

// Plugin-side text (labels, captions inside our review frames). Uses plain
// Inter with no dependency on the user's local text styles — those aren't
// guaranteed to exist and are fragile to depend on for our own chrome.
async function makePluginText(chars, { size = 12, bold = false, fill } = {}) {
  const t = figma.createText();
  const style = bold ? "Bold" : "Regular";
  await figma.loadFontAsync({ family: "Inter", style });
  t.fontName = { family: "Inter", style };
  t.fontSize = size;
  t.characters = chars || " ";
  if (fill) t.fills = [{ type: "SOLID", color: fill }];
  t.layoutSizingHorizontal = "FILL";
  return t;
}

// ---- op matching -----------------------------------------------------------

function normalizeWs(s) {
  // Collapse Figma's soft returns (), hard returns, and multi-space runs
  // so `characters.includes(snippet)` doesn't miss because of wrapping.
  return String(s ?? "").replace(/[\s]+/g, " ").trim();
}

function findMatch(root, match) {
  if (!match) return root;
  const target = String(match);
  // 1. exact layer-name match
  let hit = root.findOne ? root.findOne((n) => n.name === target) : null;
  if (hit) return hit;
  // 2. case-insensitive layer-name match
  if (root.findAll) {
    const lc = target.toLowerCase();
    hit = root.findAll((n) => n.name && n.name.toLowerCase() === lc)[0];
    if (hit) return hit;
  }
  // 3. text-content match, whitespace-normalized so \n /  don't hide it
  const targetNorm = normalizeWs(target).toLowerCase();
  if (root.findAll && targetNorm) {
    hit = root.findAll(
      (n) => n.type === "TEXT" && normalizeWs(n.characters).toLowerCase().includes(targetNorm),
    )[0];
  }
  return hit || null;
}

// ---- ops -------------------------------------------------------------------

async function setText(root, match, characters) {
  const node = findMatch(root, match);
  if (!node || node.type !== "TEXT") throw new Error(`setText: no text node for "${match}"`);
  await loadFontsForNode(node);
  // resize → HUG dance so wrapping text doesn't collapse to zero width
  const w = node.width || 200;
  node.resize(w, 100);
  node.textAutoResize = "HEIGHT";
  node.characters = characters;
}

async function setFillStyle(root, match, styleName, paints) {
  const node = findMatch(root, match);
  if (!node) throw new Error(`setFillStyle: no node for "${match}"`);
  const id = paints.get(styleName);
  if (!id) throw new Error(`setFillStyle: no local paint style "${styleName}"`);
  await node.setFillStyleIdAsync(id);
}

async function setTextStyle(root, match, textStyleName, colorStyleName, texts, paints) {
  const node = findMatch(root, match);
  if (!node || node.type !== "TEXT") throw new Error(`setTextStyle: no text node for "${match}"`);
  await loadFontsForNode(node);
  if (textStyleName) {
    const id = texts.get(textStyleName);
    if (!id) throw new Error(`setTextStyle: no local text style "${textStyleName}"`);
    await node.setTextStyleIdAsync(id);
  }
  if (colorStyleName) {
    const cid = paints.get(colorStyleName);
    if (!cid) throw new Error(`setTextStyle: no local paint style "${colorStyleName}"`);
    await node.setFillStyleIdAsync(cid); // text color is a separate paint style
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`bad hex color "${hex}"`);
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// Raw-color fallback for files without a matching local style (the reporter
// instructs Claude to prefer style names and only emit hex when nothing fits).
async function setFillColor(root, match, hex) {
  const node = findMatch(root, match);
  if (!node) throw new Error(`setFillColor: no node for "${match}"`);
  if (node.type === "TEXT") await loadFontsForNode(node);
  node.fills = [{ type: "SOLID", color: hexToRgb(hex) }];
}

// Shared op executor — mechanical jobs and creative direction options both
// run through here so the vocabulary stays in one place.
async function runOps(ops, root, frame, { paints, texts }) {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      switch (op.op) {
        case "duplicateTarget":
          // No-op: the caller's container already owns the single clone.
          break;
        case "setText":
          await setText(root || frame, op.match, op.characters);
          break;
        case "setFillStyle":
          await setFillStyle(root || frame, op.match, op.styleName, paints);
          break;
        case "setFillColor":
          await setFillColor(root || frame, op.match, op.hex);
          break;
        case "setTextStyle":
          await setTextStyle(root || frame, op.match, op.textStyleName, op.colorStyleName, texts, paints);
          break;
        case "removeNode": {
          const n = findMatch(root || frame, op.match);
          if (n) n.remove();
          break;
        }
        case "cloneNode": {
          const n = findMatch(root || frame, op.match);
          if (n && "clone" in n) n.parent.appendChild(n.clone());
          break;
        }
        default:
          throw new Error(`unknown op "${op.op}"`);
      }
    } catch (err) {
      throw new Error(`op #${i + 1} "${op.op}" failed: ${errorMessage(err)}`);
    }
  }
}

// ---- job application -------------------------------------------------------

const TARGET_KEY = "claudeCommentsTargetId";
const COMMENT_KEY = "claudeCommentsCommentId";
const APPLIED_KEY = "claudeCommentsAppliedCommentIds"; // comma-separated

async function cloneTarget(targetNodeId) {
  if (!targetNodeId) throw new Error("no target node id");
  const src = await figma.getNodeByIdAsync(targetNodeId);
  if (!src || !("clone" in src)) throw new Error(`target ${targetNodeId} not cloneable`);
  return src.clone();
}

// One container per unique target node ID on the Claude Comments page.
// Every Apply for a comment on that same node lands inside this one clone,
// so you don't get N duplicates of the source page when there are N comments
// (and hitting Apply twice on the same card is a no-op).
async function ensureContainerForTarget(targetId) {
  const existing = figma.currentPage.findOne(
    (n) => n.type === "FRAME" && n.getPluginData(TARGET_KEY) === String(targetId),
  );
  if (existing) {
    const applied = (existing.getPluginData(APPLIED_KEY) || "").split(",").filter(Boolean);
    return { frame: existing, root: existing.children[0] || null, created: false, applied: new Set(applied) };
  }
  const src = await figma.getNodeByIdAsync(targetId);
  if (!src || !("clone" in src)) throw new Error(`target ${targetId} not cloneable`);
  const label = src.name || `Target ${short(targetId)}`;
  const frame = makeAutoFrame(`[Claude] ${label}`);
  frame.setPluginData(TARGET_KEY, String(targetId));
  const root = src.clone();
  frame.appendChild(root);
  return { frame, root, created: true, applied: new Set() };
}

async function applyJob(entry, optionIndex) {
  await ensureClaudePage();
  const paints = await paintStyleMap();
  const texts = await textStyleMap();
  const targetId = entry.job?.targetNodeId || entry.nodeId;

  if (entry.category === "creative") {
    return applyCreativeOption(entry, targetId, optionIndex, { paints, texts });
  }

  const { frame, root, created, applied } = await ensureContainerForTarget(targetId);
  if (applied.has(String(entry.commentId))) {
    figma.notify(`Already applied: ${entry.job?.title || "Edit"}`);
    figma.currentPage.selection = [frame];
    figma.viewport.scrollAndZoomIntoView([frame]);
    return;
  }

  await runOps(entry.job?.ops || [], root, frame, { paints, texts });

  applied.add(String(entry.commentId));
  frame.setPluginData(APPLIED_KEY, [...applied].join(","));

  if (created) placeOnCanvas(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
}

// A creative direction applies like a mechanical job, but onto its OWN clone
// (one per option, labeled), so you can Apply two directions side by side and
// compare. Direction ops are Claude's compilation of the direction into the
// declarative vocabulary; the aiPrompt remains available as an alternative
// path through Figma's native AI.
async function applyCreativeOption(entry, targetId, optionIndex, styleMaps) {
  const options = entry.options || [];
  const opt = options[optionIndex];
  if (!opt) throw new Error(`no direction option at index ${optionIndex}`);

  const dedupKey = `${entry.commentId}:${optionIndex}`;
  const existing = figma.currentPage.findOne(
    (n) => n.type === "FRAME" && n.getPluginData(COMMENT_KEY) === dedupKey,
  );
  if (existing) {
    figma.notify(`Already applied: ${opt.label || "Direction"}`);
    figma.currentPage.selection = [existing];
    figma.viewport.scrollAndZoomIntoView([existing]);
    return;
  }

  const frame = makeAutoFrame(`[Direction] ${opt.label || `Option ${optionIndex + 1}`}`);
  frame.appendChild(
    await makePluginText(`“${entry.commentText || ""}” → ${opt.label || ""}`, {
      size: 13,
      bold: true,
    }),
  );
  if (opt.caption) frame.appendChild(await makePluginText(opt.caption, { size: 11 }));

  // Before / after, side by side: an untouched clone next to the clone the
  // direction ops run on, each under a label.
  const row = makeAutoFrame("Before / After");
  row.layoutMode = "HORIZONTAL";
  row.itemSpacing = 48;
  row.paddingTop = row.paddingBottom = 0;
  row.paddingLeft = row.paddingRight = 0;

  const beforeCol = makeAutoFrame("Before");
  beforeCol.paddingTop = beforeCol.paddingBottom = 0;
  beforeCol.paddingLeft = beforeCol.paddingRight = 0;
  beforeCol.appendChild(await makePluginText("BEFORE", { size: 11, bold: true }));
  beforeCol.appendChild(await cloneTarget(targetId));

  const afterCol = makeAutoFrame("After");
  afterCol.paddingTop = afterCol.paddingBottom = 0;
  afterCol.paddingLeft = afterCol.paddingRight = 0;
  afterCol.appendChild(await makePluginText("AFTER", { size: 11, bold: true }));
  const root = await cloneTarget(targetId);
  afterCol.appendChild(root);

  row.appendChild(beforeCol);
  row.appendChild(afterCol);
  frame.appendChild(row);

  await runOps(opt.ops || [], root, afterCol, styleMaps);

  // Mark applied only after the ops all succeeded, so a failed direction can
  // be retried after fixing the draft.
  frame.setPluginData(COMMENT_KEY, dedupKey);

  placeOnCanvas(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
}

// ---- helpers ---------------------------------------------------------------

function placeOnCanvas(frame) {
  // drop new frames below whatever already exists on the page, left-aligned
  const others = figma.currentPage.children.filter((n) => n !== frame);
  let y = 0;
  for (const n of others) y = Math.max(y, n.y + n.height + 80);
  frame.x = 0;
  frame.y = y;
}

function short(id) {
  return String(id).slice(0, 8);
}
