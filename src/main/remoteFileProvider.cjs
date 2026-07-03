const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const SftpClient = require("ssh2-sftp-client");
const { isConnectionLossError } = require("./connectionLoss.cjs");

const MIN_POLL_MS = 750;
const REMOTE_MARKDOWN_PATTERN = /\.(md|mdx|markdown|mdown|mkd|txt)$/i;
const defaultKnownHostsPath = path.join(os.homedir(), ".tether", "trusted-hosts.json");

class RemoteFileProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.client = null;
    this.connected = false;
    this.watchTimer = null;
    this.watchPath = null;
    this.lastVersion = null;
    this.polling = false;
    this.disconnecting = false;
    this.knownHostsPath = options.knownHostsPath || defaultKnownHostsPath;
    this.hostVerificationError = null;
  }

  setKnownHostsPath(knownHostsPath) {
    this.knownHostsPath = knownHostsPath || defaultKnownHostsPath;
  }

  async connect(connection) {
    await this.disconnect();
    const resolvedConnection = resolveConnection(connection);
    validateConnection(resolvedConnection);

    const config = {
      host: resolvedConnection.host,
      port: resolvedConnection.port,
      username: resolvedConnection.username,
      readyTimeout: 15000,
      tryKeyboard: true,
      hostHash: "sha256",
      hostVerifier: (fingerprint) => this.verifyHostFingerprint(resolvedConnection, fingerprint)
    };

    const agent = getSshAgentValue();
    const privateKeyPaths = getPrivateKeyCandidates(resolvedConnection);
    const attempts = [];

    if (resolvedConnection.authMode === "password") {
      if (resolvedConnection.password) {
        attempts.push({
          config: { ...config, password: resolvedConnection.password },
          summary: "password"
        });
      } else {
        throw userError("PASSWORD_REQUIRED", "Password is required for password authentication.");
      }
    } else if (resolvedConnection.authMode === "privateKey") {
      if (privateKeyPaths.length === 0) {
        throw userError("PRIVATE_KEY_REQUIRED", "Private key path is required.");
      }
      attempts.push(makePrivateKeyAttempt(config, privateKeyPaths[0], resolvedConnection.passphrase));
    } else {
      if (resolvedConnection.password) {
        attempts.push({
          config: { ...config, password: resolvedConnection.password },
          summary: "password"
        });
      }
      privateKeyPaths.forEach((privateKeyPath) => {
        attempts.push(makePrivateKeyAttempt(config, privateKeyPath, resolvedConnection.passphrase));
      });
      if (agent) {
        attempts.push({
          config: { ...config, agent },
          summary: "SSH agent"
        });
      }

      if (attempts.length === 0) {
        throw userError(
          "AUTH_REQUIRED",
          "No authentication method is available. Enter a password, choose a private key, or start an SSH agent."
        );
      }
    }

    await this.connectWithAttempts(attempts, resolvedConnection);
    this.connected = true;
    this.attachConnectionListeners();
    this.emit("status", {
      state: "connected",
      message: `Connected to ${config.username}@${config.host}:${config.port}`
    });
  }

  attachConnectionListeners() {
    if (!this.client || typeof this.client.on !== "function") return;
    const onLoss = (error) => this.handleUnexpectedDisconnect(error);
    this.client.on("error", onLoss);
    this.client.on("end", () => this.handleUnexpectedDisconnect());
    this.client.on("close", () => this.handleUnexpectedDisconnect());
  }

  // Fires when the SSH/SFTP socket drops on its own (network loss, server
  // closing the session). Mark the provider disconnected, stop polling, and tell
  // the renderer so it can recover instead of issuing doomed file operations.
  handleUnexpectedDisconnect(error) {
    if (this.disconnecting || !this.connected) return;
    this.connected = false;
    this.client = null;
    this.lastVersion = null;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.watchPath = null;
    this.polling = false;
    const message = `Lost connection to the remote host${error && error.message ? `: ${error.message}` : "."}`;
    this.emit("status", { state: "disconnected", message, unexpected: true });
    this.emit("error", userError("CONNECTION_LOST", message));
  }

  async connectWithAttempts(attempts, resolvedConnection) {
    const failures = [];
    this.hostVerificationError = null;

    for (const attempt of attempts) {
      this.client = new SftpClient();
      try {
        await this.client.connect(attempt.config);
        return;
      } catch (error) {
        failures.push({ error, summary: attempt.summary });
        try {
          await this.client.end();
        } catch {
          // Ignore cleanup failure so the auth error remains clear.
        }
        this.client = null;
        if (this.hostVerificationError) throw this.hostVerificationError;
      }
    }

    throw enhanceConnectError(failures, resolvedConnection);
  }

  verifyHostFingerprint(connection, fingerprint) {
    const result = verifyHostFingerprint(connection, fingerprint, this.knownHostsPath);
    if (!result.ok) {
      this.hostVerificationError = userError("HOST_KEY_MISMATCH", result.message);
      this.hostVerificationError.details = result.details;
      return false;
    }
    return true;
  }

  async getWorkingDirectory() {
    this.ensureConnected();
    if (typeof this.client.cwd === "function") {
      const directory = await this.client.cwd();
      return directory || ".";
    }
    return ".";
  }

  async healthCheck() {
    this.ensureConnected();
    const directory = await this.getWorkingDirectory();
    return { directory };
  }

  async disconnect() {
    this.disconnecting = true;
    this.stopWatching();
    if (this.client) {
      try {
        await this.client.end();
      } finally {
        this.client = null;
        this.connected = false;
        this.lastVersion = null;
        this.disconnecting = false;
        this.emit("status", { state: "disconnected", message: "Disconnected" });
      }
    } else {
      this.disconnecting = false;
    }
  }

  async statFile(remotePath) {
    this.ensureConnected();
    validateRemotePath(remotePath);

    const stat = await this.client.stat(remotePath);
    const mtimeMs = normalizeMtime(stat);
    const isDirectory =
      typeof stat.isDirectory === "function"
        ? stat.isDirectory()
        : typeof stat.isDirectory === "boolean"
          ? stat.isDirectory
          : (Number(stat.mode) & 0o170000) === 0o040000;
    return {
      path: remotePath,
      size: Number(stat.size || 0),
      mtimeMs,
      mtime: mtimeMs ? new Date(mtimeMs).toISOString() : null,
      mode: stat.mode,
      isDirectory
    };
  }

  async readFile(remotePath) {
    this.ensureConnected();
    validateRemotePath(remotePath);

    const [rawContent, metadata] = await Promise.all([
      this.client.get(remotePath),
      this.statFile(remotePath)
    ]);
    const buffer = Buffer.isBuffer(rawContent)
      ? rawContent
      : Buffer.from(String(rawContent ?? ""), "utf8");
    const content = buffer.toString("utf8");
    const version = versionFrom(metadata, content);

    return {
      content,
      metadata,
      version,
      refreshedAt: new Date().toISOString()
    };
  }

  async listDirectory(remotePath) {
    this.ensureConnected();
    const directory = remotePath?.trim() || ".";

    const entries = await this.client.list(directory);
    return entries
      .map((entry) => {
        const isDirectory = entry.type === "d";
        return {
          name: entry.name,
          path: joinRemotePath(directory, entry.name),
          type: isDirectory ? "directory" : "file",
          size: Number(entry.size || 0),
          mtime: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : null,
          isMarkdown: !isDirectory && isRemoteMarkdownPath(entry.name)
        };
      })
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
        if (left.isMarkdown !== right.isMarkdown) return left.isMarkdown ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }

  async writeFile(remotePath, content, expectedVersion) {
    this.ensureConnected();
    validateRemotePath(remotePath);

    if (expectedVersion?.hash) {
      const current = await this.readFile(remotePath);
      if (!versionsMatch(current.version, expectedVersion)) {
        const error = userError(
          "REMOTE_CONFLICT",
          "The remote file changed after you opened it. Review the latest remote version before saving."
        );
        error.details = {
          currentVersion: current.version,
          currentMetadata: current.metadata
        };
        throw error;
      }
    }

    await this.client.put(Buffer.from(content, "utf8"), remotePath);
    const file = await this.readFile(remotePath);
    this.lastVersion = file.version;
    this.emit("update", file);
    return file;
  }

  async createFile(remotePath, content = "") {
    this.ensureConnected();
    validateRemotePath(remotePath);

    try {
      await this.client.stat(remotePath);
      throw userError("REMOTE_FILE_EXISTS", "A remote file already exists at that path.");
    } catch (error) {
      if (error?.code === "REMOTE_FILE_EXISTS") throw error;
      if (!isMissingRemoteFileError(error)) throw error;
    }

    await this.client.put(Buffer.from(content, "utf8"), remotePath);
    const file = await this.readFile(remotePath);
    this.lastVersion = file.version;
    this.emit("update", file);
    return file;
  }

  async deleteFile(remotePath) {
    this.ensureConnected();
    validateRemotePath(remotePath);
    await this.client.delete(remotePath);
  }

  startWatching(remotePath, intervalMs) {
    this.ensureConnected();
    validateRemotePath(remotePath);

    const delay = Math.max(Number(intervalMs || 2000), MIN_POLL_MS);
    this.stopWatching();
    this.watchPath = remotePath;
    this.emit("status", {
      state: "watching",
      message: `Watching ${remotePath} every ${delay} ms`
    });

    this.pollOnce();
    this.watchTimer = setInterval(() => {
      this.pollOnce();
    }, delay);
  }

  stopWatching() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
      this.emit("status", { state: "connected", message: "Watching stopped" });
    }
    this.watchPath = null;
    this.polling = false;
  }

  async pollOnce() {
    if (this.polling || !this.watchPath) return;
    const target = this.watchPath;
    this.polling = true;

    try {
      const metadata = await this.statFile(target);
      // Bail if a disconnect or watch-target change landed while we awaited.
      if (this.disconnecting || this.watchPath !== target) return;
      const statSignature = `${metadata.mtimeMs || ""}:${metadata.size}`;
      const lastSignature = this.lastVersion
        ? `${this.lastVersion.mtimeMs || ""}:${this.lastVersion.size}`
        : null;

      if (statSignature !== lastSignature) {
        const file = await this.readFile(target);
        if (this.disconnecting || this.watchPath !== target) return;
        if (!this.lastVersion || !versionsMatch(file.version, this.lastVersion)) {
          this.lastVersion = file.version;
          this.emit("update", file);
        }
      }

      this.emit("status", {
        state: "watching",
        message: "Remote file checked",
        metadata,
        checkedAt: new Date().toISOString()
      });
    } catch (error) {
      // Suppress errors caused by an intentional disconnect or watch change.
      if (this.disconnecting || this.watchPath !== target) return;
      // A dropped connection ends the watch and triggers recovery; a transient
      // error keeps the watch alive with the last rendered content visible.
      if (isConnectionLossError(error)) {
        this.handleUnexpectedDisconnect(error);
        return;
      }
      this.emit("error", error);
      this.emit("status", {
        state: "watching",
        message: "Refresh failed; keeping the last rendered content visible",
        checkedAt: new Date().toISOString()
      });
    } finally {
      this.polling = false;
    }
  }

  ensureConnected() {
    if (!this.client || !this.connected) {
      throw userError("NOT_CONNECTED", "Connect to a remote host first.");
    }
  }
}

