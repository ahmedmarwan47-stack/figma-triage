// Figma REST helpers. All reads use a personal access token (X-Figma-Token).
// Figma has NO write API for design content — the only write we do here is
// posting a comment reply, and that stays gated behind explicit approval
// (see reply-figma.mjs). Node 20+ global fetch, zero dependencies.

const BASE = "https://api.figma.com";

function authHeaders(token) {
  return { "X-Figma-Token": token };
}

async function figmaGet(token, path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Figma GET ${path} → ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
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
 * Returns [{ key, name }]. Explicit fileKeys start with `name = key`; we
 * upgrade to the real file name via `GET /v1/files/:key?depth=1` (cheap —
 * depth=1 skips the full document tree).
 */
export async function resolveFiles(token, { teamIds = [], fileKeys = [] }) {
  const byKey = new Map();

  for (const key of fileKeys) {
    if (key && !byKey.has(key)) byKey.set(key, { key, name: key });
  }

  for (const teamId of teamIds) {
    const projects = await getTeamProjects(token, teamId);
    for (const project of projects) {
      const files = await getProjectFiles(token, project.id);
      for (const f of files) {
        if (!byKey.has(f.key)) byKey.set(f.key, { key: f.key, name: f.name });
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

/** Node metadata (name, type, children, styles) for the commented node. */
export async function getNode(token, fileKey, nodeId) {
  const data = await figmaGet(
    token,
    `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
  );
  return data.nodes?.[nodeId]?.document ?? null;
}

/**
 * Local paint + text styles defined in the file. We feed these to Claude so it
 * only picks styleName / textStyleName / colorStyleName values that actually
 * exist in the target file — otherwise setFillStyle / setTextStyle throw at
 * apply time with "no local style X". Pagination: the endpoint is cursor-based
 * but the default page (~100) covers a typical design-system file.
 */
export async function getFileStyles(token, fileKey) {
  const data = await figmaGet(token, `/v1/files/${fileKey}/styles`);
  const raw = data.meta?.styles ?? [];
  const buckets = { FILL: new Set(), TEXT: new Set(), EFFECT: new Set(), GRID: new Set() };
  for (const s of raw) {
    if (buckets[s.style_type] && s.name) buckets[s.style_type].add(s.name);
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
