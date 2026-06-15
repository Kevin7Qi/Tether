const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, shell } = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  RemoteFileProvider,
  getConnectionProfile,
  getDefaultPrivateKeyPath
} = require("./remoteFileProvider.cjs");

let mainWindow;
const provider = new RemoteFileProvider();
const bundledSamplePath = path.join(__dirname, "../../samples/sample.md");
const appIconPath = path.join(__dirname, "../../resources/tether-icon.png");
const localMarkdownExtensions = new Set([".md", ".markdown", ".mdown", ".mkd", ".txt"]);
const zoomStep = 0.1;
const minZoomFactor = 0.5;
const maxZoomFactor = 2.5;
const uiStateFileName = "tether-state.json";
const localGrantsFileName = "tether-local-grants.json";
const trustedHostsFileName = "tether-trusted-hosts.json";
const localGrants = new Set();

app.setName("Tether");
app.commandLine.appendSwitch("force-color-profile", "srgb");
if (process.platform === "win32") app.setAppUserModelId("app.tether.markdown");

function installApplicationMenu() {
  // Windows/Linux keep a menu-less window by design. macOS requires an
  // application menu for the standard Cmd+C/V/X/A/Z/Q and window shortcuts;
  // the built-in editMenu roles wire up cut/copy/paste/undo/redo/select-all.
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { label: "View", submenu: [{ role: "togglefullscreen" }] },
      { role: "windowMenu" }
    ])
  );
}

function isLocalMarkdownPath(filePath) {
  return localMarkdownExtensions.has(path.extname(filePath).toLowerCase());
}

function getUserSamplePath() {
  return path.join(app.getPath("userData"), "sample.md");
}

async function ensureUserSamplePath() {
  const samplePath = getUserSamplePath();
  try {
    await fs.access(samplePath);
  } catch {
    const bundledContent = await fs.readFile(bundledSamplePath, "utf8");
    await fs.mkdir(path.dirname(samplePath), { recursive: true });
    await fs.writeFile(samplePath, bundledContent, "utf8");
  }
  return samplePath;
}

function localFileVersion(metadata) {
  return `${metadata.mtimeMs}-${metadata.size}`;
}

function localFilePayload(filePath, content, metadata) {
  return {
    path: filePath,
    content,
    refreshedAt: new Date().toISOString(),
    version: localFileVersion(metadata),
    metadata: {
      size: metadata.size,
      mtime: metadata.mtime.toISOString()
    }
  };
}

function getLocalGrantsPath() {
  return path.join(app.getPath("userData"), localGrantsFileName);
}

function getTrustedHostsPath() {
  return path.join(app.getPath("userData"), trustedHostsFileName);
}

function normalizeLocalPathForGrant(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return path.resolve(value);
  } catch {
    return "";
  }
}

function grantLocalRoot(targetPath) {
  const normalized = normalizeLocalPathForGrant(targetPath);
  if (!normalized) return;
  localGrants.add(normalized);
  persistLocalGrants();
}

function loadLocalGrants() {
  localGrants.clear();
  try {
    const grantState = JSON.parse(fsSync.readFileSync(getLocalGrantsPath(), "utf8"));
    for (const root of grantState.roots || []) {
      const normalized = normalizeLocalPathForGrant(root);
      if (normalized) localGrants.add(normalized);
    }
  } catch {
    seedLocalGrantsFromUiState();
  }
}

function seedLocalGrantsFromUiState() {
  const state = readUiState();
  for (const session of state.sourceSessions || []) {
    if (session?.kind === "local-folder") {
      grantLocalRoot(session.rootPath || session.directory);
    } else if (session?.kind === "local-file" && session.selectedPath) {
      grantLocalRoot(session.rootPath || path.dirname(session.selectedPath || ""));
    }
  }
  persistLocalGrants();
}

