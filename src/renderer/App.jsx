import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  File,
  FileText,
  Folder,
  FolderOpen,
  GripVertical,
  Maximize2,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Sun
} from "lucide-react";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-500.css";
import "@fontsource/instrument-sans/latin-600.css";
import "@fontsource/instrument-sans/latin-700.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-600.css";
import "./styles.css";
import sampleMarkdown from "../../samples/sample.md?raw";

const LazyDocumentSurface = React.lazy(() => import("./DocumentSurface.jsx"));
const BOOT_PREFERENCES_KEY = "remoteMarkdownPreview.preferences";

showBootOverlayNow();

const defaultConnection = {
  host: "",
  port: 22,
  username: "",
  authMode: "auto",
  password: "",
  privateKeyPath: "",
  passphrase: "",
  remotePath: "",
  remoteDirectory: "",
  intervalMs: 2000
};

const SIDEBAR_WIDTH_KEY = "remoteMarkdownPreview.sidebarWidth";
const LOCAL_SAMPLE_KEY = "remoteMarkdownPreview.localSample";
const CONNECTION_DRAFT_KEY = "remoteMarkdownPreview.connectionDraft";
const PREFERENCES_KEY = BOOT_PREFERENCES_KEY;
const SOURCE_SESSIONS_KEY = "tether.sourceSessions";
const SOURCE_SESSION_LIMIT = 8;
const SIDEBAR_MIN_WIDTH = 208;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 256;
const PAGE_WIDTH_MIN = 560;
const PAGE_WIDTH_MAX = 1320;
const PAGE_WIDTH_DEFAULT = 980;
const PAGE_WIDTH_STEP = 20;
const THEME_OPTIONS = ["system", "dark", "light"];
const defaultPreferences = {
  theme: "system",
  accent: "phosphor",
  readingFont: "sans",
  pageWidthPx: PAGE_WIDTH_DEFAULT,
  defaultView: "preview",
  sidebarCollapsed: false
};
const initialSampleMarkdown = getInitialSampleMarkdown();
const initialNativeUiState = getInitialNativeUiState();
const initialPreferences = getInitialPreferences();
const initialSourceSessions = getInitialSourceSessions();
const initialFontsReady = getInitialFontsReady();

const sampleEntry = {
  name: "sample.md",
  path: "samples/sample.md",
  type: "file",
  size: initialSampleMarkdown.length,
  isMarkdown: true
};

const chooseRemoteFileMarkdown = `# Connected

Choose a Markdown file from the Files sidebar to open it.

The remote path field is optional. Leaving it blank connects to your SFTP home/current directory first, then lets you browse from there.
`;

const chooseLocalFileMarkdown = `# Local Folder Opened

Choose a Markdown file from the Files sidebar to open it.
`;

const fallbackRemoteApi = {
  getDefaultPrivateKeyPath: async () => ({ ok: true, privateKeyPath: "" }),
  getUiStateSync: () => ({}),
  saveUiState: async () => ({ ok: true }),
  getConnectionProfile: async () => ({
    ok: true,
    profile: {
      hostAlias: "",
      host: "",
      port: 22,
      username: "",
      authMode: "auto",
      configuredIdentityFiles: [],
      privateKeyCandidates: [],
      defaultPrivateKeyPath: "",
      agentAvailable: false,
      warnings: ["Connection diagnostics are available in the Electron app."]
    }
  }),
  healthCheck: async (context = {}) => {
    const startedAt = window.performance?.now?.() ?? Date.now();
    const latencyMs = Math.max(0, Math.round((window.performance?.now?.() ?? Date.now()) - startedAt));
    if (context.documentSource === "remote") {
      return {
        ok: false,
        kind: "remote",
        latencyMs,
        checkedAt: new Date().toISOString(),
        error: {
          code: "BROWSER_PREVIEW",
          message: "Remote health checks run in the Electron app."
        }
      };
    }

    return {
      ok: true,
      kind: "preview",
      target: "browser preview",
      latencyMs,
      checkedAt: new Date().toISOString()
    };
  },
  selectPrivateKey: async () => ({ ok: true, canceled: true, privateKeyPath: "" }),
  connectAndOpen: async () => ({
    ok: false,
    error: {
      code: "BROWSER_PREVIEW",
      message: "SSH/SFTP is available in the Electron app. Browser preview renders local Markdown only."
    }
  }),
  disconnect: async () => ({ ok: true }),
  openFile: async () => ({
    ok: false,
    error: {
      code: "BROWSER_PREVIEW",
      message: "Remote file opening is available in the Electron app."
    }
  }),
  listDirectory: async () => ({ ok: true, entries: [sampleEntry] }),
  startWatching: async () => ({
    ok: false,
    error: {
      code: "BROWSER_PREVIEW",
      message: "Remote watching is available in the Electron app."
    }
  }),
  stopWatching: async () => ({ ok: true }),
  saveFile: async () => ({
    ok: false,
    error: {
      code: "BROWSER_PREVIEW",
      message: "Remote saving is available in the Electron app."
    }
  }),
  readLocalSample: async () => ({
    ok: true,
    file: createLocalSampleFile(window.localStorage.getItem(LOCAL_SAMPLE_KEY) || sampleMarkdown)
  }),
  openLocalFile: async () => openBrowserLocalFile(),
  readLocalFile: async (filePath) => {
    const storedContent = window.localStorage.getItem(`remoteMarkdownPreview.localFile:${filePath}`);
    if (storedContent === null) {
      return {
        ok: false,
        error: {
          code: "BROWSER_PREVIEW",
          message: "Reopen this local file to refresh it in the browser preview."
        }
      };
    }
    return { ok: true, file: createBrowserLocalFile(filePath, storedContent) };
  },
  saveLocalFile: async ({ path, content }) => {
    window.localStorage.setItem(`remoteMarkdownPreview.localFile:${path}`, content);
    return { ok: true, file: createBrowserLocalFile(path, content) };
  },
  openLocalDirectory: async () => ({
    ok: false,
    error: {
      code: "BROWSER_PREVIEW",
      message: "Local folder trees are available in the Electron app."
    }
  }),
  listLocalDirectory: async () => ({ ok: true, entries: [sampleEntry] }),
  saveLocalSample: async (content) => {
    window.localStorage.setItem(LOCAL_SAMPLE_KEY, content);
    return { ok: true, file: createLocalSampleFile(content) };
  },
  copyText: async (text) => ({ ok: await copyTextToBrowserClipboard(text) }),
  onStatus: () => () => {},
  onUpdate: () => () => {},
  onError: () => () => {}
};

const remoteApi = {
  ...fallbackRemoteApi,
  ...(window.remoteMarkdown ?? {})
};
const hasNativeHealthCheck = Boolean(window.remoteMarkdown?.healthCheck);