function validateConnection(connection) {
  if (!connection?.host?.trim()) throw userError("HOST_REQUIRED", "Host is required.");
  if (!connection?.username?.trim()) {
    throw userError("USERNAME_REQUIRED", "Username is required. Enter it or define User in ~/.ssh/config.");
  }
}

function validateRemotePath(remotePath) {
  if (!remotePath?.trim()) {
    throw userError("REMOTE_PATH_REQUIRED", "Remote Markdown file path is required.");
  }
}

function isRemoteMarkdownPath(filePath) {
  return REMOTE_MARKDOWN_PATTERN.test(String(filePath || ""));
}

function isMissingRemoteFileError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return code === "2" || code === "ENOENT" || /no such file|not found|does not exist/i.test(message);
}

function verifyHostFingerprint(connection, fingerprint, knownHostsPath = defaultKnownHostsPath) {
  const normalizedFingerprint = String(fingerprint || "").trim();
  if (!normalizedFingerprint) {
    return {
      ok: false,
      message: "The SSH server did not provide a host key fingerprint."
    };
  }

  const trustKey = getHostTrustKey(connection);
  const store = readTrustedHosts(knownHostsPath);
  const existing = store.hosts[trustKey];
  if (existing?.fingerprint && existing.fingerprint !== normalizedFingerprint) {
    return {
      ok: false,
      message:
        `The SSH host key for ${trustKey} changed. Tether refused the connection to protect the remote session.`,
      details: {
        host: connection.host,
        port: connection.port,
        expectedFingerprint: existing.fingerprint,
        actualFingerprint: normalizedFingerprint
      }
    };
  }

  if (!existing) {
    store.hosts[trustKey] = {
      host: connection.host,
      hostAlias: connection.hostAlias || "",
      port: connection.port,
      fingerprint: normalizedFingerprint,
      firstSeenAt: new Date().toISOString()
    };
    writeTrustedHosts(knownHostsPath, store);
  }

  return { ok: true, fingerprint: normalizedFingerprint };
}