function persistLocalGrants() {
  try {
    const grantsPath = getLocalGrantsPath();
    const payload = {
      version: 1,
      roots: [...localGrants],
      updatedAt: new Date().toISOString()
    };
    fsSync.mkdirSync(path.dirname(grantsPath), { recursive: true });
    fsSync.writeFileSync(grantsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Current-process grants remain active if persistence fails.
  }
}

function resolveRealPath(targetPath) {
  const normalized = normalizeLocalPathForGrant(targetPath);
  if (!normalized) return "";
  try {
    return fsSync.realpathSync(normalized);
  } catch {
    // The path may not exist yet (e.g. a brand-new file): resolve the real
    // parent directory and re-join the basename so a symlinked parent is
    // still resolved before the grant check.
    try {
      return path.join(fsSync.realpathSync(path.dirname(normalized)), path.basename(normalized));
    } catch {
      return normalized;
    }
  }
}

function assertLocalPathGranted(targetPath, options = {}) {
  const normalized = normalizeLocalPathForGrant(targetPath);
  if (!normalized) throw userError("LOCAL_PATH_INVALID", "The local path is invalid.");

  if (options.markdownFile && !isLocalMarkdownPath(normalized)) {
    throw userError("LOCAL_FILE_TYPE", "Only Markdown and text files can be opened or saved.");
  }

  // Resolve symlinks before the containment check so a link inside a granted
  // folder cannot redirect the real read/write target outside the sandbox.
  const realTarget = resolveRealPath(normalized);
  const granted = [...localGrants].some((root) => localPathContains(resolveRealPath(root), realTarget));
  if (!granted) {
    throw userError(
      "LOCAL_PATH_NOT_GRANTED",
      "Choose this file or folder from the native picker before Tether can access it."
    );
  }
  return normalized;
}

function localPathContains(rootPath, targetPath) {
  const root = normalizeLocalPathForGrant(rootPath);
  const target = normalizeLocalPathForGrant(targetPath);
  if (!root || !target) return false;

  const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
  if (comparableTarget === comparableRoot) return true;

  const relative = path.relative(comparableRoot, comparableTarget);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function listLocalDirectoryEntries(directory) {
  const names = await fs.readdir(directory, { withFileTypes: true });
  const entries = await Promise.all(
    names.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      const type = entry.isDirectory() ? "directory" : "file";
      let size = 0;

      try {
        const metadata = await fs.stat(entryPath);
        size = metadata.size;
      } catch {
        size = 0;
      }

      return {
        name: entry.name,
        path: entryPath,
        type,
        size,
        isMarkdown: type === "directory" || isLocalMarkdownPath(entryPath)
      };
    })
  );

  return entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function toRendererError(error) {
  return {
    code: error?.code || "REMOTE_ERROR",
    message: error?.message || "Remote operation failed",
    details: error?.details
  };
}

function createWindow() {
  const backgroundColor = getResolvedWindowBackground();
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: "Tether",
    icon: appIconPath,
    autoHideMenuBar: true,
    backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  if (typeof mainWindow.removeMenu === "function") {
    mainWindow.removeMenu();
  }

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (handleZoomShortcut(mainWindow.webContents, input)) {
      event.preventDefault();
      return;
    }

    if (isBlockedShellShortcut(input)) event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, mainWindow.webContents.getURL())) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  const devServerUrl = getTrustedDevServerUrl();
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

function getTrustedDevServerUrl() {
  if (app.isPackaged) return "";
  const rawUrl = process.env.VITE_DEV_SERVER_URL;
  if (!rawUrl) return "";

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!isLocalDevHost(parsed.hostname)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isAllowedAppNavigation(nextUrl, currentUrl) {
  try {
    const next = new URL(nextUrl);
    const current = currentUrl ? new URL(currentUrl) : null;
    if (next.protocol === "file:" && current?.protocol === "file:" && next.pathname === current.pathname) return true;
    if (!app.isPackaged && current && next.origin === current.origin && isLocalDevHost(next.hostname)) return true;
  } catch {
    return false;
  }
  return false;
}

function isLocalDevHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function openExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      void shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed links from rendered Markdown.
  }
}

function getResolvedWindowBackground() {
  const theme = readUiState()?.preferences?.theme;
  const resolvedTheme = theme === "light" || theme === "dark"
    ? theme
    : nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return resolvedTheme === "dark" ? "#15181b" : "#eaedee";
}

function handleZoomShortcut(webContents, input) {
  const key = String(input.key || "").toLowerCase();
  const code = String(input.code || "").toLowerCase();
  const hasCommandModifier = Boolean(input.control || input.meta);

  if (!hasCommandModifier || input.alt) return false;

  const isZoomIn = key === "+" || key === "=" || code === "equal" || code === "numpadadd";
  const isZoomOut = key === "-" || key === "_" || code === "minus" || code === "numpadsubtract";
  const isZoomReset = key === "0" || key === ")" || code === "digit0" || code === "numpad0";

  if (!isZoomIn && !isZoomOut && !isZoomReset) return false;

  if (isZoomReset) {
    webContents.setZoomFactor(1);
    return true;
  }

  const currentZoom = webContents.getZoomFactor();
  const direction = isZoomIn ? 1 : -1;
  const nextZoom = Math.min(maxZoomFactor, Math.max(minZoomFactor, currentZoom + direction * zoomStep));
  webContents.setZoomFactor(Number(nextZoom.toFixed(2)));
  return true;
}