function App() {
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [connection, setConnection] = useState(getInitialConnection);
  const [status, setStatus] = useState({
    state: "idle",
    message: "Ready",
    checkedAt: null,
    metadata: null
  });
  const [error, setError] = useState(null);
  const [localSampleContent, setLocalSampleContent] = useState(initialSampleMarkdown);
  const [localWorkspaceDirectory, setLocalWorkspaceDirectory] = useState(null);
  const [localFile, setLocalFile] = useState(null);
  const [content, setContent] = useState(initialSampleMarkdown);
  const [editorContent, setEditorContent] = useState(initialSampleMarkdown);
  const [remoteShadow, setRemoteShadow] = useState(null);
  const [fileVersion, setFileVersion] = useState(null);
  const [fileMetadata, setFileMetadata] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [connected, setConnected] = useState(false);
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [fontsReady, setFontsReady] = useState(initialFontsReady);
  const [systemTheme, setSystemTheme] = useState(getSystemTheme);
  const [viewMode, setViewMode] = useState(initialPreferences.defaultView);
  const [zenMode, setZenMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialPreferences.sidebarCollapsed);
  const [sidebarPeeking, setSidebarPeeking] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => getIsCompactLayout());
  const [connectionPaletteOpen, setConnectionPaletteOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [tetherPing, setTetherPing] = useState(null);
  const [sourceSessions, setSourceSessions] = useState(initialSourceSessions);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [sourceOpening, setSourceOpening] = useState(null);
  const [sampleSourceOpen, setSampleSourceOpen] = useState(true);
  const [fileEntries, setFileEntries] = useState([sampleEntry]);
  const [currentDirectory, setCurrentDirectory] = useState("samples");
  const [selectedPath, setSelectedPath] = useState("samples/sample.md");
  const [documentRefreshing, setDocumentRefreshing] = useState(false);
  const [documentRefreshNotice, setDocumentRefreshNotice] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeRefreshNotice, setTreeRefreshNotice] = useState(null);
  const [defaultPrivateKeyPath, setDefaultPrivateKeyPath] = useState("");
  const [connectionProfile, setConnectionProfile] = useState(null);
  const resolvedTheme = preferences.theme === "system" ? systemTheme : preferences.theme;
  const previewRef = useRef(null);
  const scrollRatioRef = useRef(0);
  const pingTimerRef = useRef(null);
  const pingRequestRef = useRef(0);
  const documentRefreshTimerRef = useRef(null);
  const treeRefreshTimerRef = useRef(null);
  const sourceOpeningRef = useRef(null);

  useEffect(() => {
    remoteApi.getDefaultPrivateKeyPath().then((response) => {
      if (!response?.ok || !response.privateKeyPath) return;
      setDefaultPrivateKeyPath(response.privateKeyPath);
    });
  }, []);

  useEffect(() => {
    let canceled = false;
    remoteApi.getConnectionProfile(connection).then((response) => {
      if (canceled || !response?.ok) return;
      setConnectionProfile(response.profile);
    });
    return () => {
      canceled = true;
    };
  }, [connection]);

  useEffect(() => {
    saveConnectionDraft(connection);
  }, [connection]);

  useEffect(() => {
    syncBootPreferences(preferences.accent, resolvedTheme);
    savePreferences(preferences);
  }, [preferences, resolvedTheme]);

  useEffect(() => {
    saveSourceSessions(sourceSessions);
  }, [sourceSessions]);

  useEffect(() => {
    if (fontsReady || typeof document === "undefined" || !document.fonts) return undefined;

    let canceled = false;
    const fontPromises = [
      document.fonts.load('400 13px "IBM Plex Mono"'),
      document.fonts.load('500 13px "IBM Plex Mono"'),
      document.fonts.load('600 13px "IBM Plex Mono"'),
      document.fonts.load('400 16px "Instrument Sans"'),
      document.fonts.load('500 16px "Instrument Sans"'),
      document.fonts.load('600 34px "Instrument Sans"'),
      document.fonts.load('700 16px "Instrument Sans"'),
      document.fonts.load('400 17px "Newsreader"'),
      document.fonts.load('600 17px "Newsreader"'),
      document.fonts.ready
    ];

    Promise.race([
      Promise.allSettled(fontPromises).then(() => document.fonts.ready),
      waitForTimeout(900)
    ]).then(async () => {
      if (!canceled) setFontsReady(true);
    });

    return () => {
      canceled = true;
    };
  }, [fontsReady]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const root = document.documentElement;
    let canceled = false;

    function showBootOverlay() {
      showBootOverlayNow();
    }

    if (!fontsReady) {
      showBootOverlay();
      return undefined;
    }

    showBootOverlay();
    Promise.race([
      waitForAppReadyToReveal(document.getElementById("root") || document.body),
      waitForTimeout(1200)
    ]).then(() => {
      if (!canceled) hideBootOverlayNow();
    });

    window.addEventListener("beforeunload", showBootOverlay);
    window.addEventListener("pagehide", showBootOverlay);

    return () => {
      canceled = true;
      window.removeEventListener("beforeunload", showBootOverlay);
      window.removeEventListener("pagehide", showBootOverlay);
    };
  }, [fontsReady]);

  useEffect(() => {
    if (!window.matchMedia) return undefined;

    const media = window.matchMedia("(prefers-color-scheme: light)");
    function updateSystemTheme() {
      setSystemTheme(media.matches ? "light" : "dark");
    }

    updateSystemTheme();
    if (media.addEventListener) {
      media.addEventListener("change", updateSystemTheme);
      return () => media.removeEventListener("change", updateSystemTheme);
    }

    media.addListener(updateSystemTheme);
    return () => media.removeListener(updateSystemTheme);
  }, []);

  useEffect(() => {
    const removeStatus = remoteApi.onStatus((payload) => {
      setStatus((current) => ({ ...current, ...payload }));
      if (payload.metadata) setFileMetadata(payload.metadata);
    });

    const removeError = remoteApi.onError((payload) => {
      setError(payload);
    });

    const removeUpdate = remoteApi.onUpdate((file) => {
      captureScrollRatio(previewRef, scrollRatioRef);
      applyRemoteFile(file);
    });

    return () => {
      removeStatus();
      removeError();
      removeUpdate();
    };
  }, [dirty]);

  useEffect(() => {
    restoreScrollRatio(previewRef, scrollRatioRef);
  }, [content, viewMode, zenMode]);

  useEffect(() => {
    function onResize() {
      const nextCompactLayout = getIsCompactLayout();
      setCompactLayout(nextCompactLayout);
      if (!nextCompactLayout) setSidebarPeeking(false);
    }

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (pingTimerRef.current) window.clearTimeout(pingTimerRef.current);
      if (documentRefreshTimerRef.current) window.clearTimeout(documentRefreshTimerRef.current);
      if (treeRefreshTimerRef.current) window.clearTimeout(treeRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setConnectionPaletteOpen((open) => !open);
      }

      if (event.key === "Escape") {
        if (connectionPaletteOpen) setConnectionPaletteOpen(false);
        if (settingsPanelOpen) setSettingsPanelOpen(false);
        if (sidebarPeeking) setSidebarPeeking(false);
        if (zenMode) setZenMode(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [connectionPaletteOpen, settingsPanelOpen, sidebarPeeking, zenMode]);

  useEffect(() => {
    if (!resizingSidebar) return undefined;

    function onMouseMove(event) {
      const nextWidth = clampSidebarWidth(event.clientX);
      setSidebarWidth(nextWidth);
      saveSidebarWidth(nextWidth);
    }

    function onMouseUp() {
      setResizingSidebar(false);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [resizingSidebar]);

  const previewContent = dirty ? editorContent : content;
  const hasLocalDocument = Boolean(localFile || localWorkspaceDirectory);
  const documentSource = connected ? "remote" : hasLocalDocument ? "local" : sampleSourceOpen ? "sample" : "none";
  const documentTitle = connected
    ? selectedPath
      ? basename(selectedPath)
      : "Choose a Markdown file"
    : localFile?.path
      ? basename(localFile.path)
      : localWorkspaceDirectory
        ? "Choose a Markdown file"
      : documentSource === "sample"
        ? "sample.md"
        : "No document open";
  const documentEyebrow =
    connected ? selectedPath : documentSource === "local" ? "Local file" : documentSource === "sample" ? "Local sample" : "No source";
  const sidebarVisible = !zenMode;
  const canSave =
    dirty &&
    !conflict &&
    ((documentSource === "sample" && selectedPath === sampleEntry.path) ||
      (documentSource === "local" && localFile?.path) ||
      (documentSource === "remote" && selectedPath));
  const canRefreshDocument = documentSource === "remote" && selectedPath;
  const sourceLabel = connected
    ? `${connection.username || "user"}@${connection.host || "host"}`
    : documentSource === "local" && localWorkspaceDirectory
      ? compactPath(localWorkspaceDirectory)
      : documentSource === "sample"
        ? "local sample"
        : "no source";
  const rootLabel = connected || (documentSource === "local" && localWorkspaceDirectory) ? currentDirectory : documentSource === "sample" ? "samples" : "";
  const toolbarDocumentLabel =
    sourceOpening?.title || (documentSource === "none" ? documentTitle : selectedPath ? compactPath(selectedPath) : documentTitle);
  const toolbarDocumentTitle = sourceOpening?.message || selectedPath || documentTitle;
  const fileModifiedLabel = formatFileModifiedLabel(fileMetadata?.mtime || status.metadata?.mtime);
  const statusLabel = sourceOpening
    ? sourceOpening.message
    : documentRefreshing
      ? "refreshing file"
      : documentRefreshNotice
        ? documentRefreshNotice
        : treeLoading
          ? "refreshing tree"
          : treeRefreshNotice
            ? treeRefreshNotice
            : conflict
              ? "conflict - resolve to save"
              : error
                ? status.message || "error"
                : dirty
                  ? fileModifiedLabel
                    ? `unsaved - ${fileModifiedLabel}`
                    : "unsaved edits"
                  : documentSource === "remote"
                    ? selectedPath
                      ? fileModifiedLabel || "remote file"
                      : "choose a Markdown file"
                    : documentSource === "local"
                      ? localFile?.path
                        ? fileModifiedLabel || "local file"
                        : "choose a Markdown file"
                      : documentSource === "sample"
                        ? fileModifiedLabel || "local sample"
                        : "no document open";
  const sourceTone = sourceOpening || documentRefreshing || treeLoading ? "idle" : conflict ? "conflict" : error ? "error" : watching ? "watching" : connected ? "connected" : "idle";
  const syncLabel =
    sourceOpening
      ? "opening"
      : documentSource === "remote"
      ? `poll ${formatPoll(connection.intervalMs)}`
      : documentSource === "local"
        ? "local"
        : documentSource === "sample"
          ? "sample"
          : "idle";
  const wordCount = countWords(previewContent);
  const lineCount = countLines(editorContent);
  const sidebarRailMode = sidebarCollapsed || compactLayout;
  const showLocalSource = sampleSourceOpen;
  const expandedSidebarWidth = Math.max(sidebarWidth, SIDEBAR_MIN_WIDTH);
  useEffect(() => {
    if (documentSource !== "sample" || selectedPath !== sampleEntry.path || dirty) return undefined;

    let canceled = false;
    remoteApi.readLocalSample().then((response) => {
      if (canceled || !response?.ok || !response.file) return;
      setLocalSampleContent(response.file.content);
      setContent(response.file.content);
      setEditorContent(response.file.content);
      setFileVersion(response.file.version);
      setFileMetadata(response.file.metadata);
      setLastRefresh(response.file.refreshedAt);
      setFileEntries([
        {
          ...sampleEntry,
          size: response.file.metadata?.size ?? response.file.content.length
        }
      ]);
      setStatus((current) => ({ ...current, state: "idle", metadata: response.file.metadata }));
    });

    return () => {
      canceled = true;
    };
  }, [dirty, documentSource, selectedPath]);

  function applyRemoteFile(file) {
    setLastRefresh(file.refreshedAt);
    setError(null);

    if (dirty) {
      setRemoteShadow(file);
      setConflict(true);
      return;
    }

    setContent(file.content);
    setEditorContent(file.content);
    setFileVersion(file.version);
    setFileMetadata(file.metadata);
    setRemoteShadow(null);
    setConflict(false);
  }

  function applyFreshFile(file) {
    captureScrollRatio(previewRef, scrollRatioRef);
    setContent(file.content);
    setEditorContent(file.content);
    setFileVersion(file.version);
    setFileMetadata(file.metadata);
    setLastRefresh(file.refreshedAt);
    setRemoteShadow(null);
    setError(null);
  }

  function updateConnection(field, value) {
    setConnection((current) => ({ ...current, [field]: value }));
  }

  function rememberSourceSession(session) {
    if (!session?.id) return;
    setActiveSessionId(session.id);
    setSourceSessions((current) => upsertSourceSession(current, session));
  }

  function forgetSourceSession(sessionId) {
    setSourceSessions((current) => current.filter((session) => session.id !== sessionId));
    if (activeSessionId === sessionId) setActiveSessionId(null);
  }

  function confirmDiscardEdits(action) {
    return !dirty || window.confirm(`Discard unsaved local edits and ${action}?`);
  }

  function hasSourceOpening(key = "") {
    if (!sourceOpeningRef.current) return false;
    return key ? sourceOpeningRef.current.key === key : true;
  }

  function beginSourceOpening(opening) {
    sourceOpeningRef.current = opening;
    setSourceOpening(opening);
  }

  function endSourceOpening(key) {
    if (key && sourceOpeningRef.current?.key !== key) return;
    sourceOpeningRef.current = null;
    setSourceOpening(null);
  }

  function showTreeRefreshNotice(message = "tree refreshed") {
    if (treeRefreshTimerRef.current) window.clearTimeout(treeRefreshTimerRef.current);
    setTreeRefreshNotice(`${message} ${formatFileTimestamp(new Date())}`.trim());
    treeRefreshTimerRef.current = window.setTimeout(() => {
      setTreeRefreshNotice(null);
      treeRefreshTimerRef.current = null;
    }, 2400);
  }

  function showDocumentRefreshNotice(message = "file refreshed") {
    if (documentRefreshTimerRef.current) window.clearTimeout(documentRefreshTimerRef.current);
    setDocumentRefreshNotice(`${message} ${formatFileTimestamp(new Date())}`.trim());
    documentRefreshTimerRef.current = window.setTimeout(() => {
      setDocumentRefreshNotice(null);
      documentRefreshTimerRef.current = null;
    }, 2400);
  }

  async function choosePrivateKey() {
    const response = await remoteApi.selectPrivateKey();
    if (!response?.ok || response.canceled || !response.privateKeyPath) return;
    updateConnection("privateKeyPath", response.privateKeyPath);
  }

  async function connectAndOpen(connectionOverride = connection, options = {}) {
    const openingKey = options.openingKey || (options.sessionId ? `source:${options.sessionId}` : "connect");
    if (hasSourceOpening(openingKey)) return false;
    if (hasSourceOpening()) return false;
    if (!confirmDiscardEdits("connect to another source")) return false;

    const nextConnection = {
      ...defaultConnection,
      ...connectionOverride
    };

    setBusy(true);
    setError(null);
    beginSourceOpening({
      key: openingKey,
      title: options.openingTitle || "opening remote source",
      message: options.openingMessage || "Resolving SSH connection and file tree."
    });
    setStatus({ state: "connecting", message: "Connecting...", checkedAt: null, metadata: null });

    const wasConnected = connected;
    try {
      const response = await remoteApi.connectAndOpen(nextConnection);

      if (!response.ok) {
        if (wasConnected) {
          setWatching(false);
          restoreLocalFallback("Connection failed");
        }
        setConnected(false);
        setError(response.error);
        setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        return false;
      }

      const openedPath = nextConnection.remotePath.trim();
      const directory = response.directory || (openedPath ? dirname(openedPath) : ".");
      setConnection((current) => ({
        ...current,
        ...nextConnection,
        remoteDirectory: directory
      }));
      setConnected(true);
      setWatching(false);
      setLocalWorkspaceDirectory(null);
      setLocalFile(null);
      setDirty(false);
      setConflict(false);
      setSelectedPath(openedPath);
      setCurrentDirectory(directory);
      setFileEntries(response.entries || []);
      if (response.file) {
        applyFreshFile(response.file);
        setStatus((current) => ({ ...current, state: "connected", message: "Remote file opened" }));
      } else {
        setContent(chooseRemoteFileMarkdown);
        setEditorContent(chooseRemoteFileMarkdown);
        setFileVersion(null);
        setFileMetadata(null);
        setLastRefresh(null);
        setStatus((current) => ({
          ...current,
          state: "connected",
          message: "Connected. Choose a Markdown file from Files."
        }));
      }
      rememberSourceSession(buildRemoteSourceSession(nextConnection, directory, response.file ? openedPath : "", options.sessionId));
      return true;
    } finally {
      setBusy(false);
      endSourceOpening(openingKey);
    }
  }

  async function disconnect() {
    if (!confirmDiscardEdits("disconnect")) return false;

    await remoteApi.disconnect();
    setConnected(false);
    setWatching(false);
    setActiveSessionId(null);
    restoreLocalFallback("Disconnected");
    setStatus({ state: "idle", message: "Disconnected", checkedAt: null, metadata: null });
    return true;
  }

  async function loadDirectory(directory = currentDirectory) {
    setTreeLoading(true);
    setError(null);
    try {
      const response = await remoteApi.listDirectory(directory);

      if (!response.ok) {
        setError(response.error);
        setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        return false;
      }

      setCurrentDirectory(directory);
      setFileEntries(response.entries);
      const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
      rememberSourceSession(
        buildRemoteSourceSession(
          connection,
          directory,
          selectedPath && dirname(selectedPath) === directory ? selectedPath : "",
          activeSession?.kind === "remote" ? activeSession.id : ""
        )
      );
      return true;
    } finally {
      setTreeLoading(false);
    }
  }

  async function loadLocalDirectory(directory = currentDirectory) {
    setTreeLoading(true);
    setError(null);
    try {
      const response = await remoteApi.listLocalDirectory(directory);

      if (!response.ok) {
        setError(response.error);
        setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        return false;
      }

      setLocalWorkspaceDirectory(directory);
      setCurrentDirectory(directory);
      setFileEntries(response.entries);
      const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
      if (activeSession?.kind === "local-folder") {
        rememberSourceSession(buildLocalFolderSourceSession(activeSession.rootPath || directory, directory, "", activeSession.id));
      }
      return true;
    } finally {
      setTreeLoading(false);
    }
  }

  async function openEntry(entry) {
    if (entry.type === "directory") {
      await loadDirectory(entry.path);
      return;
    }

    if (!entry.isMarkdown) return;
    if (dirty && !window.confirm("Discard unsaved local edits and open another file?")) return;

    if (!connected) {
      await loadSample();
      return;
    }

    setBusy(true);
    setError(null);
    if (watching) {
      await remoteApi.stopWatching();
      setWatching(false);
    }

    const response = await remoteApi.openFile(entry.path);
    setBusy(false);

    if (!response.ok) {
      setError(response.error);
      return;
    }

    setSelectedPath(entry.path);
    setConnection((current) => ({ ...current, remotePath: entry.path }));
    setDirty(false);
    setConflict(false);
    applyFreshFile(response.file);
    const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
    rememberSourceSession(
      buildRemoteSourceSession(connection, dirname(entry.path), entry.path, activeSession?.kind === "remote" ? activeSession.id : "")
    );
    setStatus((current) => ({
      ...current,
      state: "connected",
      message: `Opened ${entry.name}`
    }));
  }

  async function openLocalFile() {
    if (dirty && !window.confirm("Discard unsaved local edits and open another file?")) return;

    setBusy(true);
    setError(null);
    const response = await remoteApi.openLocalFile();
    setBusy(false);

    if (!response.ok) {
      setError(response.error);
      setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
      return;
    }

    if (response.canceled || !response.file) return;

    if (watching) {
      await remoteApi.stopWatching();
      setWatching(false);
    }

    if (connected) {
      await remoteApi.disconnect();
      setConnected(false);
    }

    setLocalFile({ path: response.file.path });
    setSelectedPath(response.file.path);
    setLocalWorkspaceDirectory(response.directory || localDirname(response.file.path));
    setCurrentDirectory(response.directory || localDirname(response.file.path));
    setFileEntries(response.entries || []);
    setDirty(false);
    setConflict(false);
    setRemoteShadow(null);
    applyFreshFile(response.file);
    rememberSourceSession(buildLocalFileSourceSession(response.file.path, response.directory || localDirname(response.file.path)));
    setStatus({ state: "idle", message: "Opened local file", checkedAt: null, metadata: response.file.metadata });
  }

  async function openLocalDirectory() {
    if (dirty && !window.confirm("Discard unsaved local edits and open a folder?")) return;

    setBusy(true);
    setError(null);
    const response = await remoteApi.openLocalDirectory();
    setBusy(false);

    if (!response.ok) {
      setError(response.error);
      setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
      return;
    }

    if (response.canceled || !response.directory) return;

    if (watching) {
      await remoteApi.stopWatching();
      setWatching(false);
    }

    if (connected) {
      await remoteApi.disconnect();
      setConnected(false);
    }

    setLocalWorkspaceDirectory(response.directory);
    setLocalFile(null);
    setSelectedPath("");
    setCurrentDirectory(response.directory);
    setFileEntries(response.entries || []);
    setContent(chooseLocalFileMarkdown);
    setEditorContent(chooseLocalFileMarkdown);
    setDirty(false);
    setConflict(false);
    setRemoteShadow(null);
    setFileVersion(null);
    setFileMetadata(null);
    setLastRefresh(null);
    rememberSourceSession(buildLocalFolderSourceSession(response.directory, response.directory, ""));
    setStatus({ state: "idle", message: "Opened local folder", checkedAt: null, metadata: null });
  }

  async function openLocalEntry(entry) {
    if (entry.type === "directory") {
      await loadLocalDirectory(entry.path);
      return;
    }

    if (!entry.isMarkdown) return;
    if (dirty && !window.confirm("Discard unsaved local edits and open another file?")) return;

    setBusy(true);
    setError(null);
    const response = await remoteApi.readLocalFile(entry.path);
    setBusy(false);

    if (!response.ok) {
      setError(response.error);
      setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
      return;
    }

    setLocalWorkspaceDirectory(currentDirectory);
    setLocalFile({ path: response.file.path });
    setSelectedPath(response.file.path);
    setDirty(false);
    setConflict(false);
    setRemoteShadow(null);
    applyFreshFile(response.file);
    const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
    if (activeSession?.kind === "local-folder") {
      rememberSourceSession(buildLocalFolderSourceSession(activeSession.rootPath || currentDirectory, currentDirectory, response.file.path, activeSession.id));
    } else {
      rememberSourceSession(buildLocalFileSourceSession(response.file.path, currentDirectory));
    }
    setStatus({ state: "idle", message: "Opened local file", checkedAt: null, metadata: response.file.metadata });
  }

  async function toggleWatching() {
    if (!connected || !selectedPath) return;
    setError(null);

    if (watching) {
      await remoteApi.stopWatching();
      setWatching(false);
      return;
    }

    const response = await remoteApi.startWatching({
      remotePath: selectedPath,
      intervalMs: Number(connection.intervalMs)
    });

    if (response.ok) {
      setWatching(true);
    } else {
      setError(response.error);
    }
  }

  async function refreshCurrentFile() {
    if (!canRefreshDocument || documentRefreshing) return;

    const wasDirty = dirty;
    setBusy(true);
    setDocumentRefreshing(true);
    setDocumentRefreshNotice(null);
    setError(null);
    setStatus((current) => ({
      ...current,
      state: watching ? "watching" : "connected",
      message: "Refreshing remote file..."
    }));

    try {
      const response = await remoteApi.openFile(selectedPath);

      if (!response.ok) {
        setError(response.error);
        setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        return;
      }

      captureScrollRatio(previewRef, scrollRatioRef);
      applyRemoteFile(response.file);
      setStatus((current) => ({
        ...current,
        state: watching ? "watching" : "connected",
        message: wasDirty ? "Remote refresh found a newer file; review the conflict." : "Remote file refreshed",
        metadata: response.file.metadata
      }));
      showDocumentRefreshNotice(wasDirty ? "newer file found" : "file refreshed");
    } finally {
      setBusy(false);
      setDocumentRefreshing(false);
    }
  }

  function applyLocalSampleFile(file, message = "Loaded local sample") {
    const nextEntry = {
      ...sampleEntry,
      size: file.metadata?.size ?? file.content.length
    };

    captureScrollRatio(previewRef, scrollRatioRef);
    setSampleSourceOpen(true);
    setLocalWorkspaceDirectory(null);
    setLocalFile(null);
    setLocalSampleContent(file.content);
    setContent(file.content);
    setEditorContent(file.content);
    setDirty(false);
    setConflict(false);
    setRemoteShadow(null);
    setFileVersion(file.version);
    setFileMetadata(file.metadata);
    setLastRefresh(file.refreshedAt);
    setSelectedPath(file.path || sampleEntry.path);
    setCurrentDirectory("samples");
    setFileEntries([nextEntry]);
    setError(null);
    setActiveSessionId(null);
    setStatus({ state: "idle", message, checkedAt: null, metadata: file.metadata });
  }

  async function loadSample() {
    return refreshLocalSample({ showTreeLoading: false });
  }

  async function refreshLocalSample({ showTreeLoading = true } = {}) {
    if (showTreeLoading) setTreeLoading(true);
    setError(null);
    try {
      const response = await remoteApi.readLocalSample();

      if (!response?.ok || !response.file) {
        setError(response?.error || { message: "Unable to refresh local sample." });
        setStatus((current) => ({
          ...current,
          state: "error",
          message: response?.error?.message || "Unable to refresh local sample."
        }));
        return false;
      }

      applyLocalSampleFile(response.file);
      return true;
    } finally {
      if (showTreeLoading) setTreeLoading(false);
    }
  }

  function clearLocalDocument(message = "No document open") {
    captureScrollRatio(previewRef, scrollRatioRef);
    setLocalWorkspaceDirectory(null);
    setLocalFile(null);
    setContent("");
    setEditorContent("");
    setDirty(false);
    setConflict(false);
    setRemoteShadow(null);
    setFileVersion(null);
    setFileMetadata(null);
    setLastRefresh(null);
    setSelectedPath("");
    setCurrentDirectory("");
    setFileEntries([]);
    setError(null);
    setActiveSessionId(null);
    setStatus({ state: "idle", message, checkedAt: null, metadata: null });
  }

  function restoreLocalFallback(message) {
    if (sampleSourceOpen) {
      void loadSample();
      if (message) setStatus({ state: "idle", message, checkedAt: null, metadata: null });
      return;
    }

    clearLocalDocument(message);
  }

  async function openLocalSample() {
    const openingKey = `source:sample:${sampleEntry.path}`;
    if (hasSourceOpening(openingKey)) return true;
    if (hasSourceOpening()) return false;
    if (documentSource === "sample" && selectedPath === sampleEntry.path && (fileMetadata?.mtime || status.metadata?.mtime)) return true;

    if (!confirmDiscardEdits("open the local sample")) return false;
    setBusy(true);
    beginSourceOpening({
      key: openingKey,
      title: "opening local sample",
      message: "Closing the active source and loading the sample."
    });
    try {
      if (watching) {
        await remoteApi.stopWatching();
        setWatching(false);
      }
      if (connected) {
        await remoteApi.disconnect();
        setConnected(false);
      }
      await loadSample();
      return true;
    } finally {
      setBusy(false);
      endSourceOpening(openingKey);
    }
  }

  function closeLocalSource() {
    if (documentSource !== "local") return;
    if (!confirmDiscardEdits("close the local source")) return;
    if (activeSessionId?.startsWith("local-")) setActiveSessionId(null);
    restoreLocalFallback("Closed local source");
  }

  function closeSampleSource() {
    if (documentSource === "sample" && !confirmDiscardEdits("close the local sample")) return;
    setSampleSourceOpen(false);
    if (documentSource === "sample") clearLocalDocument("Closed local sample");
  }

  async function refreshSidebarTree() {
    if (treeLoading || hasSourceOpening()) return;

    if (connected) {
      const refreshed = await loadDirectory(currentDirectory);
      if (refreshed) showTreeRefreshNotice("tree refreshed");
      return;
    }

    if (localWorkspaceDirectory) {
      const refreshed = await loadLocalDirectory(currentDirectory);
      if (refreshed) showTreeRefreshNotice("tree refreshed");
      return;
    }

    if (!confirmDiscardEdits("reload the local sample")) return;
    const refreshed = await refreshLocalSample();
    if (refreshed) showTreeRefreshNotice("sample reloaded");
  }

  function isSourceSessionOpen(session) {
    if (!session || session.id !== activeSessionId) return false;

    if (session.kind === "remote") {
      return connected && getRemoteSourceSessionId(connection) === session.id;
    }

    if (session.kind === "local-file") {
      return documentSource === "local" && pathsReferToSameLocalFile(localFile?.path, session.selectedPath);
    }

    if (session.kind === "local-folder") {
      return documentSource === "local" && Boolean(localWorkspaceDirectory);
    }

    return false;
  }

  async function openSourceSession(session) {
    if (!session) return;
    const openingKey = `source:${session.id}`;
    if (hasSourceOpening(openingKey)) return true;
    if (hasSourceOpening()) return false;
    if (isSourceSessionOpen(session)) return true;

    if (session.kind === "remote") {
      const nextConnection = hydrateConnectionFromSourceSession(session);
      setConnection(nextConnection);
      await connectAndOpen(nextConnection, { openingKey, sessionId: session.id });
      return;
    }

    if (!confirmDiscardEdits("switch sources")) return;

    if (watching) {
      await remoteApi.stopWatching();
      setWatching(false);
    }

    if (connected) {
      await remoteApi.disconnect();
      setConnected(false);
    }

    setBusy(true);
    setError(null);
    beginSourceOpening({
      key: openingKey,
      title: session.kind === "local-file" ? "opening local file" : "opening local folder",
      message: "Reading local files and folder tree."
    });

    try {
      if (session.kind === "local-file") {
        const filePath = session.selectedPath;
        const directory = session.directory || localDirname(filePath);
        const [fileResponse, entriesResponse] = await Promise.all([
          remoteApi.readLocalFile(filePath),
          remoteApi.listLocalDirectory(directory)
        ]);

        if (!fileResponse.ok) {
          setError(fileResponse.error);
          setStatus((current) => ({ ...current, state: "error", message: fileResponse.error.message }));
          return;
        }

        setLocalWorkspaceDirectory(directory);
        setLocalFile({ path: fileResponse.file.path });
        setSelectedPath(fileResponse.file.path);
        setCurrentDirectory(directory);
        setFileEntries(entriesResponse.ok ? entriesResponse.entries : []);
        setDirty(false);
        setConflict(false);
        setRemoteShadow(null);
        applyFreshFile(fileResponse.file);
        rememberSourceSession(buildLocalFileSourceSession(fileResponse.file.path, directory, session.id));
        setStatus({ state: "idle", message: "Restored local file", checkedAt: null, metadata: fileResponse.file.metadata });
        return;
      }

      const directory = session.directory || session.rootPath;
      const entriesResponse = await remoteApi.listLocalDirectory(directory);
      let fileResponse = null;
      if (session.selectedPath) fileResponse = await remoteApi.readLocalFile(session.selectedPath);

      if (!entriesResponse.ok) {
        setError(entriesResponse.error);
        setStatus((current) => ({ ...current, state: "error", message: entriesResponse.error.message }));
        return;
      }

      setLocalWorkspaceDirectory(directory);
      setCurrentDirectory(directory);
      setFileEntries(entriesResponse.entries);
      setDirty(false);
      setConflict(false);
      setRemoteShadow(null);
      setFileVersion(null);
      setFileMetadata(null);
      setLastRefresh(null);

      if (fileResponse?.ok) {
        setLocalFile({ path: fileResponse.file.path });
        setSelectedPath(fileResponse.file.path);
        applyFreshFile(fileResponse.file);
        setStatus({ state: "idle", message: "Restored local folder", checkedAt: null, metadata: fileResponse.file.metadata });
        rememberSourceSession(buildLocalFolderSourceSession(session.rootPath || directory, directory, fileResponse.file.path, session.id));
        return;
      }

      setLocalFile(null);
      setSelectedPath("");
      setContent(chooseLocalFileMarkdown);
      setEditorContent(chooseLocalFileMarkdown);
      setError(fileResponse?.error || null);
      setStatus({ state: "idle", message: "Restored local folder", checkedAt: null, metadata: null });
      rememberSourceSession(buildLocalFolderSourceSession(session.rootPath || directory, directory, "", session.id));
    } finally {
      setBusy(false);
      endSourceOpening(openingKey);
    }
  }

  function onEditorChange(event) {
    setEditorContent(event.target.value);
    setDirty(event.target.value !== content);
  }

  function useLatestRemote() {
    if (!remoteShadow) return;
    applyFreshFile(remoteShadow);
    setDirty(false);
    setConflict(false);
  }

  async function keepLocalEditsAndOverwrite() {
    if (!dirty || !conflict || !remoteShadow) return;

    setBusy(true);
    setError(null);

    const response =
      documentSource === "remote"
        ? await remoteApi.saveFile({
            remotePath: selectedPath,
            content: editorContent,
            expectedVersion: remoteShadow.version
          })
        : documentSource === "local" && localFile?.path
          ? await remoteApi.saveLocalFile({
              path: localFile.path,
              content: editorContent,
              expectedVersion: remoteShadow.version
            })
          : null;

    setBusy(false);

    if (!response?.ok) {
      const nextError = response?.error || { message: "Unable to overwrite the changed file." };
      setError(nextError);
      setStatus((current) => ({ ...current, state: "error", message: nextError.message }));
      return;
    }

    if (documentSource === "local") setLocalFile({ path: response.file.path });
    applyFreshFile(response.file);
    setDirty(false);
    setConflict(false);
    setStatus((current) => ({
      ...current,
      state: documentSource === "remote" ? "connected" : "idle",
      message: "Saved your version over the newer file",
      metadata: response.file.metadata
    }));
  }

  async function saveCurrentFile() {
    if (!canSave) return;
    setBusy(true);
    setError(null);

    if (documentSource === "sample") {
      const response = await remoteApi.saveLocalSample(editorContent);
      setBusy(false);

      if (!response.ok) {
        setError(response.error);
        setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        return;
      }

      setLocalSampleContent(editorContent);
      applyFreshFile(response.file);
      setDirty(false);
      setConflict(false);
      setStatus({ state: "idle", message: "Saved local sample", checkedAt: null, metadata: response.file.metadata });
      return;
    }

    if (documentSource === "local") {
      const response = await remoteApi.saveLocalFile({
        path: localFile.path,
        content: editorContent,
        expectedVersion: fileVersion
      });
      setBusy(false);

      if (!response.ok) {
        setError(response.error);
        if (response.error.code === "LOCAL_CONFLICT") {
          const latest = localFile?.path ? await remoteApi.readLocalFile(localFile.path) : null;
          if (latest?.ok && latest.file) setRemoteShadow(latest.file);
          setConflict(true);
        }
        setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        return;
      }

      setLocalFile({ path: response.file.path });
      applyFreshFile(response.file);
      setDirty(false);
      setConflict(false);
      setStatus({ state: "idle", message: "Saved local file", checkedAt: null, metadata: response.file.metadata });
      return;
    }

    const response = await remoteApi.saveFile({
      remotePath: selectedPath,
      content: editorContent,
      expectedVersion: fileVersion
    });

    setBusy(false);

    if (!response.ok) {
      setError(response.error);
      if (response.error.code === "REMOTE_CONFLICT") {
        const latest = selectedPath ? await remoteApi.openFile(selectedPath) : null;
        if (latest?.ok && latest.file) setRemoteShadow(latest.file);
        setConflict(true);
      }
      return;
    }

    applyFreshFile(response.file);
    setDirty(false);
    setConflict(false);
    setStatus((current) => ({ ...current, message: "Saved remote file" }));
  }

  function resizeSidebarWithKeyboard(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
      return;
    }

    event.preventDefault();
    const delta = event.shiftKey ? 40 : 16;
    let nextWidth = sidebarWidth;

    if (event.key === "ArrowLeft") nextWidth -= delta;
    if (event.key === "ArrowRight") nextWidth += delta;
    if (event.key === "Home") nextWidth = SIDEBAR_MIN_WIDTH;
    if (event.key === "End") nextWidth = SIDEBAR_MAX_WIDTH;

    const clampedWidth = clampSidebarWidth(nextWidth);
    setSidebarWidth(clampedWidth);
    saveSidebarWidth(clampedWidth);
  }

  function updatePreference(field, value) {
    setPreferences((current) => ({ ...current, [field]: value }));
    if (field === "defaultView") setViewMode(value);
    if (field === "sidebarCollapsed") setSidebarCollapsed(Boolean(value));
  }

  function setSidebarCollapsedPreference(value) {
    if (!value && sidebarWidth < SIDEBAR_MIN_WIDTH) {
      setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
      saveSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    }
    setSidebarCollapsed(value);
    setPreferences((current) => ({ ...current, sidebarCollapsed: value }));
  }

  async function triggerTetherPing() {
    const requestId = Date.now();
    pingRequestRef.current = requestId;
    if (pingTimerRef.current) window.clearTimeout(pingTimerRef.current);

    const context = {
      documentSource,
      target: connected ? sourceLabel : documentSource === "sample" ? "sample.md" : localFile?.path || localWorkspaceDirectory || "",
      remotePath: connected ? selectedPath : "",
      currentDirectory,
      localPath: documentSource === "local" ? localFile?.path || localWorkspaceDirectory || "" : "",
      hasNativeBackend: hasNativeHealthCheck
    };

    setTetherPing({
      id: `checking-${requestId}`,
      message: healthCheckPendingMessage(context),
      tone: "idle"
    });

    const response = await remoteApi.healthCheck(context);
    if (pingRequestRef.current !== requestId) return;

    setTetherPing({
      id: `checked-${requestId}`,
      message: response?.ok ? healthCheckSuccessMessage(response) : healthCheckErrorMessage(response?.error),
      tone: response?.ok ? "idle" : "error"
    });

    pingTimerRef.current = window.setTimeout(() => {
      setTetherPing(null);
      pingTimerRef.current = null;
    }, 2200);
  }

  function openSidebarFromRail() {
    if (compactLayout) {
      setSidebarPeeking(true);
      return;
    }
    setSidebarCollapsedPreference(false);
  }

  function toggleSidebarFromHeader() {
    if (compactLayout) {
      setSidebarPeeking(false);
      return;
    }
    setSidebarCollapsedPreference(true);
  }

  const railToggleTitle = compactLayout ? "Show sidebar" : "Open sidebar";
  const headerToggleTitle = compactLayout ? "Close sidebar" : "Collapse sidebar";

  return (
    <div
      className={`app-shell ${zenMode ? "zen" : ""} ${resizingSidebar ? "is-resizing-sidebar" : ""} ${
        sidebarRailMode ? "is-sidebar-rail" : ""
      } ${sidebarPeeking ? "is-sidebar-peeking" : ""} ${
        compactLayout ? "is-compact-layout" : ""
      } ${resolvedTheme === "light" ? "theme-light" : ""} accent-${preferences.accent} reading-${preferences.readingFont}`}
      style={{
        "--sidebar-width": `${sidebarRailMode ? 48 : expandedSidebarWidth}px`,
        "--expanded-sidebar-width": `${expandedSidebarWidth}px`,
        "--page-width": `${preferences.pageWidthPx}px`
      }}
    >
      {sidebarVisible && (
        <aside
          className="navigation-panel"
          aria-label="Documentation sidebar"
        >
          <div className="sidebar-expanded">
            <div className="brand-row">
              <div className="brand-lockup" onClick={triggerTetherPing}>
                <TetherGlyph pingKey={tetherPing?.id} />
                <strong>tether</strong>
                <span>v0.0</span>
              </div>
              <button
                className="icon-button compact panel-toggle"
                title={headerToggleTitle}
                onClick={toggleSidebarFromHeader}
              >
                <PanelLeftClose size={15} />
              </button>
            </div>

            <SourcesPanel
              activeSessionId={activeSessionId}
              connected={connected}
              documentSource={documentSource}
              localWorkspaceDirectory={localWorkspaceDirectory}
              onCloseLocalSource={closeLocalSource}
              onCloseSampleSource={closeSampleSource}
              onDisconnect={disconnect}
              onEditConnection={() => setConnectionPaletteOpen(true)}
              onForgetSession={forgetSourceSession}
              onOpenPalette={() => setConnectionPaletteOpen(true)}
              onOpenSession={openSourceSession}
              showLocalSource={showLocalSource}
              sourceLabel={sourceLabel}
              sourceSessions={sourceSessions}
              onLoadSample={openLocalSample}
            />

            <FilesPanel
              connected={connected}
              currentDirectory={currentDirectory}
              documentSource={documentSource}
              entries={fileEntries}
              sampleSourceOpen={sampleSourceOpen}
              localFile={localFile}
              rootLabel={rootLabel}
              selectedPath={selectedPath}
              sourceLoading={Boolean(sourceOpening)}
              sourceLoadingMessage={sourceOpening?.message}
              sourceLoadingTitle={sourceOpening?.title}
              treeLoading={treeLoading}
              onOpenEntry={connected ? openEntry : openLocalEntry}
              onRefresh={refreshSidebarTree}
              onLoadSample={openLocalSample}
            />

          </div>

          <div className="sidebar-rail">
            <button className="icon-button compact panel-toggle" title={railToggleTitle} onClick={openSidebarFromRail}>
              <PanelLeftOpen size={15} />
            </button>
            <div className="rail-divider" />
            <button className="rail-source" title={sourceLabel} onClick={openSidebarFromRail}>
              {connected ? <span className="status-dot pulse" /> : <Folder size={14} />}
            </button>
            <button
              className="icon-button compact"
              title="Add source"
              onClick={() => {
                setSidebarPeeking(false);
                setConnectionPaletteOpen(true);
              }}
            >
              <Plus size={15} />
            </button>
          </div>
        </aside>
      )}

      {sidebarVisible && !sidebarRailMode && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={expandedSidebarWidth}
          tabIndex={0}
          onKeyDown={resizeSidebarWithKeyboard}
          onMouseDown={(event) => {
            event.preventDefault();
            setResizingSidebar(true);
          }}
        >
          <GripVertical size={14} aria-hidden="true" />
        </div>
      )}

      <main className={`workspace ${conflict && !zenMode ? "has-conflict" : ""}`}>
        {!zenMode && (
          <header className="document-toolbar">
            <div className="document-title" title={toolbarDocumentTitle}>
              <span className={`document-path ${documentSource === "none" ? "is-empty" : ""}`}>{toolbarDocumentLabel}</span>
              {dirty && <span className="dirty-dot" title="Unsaved changes" />}
            </div>
            <div className="toolbar-actions">
              <div className="view-switch" role="group" aria-label="View mode">
                <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")}>
                  read
                </button>
                <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>
                  split
                </button>
                <button className={viewMode === "source" ? "active" : ""} onClick={() => setViewMode("source")}>
                  src
                </button>
              </div>
              {documentSource === "remote" && (
                <>
                  <button
                    className={`quiet-button ${documentRefreshing ? "loading" : ""}`}
                    disabled={!canRefreshDocument || busy || documentRefreshing}
                    aria-busy={documentRefreshing}
                    onClick={refreshCurrentFile}
                    title={documentRefreshing ? "Refreshing current file" : "Refresh once"}
                  >
                    <RefreshCw size={13} />
                    <span className="action-label">{documentRefreshing ? "refreshing" : "refresh"}</span>
                  </button>
                  <button
                    className={`watch-chip ${watching ? "active" : ""}`}
                    disabled={!connected || !selectedPath || busy}
                    onClick={toggleWatching}
                    title={watching ? "Stop watching" : "Watch remote changes"}
                  >
                    <span className={watching ? "status-dot pulse" : "status-dot"} />
                    <span className="action-label">{watching ? "watching" : "watch"}</span>
                  </button>
                </>
              )}
              <button
                className="save-button"
                disabled={!canSave || busy}
                onClick={saveCurrentFile}
                title={canSave ? "Save" : "No changes to save"}
                aria-label="Save current document"
              >
                <Save size={13} />
                <span className="action-label">save</span>
              </button>
              <div className="toolbar-divider" />
              <ThemeSwitch
                value={preferences.theme}
                resolvedTheme={resolvedTheme}
                onChange={(value) => updatePreference("theme", value)}
              />
              <button className="icon-button compact" title="Zen reading" aria-label="Zen reading" onClick={() => setZenMode(true)}>
                <Maximize2 size={14} />
              </button>
              <button className="icon-button compact" title="Settings" aria-label="Settings" onClick={() => setSettingsPanelOpen(true)}>
                <Settings size={14} />
              </button>
            </div>
          </header>
        )}

        {conflict && !zenMode && (
          <div className="conflict-banner">
            <AlertCircle size={14} />
            <span>
              <strong>conflict</strong> - {documentTitle} changed while you were editing
            </span>
            <button onClick={useLatestRemote}>take theirs</button>
            <button className="warn" onClick={keepLocalEditsAndOverwrite}>
              keep mine - overwrite
            </button>
          </div>
        )}

        <React.Suspense
          fallback={
            <DocumentSurfaceFallback
              loadingMessage="Preparing the Markdown view."
              loadingTitle="loading renderer"
              previewRef={previewRef}
            />
          }
        >
          <LazyDocumentSurface
            content={previewContent}
            copyText={copyCodeText}
            dirty={dirty}
            documentEyebrow={documentEyebrow}
            editorContent={editorContent}
            LoadingGlyph={TetherGlyph}
            loading={Boolean(sourceOpening)}
            loadingMessage={sourceOpening?.message}
            loadingTitle={sourceOpening?.title}
            onEditorChange={onEditorChange}
            previewRef={previewRef}
            sourceLabel={sourceLabel}
            viewMode={zenMode ? "preview" : viewMode}
          />
        </React.Suspense>

        {!zenMode && (
          <StatusBar
            lineCount={lineCount}
            statusLabel={tetherPing?.message || statusLabel}
            syncLabel={syncLabel}
            tone={tetherPing?.tone || sourceTone}
            wordCount={wordCount}
          />
        )}

        {zenMode && (
          <button className="zen-exit" onClick={() => setZenMode(false)} title="Exit Zen mode">
            esc
          </button>
        )}
      </main>

      <ConnectionPalette
        busy={busy}
        connected={connected}
        connection={connection}
        connectionProfile={connectionProfile}
        defaultPrivateKeyPath={defaultPrivateKeyPath}
        error={error}
        open={connectionPaletteOpen}
        status={status}
        onChoosePrivateKey={choosePrivateKey}
        onClose={() => setConnectionPaletteOpen(false)}
        onConnect={async () => {
          const connectedSuccessfully = await connectAndOpen();
          if (connectedSuccessfully) setConnectionPaletteOpen(false);
        }}
        onDisconnect={disconnect}
        onOpenLocalDirectory={async () => {
          await openLocalDirectory();
          setConnectionPaletteOpen(false);
        }}
        onOpenLocalFile={async () => {
          await openLocalFile();
          setConnectionPaletteOpen(false);
        }}
        onUpdate={updateConnection}
      />
      <SettingsPanel
        open={settingsPanelOpen}
        preferences={preferences}
        onClose={() => setSettingsPanelOpen(false)}
        onUpdate={updatePreference}
      />
    </div>
  );
}

function TetherGlyph({ dashed = false, pingKey = null }) {
  return (
    <svg className="tether-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.6" cy="12.4" r="2.1" fill="var(--accent)" />
      <path
        d="M5.4 10.6 C 7.4 8.6, 8.4 7.4, 10.4 5.4"
        stroke="var(--ink3)"
        strokeDasharray={dashed ? "1.6 1.6" : undefined}
        strokeWidth="1.2"
        fill="none"
      />
      <circle cx="12" cy="4" r="2.4" fill="none" stroke="var(--ink)" strokeWidth="1.6" />
      {pingKey && <circle key={pingKey} className="tether-ping-dot" cx="3.6" cy="12.4" r="1.35" fill="var(--accent)" />}
    </svg>
  );
}

function DocumentSurfaceFallback({ loadingMessage, loadingTitle, previewRef }) {
  return (
    <div className="document-grid mode-preview is-loading">
      <section ref={previewRef} className="preview-pane preview-loading-pane" aria-label="Opening document">
        <article className="document-loading" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true">
            <TetherGlyph pingKey="loading" />
          </span>
          <strong>{loadingTitle || "loading renderer"}</strong>
          <span>{loadingMessage || "Preparing the Markdown view."}</span>
        </article>
      </section>
    </div>
  );
}

function SourcesPanel({
  activeSessionId,
  connected,
  documentSource,
  localWorkspaceDirectory,
  onCloseLocalSource,
  onCloseSampleSource,
  onDisconnect,
  onEditConnection,
  onForgetSession,
  onLoadSample,
  onOpenPalette,
  onOpenSession,
  showLocalSource,
  sourceLabel,
  sourceSessions
}) {
  const hasActiveRemoteSession = sourceSessions.some((session) => session.id === activeSessionId && session.kind === "remote");
  const sampleSourceActive = showLocalSource && documentSource === "sample";

  return (
    <section className="sources-panel">
      <div className="sidebar-label">
        <span>sources</span>
        <i />
      </div>
      {connected && !hasActiveRemoteSession && (
        <div className={`source-row ${documentSource === "remote" ? "active" : ""}`} aria-label="Remote source">
          <span className="source-icon">
            <span className="status-dot pulse" />
          </span>
          <span className="source-name">{sourceLabel}</span>
          <span className="tag">ssh</span>
          <button
            className="source-edit"
            type="button"
            title="Edit connection"
            aria-label="Edit connection"
            onClick={(event) => {
              event.stopPropagation();
              onEditConnection();
            }}
          >
            <Settings size={11} aria-hidden="true" />
          </button>
          <button
            className="source-remove"
            type="button"
            title="Disconnect"
            aria-label="Disconnect remote source"
            onClick={(event) => {
              event.stopPropagation();
              onDisconnect();
            }}
          >
            x
          </button>
        </div>
      )}
      {sourceSessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            className={`source-row remembered-source ${active ? "active" : ""}`}
            role={active ? undefined : "button"}
            tabIndex={active ? undefined : 0}
            aria-current={active ? "true" : undefined}
            title={session.title || session.detail || session.label}
            onClick={active ? undefined : () => onOpenSession(session)}
            onKeyDown={
              active
                ? undefined
                : (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onOpenSession(session);
                  }
            }
          >
            <span className="source-icon">
              {session.kind === "remote" ? (
                <span className={`status-dot ${active && connected ? "pulse connected" : ""}`} />
              ) : session.kind === "local-file" ? (
                <FileText size={13} />
              ) : (
                <Folder size={13} />
              )}
            </span>
            <span className="source-copy">
              <span className="source-name">{session.label}</span>
              {session.detail && <span className="source-detail">{session.detail}</span>}
            </span>
            <span className="tag">{session.tag}</span>
            {active && session.kind === "remote" && (
              <button
                className="source-edit"
                type="button"
                title="Edit connection"
                aria-label="Edit connection"
                onClick={(event) => {
                  event.stopPropagation();
                  onEditConnection();
                }}
              >
                <Settings size={11} aria-hidden="true" />
              </button>
            )}
            {active && session.kind === "remote" ? (
              <button
                className="source-remove"
                type="button"
                title="Disconnect"
                aria-label="Disconnect remote source"
                onClick={(event) => {
                  event.stopPropagation();
                  onDisconnect();
                }}
              >
                x
              </button>
            ) : active ? (
              <button
                className="source-remove"
                type="button"
                title="Close source"
                aria-label={`Close ${session.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseLocalSource();
                }}
              >
                x
              </button>
            ) : (
              <button
                className="source-remove"
                type="button"
                title="Forget source"
                aria-label={`Forget ${session.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onForgetSession(session.id);
                }}
              >
                x
              </button>
            )}
          </div>
        );
      })}
      {showLocalSource && (
        <div
          className={`source-row ${sampleSourceActive ? "active" : ""}`}
          role={sampleSourceActive ? undefined : "button"}
          tabIndex={sampleSourceActive ? undefined : 0}
          aria-current={sampleSourceActive ? "true" : undefined}
          aria-label={sampleSourceActive ? "Local sample source" : "Open local sample source"}
          title={sampleSourceActive ? "Local sample is open" : "Open local sample"}
          onClick={sampleSourceActive ? undefined : onLoadSample}
          onKeyDown={
            sampleSourceActive
              ? undefined
              : (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onLoadSample();
                }
          }
        >
          <span className="source-icon">
            <Folder size={13} />
          </span>
          <span className="source-name">local sample</span>
          <span className="tag">local</span>
          <button
            className="source-remove"
            type="button"
            title="Close local sample"
            aria-label="Close local sample"
            onClick={(event) => {
              event.stopPropagation();
              onCloseSampleSource();
            }}
          >
            x
          </button>
        </div>
      )}
      <button className="source-row add-source" type="button" onClick={onOpenPalette}>
        <span className="source-icon">+</span>
        <span className="source-name">add source</span>
      </button>
    </section>
  );
}

