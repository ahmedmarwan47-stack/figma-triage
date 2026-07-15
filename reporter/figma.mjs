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
 * Returns [{ key, name }].
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

  return [...byKey.values()];
}

/** All comments on a file (resolved and unresolved, with replies). */
export async function getFileComments(token, fileKey) {
  const data = await figmaGet(token, `/v1/files/${fileKey}/comments`);
  return data.comments ?? [];
}

/** Node metadata (name, type, children, styles) for the commented node. */
export async function getNode(token, fileKey, nodeId) {
  const data = await figmaGet(
    token,
    `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
  );
  return data.nodes?.[nodeId]?.document ?? null;
}

/** A rendered PNG URL for the node (scale 2). URLs are temporary — fine for a daily digest. */
export async function getNodeImage(token, fileKey, nodeId) {
  const data = await figmaGet(
    token,
    `/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&scale=2&format=png`,
  );
  return data.images?.[nodeId] ?? null;
}
