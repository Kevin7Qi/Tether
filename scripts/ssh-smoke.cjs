const { once } = require("node:events");
const { RemoteFileProvider, getConnectionProfile } = require("../src/main/remoteFileProvider.cjs");

const required = ["REMOTE_MD_HOST"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  printUsage();
  process.exit(1);
}

const authMode = process.env.REMOTE_MD_AUTH_MODE || inferAuthMode();
const remotePath = process.env.REMOTE_MD_PATH || "";
const writePath = process.env.REMOTE_MD_WRITE_PATH || "";
const intervalMs = Number(process.env.REMOTE_MD_INTERVAL_MS || 1000);
const findMarkdown = process.env.REMOTE_MD_FIND_MARKDOWN === "1";
const findMaxDepth = Number(process.env.REMOTE_MD_FIND_MAX_DEPTH || 3);
const findMaxDirs = Number(process.env.REMOTE_MD_FIND_MAX_DIRS || 80);
const includeHidden = process.env.REMOTE_MD_INCLUDE_HIDDEN === "1";
const tempWrite = process.env.REMOTE_MD_TEMP_WRITE === "1";
const provider = new RemoteFileProvider();

const connection = {
  host: process.env.REMOTE_MD_HOST,
  port: Number(process.env.REMOTE_MD_PORT || 22),
  username: process.env.REMOTE_MD_USERNAME || "",
  authMode,
  password: process.env.REMOTE_MD_PASSWORD || "",
  privateKeyPath: process.env.REMOTE_MD_PRIVATE_KEY_PATH || "",
  passphrase: process.env.REMOTE_MD_KEY_PASSPHRASE || "",
  remotePath,
  intervalMs
};

async function main() {
  const startedAt = new Date().toISOString();
  const profile = getConnectionProfile(connection);
  printConnectionProfile(profile);

  await provider.connect(connection);
  const directory = remotePath ? dirname(remotePath) : await provider.getWorkingDirectory();
  const entries = await provider.listDirectory(directory);
  const markdownEntries = entries.filter((entry) => entry.isMarkdown);
  let discoveredPath = "";

  console.log("SSH/SFTP connect and browse check passed");
  console.log(`Directory listed: ${directory}`);
  console.log(`Directory entries: ${entries.length}`);
  console.log(`Markdown entries: ${markdownEntries.length}`);

  if (!remotePath && findMarkdown) {
    const discovered = await findMarkdownFiles(directory);
    discoveredPath = discovered[0]?.path || "";
    console.log(`Markdown discovery checked directories: ${discovered.checkedDirectories}`);
    console.log(`Markdown discovery skipped directories: ${discovered.skippedDirectories}`);
    console.log(`Markdown discovery matches: ${discovered.length}`);
    discovered.slice(0, 10).forEach((entry) => console.log(`- ${entry.path}`));
  }

  const pathToRead = remotePath || discoveredPath;

  if (pathToRead) {
    await readCheck(pathToRead, dirname(pathToRead));
    if (process.env.REMOTE_MD_WATCH_ONCE === "1") {
      await watchOnce(pathToRead);
    }
  } else {
    const firstMarkdown = markdownEntries[0];
    console.log(
      firstMarkdown
        ? `First Markdown candidate: ${firstMarkdown.path}`
        : "No Markdown file was opened because REMOTE_MD_PATH is unset."
    );
  }

  if (writePath) {
    await writeRoundTrip(writePath, startedAt);
  } else if (tempWrite) {
    await tempWriteRoundTrip(directory, startedAt);
  } else {
    console.log("Write/save check skipped. Set REMOTE_MD_WRITE_PATH or REMOTE_MD_TEMP_WRITE=1 to enable it.");
  }

  await provider.disconnect();
  console.log("SSH/SFTP smoke test passed");
}

async function readCheck(pathToRead, directory) {
  const file = await provider.readFile(pathToRead);
  const preview = file.content
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.slice(0, 120);

  console.log("Remote Markdown read check passed");
  console.log(`Remote path: ${pathToRead}`);
  console.log(`Parent directory: ${directory}`);
  console.log(`Bytes read: ${Buffer.byteLength(file.content, "utf8")}`);
  console.log(`Remote mtime: ${file.metadata.mtime || "unknown"}`);
  console.log(`First non-empty line: ${preview || "(empty file)"}`);
}

async function watchOnce(pathToWatch) {
  const updatePromise = once(provider, "update");
  provider.startWatching(pathToWatch, intervalMs);
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for initial watch update.")), intervalMs + 5000);
  });
  const [file] = await Promise.race([updatePromise, timeout]);
  provider.stopWatching();
  console.log("Watch check passed");
  console.log(`Watched path: ${pathToWatch}`);
  console.log(`Watch bytes read: ${Buffer.byteLength(file.content, "utf8")}`);
}