function FilesPanel({
  connected,
  currentDirectory,
  documentSource,
  entries,
  sampleSourceOpen,
  localFile,
  rootLabel,
  selectedPath,
  sourceLoading,
  sourceLoadingMessage,
  sourceLoadingTitle,
  treeLoading,
  onOpenEntry,
  onRefresh,
  onLoadSample
}) {
  const showLocalTree = !connected && documentSource === "local";
  const canRefreshTree = !sourceLoading && (connected || sampleSourceOpen || showLocalTree);
  const showSourceLoading = sourceLoading;
  const showSampleFile = !connected && documentSource === "sample";
  const directoryPath = formatSidebarDirectoryPath(rootLabel || currentDirectory);

  return (
    <section className="sidebar-section files-section">
      <div className="sidebar-label">
        <span>files</span>
        <i />
      </div>
      {directoryPath && !sourceLoading && (
        <div className="sidebar-path" title={directoryPath.full} aria-label={`Current folder: ${directoryPath.full}`}>
          <span>{directoryPath.display}</span>
        </div>
      )}

      <div className="file-list" aria-label="Markdown files">
        {showSourceLoading && (
          <div className="sidebar-loading" role="status" aria-live="polite">
            <span className="loading-mark" aria-hidden="true">
              <TetherGlyph pingKey="loading" />
            </span>
            <strong>{sourceLoadingTitle || (connected ? "opening source" : "connecting source")}</strong>
            <span>{sourceLoadingMessage || statusTextForLoading(documentSource)}</span>
          </div>
        )}

        {!showSourceLoading && showSampleFile && (
          <button className="file-row active" onClick={onLoadSample}>
            <FileText size={16} />
            <span>sample.md</span>
          </button>
        )}

        {!showSourceLoading && documentSource === "none" && <div className="empty-state">No source open</div>}

        {!showSourceLoading && connected && canGoUp(currentDirectory) && (
          <button
            className="file-row"
            onClick={() =>
              onOpenEntry({
                name: "..",
                path: parentRemotePath(currentDirectory),
                type: "directory"
              })
            }
          >
            <FolderOpen size={16} />
            <span>..</span>
          </button>
        )}

        {!showSourceLoading && showLocalTree && localCanGoUp(currentDirectory) && (
          <button
            className="file-row"
            onClick={() =>
              onOpenEntry({
                name: "..",
                path: localParentPath(currentDirectory),
                type: "directory",
                isMarkdown: true
              })
            }
          >
            <FolderOpen size={16} />
            <span>..</span>
          </button>
        )}

        {!showSourceLoading && (connected || showLocalTree) && entries.length === 0 && (
          <div className="empty-state">{treeLoading ? "Loading..." : "No files in this folder"}</div>
        )}

        {!showSourceLoading &&
          (connected || showLocalTree) &&
          entries.map((entry) => (
            <button
              key={entry.path}
              className={`file-row ${entry.path === selectedPath ? "active" : ""} ${
                entry.name.startsWith(".") ? "muted" : ""
              }`}
              disabled={entry.type === "file" && !entry.isMarkdown}
              onClick={() => onOpenEntry(entry)}
              title={entry.path}
            >
              {entry.type === "directory" ? <FolderOpen size={16} /> : <File size={16} />}
              <span>{entry.name}</span>
            </button>
          ))}
      </div>
      {canRefreshTree && (
        <button
          className={`file-refresh ${treeLoading ? "loading" : ""}`}
          type="button"
          disabled={treeLoading}
          aria-busy={treeLoading}
          onClick={onRefresh}
        >
          <RefreshCw size={12} />
          {treeLoading ? "refreshing" : "refresh tree"}
        </button>
      )}
    </section>
  );
}

