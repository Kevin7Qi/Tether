import React, { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import {
  basename,
  canGoUp,
  compactPath,
  compactPathStart,
  dirname,
  formatSidebarDirectoryPath,
  localCanGoUp,
  localDirname,
  localParentPath,
  normalizeLocalComparisonPath,
  parentRemotePath,
  pathsReferToSameLocalFile
} from "./lib/paths.js";
import {
  applyConnectionTarget,
  countLines,
  countWords,
  formatConnectionTarget,
  formatFileModifiedLabel,
  formatFileTimestamp,
  formatLatency,
  formatPoll,
  formatSourcePathDetail,
  healthCheckErrorMessage,
  healthCheckPendingMessage,
  healthCheckSuccessMessage,
  statusTextForLoading
} from "./lib/format.js";
import { createDocumentState, documentReducer } from "./lib/documentState.js";
import { PAGE_WIDTH_DEFAULT, clampPageWidth } from "./lib/constants.js";
import { DocumentSurfaceFallback, FilesPanel, SourcesPanel, TetherGlyph } from "./components/panels.jsx";
import { ConnectionPalette, SettingsPanel, StatusBar, ThemeSwitch } from "./components/dialogs.jsx";

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
  const [documentState, dispatchDocument] = useReducer(documentReducer, undefined, () =>
    createDocumentState(initialSampleMarkdown)
  );
  const { content, editorContent, remoteShadow, fileVersion, dirty, conflict } = documentState;
  const [fileMetadata, setFileMetadata] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [connected, setConnected] = useState(false);
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const saveActionRef = useRef(null);

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
      if (event.isComposing) return;
      const key = event.key ? event.key.toLowerCase() : "";

      if ((event.ctrlKey || event.metaKey) && key === "k") {
        event.preventDefault();
        setConnectionPaletteOpen((open) => !open);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === "s") {
        event.preventDefault();
        saveActionRef.current?.();
        return;
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
  // Defer the rendered-preview content so typing in the textarea stays responsive
  // while the heavy Markdown re-render runs at lower priority.
  const deferredPreviewContent = useDeferredValue(previewContent);
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
  const wordCount = useMemo(() => countWords(deferredPreviewContent), [deferredPreviewContent]);
  const lineCount = useMemo(() => countLines(editorContent), [editorContent]);
  const sidebarRailMode = sidebarCollapsed || compactLayout;
  const showLocalSource = sampleSourceOpen;
  const expandedSidebarWidth = Math.max(sidebarWidth, SIDEBAR_MIN_WIDTH);
  useEffect(() => {
    if (documentSource !== "sample" || selectedPath !== sampleEntry.path || dirty) return undefined;

    let canceled = false;
    remoteApi.readLocalSample().then((response) => {
      if (canceled || !response?.ok || !response.file) return;
      setLocalSampleContent(response.file.content);
      dispatchDocument({ type: "LOAD_FRESH", file: response.file });
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
    // Metadata only updates when adopting the file; during a conflict the open
    // file's metadata is preserved (matching the pre-reducer behavior).
    if (!dirty) setFileMetadata(file.metadata);
    dispatchDocument({ type: "REMOTE_UPDATE", file });
  }

  function applyFreshFile(file) {
    captureScrollRatio(previewRef, scrollRatioRef);
    dispatchDocument({ type: "LOAD_FRESH", file });
    setFileMetadata(file.metadata);
    setLastRefresh(file.refreshedAt);
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
      setSelectedPath(openedPath);
      setCurrentDirectory(directory);
      setFileEntries(response.entries || []);
      if (response.file) {
        applyFreshFile(response.file);
        setStatus((current) => ({ ...current, state: "connected", message: "Remote file opened" }));
      } else {
        dispatchDocument({ type: "SET_TEXT", text: chooseRemoteFileMarkdown });
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
    dispatchDocument({ type: "SET_TEXT", text: chooseLocalFileMarkdown });
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
    dispatchDocument({ type: "LOAD_FRESH", file });
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
    dispatchDocument({ type: "SET_TEXT", text: "" });
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
      dispatchDocument({ type: "SET_TEXT", text: chooseLocalFileMarkdown });
      setError(fileResponse?.error || null);
      setStatus({ state: "idle", message: "Restored local folder", checkedAt: null, metadata: null });
      rememberSourceSession(buildLocalFolderSourceSession(session.rootPath || directory, directory, "", session.id));
    } finally {
      setBusy(false);
      endSourceOpening(openingKey);
    }
  }

  // The reducer derives dirty from the value vs. the base and clears a stuck
  // conflict when edits are reverted, so this stays stable (no deps needed).
  const onEditorChange = useCallback((event) => {
    dispatchDocument({ type: "EDIT", value: event.target.value });
  }, []);

  function useLatestRemote() {
    if (!remoteShadow) return;
    applyFreshFile(remoteShadow);
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
          dispatchDocument({
            type: "CONFLICT_DETECTED",
            shadow: latest?.ok && latest.file ? latest.file : remoteShadow
          });
        }
        setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        return;
      }

      setLocalFile({ path: response.file.path });
      applyFreshFile(response.file);
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
        dispatchDocument({
          type: "CONFLICT_DETECTED",
          shadow: latest?.ok && latest.file ? latest.file : remoteShadow
        });
      }
      return;
    }

    applyFreshFile(response.file);
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

  // Keep the latest save action in a ref so the global Cmd/Ctrl+S handler can
  // invoke the current closure without re-subscribing the keydown listener.
  saveActionRef.current = () => {
    if (canSave && !busy) saveCurrentFile();
  };

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
              <div
                className="brand-lockup"
                role="button"
                tabIndex={0}
                title="Run a connection health check"
                onClick={triggerTetherPing}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  triggerTetherPing();
                }}
              >
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
            <button disabled={busy} onClick={useLatestRemote}>take theirs</button>
            <button className="warn" disabled={busy} onClick={keepLocalEditsAndOverwrite}>
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
            content={deferredPreviewContent}
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

const rootElement = document.getElementById("root");
const reactRoot = window.__TETHER_REACT_ROOT__ || createRoot(rootElement);
window.__TETHER_REACT_ROOT__ = reactRoot;
reactRoot.render(<App />);
