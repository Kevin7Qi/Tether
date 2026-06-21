const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  RemoteFileProvider,
  isConnectionLossError,
  isRemoteMarkdownPath,
  parseSshConfig,
  resolveConnection,
  verifyHostFingerprint
} = require("../src/main/remoteFileProvider.cjs");

function connectedProvider() {
  const provider = new RemoteFileProvider();
  // Node's EventEmitter throws if an "error" event is emitted with no listener;
  // main.cjs always registers one, so mirror that here.
  provider.on("error", () => {});
  provider.connected = true;
  provider.client = { on() {} };
  provider.watchPath = "/srv/docs/readme.md";
  provider.watchTimer = setInterval(() => {}, 60000);
  provider.lastVersion = { hash: "abc" };
  return provider;
}

test("parseSshConfig resolves host alias, user, port, and identity files", () => {
  const config = `
Host docs
  HostName docs.lan.example
  User docs-user
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
  IdentityFile "C:\\Users\\demo\\.ssh\\work key"

Host *
  Port 22
`;

  assert.deepEqual(parseSshConfig(config, "docs"), {
    hostName: "docs.lan.example",
    user: "docs-user",
    port: "2222",
    identityFiles: ["~/.ssh/id_ed25519", "C:\\Users\\demo\\.ssh\\work key"]
  });
});

test("parseSshConfig lets Host star fill missing values without overriding earlier values", () => {
  const config = `
Host docs
  HostName docs.internal
  IdentityFile ~/.ssh/docs

Host *
  User default-user
  Port 22
  IdentityFile ~/.ssh/default
`;

  assert.deepEqual(parseSshConfig(config, "docs"), {
    hostName: "docs.internal",
    user: "default-user",
    port: "22",
    identityFiles: ["~/.ssh/docs", "~/.ssh/default"]
  });
});

test("parseSshConfig keeps comments outside quoted paths only", () => {
  const config = `
Host doc-?
  HostName "docs#1.internal" # outside comment
  IdentityFile "C:\\Users\\demo\\.ssh\\key # prod"
`;

  assert.deepEqual(parseSshConfig(config, "doc-a"), {
    hostName: "docs#1.internal",
    identityFiles: ["C:\\Users\\demo\\.ssh\\key # prod"]
  });
});

test("resolveConnection keeps remote path optional and expands explicit auth defaults", () => {
  const resolved = resolveConnection({
    host: "docs.example.com",
    port: "",
    username: "deploy",
    authMode: "",
    privateKeyPath: "",
    remotePath: ""
  });

  assert.equal(resolved.host, "docs.example.com");
  assert.equal(resolved.hostAlias, "docs.example.com");
  assert.equal(resolved.port, 22);
  assert.equal(resolved.username, "deploy");
  assert.equal(resolved.authMode, "auto");
  assert.equal(resolved.remotePath, "");
});

test("verifyHostFingerprint trusts first use and rejects changed host keys", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tether-hosts-"));
  const trustStore = path.join(tempDir, "trusted-hosts.json");
  const connection = { host: "docs.example.com", port: 22 };

  assert.equal(verifyHostFingerprint(connection, "fingerprint-a", trustStore).ok, true);
  assert.equal(verifyHostFingerprint(connection, "fingerprint-a", trustStore).ok, true);

  const mismatch = verifyHostFingerprint(connection, "fingerprint-b", trustStore);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.details.expectedFingerprint, "fingerprint-a");
  assert.equal(mismatch.details.actualFingerprint, "fingerprint-b");
});

test("remote Markdown file matching aligns with local Markdown extensions", () => {
  assert.equal(isRemoteMarkdownPath("README.md"), true);
  assert.equal(isRemoteMarkdownPath("guide.markdown"), true);
  assert.equal(isRemoteMarkdownPath("notes.mdown"), true);
  assert.equal(isRemoteMarkdownPath("draft.mkd"), true);
  assert.equal(isRemoteMarkdownPath("plain.txt"), true);
  assert.equal(isRemoteMarkdownPath("archive.zip"), false);
});

test("handleUnexpectedDisconnect tears down the session and notifies the renderer", () => {
  const provider = connectedProvider();
  const events = [];
  provider.on("status", (payload) => events.push(["status", payload]));
  provider.on("error", (error) => events.push(["error", error]));

  provider.handleUnexpectedDisconnect(new Error("read ECONNRESET"));

  assert.equal(provider.connected, false);
  assert.equal(provider.client, null);
  assert.equal(provider.watchTimer, null);
  assert.equal(provider.watchPath, null);
  assert.equal(provider.lastVersion, null);

  const status = events.find(([type]) => type === "status")[1];
  assert.equal(status.state, "disconnected");
  assert.equal(status.unexpected, true);
  assert.match(status.message, /Lost connection to the remote host/);

  const error = events.find(([type]) => type === "error")[1];
  assert.equal(error.code, "CONNECTION_LOST");
});

test("handleUnexpectedDisconnect ignores events during an intentional disconnect", () => {
  const provider = connectedProvider();
  provider.disconnecting = true;
  let emitted = false;
  provider.on("status", () => {
    emitted = true;
  });

  provider.handleUnexpectedDisconnect();

  assert.equal(emitted, false);
  assert.equal(provider.connected, true);
  clearInterval(provider.watchTimer);
});

test("isConnectionLossError distinguishes dropped connections from ordinary failures", () => {
  assert.equal(isConnectionLossError({ code: "ECONNRESET" }), true);
  assert.equal(isConnectionLossError({ code: "NOT_CONNECTED" }), true);
  assert.equal(isConnectionLossError({ message: "No SFTP connection available" }), true);
  assert.equal(isConnectionLossError({ message: "Socket hang up" }), true);
  assert.equal(isConnectionLossError({ code: "REMOTE_CONFLICT", message: "The remote file changed." }), false);
  assert.equal(isConnectionLossError({ code: "ENOENT", message: "No such file" }), false);
  assert.equal(isConnectionLossError(null), false);
});

test("handleUnexpectedDisconnect is idempotent once disconnected", () => {
  const provider = connectedProvider();
  provider.handleUnexpectedDisconnect();
  let secondFired = false;
  provider.on("status", () => {
    secondFired = true;
  });
  provider.handleUnexpectedDisconnect();
  assert.equal(secondFired, false);
});
