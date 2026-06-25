// Pure path and path-display helpers shared across the renderer.
// No DOM/Electron dependencies, so these are unit-testable in Node.

export function basename(remotePath) {
  return remotePath?.split(/[\\/]/).filter(Boolean).pop() || "Remote file";
}

export function dirname(remotePath) {
  const normalized = remotePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  parts.pop();
  const directory = parts.join("/");
  // A bare relative name ("README.md") has no parent segment: report "." so it
  // matches the working directory the SFTP layer records, not the filesystem
  // root. Absolute paths ("/README.md") still resolve their parent to "/".
  return directory || (normalized.startsWith("/") ? "/" : ".");
}

export function localDirname(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  const slashIndex = trimmed.lastIndexOf("/");

  if (slashIndex < 0) return ".";
  if (slashIndex === 0) return "/";
  if (slashIndex === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, slashIndex);
}

export function canGoUp(remotePath) {
  return remotePath && remotePath !== "." && remotePath !== "/";
}

export function localCanGoUp(directory) {
  if (!directory || directory === "." || directory === "/") return false;
  return !/^[A-Za-z]:\/?$/.test(directory.replace(/\\/g, "/"));
}

export function parentRemotePath(remotePath) {
  if (!canGoUp(remotePath)) return remotePath || ".";
  const normalized = remotePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = normalized.split("/").slice(0, -1).join("/");
  return parent || (normalized.startsWith("/") ? "/" : ".");
}

export function localParentPath(directory) {
  if (!localCanGoUp(directory)) return directory || ".";
  return localDirname(directory);
}

export function compactPath(value) {
  if (!value) return "";
  const normalized = String(value).replace(/\\/g, "/");
  const homeMatch = normalized.match(/^(?:[A-Za-z]:)?\/Users\/[^/]+(\/.*)?$/i);
  if (homeMatch) return `~${homeMatch[1] || ""}`;
  if (normalized.length <= 34) return normalized;
  return `...${normalized.slice(-31)}`;
}

export function compactPathStart(value, maxLength) {
  if (!value || value.length <= maxLength) return value;

  const normalized = String(value).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return `...${normalized.slice(-(maxLength - 3))}`;

  const tail = [parts[parts.length - 1]];

  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const nextTail = [parts[index], ...tail];
    const candidate = `.../${nextTail.join("/")}`;
    if (candidate.length > maxLength) break;
    tail.unshift(parts[index]);
  }

  const display = `.../${tail.join("/")}`;
  return display.length <= maxLength ? display : `...${display.slice(-(maxLength - 3))}`;
}

export function formatSidebarDirectoryPath(value) {
  if (!value) return null;

  const full = String(value).replace(/\\/g, "/");
  const readable = full
    .replace(/^(?:[A-Za-z]:)?\/Users\/[^/]+(?=\/|$)/i, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/i, "~");

  return { full, display: compactPathStart(readable, 30) };
}

export function normalizeLocalComparisonPath(value) {
  const normalized = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function pathsReferToSameLocalFile(left, right) {
  if (!left || !right) return false;
  return normalizeLocalComparisonPath(left) === normalizeLocalComparisonPath(right);
}
