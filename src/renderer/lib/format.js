// Pure formatting + label helpers shared across the renderer.
// No DOM/Electron dependencies, so these are unit-testable in Node.

import { formatSidebarDirectoryPath } from "./paths.js";

export function countWords(text) {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

export function countLines(text) {
  return Math.max(text.split(/\r\n|\r|\n/).length, 1);
}

export function formatLatency(value) {
  const rawLatency = Number(value);
  if (!Number.isFinite(rawLatency) || rawLatency < 1) return "<1ms";
  const latency = rawLatency < 10 ? Math.round(rawLatency * 10) / 10 : Math.round(rawLatency);
  return `${latency}ms`;
}

export function formatPoll(value) {
  const ms = Number(value) || 0;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}

export function formatFileTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

export function formatFileModifiedLabel(value) {
  const timestamp = formatFileTimestamp(value);
  return timestamp ? `edited ${timestamp}` : "";
}

export function healthCheckPendingMessage(context) {
  if (!context.hasNativeBackend) return "checking preview";
  if (context.documentSource === "remote") return "checking server";
  if (context.documentSource === "sample") return "checking sample";
  if (context.documentSource === "local") return "checking local source";
  return "checking source";
}

export function healthCheckSuccessMessage(response) {
  const latency = formatLatency(response.latencyMs);
  if (response.kind === "remote") return `server checked · ${latency}`;
  if (response.kind === "sample") return `sample checked · ${latency}`;
  if (response.kind === "local") return `local source checked · ${latency}`;
  if (response.kind === "preview") return `preview checked · ${latency}`;
  return `source checked · ${latency}`;
}

export function healthCheckErrorMessage(error) {
  return `check failed · ${error?.message || "Unable to reach source."}`;
}

export function statusTextForLoading(documentSource) {
  if (documentSource === "remote") return "Refreshing the remote file tree.";
  if (documentSource === "local") return "Reading the local folder.";
  return "Resolving connection and files.";
}

export function formatConnectionTarget(connection) {
  const userHost = connection.username ? `${connection.username}@${connection.host}` : connection.host;
  const remotePath = connection.remotePath ? `:${connection.remotePath}` : "";
  return `${userHost}${remotePath}`;
}

export function applyConnectionTarget(value, onUpdate) {
  const match = value.match(/^(?:(?<username>[^@:]+)@)?(?<host>[^:]*)(?::(?<remotePath>.*))?$/);
  if (!match?.groups) return;
  onUpdate("host", match.groups.host || "");
  if (match.groups.username !== undefined) onUpdate("username", match.groups.username);
  // Always reflect the path portion, so deleting ":path" from the target clears
  // it (empty path browses from home) rather than silently keeping the old path.
  onUpdate("remotePath", match.groups.remotePath || "");
}

export function formatSourcePathDetail(value) {
  if (!value) return "";
  return formatSidebarDirectoryPath(value)?.display || value;
}
