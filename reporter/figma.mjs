// Figma REST helpers. All reads use a personal access token (X-Figma-Token).
// Figma has NO write API for design content — the only write we do here is
// posting a comment reply, and that stays gated behind explicit approval
// (see reply-figma.mjs). Node 20+ global fetch, zero dependencies.

const BASE = "https://api.figma.com";

function authHeaders(token) {
  return { "X-Figma-Token": token };
}

async function figmaGet(token, path, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, { headers: authHeaders(token) });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    // Rate limits are routine when a run renders several node images —
    // honor Retry-After instead of dropping the screenshot.
    if (res.status === 429 && attempt < retries) {
      const waitS = Number(res.headers.get("retry-after")) || 10 * (attempt + 1);
      console.warn(
        `[figma] 429 on ${path} — waiting ${waitS}s (attempt ${attempt + 1}/${retries})`,
      );
      await new Promise((r) => setTimeout(r, waitS * 1000));
      continue;
    }
    throw new Error(`Figma GET ${path} → ${res.status} ${res.statusText} ${body}`);
  }
}

/** The authenticated user — used to figure out which comments mention Ahmed. */
export async function getMe(token) {
  return figmaGet(token, "/v1/me");
}

/** Every project in a team. */
export async function getTeamProjects(token, teamId) {
  const data = await figmaGet(token, `/v1/teams/${teamId}/projects`);
  return data.projects ?? [];
}

/** Every file in a project. */
export async function getProjectFiles(token, projectId) {
  const data = await figmaGet(token, `/v1/projects/${projectId}/files`);
  return data.files ?? [];
}

/**
 * Resolve the full set of file keys to scan: explicit config.fileKeys plus
 * every file discovered by walking each configured team → projects → files.
 * Returns [{ key, name, project }]. `project` is the Figma project (folder)
 * the file lives in — the dashboard groups by it, mirroring how the PM
 * organizes by client. Explicit fileKeys have `project = null` (we can't know
 * their folder without an extra call) and start with `name = key`; we upgrade
 * to the real file name via `GET /v1/files/:key?depth=1` (cheap — depth=1
 * skips the full document tree).
 */
export async function resolveFiles(token, { teamIds = [], fileKeys = [] }) {
  const byKey = new Map();

  for (const key of fileKeys) {
    if (key && !byKey.has(key)) byKey.set(key, { key, name: key, project: null });
  }

  for (const teamId of teamIds) {
    const projects = await getTeamProjects(token, teamId);
    for (const project of projects) {
      const files = await getProjectFiles(token, project.id);
      for (const f of files) {
        if (!byKey.has(f.key)) {
          byKey.set(f.key, { key: f.key, name: f.name, project: project.name ?? null });
        }
      }
    }
  }

  // Resolve friendly names for entries where name still equals the key
  // (i.e. came in through explicit fileKeys, not team walking).
  await Promise.all(
    [...byKey.values()].map(async (entry) => {
      if (entry.name && entry.name !== entry.key) return;
      try {
        const data = await figmaGet(token, `/v1/files/${entry.key}?depth=1`);
        if (data.name) entry.name = data.name;
      } catch (err) {
        // Keep the key as name — better than crashing the run.
        console.warn(`[figma] couldn't resolve file name for ${entry.key}: ${err.message}`);
      }
    }),
  );

  return [...byKey.values()];
}

/** All comments on a file (resolved and unresolved, with replies). */
export async function getFileComments(token, fileKey) {
  const data = await figmaGet(token, `/v1/files/${fileKey}/comments`);
  return data.comments ?? [];
}

/**
 * Fetch dev-mode annotations for a file. Figma's annotations API has been
 * gated over time — this call tries the current public endpoint and returns
 * an empty array on 404/403 so the pipeline doesn't crash on files/plans that
 * don't expose it. Successful responses are normalized to the same shape the
 * caller uses for comments (id, message, client_meta, user, created_at).
 */
export async function getFileAnnotations(token, fileKey) {
  try {
    const data = await figmaGet(token, `/v1/files/${fileKey}/annotations`);
    const annotations = data.annotations ?? data.meta?.annotations ?? [];
    console.log(
      `[figma] annotations for ${fileKey}: ${annotations.length} (endpoint alive)`,
    );
    return annotations.map((a) => normalizeAnnotation(a));
  } catch (err) {
    if (/\b(403|404)\b/.test(err.message)) {
      console.log(
        `[figma] annotations endpoint not available for ${fileKey} (${err.message.match(/\b(403|404)\b/)[0]}). Skipping.`,
      );
      return [];
    }
    console.warn(`[figma] annotations fetch failed for ${fileKey}: ${err.message}`);
    return [];
  }
}