function getHostTrustKey(connection) {
  const host = String(connection.host || "").trim().toLowerCase();
  const port = Number(connection.port || 22);
  return `${host}:${port}`;
}

function readTrustedHosts(knownHostsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(knownHostsPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.hosts && typeof parsed.hosts === "object") {
      return parsed;
    }
  } catch {
    // Missing or malformed trust stores are treated as empty.
  }
  return { version: 1, hosts: {} };
}

function writeTrustedHosts(knownHostsPath, store) {
  fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true });
  const payload = {
    version: 1,
    hosts: store.hosts || {},
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(knownHostsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeMtime(stat) {
  if (typeof stat.modifyTime === "number") return stat.modifyTime;
  if (typeof stat.mtime === "number") return stat.mtime;
  if (stat.mtime instanceof Date) return stat.mtime.getTime();
  return null;
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function versionFrom(metadata, content) {
  return {
    path: metadata.path,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    hash: hashContent(content)
  };
}

function versionsMatch(left, right) {
  return Boolean(left && right && left.hash === right.hash);
}

function joinRemotePath(directory, name) {
  const normalized = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  return `${normalized}/${name}`;
}

function getDefaultPrivateKeyPath() {
  const sshDirectory = path.join(os.homedir(), ".ssh");
  const candidates = [
    "id_ed25519",
    "id_rsa",
    "id_ecdsa",
    "id_dsa"
  ].map((keyName) => path.join(sshDirectory, keyName));

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function getPrivateKeyCandidates(connection) {
  const sshDirectory = path.join(os.homedir(), ".ssh");
  const candidates = [
    connection.privateKeyPath,
    ...(connection.identityFiles || []),
    connection.identityFile,
    path.join(sshDirectory, "id_ed25519"),
    path.join(sshDirectory, "id_rsa"),
    path.join(sshDirectory, "id_ecdsa"),
    path.join(sshDirectory, "id_dsa")
  ];

  return [...new Set(candidates.filter(Boolean).map(expandSshPath))].filter((candidate) =>
    fs.existsSync(candidate)
  );
}

function makePrivateKeyAttempt(baseConfig, privateKeyPath, passphrase) {
  const config = {
    ...baseConfig,
    privateKey: fs.readFileSync(privateKeyPath, "utf8")
  };
  if (passphrase) config.passphrase = passphrase;
  return {
    config,
    summary: `private key (${privateKeyPath})`
  };
}

function getSshAgentValue() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.env.SSH_AGENT) return process.env.SSH_AGENT;
  return "";
}

function resolveConnection(connection) {
  const hostAlias = connection.host?.trim() || "";
  const sshConfig = getSshConfigForHost(hostAlias);
  const host = sshConfig.hostName || hostAlias;
  const username = connection.username?.trim() || sshConfig.user || "";
  const uiPort = Number(connection.port || 22);
  const port = Number(sshConfig.port || uiPort || 22);
  const identityFiles = (sshConfig.identityFiles || []).map((identityFile) =>
    expandSshPath(identityFile, { host, hostAlias, username, port })
  );
  const identityFile = identityFiles[0] || "";

  return {
    ...connection,
    host,
    hostAlias,
    username,
    port,
    identityFile,
    identityFiles,
    privateKeyPath: expandSshPath(connection.privateKeyPath?.trim() || identityFile, {
      host,
      hostAlias,
      username,
      port
    }),
    authMode: connection.authMode || "auto"
  };
}

function getSshConfigForHost(hostAlias) {
  const configPath = path.join(os.homedir(), ".ssh", "config");
  if (!hostAlias || !fs.existsSync(configPath)) return {};

  return parseSshConfig(fs.readFileSync(configPath, "utf8"), hostAlias);
}

function parseSshConfig(configText, hostAlias) {
  const lines = String(configText || "").split(/\r?\n/);
  const resolved = { identityFiles: [] };
  let activePatterns = [];

  for (const rawLine of lines) {
    const line = stripSshComment(rawLine).trim();
    if (!line) continue;

    const [keywordRaw, ...rest] = parseSshWords(line);
    if (!keywordRaw) continue;
    const keyword = keywordRaw.toLowerCase();
    const value = rest.join(" ");

    if (keyword === "host") {
      activePatterns = rest;
      continue;
    }

    if (!activePatterns.some((pattern) => hostPatternMatches(pattern, hostAlias))) continue;

    if (keyword === "hostname" && !resolved.hostName) resolved.hostName = value;
    if (keyword === "user" && !resolved.user) resolved.user = value;
    if (keyword === "port" && !resolved.port) resolved.port = value;
    if (keyword === "identityfile") resolved.identityFiles.push(value);
  }

  return resolved;
}

function parseSshWords(line) {
  const words = [];
  let word = "";
  let quote = "";
  let escaping = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaping) {
      word += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote && line[index + 1] === quote) {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        word += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (word) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += char;
  }

  if (word) words.push(word);
  return words;
}

function stripSshComment(line) {
  let quote = "";
  let escaping = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && quote && line[index + 1] === quote) {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }

  return line;
}