function isBlockedShellShortcut(input) {
  const key = String(input.key || "").toLowerCase();
  const code = String(input.code || "").toLowerCase();
  const hasCommandModifier = Boolean(input.control || input.meta);
  const hasShift = Boolean(input.shift);

  if (input.alt && !hasCommandModifier && !hasShift && (key === "alt" || code.startsWith("alt"))) return true;
  if (key === "f10" || code === "f10") return true;
  if (key === "f5" || code === "f5") return true;
  if ((key === "f12" || code === "f12") && !input.alt) return true;

  if (!hasCommandModifier) return false;

  if (key === "r") return true;
  if (key === "p") return true;
  if (hasShift && key === "i") return true;

  return false;
}

provider.on("status", (payload) => sendToRenderer("remote:status", payload));
provider.on("update", (payload) => sendToRenderer("remote:update", payload));
provider.on("error", (error) => sendToRenderer("remote:error", toRendererError(error)));

ipcMain.on("state:getUiState", (event) => {
  event.returnValue = readUiState();
});

ipcMain.handle("state:saveUiState", async (_event, patch = {}) => {
  try {
    return { ok: true, state: writeUiStatePatch(patch) };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("remote:connectAndOpen", async (_event, connection) => {
  try {
    await provider.connect(connection);
    const remotePath = connection.remotePath?.trim();

    if (remotePath) {
      const file = await provider.readFile(remotePath);
      const directory = path.posix.dirname(remotePath.replace(/\\/g, "/")) || ".";
      const entries = await provider.listDirectory(directory);
      return { ok: true, file, directory, entries };
    }

    const directory = connection.remoteDirectory?.trim() || await provider.getWorkingDirectory();
    const entries = await provider.listDirectory(directory);
    return { ok: true, file: null, directory, entries };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

function getUiStatePath() {
  return path.join(app.getPath("userData"), uiStateFileName);
}

function readUiState() {
  try {
    const statePath = getUiStatePath();
    const state = JSON.parse(fsSync.readFileSync(statePath, "utf8"));
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function writeUiStatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return readUiState();

  const statePath = getUiStatePath();
  const nextState = {
    ...readUiState(),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  const tempPath = `${statePath}.tmp`;

  fsSync.mkdirSync(path.dirname(statePath), { recursive: true });
  fsSync.writeFileSync(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  fsSync.renameSync(tempPath, statePath);
  return nextState;
}

ipcMain.handle("remote:getDefaultPrivateKeyPath", async () => ({
  ok: true,
  privateKeyPath: getDefaultPrivateKeyPath()
}));

ipcMain.handle("remote:getConnectionProfile", async (_event, connection) => {
  try {
    return { ok: true, profile: getConnectionProfile(connection) };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("app:healthCheck", async (_event, context = {}) => {
  const startedAt = performance.now();

  function latencyMs() {
    return Math.max(0, performance.now() - startedAt);
  }

  try {
    if (context.documentSource === "remote") {
      const details = await provider.healthCheck();
      return {
        ok: true,
        kind: "remote",
        target: context.target || "remote server",
        latencyMs: latencyMs(),
        checkedAt: new Date().toISOString(),
        details
      };
    }

    const localPath =
      context.documentSource === "sample"
        ? await ensureUserSamplePath()
        : context.localPath || context.currentDirectory;

    if (!localPath) {
      return {
        ok: false,
        latencyMs: latencyMs(),
        checkedAt: new Date().toISOString(),
        error: {
          code: "NO_SOURCE",
          message: "No source is open to check."
        }
      };
    }

    const checkedPath =
      context.documentSource === "sample" ? localPath : assertLocalPathGranted(localPath);
    const metadata = await fs.stat(checkedPath);
    return {
      ok: true,
      kind: context.documentSource === "sample" ? "sample" : "local",
      target: context.documentSource === "sample" ? "sample.md" : checkedPath,
      latencyMs: latencyMs(),
      checkedAt: new Date().toISOString(),
      metadata: {
        isDirectory: metadata.isDirectory(),
        size: metadata.size,
        mtime: metadata.mtime.toISOString()
      }
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: latencyMs(),
      checkedAt: new Date().toISOString(),
      error: toRendererError(error)
    };
  }
});

ipcMain.handle("app:copyText", async (_event, text) => {
  try {
    clipboard.writeText(String(text ?? ""));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("remote:selectPrivateKey", async () => {
  const response = await dialog.showOpenDialog(mainWindow, {
    title: "Choose private key",
    properties: ["openFile", "showHiddenFiles"],
    filters: [
      { name: "Private keys", extensions: ["pem", "key", "ppk", "*"] },
      { name: "All files", extensions: ["*"] }
    ]
  });

  if (response.canceled || response.filePaths.length === 0) {
    return { ok: true, canceled: true, privateKeyPath: "" };
  }

  return { ok: true, canceled: false, privateKeyPath: response.filePaths[0] };
});

ipcMain.handle("remote:disconnect", async () => {
  try {
    await provider.disconnect();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("remote:openFile", async (_event, remotePath) => {
  try {
    const file = await provider.readFile(remotePath);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("remote:listDirectory", async (_event, remotePath) => {
  try {
    const entries = await provider.listDirectory(remotePath);
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("remote:startWatching", async (_event, options) => {
  try {
    assertObject(options, "Watch");
    assertString(options.remotePath, "Remote path");
    provider.startWatching(options.remotePath, options.intervalMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("remote:stopWatching", async () => {
  provider.stopWatching();
  return { ok: true };
});

ipcMain.handle("remote:saveFile", async (_event, payload) => {
  try {
    assertObject(payload, "Save");
    assertString(payload.remotePath, "Remote path");
    assertString(payload.content, "Content");
    const file = await provider.writeFile(
      payload.remotePath,
      payload.content,
      payload.expectedVersion
    );
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("local:readSample", async () => {
  try {
    const samplePath = await ensureUserSamplePath();
    const content = await fs.readFile(samplePath, "utf8");
    const metadata = await fs.stat(samplePath);
    return { ok: true, file: localFilePayload("samples/sample.md", content, metadata) };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("local:saveSample", async (_event, content) => {
  try {
    const samplePath = await ensureUserSamplePath();
    await fs.writeFile(samplePath, content, "utf8");
    const metadata = await fs.stat(samplePath);
    return { ok: true, file: localFilePayload("samples/sample.md", content, metadata) };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("local:openFile", async () => {
  try {
    const response = await dialog.showOpenDialog(mainWindow, {
      title: "Open local Markdown file",
      properties: ["openFile"],
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
        { name: "Text", extensions: ["txt"] },
        { name: "All files", extensions: ["*"] }
      ]
    });

    if (response.canceled || response.filePaths.length === 0) {
      return { ok: true, canceled: true, file: null };
    }

    const filePath = response.filePaths[0];
    if (!isLocalMarkdownPath(filePath)) {
      throw userError("LOCAL_FILE_TYPE", "Only Markdown and text files can be opened.");
    }
    grantLocalRoot(path.dirname(filePath));
    const content = await fs.readFile(filePath, "utf8");
    const metadata = await fs.stat(filePath);
    const directory = path.dirname(filePath);
    const entries = await listLocalDirectoryEntries(directory);
    return { ok: true, canceled: false, file: localFilePayload(filePath, content, metadata), directory, entries };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("local:readFile", async (_event, filePath) => {
  try {
    const grantedPath = assertLocalPathGranted(filePath, { markdownFile: true });
    const content = await fs.readFile(grantedPath, "utf8");
    const metadata = await fs.stat(grantedPath);
    return { ok: true, file: localFilePayload(grantedPath, content, metadata) };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("local:openDirectory", async () => {
  try {
    const response = await dialog.showOpenDialog(mainWindow, {
      title: "Open local folder",
      properties: ["openDirectory"]
    });

    if (response.canceled || response.filePaths.length === 0) {
      return { ok: true, canceled: true, directory: "", entries: [] };
    }

    const directory = response.filePaths[0];
    grantLocalRoot(directory);
    const entries = await listLocalDirectoryEntries(directory);
    return { ok: true, canceled: false, directory, entries };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("local:listDirectory", async (_event, directory) => {
  try {
    const grantedDirectory = assertLocalPathGranted(directory);
    const entries = await listLocalDirectoryEntries(grantedDirectory);
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

ipcMain.handle("local:saveFile", async (_event, payload) => {
  try {
    assertObject(payload, "Save");
    assertString(payload.path, "File path");
    assertString(payload.content, "Content");
    const grantedPath = assertLocalPathGranted(payload.path, { markdownFile: true });
    const currentMetadata = await fs.stat(grantedPath);
    const currentVersion = localFileVersion(currentMetadata);

    if (payload.expectedVersion && payload.expectedVersion !== currentVersion) {
      const error = new Error("Local file changed on disk. Refresh or reopen it before saving.");
      error.code = "LOCAL_CONFLICT";
      throw error;
    }

    await fs.writeFile(grantedPath, payload.content, "utf8");
    const metadata = await fs.stat(grantedPath);
    return { ok: true, file: localFilePayload(grantedPath, payload.content, metadata) };
  } catch (error) {
    return { ok: false, error: toRendererError(error) };
  }
});

function userError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw userError("BAD_REQUEST", `${label} request is malformed.`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string") {
    throw userError("BAD_REQUEST", `${label} must be text.`);
  }
}

app.whenReady().then(() => {
  installApplicationMenu();
  provider.setKnownHostsPath(getTrustedHostsPath());
  loadLocalGrants();
  createWindow();
});

let quitCleanupStarted = false;
app.on("before-quit", () => {
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  provider.disconnect().catch(() => {});
});

app.on("window-all-closed", () => {
  provider.disconnect().catch(() => {});
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