function normalizeAnnotation(a) {
  // Shape defensively — fields vary across API versions. Keep the raw payload
  // available under `_raw` so we can iterate on parsing without another round-trip.
  const label = a.label ?? a.name ?? "";
  const properties = Array.isArray(a.properties)
    ? a.properties.map((p) => `${p.label ?? p.name ?? ""}: ${p.value ?? ""}`).join("; ")
    : "";
  return {
    id: `annotation:${a.id ?? a.node_id ?? ""}`,
    message: [label, properties].filter(Boolean).join(" — "),
    resolved_at: null,
    parent_id: null,
    created_at: a.created_at ?? new Date().toISOString(),
    user: { handle: a.author?.handle ?? "annotation" },
    client_meta: { node_id: a.node_id ?? null, node_offset: null },
    _raw: a,
    _isAnnotation: true,
  };
}

/**
 * Node metadata for the commented node, PLUS the styles referenced within
 * that subtree. The nodes endpoint returns a per-node `styles` map — the only
 * REST source that reliably surfaces unpublished local styles (the file-level
 * styles map is truncated by ?depth, and /styles lists published only).
 * Returns { document, styles: { paint: [names], text: [names] } }.
 */
export async function getNode(token, fileKey, nodeId) {
  const data = await figmaGet(
    token,
    `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
  );
  const entry = data.nodes?.[nodeId];
  const buckets = { FILL: new Set(), TEXT: new Set() };
  for (const s of Object.values(entry?.styles ?? {})) {
    if (s.remote) continue; // library style — not resolvable as local in the plugin
    if (buckets[s.styleType] && s.name) buckets[s.styleType].add(s.name);
  }
  return {
    document: entry?.document ?? null,
    styles: { paint: [...buckets.FILL].sort(), text: [...buckets.TEXT].sort() },
  };
}

/**
 * Paint + text styles available in the file. We feed these to Claude so it
 * only picks styleName / textStyleName / colorStyleName values that actually
 * exist in the target file — otherwise setFillStyle / setTextStyle throw at
 * apply time with "no local style X".
 *
 * Two sources, merged:
 *  - GET /v1/files/:key → top-level `styles` map: every style REFERENCED in
 *    the document, including unpublished local styles. (The /styles endpoint
 *    alone returned 0 for a file where the plugin happily resolved Navy/800 —
 *    that endpoint only lists PUBLISHED styles.)
 *  - GET /v1/files/:key/styles → published styles, kept as a supplement.
 */
export async function getFileStyles(token, fileKey) {
  const buckets = { FILL: new Set(), TEXT: new Set(), EFFECT: new Set(), GRID: new Set() };

  try {
    const doc = await figmaGet(token, `/v1/files/${fileKey}?depth=1`);
    for (const s of Object.values(doc.styles ?? {})) {
      // remote === true means a library style — the plugin resolves styles via
      // getLocalPaintStylesAsync, so only local ones are usable in ops.
      if (s.remote) continue;
      if (buckets[s.styleType] && s.name) buckets[s.styleType].add(s.name);
    }
  } catch (err) {
    console.warn(`[figma] document styles for ${fileKey}: ${err.message}`);
  }

  try {
    const pub = await figmaGet(token, `/v1/files/${fileKey}/styles`);
    for (const s of pub.meta?.styles ?? []) {
      if (buckets[s.style_type] && s.name) buckets[s.style_type].add(s.name);
    }
  } catch (err) {
    console.warn(`[figma] published styles for ${fileKey}: ${err.message}`);
  }

  return {
    paint: [...buckets.FILL].sort(),
    text: [...buckets.TEXT].sort(),
    effect: [...buckets.EFFECT].sort(),
    grid: [...buckets.GRID].sort(),
  };
}

/** A rendered PNG URL for the node (scale 2). URLs are temporary — fine for a daily digest. */
export async function getNodeImage(token, fileKey, nodeId) {
  const data = await figmaGet(
    token,
    `/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&scale=2&format=png`,
  );
  return data.images?.[nodeId] ?? null;
}