async function writeRoundTrip(pathToWrite, startedAt) {
  let originalFile = null;
  try {
    originalFile = await provider.readFile(pathToWrite);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    throw new Error(
      "REMOTE_MD_WRITE_PATH must point to an existing Markdown file so the smoke test can restore it safely."
    );
  }

  const originalContent = originalFile.content;
  const originalVersion = originalFile.version;
  const marker = `tether smoke ${startedAt}`;
  const nextContent = originalContent
    ? `${originalContent.replace(/\s*$/, "")}\n\n<!-- ${marker} -->\n`
    : `# Tether Smoke Test\n\n<!-- ${marker} -->\n`;

  const writtenFile = await provider.writeFile(pathToWrite, nextContent, originalVersion);
  if (!writtenFile.content.includes(marker)) {
    throw new Error("Write check failed: marker was not present after save.");
  }

  await provider.writeFile(pathToWrite, originalContent, writtenFile.version);
  console.log("Write/save round-trip check passed");
  console.log(`Write path: ${pathToWrite}`);
  console.log("Original file restored");
}

async function tempWriteRoundTrip(directory, startedAt) {
  const safeDirectory = directory?.trim() || ".";
  const tempPath = joinRemotePath(
    safeDirectory,
    `.tether-smoke-${Date.now()}-${process.pid}.md`
  );
  const marker = `tether temp smoke ${startedAt}`;
  const content = `# Tether Smoke Test\n\n<!-- ${marker} -->\n`;

  try {
    const writtenFile = await provider.writeFile(tempPath, content, null);
    if (!writtenFile.content.includes(marker)) {
      throw new Error("Temp write check failed: marker was not present after save.");
    }
    await provider.deleteFile(tempPath);
  } catch (error) {
    try {
      await provider.deleteFile(tempPath);
    } catch {
      // Preserve the original write/read/delete error.
    }
    throw error;
  }

  console.log("Temporary write/save/delete check passed");
  console.log(`Temporary write path: ${tempPath}`);
}

async function findMarkdownFiles(startDirectory) {
  const matches = [];
  const queue = [{ path: startDirectory, depth: 0 }];
  let checkedDirectories = 0;
  let skippedDirectories = 0;

  while (queue.length > 0 && checkedDirectories < findMaxDirs) {
    const current = queue.shift();
    checkedDirectories += 1;

    let entries;
    try {
      entries = await provider.listDirectory(current.path);
    } catch {
      skippedDirectories += 1;
      continue;
    }

    for (const entry of entries) {
      if (entry.isMarkdown) matches.push(entry);
      if (entry.type !== "directory" || current.depth >= findMaxDepth) continue;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      queue.push({ path: entry.path, depth: current.depth + 1 });
    }
  }

  matches.checkedDirectories = checkedDirectories;
  matches.skippedDirectories = skippedDirectories;
  return matches;
}

main().catch(async (error) => {
  try {
    await provider.disconnect();
  } catch {
    // Ignore cleanup failure; preserve the original error.
  }

  console.error("SSH/SFTP smoke test failed");
  console.error(`${error.code || "REMOTE_ERROR"}: ${error.message || error}`);
  process.exit(1);
});

function inferAuthMode() {
  if (process.env.REMOTE_MD_PASSWORD) return "password";
  if (process.env.REMOTE_MD_PRIVATE_KEY_PATH) return "privateKey";
  return "auto";
}

function dirname(pathToRead) {
  const normalized = pathToRead.replace(/\\/g, "/");
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function joinRemotePath(directory, name) {
  const normalized = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  return `${normalized}/${name}`;
}

function isMissingFileError(error) {
  return /No such file|not exist|does not exist|ENOENT|Failure/i.test(error?.message || "");
}

function printConnectionProfile(profile) {
  console.log("Resolved connection profile");
  console.log(`Host: ${profile.host || "(missing)"}`);
  console.log(`Port: ${profile.port || 22}`);
  console.log(`Username: ${profile.username || "(from ssh config or missing)"}`);
  console.log(`Auth mode: ${profile.authMode}`);
  console.log(`SSH agent available: ${profile.agentAvailable ? "yes" : "no"}`);
  console.log(`Readable key candidates: ${profile.privateKeyCandidates.length}`);
  profile.privateKeyCandidates.forEach((keyPath) => console.log(`- ${keyPath}`));
  profile.warnings.forEach((warning) => console.log(`Warning: ${warning}`));
}

function printUsage() {
  console.error("Required: REMOTE_MD_HOST");
  console.error("Optional: REMOTE_MD_USERNAME, REMOTE_MD_PORT, REMOTE_MD_AUTH_MODE");
  console.error("Optional auth: REMOTE_MD_PASSWORD or REMOTE_MD_PRIVATE_KEY_PATH");
  console.error("Optional read: REMOTE_MD_PATH");
  console.error("Optional watch: REMOTE_MD_WATCH_ONCE=1");
  console.error("Optional discovery: REMOTE_MD_FIND_MARKDOWN=1");
  console.error("Optional write/save round trip: REMOTE_MD_WRITE_PATH");
  console.error("Optional temporary write/save/delete: REMOTE_MD_TEMP_WRITE=1");
}
