const path = require("node:path");
const { fileURLToPath } = require("node:url");

const supportedLocalDocumentExtensions = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".txt"
]);

function isSupportedLocalDocumentPath(filePath) {
  return typeof filePath === "string"
    && supportedLocalDocumentExtensions.has(path.extname(filePath).toLowerCase());
}

function normalizeExternalDocumentPath(value, cwd = process.cwd()) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("--")) return "";
  let candidate = value.trim();
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return "";
    }
  }
  if (!isSupportedLocalDocumentPath(candidate)) return "";
  return path.resolve(cwd, candidate);
}

function externalDocumentPathsFromArgv(argv, cwd = process.cwd(), platform = process.platform) {
  const paths = [];
  const seen = new Set();
  for (const value of Array.isArray(argv) ? argv : []) {
    const normalized = normalizeExternalDocumentPath(value, cwd);
    if (!normalized) continue;
    const identity = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(identity)) continue;
    seen.add(identity);
    paths.push(normalized);
  }
  return paths;
}

module.exports = {
  externalDocumentPathsFromArgv,
  isSupportedLocalDocumentPath,
  normalizeExternalDocumentPath,
  supportedLocalDocumentExtensions
};