function hostPatternMatches(pattern, hostAlias) {
  if (!pattern || pattern.startsWith("!")) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(hostAlias);
}

function expandSshPath(value, tokens = {}) {
  if (!value) return "";
  const normalized = stripSshQuotes(value);
  return normalized
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%d/g, os.homedir())
    .replace(/%h/g, tokens.host || tokens.hostAlias || "")
    .replace(/%n/g, tokens.hostAlias || tokens.host || "")
    .replace(/%p/g, String(tokens.port || ""))
    .replace(/%r/g, tokens.username || "");
}

function stripSshQuotes(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getConnectionProfile(connection) {
  const resolvedConnection = resolveConnection(connection || {});
  const privateKeyCandidates = getPrivateKeyCandidates(resolvedConnection);
  const missingExplicitKey =
    resolvedConnection.privateKeyPath && !fs.existsSync(resolvedConnection.privateKeyPath)
      ? resolvedConnection.privateKeyPath
      : "";
  const warnings = [];

  if (!resolvedConnection.username) {
    warnings.push("Username is missing. Enter it or define User in ~/.ssh/config.");
  }
  if (
    resolvedConnection.authMode !== "password" &&
    resolvedConnection.privateKeyPath &&
    missingExplicitKey
  ) {
    warnings.push(`Private key path does not exist: ${missingExplicitKey}`);
  }
  if (
    resolvedConnection.authMode !== "password" &&
    privateKeyCandidates.length === 0 &&
    !getSshAgentValue()
  ) {
    warnings.push("No readable private keys or SSH agent were found for Auto authentication.");
  }

  return {
    hostAlias: resolvedConnection.hostAlias,
    host: resolvedConnection.host,
    port: resolvedConnection.port,
    username: resolvedConnection.username,
    authMode: resolvedConnection.authMode,
    configuredIdentityFiles: resolvedConnection.identityFiles || [],
    privateKeyCandidates,
    defaultPrivateKeyPath: getDefaultPrivateKeyPath(),
    agentAvailable: Boolean(getSshAgentValue()),
    warnings
  };
}

function enhanceConnectError(failures, connection) {
  const failureList = Array.isArray(failures) ? failures : [{ error: failures, summary: "unknown" }];
  const lastError = failureList.at(-1)?.error;
  const message = lastError?.message || "SSH connection failed.";
  const tried = failureList.map((failure) => failure.summary).filter(Boolean).join(", ") || "no usable auth method";

  if (/All configured authentication methods failed/i.test(message)) {
    return userError(
      "AUTH_FAILED",
      `Authentication failed for ${connection.username}@${connection.host}. Tried ${tried}. Check username, key path, passphrase/password, and whether this key is authorized on the server.`
    );
  }

  if (/Cannot parse privateKey|Encrypted .*key.*no passphrase|Bad passphrase|bad passphrase/i.test(message)) {
    return userError(
      "PRIVATE_KEY_FAILED",
      `The private key could not be used. Check the key path and passphrase. Tried ${tried}.`
    );
  }

  const wrapped = userError(lastError?.code || "CONNECT_FAILED", message);
  wrapped.details = { tried };
  return wrapped;
}

function userError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  RemoteFileProvider,
  getConnectionProfile,
  getDefaultPrivateKeyPath,
  getSshConfigForHost,
  isConnectionLossError,
  isRemoteMarkdownPath,
  parseSshConfig,
  resolveConnection,
  verifyHostFingerprint
};
