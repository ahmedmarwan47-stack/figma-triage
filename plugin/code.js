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
    const title =
      msg.job.job?.title || (msg.job.category === "creative" ? "Direction options" : "Edit");
    try {
      await applyJob(msg.job);
      figma.ui.postMessage({ type: "applied", ok: true, title });
      figma.notify(`Applied: ${title}`);
    } catch (err) {
      // Some Figma Plugin API rejections don't carry a .message — fall back to
      // stringifying so we never surface "Failed: undefined" with no clue.
      const errMsg = errorMessage(err);
      console.error("[Claude Comments] apply failed:", err);
      figma.ui.postMessage({ type: "applied", ok: false, title, error: errMsg });
      figma.notify(`Failed: ${errMsg}`, { error: true });
    }
  }
};

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

async function applyJob(entry) {
  await ensureClaudePage();
  const paints = await paintStyleMap();
  const texts = await textStyleMap();
  const targetId = entry.job?.targetNodeId || entry.nodeId;

  if (entry.category === "creative") {
    return applyCreative(entry, targetId, texts);
  }

  const { frame, root, created, applied } = await ensureContainerForTarget(targetId);
  if (applied.has(String(entry.commentId))) {
    figma.notify(`Already applied: ${entry.job?.title || "Edit"}`);
    figma.currentPage.selection = [frame];
    figma.viewport.scrollAndZoomIntoView([frame]);
    return;
  }

  const ops = entry.job?.ops || [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      switch (op.op) {
        case "duplicateTarget":
          // No-op: the container already holds the single clone we share.
          break;
        case "setText":
          await setText(root || frame, op.match, op.characters);
          break;
        case "setFillStyle":
          await setFillStyle(root || frame, op.match, op.styleName, paints);
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

  applied.add(String(entry.commentId));
  frame.setPluginData(APPLIED_KEY, [...applied].join(","));

  if (created) placeOnCanvas(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
}

async function applyCreative(entry, targetId, texts) {
  const existing = figma.currentPage.findOne(
    (n) => n.type === "FRAME" && n.getPluginData(COMMENT_KEY) === String(entry.commentId),
  );
  if (existing) {
    figma.notify(`Already applied: ${entry.job?.title || "Directions"}`);
    figma.currentPage.selection = [existing];
    figma.viewport.scrollAndZoomIntoView([existing]);
    return;
  }
  const outer = makeAutoFrame(`[Comment ${short(entry.commentId)}] Directions`);
  outer.layoutMode = "HORIZONTAL";
  outer.itemSpacing = 24;
  outer.paddingTop = outer.paddingBottom = 32;
  outer.paddingLeft = outer.paddingRight = 32;

  // Comment preamble at the top of the outer frame (column of the outer's
  // main-axis parent — since outer is HORIZONTAL we wrap the comment text
  // into a sibling row above via a vertical wrapper).
  const wrapper = makeAutoFrame(`[Claude] Directions ${short(entry.commentId)}`);
  wrapper.itemSpacing = 20;
  const commentText = await makePluginText(
    `“${entry.commentText || ""}”`,
    { size: 14, bold: true },
  );
  wrapper.appendChild(commentText);
  wrapper.appendChild(outer);

  const options = entry.options || [];
  for (const opt of options) {
    const col = makeAutoFrame(opt.label || "Option");
    col.itemSpacing = 12;
    col.paddingTop = col.paddingBottom = 20;
    col.paddingLeft = col.paddingRight = 20;
    col.resize(320, col.height); // fixed column width so text wraps predictably
    col.primaryAxisSizingMode = "AUTO";
    col.counterAxisSizingMode = "FIXED";
    col.strokes = [{ type: "SOLID", color: { r: 0.75, g: 0.75, b: 0.75 } }];
    col.strokeWeight = 1;
    col.cornerRadius = 8;

    col.appendChild(await makePluginText(opt.label || "Option", { size: 16, bold: true }));
    col.appendChild(await makePluginText(opt.caption || "", { size: 12 }));
    if (opt.aiPrompt) {
      col.appendChild(await makePluginText("AI prompt:", { size: 11, bold: true }));
      col.appendChild(await makePluginText(opt.aiPrompt, { size: 11 }));
    }
    outer.appendChild(col);
  }

  // Mark applied AFTER all columns built successfully, so a mid-build failure
  // doesn't leave a broken frame that's flagged done.
  wrapper.setPluginData(COMMENT_KEY, String(entry.commentId));

  placeOnCanvas(wrapper);
  figma.currentPage.selection = [wrapper];
  figma.viewport.scrollAndZoomIntoView([wrapper]);
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
