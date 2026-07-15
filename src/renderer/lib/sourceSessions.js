import { basename, localDirname, normalizeLocalComparisonPath } from "./paths.js";
import { formatSourcePathDetail } from "./format.js";

function normalizedDisplayPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function localRootForSession(session) {
  return normalizedDisplayPath(
    session?.rootPath || session?.directory || (session?.selectedPath ? localDirname(session.selectedPath) : "")
  );
}

function sessionTime(session) {
  const timestamp = Date.parse(session?.updatedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sourceSessionIdentity(session) {
  if (!session || typeof session !== "object") return "";
  if (session.kind === "remote") return session.id ? `remote:${session.id}` : "";
  if (session.kind !== "local-file" && session.kind !== "local-folder") return "";
  const root = localRootForSession(session);
  return root ? `local:${normalizeLocalComparisonPath(root)}` : "";
}

function mergeLocalSessions(sessions) {
  const newest = sessions[0];
  const rootPath = localRootForSession(newest) || sessions.map(localRootForSession).find(Boolean) || "";
  const selectedPath = sessions.find((session) => session.selectedPath)?.selectedPath || "";
  const directory = normalizedDisplayPath(newest.directory) || rootPath;

  return {
    ...newest,
    id: `local-folder:${rootPath}`,
    kind: "local-folder",
    label: basename(rootPath) || "local folder",
    detail: selectedPath ? basename(selectedPath) : formatSourcePathDetail(directory || rootPath),
    title: rootPath,
    tag: "local",
    rootPath,
    directory,
    selectedPath
  };
}

// Sources represent workspaces/connections; individual documents belong in the
// tab strip. Older builds persisted every directly opened local file as its own
// source, so collapse those records by canonical parent directory on load and
// after every upsert. The newest record supplies the active document and browse
// directory while the stable folder identity prevents the list growing again.
export function consolidateSourceSessions(sourceSessions, limit = 8) {
  if (!Array.isArray(sourceSessions)) return [];
  const ranked = sourceSessions
    .map((session, index) => ({ session, index, time: sessionTime(session) }))
    .filter(({ session }) => sourceSessionIdentity(session))
    .sort((left, right) => right.time - left.time || left.index - right.index);
  const groups = new Map();

  for (const candidate of ranked) {
    const identity = sourceSessionIdentity(candidate.session);
    const group = groups.get(identity);
    if (group) group.push(candidate.session);
    else groups.set(identity, [candidate.session]);
  }

  return Array.from(groups.values())
    .map((sessions) =>
      sessions[0].kind === "local-file" || sessions[0].kind === "local-folder"
        ? mergeLocalSessions(sessions)
        : sessions[0]
    )
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function buildLocalWorkspaceSourceSession(
  filePath,
  directory = localDirname(filePath),
  sessionId = ""
) {
  const rootPath = normalizedDisplayPath(directory || localDirname(filePath));
  const canonicalId = `local-folder:${rootPath}`;
  return {
    id: sessionId.startsWith("local-folder:") ? sessionId : canonicalId,
    kind: "local-folder",
    label: basename(rootPath) || "local folder",
    detail: filePath ? basename(filePath) : formatSourcePathDetail(rootPath),
    title: rootPath,
    tag: "local",
    rootPath,
    directory: rootPath,
    selectedPath: filePath || "",
    updatedAt: new Date().toISOString()
  };
}