function ConnectionPalette({
  busy,
  connected,
  connection,
  connectionProfile,
  defaultPrivateKeyPath,
  error,
  open,
  onChoosePrivateKey,
  onClose,
  onConnect,
  onDisconnect,
  onOpenLocalDirectory,
  onOpenLocalFile,
  onUpdate,
  status
}) {
  if (!open) return null;

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <div
        className="connection-palette"
        role="dialog"
        aria-modal="true"
        aria-label={connected ? "Edit connection" : "Open or connect"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="palette-header">
          <span>{connected ? "edit connection" : "open / connect"}</span>
          <button className="esc-chip" type="button" onClick={onClose}>
            esc
          </button>
        </div>

        <div className="target-input">
          <span>&gt;</span>
          <input
            value={formatConnectionTarget(connection)}
            onChange={(event) => applyConnectionTarget(event.target.value, onUpdate)}
            placeholder="user@host:/path/to/doc.md - or use local actions below"
            spellCheck="false"
          />
        </div>
        <p className="palette-helper">Host aliases from ~/.ssh/config work; an empty remote path browses from home.</p>

        <div className="palette-section">
          <div className="palette-label">local</div>
          <div className="palette-local-actions">
            <button type="button" onClick={onOpenLocalDirectory}>
              <FolderOpen size={13} />
              open folder...
            </button>
            <button type="button" onClick={onOpenLocalFile}>
              <FileText size={13} />
              open file...
            </button>
          </div>
        </div>

        <ConnectionPanel
          connected={connected}
          connection={connection}
          connectionProfile={connectionProfile}
          defaultPrivateKeyPath={defaultPrivateKeyPath}
          error={error}
          onChoosePrivateKey={onChoosePrivateKey}
          onUpdate={onUpdate}
          status={status}
        />

        <div className="palette-footer">
          {connected ? (
            <button className="disconnect-action" type="button" onClick={onDisconnect}>
              disconnect
            </button>
          ) : (
            <span className="palette-hint">local files or ssh remotes</span>
          )}
          <span className="footer-spacer" />
          <button className="outline-action" type="button" onClick={onClose}>
            cancel
          </button>
          <button className="connect-action" type="button" disabled={busy} onClick={onConnect}>
            {connected ? "reconnect" : "connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionPanel({
  connected,
  connection,
  connectionProfile,
  defaultPrivateKeyPath,
  error,
  onChoosePrivateKey,
  onUpdate,
  status
}) {
  return (
    <section className="sidebar-section">
      <h2>Connection</h2>
      <div className={`connection-note ${error ? "error" : connected ? "connected" : ""}`}>
        {error
          ? error.message
          : connected
            ? "Edit fields and reconnect to apply changes."
            : "Enter host and username. The remote file path is optional; you can pick a Markdown file after connecting."}
      </div>
      <div className="connection-fields">
        <Field label="Host">
          <input
            value={connection.host}
            autoComplete="off"
            onChange={(event) => onUpdate("host", event.target.value)}
            placeholder="docs.example.com"
          />
        </Field>
        <Field label="Username">
          <input
            value={connection.username}
            autoComplete="username"
            onChange={(event) => onUpdate("username", event.target.value)}
            placeholder="deploy"
          />
        </Field>
      </div>
      <div className="connection-fields compact">
        <Field label="Port">
          <input
            type="number"
            min="1"
            value={connection.port}
            onChange={(event) => onUpdate("port", event.target.value)}
          />
        </Field>
        <Field label="Polling">
          <SegmentedControl
            ariaLabel="Polling interval"
            options={[
              { label: "1s", value: 1000 },
              { label: "2s", value: 2000 },
              { label: "5s", value: 5000 }
            ]}
            value={Number(connection.intervalMs)}
            onChange={(value) => onUpdate("intervalMs", value)}
          />
        </Field>
      </div>
      <Field label="Authentication">
        <SegmentedControl
          ariaLabel="Authentication method"
          options={[
            { label: "auto", value: "auto" },
            { label: "key", value: "privateKey" },
            { label: "password", value: "password" }
          ]}
          value={connection.authMode}
          onChange={(value) => onUpdate("authMode", value)}
        />
      </Field>

      {connection.authMode === "password" ? (
        <Field label="Password">
          <input
            type="password"
            value={connection.password}
            autoComplete="current-password"
            onChange={(event) => onUpdate("password", event.target.value)}
            placeholder="Kept in memory only"
          />
        </Field>
      ) : (
        <>
          <Field label="Private Key Path">
            <div className="input-row">
              <input
                value={connection.privateKeyPath}
                autoComplete="off"
                onChange={(event) => onUpdate("privateKeyPath", event.target.value)}
                placeholder={
                  connection.authMode === "auto"
                    ? "Optional; Auto checks SSH config and common keys"
                    : defaultPrivateKeyPath || "Choose or enter a private key"
                  }
                />
              <button
                className="icon-button compact"
                type="button"
                onClick={onChoosePrivateKey}
                title="Choose private key"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </Field>
          <Field label="Key Passphrase">
            <input
              type="password"
              value={connection.passphrase}
              autoComplete="off"
              onChange={(event) => onUpdate("passphrase", event.target.value)}
              placeholder="Optional"
            />
          </Field>
        </>
      )}

      <Field label="Remote Markdown Path">
        <input
          value={connection.remotePath}
          autoComplete="off"
          onChange={(event) => onUpdate("remotePath", event.target.value)}
          placeholder="Optional: /srv/docs/readme.md"
        />
      </Field>

      <ConnectionProfile profile={connectionProfile} />
    </section>
  );
}

function SegmentedControl({ ariaLabel, options, value, onChange }) {
  return (
    <div className="segmented-control" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "active" : ""}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function PageWidthControl({ value, onChange }) {
  const width = clampPageWidth(value);

  function updateWidth(nextValue) {
    onChange(clampPageWidth(nextValue));
  }

  return (
    <div className="width-control">
      <input
        aria-label="Page width"
        type="range"
        min={PAGE_WIDTH_MIN}
        max={PAGE_WIDTH_MAX}
        step={PAGE_WIDTH_STEP}
        value={width}
        onChange={(event) => updateWidth(event.target.value)}
      />
      <label className="width-value">
        <input
          aria-label="Page width in pixels"
          type="number"
          min={PAGE_WIDTH_MIN}
          max={PAGE_WIDTH_MAX}
          step={PAGE_WIDTH_STEP}
          value={width}
          onChange={(event) => updateWidth(event.target.value)}
        />
        <span>px</span>
      </label>
    </div>
  );
}

function ThemeSwitch({ value, resolvedTheme, onChange }) {
  const options = [
    { value: "system", label: `Use system theme (${resolvedTheme})`, icon: Monitor },
    { value: "dark", label: "Use dark theme", icon: Moon },
    { value: "light", label: "Use light theme", icon: Sun }
  ];

  return (
    <div className="theme-switch" role="group" aria-label="Theme mode">
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            aria-label={option.label}
            aria-pressed={value === option.value}
            className={value === option.value ? "active" : ""}
            title={option.label}
            type="button"
            onClick={() => onChange(option.value)}
          >
            <Icon size={13} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

function ConnectionProfile({ profile }) {
  if (!profile) return null;

  const resolvedHost = profile.host
    ? `${profile.username || "unknown"}@${profile.host}:${profile.port || 22}`
    : "Enter a host to resolve SSH settings";
  const keyCandidates = profile.privateKeyCandidates || [];
  const configuredKeys = profile.configuredIdentityFiles || [];

  return (
    <div className="connection-profile" aria-label="Resolved connection settings">
      <div className="profile-row">
        <span>resolved</span>
        <strong>{resolvedHost}</strong>
      </div>
      {profile.hostAlias && profile.hostAlias !== profile.host && (
        <div className="profile-row">
          <span>alias</span>
          <strong>{profile.hostAlias}</strong>
        </div>
      )}
      <div className="profile-row">
        <span>auth</span>
        <strong>{profile.agentAvailable ? "keys + agent" : "keys only"}</strong>
      </div>
      {configuredKeys.length > 0 && (
        <div className="profile-list">
          <span>ssh config</span>
          {configuredKeys.map((keyPath) => (
            <code key={keyPath}>{keyPath}</code>
          ))}
        </div>
      )}
      <div className="profile-list">
        <span>auto keys</span>
        {keyCandidates.length > 0 ? (
          keyCandidates.map((keyPath) => <code key={keyPath}>{keyPath}</code>)
        ) : (
          <em>None found yet</em>
        )}
      </div>
      {profile.warnings?.length > 0 && (
        <div className="profile-warnings">
          {profile.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ open, preferences, onClose, onUpdate }) {
  if (!open) return null;

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings" onClick={(event) => event.stopPropagation()}>
        <div className="palette-header">
          <span>settings</span>
          <button className="esc-chip" type="button" onClick={onClose}>
            esc
          </button>
        </div>

        <section className="settings-section">
          <div className="palette-label">appearance</div>
          <div className="settings-row">
            <div>
              <strong>theme</strong>
            </div>
            <SegmentedControl
              ariaLabel="Theme"
              options={[
                { label: "system", value: "system" },
                { label: "dark", value: "dark" },
                { label: "light", value: "light" }
              ]}
              value={preferences.theme}
              onChange={(value) => onUpdate("theme", value)}
            />
          </div>

          <div className="settings-row">
            <div>
              <strong>accent</strong>
            </div>
            <div className="accent-picker" role="group" aria-label="Accent color">
              {[
                { label: "phosphor", value: "phosphor", color: "#43b37a" },
                { label: "amber", value: "amber", color: "#dba33e" },
                { label: "cobalt", value: "cobalt", color: "#4d80e8" }
              ].map((accent) => (
                <button
                  key={accent.value}
                  aria-label={`${accent.label} accent`}
                  aria-pressed={preferences.accent === accent.value}
                  className={`accent-option accent-${accent.value} ${preferences.accent === accent.value ? "active" : ""}`}
                  style={{ "--swatch": accent.color }}
                  title={accent.label}
                  type="button"
                  onClick={() => onUpdate("accent", accent.value)}
                >
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <div>
              <strong>reading</strong>
            </div>
            <SegmentedControl
              ariaLabel="Reading font"
              options={[
                { label: "sans", value: "sans" },
                { label: "serif", value: "serif" }
              ]}
              value={preferences.readingFont}
              onChange={(value) => onUpdate("readingFont", value)}
            />
          </div>

          <div className="settings-row">
            <div>
              <strong>width</strong>
            </div>
            <PageWidthControl
              value={preferences.pageWidthPx}
              onChange={(value) => onUpdate("pageWidthPx", value)}
            />
          </div>
        </section>

      </div>
    </div>
  );
}

function StatusBar({ lineCount, statusLabel, syncLabel, tone, wordCount }) {
  const showStatusDot = tone === "watching" || tone === "conflict" || tone === "error";
  const metrics = [`${wordCount}w`, `${lineCount}L`, "utf-8", syncLabel].filter(Boolean);

  return (
    <footer className="status-bar" aria-label={`Status: ${[statusLabel, ...metrics].join("; ")}`} aria-live="polite">
      <span className="status-cluster">
        {showStatusDot && <span className={`status-dot ${tone === "watching" ? "pulse" : ""} ${tone}`} />}
        <span className="status-primary">{statusLabel}</span>
      </span>
      <span className="status-spacer" />
      <span className="status-metrics" aria-hidden="true">
        {metrics.map((metric) => (
          <span className="status-metric" key={metric}>
            {metric}
          </span>
        ))}
      </span>
    </footer>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

async function copyCodeText(text) {
  try {
    const response = await remoteApi.copyText(text);
    if (response?.ok) return true;
  } catch {
    // Fall through to the browser clipboard fallback.
  }

  return copyTextToBrowserClipboard(text);
}

async function copyTextToBrowserClipboard(text) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    if (copied) return true;
  } catch {
    // Fall through to the async Clipboard API fallback.
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function formatConnectionTarget(connection) {
  const userHost = connection.username ? `${connection.username}@${connection.host}` : connection.host;
  const remotePath = connection.remotePath ? `:${connection.remotePath}` : "";
  return `${userHost}${remotePath}`;
}

function applyConnectionTarget(value, onUpdate) {
  const match = value.match(/^(?:(?<username>[^@:]+)@)?(?<host>[^:]*)(?::(?<remotePath>.*))?$/);
  if (!match?.groups) return;
  onUpdate("host", match.groups.host || "");
  if (match.groups.username !== undefined) onUpdate("username", match.groups.username);
  if (match.groups.remotePath !== undefined) onUpdate("remotePath", match.groups.remotePath);
}

function countWords(text) {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function countLines(text) {
  return Math.max(text.split(/\r\n|\r|\n/).length, 1);
}

function compactPath(value) {
  if (!value) return "";
  const normalized = String(value).replace(/\\/g, "/");
  const homeMatch = normalized.match(/^(?:[A-Za-z]:)?\/Users\/[^/]+(\/.*)?$/i);
  if (homeMatch) return `~${homeMatch[1] || ""}`;
  if (normalized.length <= 34) return normalized;
  return `...${normalized.slice(-31)}`;
}

function pathsReferToSameLocalFile(left, right) {
  if (!left || !right) return false;
  return normalizeLocalComparisonPath(left) === normalizeLocalComparisonPath(right);
}

function normalizeLocalComparisonPath(value) {
  const normalized = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function formatStatusMessage(message, fallback) {
  const cleanMessage = String(message || "")
    .trim()
    .replace(/^connected(?:\s*[-.]|\s+)/i, "")
    .trim();

  if (!cleanMessage) return fallback;
  return cleanMessage.charAt(0).toLowerCase() + cleanMessage.slice(1);
}

function formatFileModifiedLabel(value) {
  const timestamp = formatFileTimestamp(value);
  return timestamp ? `edited ${timestamp}` : "";
}

function formatFileTimestamp(value) {
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

function formatLatency(value) {
  const rawLatency = Number(value);
  if (!Number.isFinite(rawLatency) || rawLatency < 1) return "<1ms";
  const latency = rawLatency < 10 ? Math.round(rawLatency * 10) / 10 : Math.round(rawLatency);
  return `${latency}ms`;
}

function healthCheckPendingMessage(context) {
  if (!context.hasNativeBackend) return "checking preview";
  if (context.documentSource === "remote") return "checking server";
  if (context.documentSource === "sample") return "checking sample";
  if (context.documentSource === "local") return "checking local source";
  return "checking source";
}

function healthCheckSuccessMessage(response) {
  const latency = formatLatency(response.latencyMs);
  if (response.kind === "remote") return `server checked - ${latency}`;
  if (response.kind === "sample") return `sample checked - ${latency}`;
  if (response.kind === "local") return `local source checked - ${latency}`;
  if (response.kind === "preview") return `preview checked - ${latency}`;
  return `source checked - ${latency}`;
}

function healthCheckErrorMessage(error) {
  return `check failed - ${error?.message || "Unable to reach source."}`;
}

function statusTextForLoading(documentSource) {
  if (documentSource === "remote") return "Refreshing the remote file tree.";
  if (documentSource === "local") return "Reading the local folder.";
  return "Resolving connection and files.";
}

function formatSidebarDirectoryPath(value) {
  if (!value) return null;

  const full = String(value).replace(/\\/g, "/");
  const readable = full
    .replace(/^(?:[A-Za-z]:)?\/Users\/[^/]+(?=\/|$)/i, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/i, "~");

  return { full, display: compactPathStart(readable, 30) };
}

function compactPathStart(value, maxLength) {
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

function formatPoll(value) {
  const ms = Number(value) || 0;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}

function formatRelativeTime(value) {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1m ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 5400) return "1h ago";
  return `${Math.round(seconds / 3600)}h ago`;
}

function captureScrollRatio(previewRef, ratioRef) {
  const node = previewRef.current;
  if (!node) return;
  const maxScroll = node.scrollHeight - node.clientHeight;
  ratioRef.current = maxScroll > 0 ? node.scrollTop / maxScroll : 0;
}

function restoreScrollRatio(previewRef, ratioRef) {
  window.requestAnimationFrame(() => {
    const node = previewRef.current;
    if (!node) return;
    const maxScroll = node.scrollHeight - node.clientHeight;
    node.scrollTop = maxScroll * ratioRef.current;
  });
}

function showBootOverlayNow() {
  if (typeof document === "undefined") return;
  syncBootPreferences();
  const root = document.documentElement;
  const boot = document.getElementById("tether-boot");
  root.classList.remove("tether-ready");
  if (!boot) return;
  boot.classList.remove("is-hidden");
  boot.style.opacity = "1";
  boot.style.visibility = "visible";
}

function syncBootPreferences(accentOverride = "", themeOverride = "") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const storedPreferences = readStoredBootPreferences();
  root.dataset.tetherAccent = normalizeBootAccent(accentOverride || storedPreferences.accent);
  root.dataset.tetherTheme = normalizeBootTheme(themeOverride || storedPreferences.theme);
}

function readStoredBootPreferences() {
  const fallback = { accent: "phosphor", theme: getSystemTheme() };
  if (typeof window === "undefined") return fallback;

  try {
    const preferences = JSON.parse(window.localStorage.getItem(BOOT_PREFERENCES_KEY) || "{}");
    const storedTheme = ["dark", "light"].includes(preferences.theme) ? preferences.theme : getSystemTheme();
    return {
      accent: preferences.accent,
      theme: storedTheme
    };
  } catch {
    return fallback;
  }
}

function normalizeBootAccent(accent) {
  return ["phosphor", "amber", "cobalt"].includes(accent) ? accent : "phosphor";
}

function normalizeBootTheme(theme) {
  return ["dark", "light"].includes(theme) ? theme : getSystemTheme();
}

function hideBootOverlayNow() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const boot = document.getElementById("tether-boot");
  root.classList.add("tether-ready");
  if (!boot) return;
  boot.classList.add("is-hidden");
  boot.style.opacity = "0";
  boot.style.visibility = "hidden";
}

async function waitForAppReadyToReveal(container) {
  await Promise.race([
    (async () => {
      await waitForFrames(2);
      await Promise.allSettled([waitForImagesToSettle(container), waitForFrames(1)]);
    })(),
    waitForTimeout(650)
  ]);
}

async function waitForFontSetToSettle(timeoutMs = 700) {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.race([
    (async () => {
      for (;;) {
        await document.fonts.ready;
        await waitForFrames(2);
        if (document.fonts.status !== "loading") return;
      }
    })(),
    waitForTimeout(timeoutMs)
  ]);
}

function waitForTimeout(timeoutMs) {
  return new Promise((resolve) => window.setTimeout(resolve, timeoutMs));
}

function waitForFrames(count, timeoutMs = 260) {
  return new Promise((resolve) => {
    let finished = false;
    const timeout = window.setTimeout(finish, timeoutMs);

    function finish() {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      resolve();
    }

    function step(remaining) {
      if (finished) return;
      if (remaining <= 0) {
        finish();
        return;
      }

      window.requestAnimationFrame(() => step(remaining - 1));
    }

    step(count);
  });
}

function waitForImagesToSettle(container, timeoutMs = 1800) {
  const images = Array.from(container?.querySelectorAll("img") || []);
  if (images.length === 0) return Promise.resolve();

  return Promise.race([
    Promise.allSettled(images.map(waitForImageToSettle)),
    new Promise((resolve) => window.setTimeout(resolve, timeoutMs))
  ]);
}

function waitForImageToSettle(image) {
  if (image.complete) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;

    function done() {
      if (settled) return;
      settled = true;
      image.removeEventListener("load", done);
      image.removeEventListener("error", done);
      resolve();
    }

    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", done, { once: true });

    if (image.decode) image.decode().then(done, done);
  });
}

function getInitialSampleMarkdown() {
  try {
    return window.localStorage.getItem(LOCAL_SAMPLE_KEY) || sampleMarkdown;
  } catch {
    return sampleMarkdown;
  }
}

function getInitialConnection() {
  try {
    const storedDraft = getInitialStateValue("connectionDraft", CONNECTION_DRAFT_KEY, {});
    return {
      ...defaultConnection,
      host: typeof storedDraft.host === "string" ? storedDraft.host : defaultConnection.host,
      port: normalizeStoredNumber(storedDraft.port, defaultConnection.port),
      username: typeof storedDraft.username === "string" ? storedDraft.username : defaultConnection.username,
      authMode: ["auto", "password", "privateKey"].includes(storedDraft.authMode)
        ? storedDraft.authMode
        : defaultConnection.authMode,
      privateKeyPath:
        typeof storedDraft.privateKeyPath === "string" ? storedDraft.privateKeyPath : defaultConnection.privateKeyPath,
      remoteDirectory:
        typeof storedDraft.remoteDirectory === "string" ? storedDraft.remoteDirectory : defaultConnection.remoteDirectory,
      intervalMs: normalizeStoredNumber(storedDraft.intervalMs, defaultConnection.intervalMs)
    };
  } catch {
    return defaultConnection;
  }
}

function getInitialPreferences() {
  try {
    const storedPreferences = getInitialStateValue("preferences", PREFERENCES_KEY, {});
    return {
      ...defaultPreferences,
      theme: THEME_OPTIONS.includes(storedPreferences.theme) ? storedPreferences.theme : defaultPreferences.theme,
      accent: ["phosphor", "amber", "cobalt"].includes(storedPreferences.accent)
        ? storedPreferences.accent
        : defaultPreferences.accent,
      readingFont: ["sans", "serif"].includes(storedPreferences.readingFont)
        ? storedPreferences.readingFont
        : defaultPreferences.readingFont,
      pageWidthPx: getStoredPageWidth(storedPreferences),
      defaultView: ["preview", "split", "source"].includes(storedPreferences.defaultView)
        ? storedPreferences.defaultView
        : defaultPreferences.defaultView,
      sidebarCollapsed:
        typeof storedPreferences.sidebarCollapsed === "boolean"
          ? storedPreferences.sidebarCollapsed
          : defaultPreferences.sidebarCollapsed
    };
  } catch {
    return defaultPreferences;
  }
}

function getInitialSourceSessions() {
  try {
    const storedSessions = getInitialStateValue("sourceSessions", SOURCE_SESSIONS_KEY, []);
    if (!Array.isArray(storedSessions)) return [];
    return storedSessions.map(normalizeSourceSession).filter(Boolean).slice(0, SOURCE_SESSION_LIMIT);
  } catch {
    return [];
  }
}

function getInitialNativeUiState() {
  try {
    const state = window.remoteMarkdown?.getUiStateSync?.();
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function getInitialStateValue(nativeKey, localStorageKey, fallback) {
  if (Object.prototype.hasOwnProperty.call(initialNativeUiState, nativeKey)) {
    return initialNativeUiState[nativeKey];
  }

  try {
    return JSON.parse(window.localStorage.getItem(localStorageKey) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function getInitialFontsReady() {
  return typeof document === "undefined" || !document.fonts ? true : false;
}

function getSystemTheme() {
  if (!window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function saveConnectionDraft(connection) {
  const connectionDraft = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMode: connection.authMode,
    privateKeyPath: connection.privateKeyPath,
    remoteDirectory: connection.remoteDirectory,
    intervalMs: connection.intervalMs
  };
  try {
    window.localStorage.setItem(CONNECTION_DRAFT_KEY, JSON.stringify(connectionDraft));
  } catch {
    // Local persistence is best-effort; connection fields still work in memory.
  }
  saveNativeUiState({ connectionDraft });
}

function savePreferences(preferences) {
  const normalizedPreferences = {
    theme: preferences.theme,
    accent: preferences.accent,
    readingFont: preferences.readingFont,
    pageWidthPx: clampPageWidth(preferences.pageWidthPx),
    defaultView: preferences.defaultView,
    sidebarCollapsed: preferences.sidebarCollapsed
  };
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(normalizedPreferences));
  } catch {
    // Preferences are convenience state; the app remains usable in memory.
  }
  saveNativeUiState({ preferences: normalizedPreferences });
}

function saveSourceSessions(sourceSessions) {
  const recentSourceSessions = sourceSessions.slice(0, SOURCE_SESSION_LIMIT);
  try {
    window.localStorage.setItem(SOURCE_SESSIONS_KEY, JSON.stringify(recentSourceSessions));
  } catch {
    // Recent source history is convenience state; the app remains usable in memory.
  }
  saveNativeUiState({ sourceSessions: recentSourceSessions });
}

function saveSidebarWidth(sidebarWidth) {
  const nextWidth = clampSidebarWidth(sidebarWidth);
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
  } catch {
    // Sidebar width is convenience state; the app remains usable in memory.
  }
  saveNativeUiState({ sidebarWidth: nextWidth });
}

function saveNativeUiState(patch) {
  try {
    remoteApi.saveUiState?.(patch)?.catch?.(() => {});
  } catch {
    // Native state is only available in Electron.
  }
}

function normalizeSourceSession(session) {
  if (!session || typeof session !== "object" || typeof session.id !== "string") return null;
  if (!["remote", "local-folder", "local-file"].includes(session.kind)) return null;

  const normalized = {
    id: session.id,
    kind: session.kind,
    label: typeof session.label === "string" && session.label ? session.label : "source",
    detail: typeof session.detail === "string" ? session.detail : "",
    title: typeof session.title === "string" ? session.title : "",
    tag: typeof session.tag === "string" ? session.tag : session.kind === "remote" ? "ssh" : "local",
    rootPath: typeof session.rootPath === "string" ? session.rootPath : "",
    directory: typeof session.directory === "string" ? session.directory : "",
    selectedPath: typeof session.selectedPath === "string" ? session.selectedPath : "",
    updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : new Date().toISOString()
  };

  if (session.kind === "remote") {
    normalized.connection = sanitizeConnectionForSession(session.connection || {});
    if (!normalized.connection.host) return null;
  }

  if (session.kind === "local-folder" && !normalized.rootPath && !normalized.directory) return null;
  if (session.kind === "local-file" && !normalized.selectedPath) return null;

  return normalized;
}

function upsertSourceSession(sourceSessions, nextSession) {
  const normalized = normalizeSourceSession({
    ...nextSession,
    updatedAt: new Date().toISOString()
  });
  if (!normalized) return sourceSessions;

  const existingIndex = sourceSessions.findIndex((session) => session.id === normalized.id);
  if (existingIndex >= 0) {
    const nextSessions = [...sourceSessions];
    nextSessions[existingIndex] = normalized;
    return nextSessions.slice(0, SOURCE_SESSION_LIMIT);
  }

  return [normalized, ...sourceSessions].slice(0, SOURCE_SESSION_LIMIT);
}

function buildRemoteSourceSession(connection, directory, selectedPath = "", sessionId = "") {
  const id = sessionId || getRemoteSourceSessionId(connection);
  const safeConnection = sanitizeConnectionForSession({
    ...connection,
    remoteDirectory: directory || "",
    remotePath: selectedPath || ""
  });
  const label = `${safeConnection.username || "user"}@${safeConnection.host}`;
  const detail = selectedPath ? basename(selectedPath) : formatSourcePathDetail(directory);

  return {
    id,
    kind: "remote",
    label,
    detail,
    title: `${label}${directory ? ` - ${directory}` : ""}`,
    tag: "ssh",
    connection: safeConnection,
    directory: directory || "",
    selectedPath: selectedPath || "",
    updatedAt: new Date().toISOString()
  };
}

function buildLocalFolderSourceSession(rootPath, directory = rootPath, selectedPath = "", sessionId = "") {
  const id = sessionId || `local-folder:${rootPath}`;
  return {
    id,
    kind: "local-folder",
    label: basename(rootPath) || "local folder",
    detail: selectedPath ? basename(selectedPath) : formatSourcePathDetail(directory || rootPath),
    title: directory || rootPath,
    tag: "local",
    rootPath: rootPath || directory || "",
    directory: directory || rootPath || "",
    selectedPath: selectedPath || "",
    updatedAt: new Date().toISOString()
  };
}

function buildLocalFileSourceSession(filePath, directory = localDirname(filePath), sessionId = "") {
  const id = sessionId || `local-file:${filePath}`;
  return {
    id,
    kind: "local-file",
    label: basename(filePath) || "local file",
    detail: formatSourcePathDetail(directory),
    title: filePath,
    tag: "file",
    rootPath: directory || "",
    directory: directory || "",
    selectedPath: filePath || "",
    updatedAt: new Date().toISOString()
  };
}

function hydrateConnectionFromSourceSession(session) {
  const connection = sanitizeConnectionForSession(session.connection || {});
  const shouldOpenFile = session.selectedPath && (!session.directory || dirname(session.selectedPath) === session.directory);
  return {
    ...defaultConnection,
    ...connection,
    password: "",
    passphrase: "",
    remotePath: shouldOpenFile ? session.selectedPath : "",
    remoteDirectory: shouldOpenFile ? "" : session.directory || connection.remoteDirectory || ""
  };
}

function sanitizeConnectionForSession(connection) {
  return {
    host: typeof connection.host === "string" ? connection.host : "",
    port: normalizeStoredNumber(connection.port, defaultConnection.port),
    username: typeof connection.username === "string" ? connection.username : "",
    authMode: ["auto", "password", "privateKey"].includes(connection.authMode) ? connection.authMode : "auto",
    password: "",
    privateKeyPath: typeof connection.privateKeyPath === "string" ? connection.privateKeyPath : "",
    passphrase: "",
    remotePath: typeof connection.remotePath === "string" ? connection.remotePath : "",
    remoteDirectory: typeof connection.remoteDirectory === "string" ? connection.remoteDirectory : "",
    intervalMs: normalizeStoredNumber(connection.intervalMs, defaultConnection.intervalMs)
  };
}

function getRemoteSourceSessionId(connection) {
  const host = String(connection.host || "").trim().toLowerCase();
  const username = String(connection.username || "").trim().toLowerCase();
  const port = normalizeStoredNumber(connection.port, defaultConnection.port);
  if (!host) return "";
  return `remote:${username}@${host}:${port}`;
}

function formatSourcePathDetail(value) {
  if (!value) return "";
  return formatSidebarDirectoryPath(value)?.display || value;
}

function normalizeStoredNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getStoredPageWidth(storedPreferences) {
  if (Number.isFinite(Number(storedPreferences.pageWidthPx))) {
    return clampPageWidth(storedPreferences.pageWidthPx);
  }

  const legacyWidths = {
    narrow: 680,
    normal: 820,
    wide: PAGE_WIDTH_DEFAULT,
    fluid: 1180
  };

  return clampPageWidth(legacyWidths[storedPreferences.pageWidth] || PAGE_WIDTH_DEFAULT);
}

function clampPageWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return PAGE_WIDTH_DEFAULT;
  return Math.min(PAGE_WIDTH_MAX, Math.max(PAGE_WIDTH_MIN, Math.round(number)));
}

function getIsCompactLayout() {
  return typeof window !== "undefined" && window.innerWidth <= 820;
}

function openBrowserLocalFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain";

    input.addEventListener(
      "change",
      async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve({ ok: true, canceled: true, file: null });
          return;
        }

        const content = await file.text();
        const filePath = file.webkitRelativePath || file.name;
        window.localStorage.setItem(`remoteMarkdownPreview.localFile:${filePath}`, content);
        resolve({
          ok: true,
          canceled: false,
          file: createBrowserLocalFile(filePath, content),
          directory: localDirname(filePath),
          entries: [
            {
              name: basename(filePath),
              path: filePath,
              type: "file",
              size: new Blob([content]).size,
              isMarkdown: true
            }
          ]
        });
      },
      { once: true }
    );

    input.click();
  });
}

function createLocalSampleFile(content) {
  const refreshedAt = new Date().toISOString();
  return {
    path: sampleEntry.path,
    content,
    refreshedAt,
    version: `local-${refreshedAt}-${content.length}`,
    metadata: {
      size: new Blob([content]).size,
      mtime: refreshedAt
    }
  };
}

function createBrowserLocalFile(filePath, content) {
  const refreshedAt = new Date().toISOString();
  return {
    path: filePath,
    content,
    refreshedAt,
    version: `browser-local-${refreshedAt}-${content.length}`,
    metadata: {
      size: new Blob([content]).size,
      mtime: refreshedAt
    }
  };
}

function getInitialSidebarWidth() {
  const storedWidth = Number(
    Object.prototype.hasOwnProperty.call(initialNativeUiState, "sidebarWidth")
      ? initialNativeUiState.sidebarWidth
      : window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
  );
  return clampSidebarWidth(storedWidth || SIDEBAR_DEFAULT_WIDTH);
}

function clampSidebarWidth(width) {
  const viewportMax = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 560);
  return Math.min(Math.max(Number(width) || SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH), Math.min(SIDEBAR_MAX_WIDTH, viewportMax));
}

function basename(remotePath) {
  return remotePath?.split(/[\\/]/).filter(Boolean).pop() || "Remote file";
}

function dirname(remotePath) {
  const normalized = remotePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  parts.pop();
  const directory = parts.join("/");
  return directory || "/";
}

function localDirname(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  const slashIndex = trimmed.lastIndexOf("/");

  if (slashIndex < 0) return ".";
  if (slashIndex === 0) return "/";
  if (slashIndex === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, slashIndex);
}

function canGoUp(remotePath) {
  return remotePath && remotePath !== "." && remotePath !== "/";
}

function localCanGoUp(directory) {
  if (!directory || directory === "." || directory === "/") return false;
  return !/^[A-Za-z]:\/?$/.test(directory.replace(/\\/g, "/"));
}

function parentRemotePath(remotePath) {
  if (!canGoUp(remotePath)) return remotePath || ".";
  const normalized = remotePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = normalized.split("/").slice(0, -1).join("/");
  return parent || (normalized.startsWith("/") ? "/" : ".");
}

function localParentPath(directory) {
  if (!localCanGoUp(directory)) return directory || ".";
  return localDirname(directory);
}

const rootElement = document.getElementById("root");
const reactRoot = window.__TETHER_REACT_ROOT__ || createRoot(rootElement);
window.__TETHER_REACT_ROOT__ = reactRoot;
reactRoot.render(<App />);
