import React, { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Download,
  File,
  FilePlus,
  Folder,
  List,
  Maximize2,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sun,
  SunMoon,
  X
} from "lucide-react";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-400-italic.css";
import "@fontsource/instrument-sans/latin-500.css";
import "@fontsource/instrument-sans/latin-500-italic.css";
import "@fontsource/instrument-sans/latin-600.css";
import "@fontsource/instrument-sans/latin-600-italic.css";
import "@fontsource/instrument-sans/latin-700.css";
import "@fontsource/instrument-sans/latin-700-italic.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-400-italic.css";
import "@fontsource/newsreader/latin-600.css";
import "@fontsource/newsreader/latin-600-italic.css";
import "@milkdown/crepe/theme/common/style.css";
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
import { PAGE_WIDTH_DEFAULT, clampPageWidth, hotkey } from "./lib/constants.js";
import { EDITOR_MODE_SOURCE, EDITOR_MODE_WYSIWYG } from "./lib/editorModes.js";
import { parseOutline } from "./lib/outline.js";
import { isConnectionLostError, connectionLostMessage } from "./lib/connection.js";
import { tabId, makeTab, tabsForSource, upsertTab, patchTab, removeTab, rekeyTabsForSource, selectNeighborTab } from "./lib/tabs.js";
import { DocumentSurfaceFallback, FilesPanel, OutlinePanel, SourcesPanel, TetherGlyph } from "./components/panels.jsx";
import { ConnectionPalette, NewFileDialog, SettingsPanel, StatusBar } from "./components/dialogs.jsx";

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
const COPY_NOTICE_TIMEOUT_MS = 1800;
const THEME_OPTIONS = ["system", "dark", "light"];
const defaultPreferences = {
  theme: "system",
  accent: "phosphor",
  readingFont: "sans",
  pageWidthPx: PAGE_WIDTH_DEFAULT,
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
  createRemoteFile: async () => ({
    ok: false,
    error: {
      code: "BROWSER_PREVIEW",
      message: "Remote file creation is available in the Electron app."
    }
  }),
  downloadRemoteFile: async () => ({
    ok: false,
    error: {
      code: "BROWSER_PREVIEW",
      message: "Remote downloads are available in the Electron app."
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
  createLocalFile: async ({ directory, name }) => {
    const fileName = normalizeMarkdownFileName(name);
    const filePath = joinBrowserPath(directory || ".", fileName);
    window.localStorage.setItem(`remoteMarkdownPreview.localFile:${filePath}`, "");
    return {
      ok: true,
      file: createBrowserLocalFile(filePath, ""),
      directory: directory || ".",
      entries: [
        {
          name: fileName,
          path: filePath,
          type: "file",
          size: 0,
          isMarkdown: true
        }
      ]
    };
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
  saveTextAs: async ({ content, defaultPath }) => saveTextAsBrowserDownload(content, defaultPath),
  onStatus: () => () => {},
  onUpdate: () => () => {},
  onError: () => () => {}
};

const remoteApi = {
  ...fallbackRemoteApi,
  ...(window.remoteMarkdown ?? {})
};
const hasNativeHealthCheck = Boolean(window.remoteMarkdown?.healthCheck);

export default function App() {
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
  const [viewMode, setViewMode] = useState(EDITOR_MODE_WYSIWYG);
  const [zenMode, setZenMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialPreferences.sidebarCollapsed);
  const [sidebarPeeking, setSidebarPeeking] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineHovering, setOutlineHovering] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [compactLayout, setCompactLayout] = useState(() => getIsCompactLayout());
  const [connectionPaletteOpen, setConnectionPaletteOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState(null);
  const [newFileDialog, setNewFileDialog] = useState({ open: false, directory: "" });
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
  const [copyNotice, setCopyNotice] = useState(null);
  const [expandedDirs, setExpandedDirs] = useState(() => new Set());
  const [childrenByDir, setChildrenByDir] = useState({});
  const [loadingDirs, setLoadingDirs] = useState(() => new Set());
  const [defaultPrivateKeyPath, setDefaultPrivateKeyPath] = useState("");
  const [connectionProfile, setConnectionProfile] = useState(null);
  const resolvedTheme = preferences.theme === "system" ? systemTheme : preferences.theme;
  const previewRef = useRef(null);
  const scrollRatioRef = useRef(0);
  // Mirror `dirty`/`selectedPath` into refs so the remote-update listeners
  // (subscribed once) can read the latest values without re-subscribing on every
  // keystroke or tab switch.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const documentSourceRef = useRef("none");
  const pingTimerRef = useRef(null);
  const pingRequestRef = useRef(0);
  const documentRefreshTimerRef = useRef(null);
  const treeRefreshTimerRef = useRef(null);
  const copyNoticeTimerRef = useRef(null);
  const outlineHoverTimerRef = useRef(null);
  const sourceOpeningRef = useRef(null);
  const saveActionRef = useRef(null);
  const openFileActionRef = useRef(null);
  const openFolderActionRef = useRef(null);
  const findInputRef = useRef(null);

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
      if (payload.state === "disconnected" && payload.unexpected) {
        handleRemoteConnectionLoss(payload.message);
        return;
      }
      setStatus((current) => ({ ...current, ...payload }));
      if (payload.metadata) setFileMetadata(payload.metadata);
    });

    const removeError = remoteApi.onError((payload) => {
      if (isConnectionLostError(payload)) {
        handleRemoteConnectionLoss(payload.message || connectionLostMessage());
        return;
      }
      setError(payload);
    });

    const removeUpdate = remoteApi.onUpdate((file) => {
      // Ignore a watch update for a file that is no longer the active document:
      // after a tab switch, a poll for the previously-watched file can still be
      // in flight, and applying it would overwrite the now-active tab's content.
      // (The watch target is the active file's path, so a legit update always
      // matches; metadata.path carries the path, not a top-level file.path.)
      const updatedPath = file.metadata?.path;
      if (updatedPath && updatedPath !== selectedPathRef.current) return;
      captureScrollRatio(previewRef, scrollRatioRef);
      applyRemoteFile(file);
    });

    return () => {
      removeStatus();
      removeError();
      removeUpdate();
    };
    // Subscribe once: the handlers read live state through refs/stable setters,
    // so they never need to re-bind (previously re-ran on every `dirty` toggle).
  }, []);

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
      if (copyNoticeTimerRef.current) window.clearTimeout(copyNoticeTimerRef.current);
      if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!findOpen) return undefined;
    const timer = window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [findOpen]);

  useEffect(() => {
    if (!contextMenu) return undefined;

    function closeMenu() {
      setContextMenu(null);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") closeMenu();
    }

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    // Cmd/Ctrl+Shift+O reaches us on key-down in the normal case, but may only
    // arrive on key-up in two situations: macOS suppresses key-up for letter
    // keys while Cmd is held, and a global hotkey can swallow the key-down on
    // Windows/Linux. Listen on both and coalesce so one press opens the picker
    // exactly once regardless of platform or key-release order.
    let lastFolderShortcutAt = 0;
    function openFolderFromShortcut() {
      const now = Date.now();
      if (now - lastFolderShortcutAt < 700) return;
      lastFolderShortcutAt = now;
      openFolderActionRef.current?.();
    }

    function onKeyDown(event) {
      if (event.isComposing) return;
      const key = event.key ? event.key.toLowerCase() : "";

      if ((event.ctrlKey || event.metaKey) && key === "f") {
        event.preventDefault();
        if (documentSourceRef.current !== "none") setFindOpen(true);
        return;
      }

      if (event.key === "F3" && findOpen) {
        event.preventDefault();
        setFindActiveIndex((current) => current + (event.shiftKey ? -1 : 1));
        return;
      }

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

      // Open folder on Ctrl/Cmd+Shift+O (must be checked before the no-Shift
      // open-file branch below).
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (key === "o" || event.code === "KeyO")) {
        event.preventDefault();
        openFolderFromShortcut();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (key === "o" || event.code === "KeyO")) {
        event.preventDefault();
        openFileActionRef.current?.();
        return;
      }

      if (event.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        if (findOpen) {
          setFindOpen(false);
          return;
        }
        if (connectionPaletteOpen) setConnectionPaletteOpen(false);
        if (settingsPanelOpen) setSettingsPanelOpen(false);
        if (sidebarPeeking) setSidebarPeeking(false);
        if (zenMode) setZenMode(false);
      }
    }

    // Fallback for platforms where the key-down above is intercepted before it
    // reaches the app; coalesced with the key-down path so it never double-fires.
    function onKeyUp(event) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyO") {
        event.preventDefault();
        openFolderFromShortcut();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [connectionPaletteOpen, contextMenu, findOpen, settingsPanelOpen, sidebarPeeking, zenMode]);

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
  const outline = useMemo(() => parseOutline(deferredPreviewContent), [deferredPreviewContent]);

  // Scroll-spy: while the outline is visible, highlight the heading the reader is in.
  useEffect(() => {
    if (!outlineOpen && !outlineHovering) return undefined;
    const pane = previewRef.current;
    if (!pane) return undefined;

    let raf = 0;
    function compute() {
      raf = 0;
      const headings = pane.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]");
      const threshold = pane.getBoundingClientRect().top + 28;
      let active = null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= threshold) active = heading.id;
        else break;
      }
      setActiveHeadingId(active);
    }
    function onScroll() {
      if (!raf) raf = window.requestAnimationFrame(compute);
    }

    pane.addEventListener("scroll", onScroll, { passive: true });
    compute();
    return () => {
      pane.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [outlineOpen, outlineHovering, deferredPreviewContent, viewMode, zenMode]);
  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null;
  const hasLocalDocument = Boolean(localFile || localWorkspaceDirectory);
  const connectionSource = connected ? "remote" : hasLocalDocument ? "local" : sampleSourceOpen ? "sample" : "none";
  // Classify the open document by the tab that owns it, not the live `connected`
  // flag: when an SSH session drops, the still-open remote document (and its tab)
  // must stay "remote" rather than being reclassified as the local sample — which
  // would hide its tab, switch the panel to the sample, and lose the user's place.
  // Falls back to the connection-derived source when no tab is live (the
  // "choose a file" placeholders and the tab-less sample).
  const documentSource = activeTab ? activeTab.kind : connectionSource;
  documentSourceRef.current = documentSource;
  const currentSourceKey = activeTab
    ? activeTab.sourceKey
    : sourceKeyFor(connectionSource, connection, localWorkspaceDirectory, localFile);
  const sourceTabs = useMemo(() => tabsForSource(tabs, currentSourceKey), [tabs, currentSourceKey]);

  // The lazily-loaded directory tree is rooted at the current source's directory;
  // reset its expansion + child cache when the source or its root changes.
  useEffect(() => {
    setExpandedDirs(new Set());
    setChildrenByDir({});
    setLoadingDirs(new Set());
  }, [currentSourceKey, currentDirectory]);
  // Driven by documentSource (the active tab's kind) and selectedPath rather than
  // `connected`, so a dropped remote session keeps showing the open file's name.
  const documentTitle =
    selectedPath && documentSource !== "none"
      ? basename(selectedPath)
      : documentSource === "none"
        ? "No document open"
        : "Choose a Markdown file";
  const documentEyebrow =
    documentSource === "remote"
      ? selectedPath || "Remote source"
      : documentSource === "local"
        ? "Local file"
        : documentSource === "sample"
          ? "Local sample"
          : "No source";
  const sidebarVisible = !zenMode;
  const canSave =
    dirty &&
    !conflict &&
    ((documentSource === "sample" && selectedPath === sampleEntry.path) ||
      (documentSource === "local" && localFile?.path) ||
      // A remote save needs a live connection; while disconnected the document
      // stays "remote" (so its tab/place are kept) but saving waits for reconnect.
      (documentSource === "remote" && selectedPath && connected));
  const canRefreshDocument = documentSource === "remote" && selectedPath && connected;
  const canCopyDocument = documentSource !== "none" && Boolean(editorContent || content);
  const canDownloadDocument = documentSource === "remote" && selectedPath;
  const canCreateFile =
    (documentSource === "remote" && connected && currentDirectory) ||
    (documentSource === "local" && localWorkspaceDirectory && currentDirectory);
  const sourceLabel = connected
    ? `${connection.username || "user"}@${connection.host || "host"}`
    : documentSource === "local" && localWorkspaceDirectory
      ? compactPath(localWorkspaceDirectory)
      : documentSource === "sample"
        ? "local sample"
        : "no source";
  const rootLabel = connected || (documentSource === "local" && localWorkspaceDirectory) ? currentDirectory : documentSource === "sample" ? "samples" : "";
  const toolbarDocumentLabel =
    sourceOpening?.title || (documentSource === "none" ? "no source" : selectedPath ? compactPath(selectedPath) : documentTitle);
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
              ? "conflict · resolve to save"
              : error
                ? status.message || "error"
                : dirty
                  ? fileModifiedLabel
                    ? `unsaved · ${fileModifiedLabel}`
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
                        : `no source · ${hotkey("k")} to connect`;
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
    // file's metadata is preserved (matching the pre-reducer behavior). Read the
    // ref so this stays correct when invoked from the once-subscribed listener.
    if (!dirtyRef.current) setFileMetadata(file.metadata);
    dispatchDocument({ type: "REMOTE_UPDATE", file });
  }

  function applyFreshFile(file) {
    captureScrollRatio(previewRef, scrollRatioRef);
    dispatchDocument({ type: "LOAD_FRESH", file });
    setFileMetadata(file.metadata);
    setLastRefresh(file.refreshedAt);
    setError(null);
  }

  // Recover gracefully when the remote connection drops — whether detected
  // mid-operation or via a background disconnect event. Stop watching, mark the
  // session detached, drop the now-stale file tree, and surface a clear,
  // actionable message. The open document and any unsaved edits are kept, and the
  // remembered source becomes clickable again so the user can reconnect.
  //
  // MUST stay idempotent: a single background drop fires both a status(unexpected)
  // and an error(CONNECTION_LOST) event (see remoteFileProvider.handleUnexpectedDisconnect),
  // so this runs twice per drop — and it can also race with an op-path call. Keep
  // every step here a plain reset; do not add non-idempotent work (auto-reconnect,
  // a toast, analytics) without guarding it against re-entry.
  function handleRemoteConnectionLoss(message) {
    const text = message || connectionLostMessage();
    setWatching(false);
    setConnected(false);
    setActiveSessionId(null);
    setFileEntries([]);
    setError({ code: "CONNECTION_LOST", message: text });
    setStatus({ state: "error", message: text, checkedAt: null, metadata: null });
  }

  function tabExistsFor(sourceKey, path) {
    return tabs.some((tab) => tab.id === tabId(sourceKey, path));
  }

  // Open a file as a tab (or focus the existing one): snapshot the outgoing
  // active tab's live edits, upsert the new tab, and make it the live document.
  function adoptFileIntoTab({ sourceKey, kind, path, label, file }) {
    const id = tabId(sourceKey, path);

    // The file is already open in another tab: focus it instead of overwriting,
    // so that tab's unsaved edits are never silently replaced with the freshly
    // read copy. (Centralizes the guard the file-tree open paths apply too, so
    // the native picker / connect / session-restore callers are safe as well.)
    if (id !== activeTabId && tabExistsFor(sourceKey, path)) {
      switchToTab(id);
      return;
    }
    // Re-opening the file that is already the live document: keep any in-progress
    // edits rather than discarding them for the re-read copy.
    if (id === activeTabId && dirty) {
      return;
    }

    captureScrollRatio(previewRef, scrollRatioRef);
    const outgoingScrollRatio = scrollRatioRef.current;
    setTabs((prev) => {
      const snapshotted =
        activeTabId && activeTabId !== id
          ? patchTab(prev, activeTabId, {
              doc: documentState,
              metadata: fileMetadata,
              refreshedAt: lastRefresh,
              scrollRatio: outgoingScrollRatio
            })
          : prev;
      return upsertTab(
        snapshotted,
        makeTab({ sourceKey, kind, path, label, doc: docFromFile(file), metadata: file.metadata, refreshedAt: file.refreshedAt })
      );
    });
    setActiveTabId(id);
    applyFreshFile(file);
    setSelectedPath(path);
  }

  // Make a stored tab live again (tab switch / close-to-neighbor). Seed the
  // scroll ref with the tab's saved ratio; the restore-scroll effect applies it
  // on the next frame once the restored content has rendered.
  function restoreTab(tab) {
    scrollRatioRef.current = tab.scrollRatio || 0;
    dispatchDocument({ type: "RESTORE", doc: tab.doc });
    setSelectedPath(tab.path);
    setFileMetadata(tab.metadata);
    setLastRefresh(tab.refreshedAt);
    setActiveTabId(tab.id);
    setError(null);
    if (tab.kind === "remote") setConnection((current) => ({ ...current, remotePath: tab.path }));
    if (tab.kind === "local") setLocalFile({ path: tab.path });
  }

  function switchToTab(id) {
    if (id === activeTabId) return;
    const target = tabs.find((tab) => tab.id === id);
    if (!target) return;
    captureScrollRatio(previewRef, scrollRatioRef);
    const outgoingScrollRatio = scrollRatioRef.current;
    if (watching) {
      remoteApi.stopWatching();
      setWatching(false);
    }
    if (activeTabId) {
      setTabs((prev) =>
        patchTab(prev, activeTabId, {
          doc: documentState,
          metadata: fileMetadata,
          refreshedAt: lastRefresh,
          scrollRatio: outgoingScrollRatio
        })
      );
    }
    restoreTab(target);
  }

  function closeTab(id) {
    const tab = tabs.find((existing) => existing.id === id);
    if (!tab) return;
    const isActive = id === activeTabId;
    const tabDirty = isActive ? dirty : Boolean(tab.doc && tab.doc.dirty);
    if (tabDirty && !window.confirm("Discard unsaved edits and close this tab?")) return;

    if (!isActive) {
      setTabs((prev) => removeTab(prev, id));
      return;
    }

    if (watching) {
      remoteApi.stopWatching();
      setWatching(false);
    }
    const nextId = selectNeighborTab(tabs, tab.sourceKey, id);
    setTabs((prev) => removeTab(prev, id));
    if (nextId) {
      restoreTab(tabs.find((existing) => existing.id === nextId));
    } else {
      setActiveTabId(null);
      setSelectedPath("");
      // Drop the reference to the now-closed file so Save can't write the
      // placeholder back over it (canSave keys off localFile?.path).
      setLocalFile(null);
      dispatchDocument({ type: "SET_TEXT", text: tab.kind === "remote" ? chooseRemoteFileMarkdown : chooseLocalFileMarkdown });
      setFileMetadata(null);
      setLastRefresh(null);
      setError(null);
    }
  }

  function updateConnection(field, value) {
    setConnection((current) => {
      const next = { ...current, [field]: value };
      // remoteDirectory is a runtime browse hint set at connect time; clear it
      // when the path is edited so the next connect re-derives it (dirname of the
      // path, or home when empty) instead of reusing the prior connection's dir.
      if (field === "remotePath") next.remoteDirectory = "";
      return next;
    });
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

  function editSourceSessionConnection(session) {
    if (!session || session.kind !== "remote") return;
    setConnection(hydrateConnectionFromSourceSession(session));
    setError(null);
    setConnectionPaletteOpen(true);
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

  function showCopyNotice(message = "Copied") {
    if (copyNoticeTimerRef.current) window.clearTimeout(copyNoticeTimerRef.current);
    setCopyNotice(message);
    copyNoticeTimerRef.current = window.setTimeout(() => {
      setCopyNotice(null);
      copyNoticeTimerRef.current = null;
    }, COPY_NOTICE_TIMEOUT_MS);
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
      // Only a file becomes the selected document; a folder target just browses,
      // so leave selectedPath empty (else file-refresh/watch would act on a dir).
      setSelectedPath(response.file ? openedPath : "");
      setCurrentDirectory(directory);
      setFileEntries(response.entries || []);
      if (response.file) {
        adoptFileIntoTab({ sourceKey: remoteSourceKey(nextConnection), kind: "remote", path: openedPath, label: basename(openedPath), file: response.file });
        setStatus((current) => ({ ...current, state: "connected", message: "Remote file opened" }));
      } else {
        setActiveTabId(null);
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

  async function loadChildren(dirPath) {
    // Don't issue a second listing for a directory whose first load is still in
    // flight (rapid expand/collapse/expand, double-click) — that fires duplicate
    // concurrent SFTP/readdir calls for the same path.
    if (loadingDirs.has(dirPath)) return;
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const response = connected
        ? await remoteApi.listDirectory(dirPath)
        : await remoteApi.listLocalDirectory(dirPath);
      if (!response.ok) {
        if (connected && isConnectionLostError(response.error)) {
          handleRemoteConnectionLoss(connectionLostMessage(connection.host));
        } else {
          setError(response.error);
        }
        return;
      }
      setChildrenByDir((prev) => ({ ...prev, [dirPath]: response.entries }));
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }

  function toggleDir(entry) {
    const dirPath = entry.path;
    const willExpand = !expandedDirs.has(dirPath);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
    if (willExpand && !childrenByDir[dirPath] && !loadingDirs.has(dirPath)) loadChildren(dirPath);
  }

  // Re-root the tree at a folder (drill down) or its parent (".." goes up). Only
  // the browse root (currentDirectory) moves; the source identity and open tabs
  // are untouched. The reset effect rebuilds the tree at the new root.
  async function enterDirectory(entry) {
    if (!entry || entry.type !== "directory" || entry.path === currentDirectory) return;
    setTreeLoading(true);
    setError(null);
    try {
      const response = connected
        ? await remoteApi.listDirectory(entry.path)
        : await remoteApi.listLocalDirectory(entry.path);
      if (!response.ok) {
        if (connected && isConnectionLostError(response.error)) {
          handleRemoteConnectionLoss(connectionLostMessage(connection.host));
        } else {
          setError(response.error);
          setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        }
        return;
      }
      setCurrentDirectory(entry.path);
      setFileEntries(response.entries);
    } finally {
      setTreeLoading(false);
    }
  }

  async function openEntry(entry) {
    if (entry.type === "directory") {
      await enterDirectory(entry);
      return;
    }

    if (!entry.isMarkdown) return;

    if (!connected) {
      await loadSample();
      return;
    }

    // Edits typed into the tab-less "choose a file" placeholder can't be
    // snapshotted (no active tab), so confirm before discarding them. With a live
    // tab, adoptFileIntoTab/switchToTab snapshot the outgoing edits safely.
    if (!activeTabId && !confirmDiscardEdits("open a file")) return;

    if (tabExistsFor(remoteSourceKey(connection), entry.path)) {
      switchToTab(tabId(remoteSourceKey(connection), entry.path));
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
      if (isConnectionLostError(response.error)) {
        handleRemoteConnectionLoss(connectionLostMessage(connection.host));
      } else {
        setError(response.error);
      }
      return;
    }

    setConnection((current) => ({ ...current, remotePath: entry.path }));
    adoptFileIntoTab({ sourceKey: remoteSourceKey(connection), kind: "remote", path: entry.path, label: entry.name, file: response.file });
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
    // Opening via the native picker disconnects any remote session and switches
    // the workspace, which hides the current document's tab — so even a snapshotted
    // outgoing tab becomes unreachable. Confirm whenever there are unsaved edits,
    // regardless of whether a tab backs them.
    if (!confirmDiscardEdits("open a file")) return;
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
    setLocalWorkspaceDirectory(response.directory || localDirname(response.file.path));
    setCurrentDirectory(response.directory || localDirname(response.file.path));
    setFileEntries(response.entries || []);
    adoptFileIntoTab({
      sourceKey: localSourceKey(response.directory || localDirname(response.file.path)),
      kind: "local",
      path: response.file.path,
      label: basename(response.file.path),
      file: response.file
    });
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
    setActiveTabId(null);
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
      await enterDirectory(entry);
      return;
    }

    if (!entry.isMarkdown) return;

    // Edits typed into the tab-less "choose a file" placeholder can't be
    // snapshotted (no active tab), so confirm before discarding them.
    if (!activeTabId && !confirmDiscardEdits("open a file")) return;

    // The source identity stays the originally opened folder, not the drilled-in
    // browse root — so drilling never fragments the open tabs.
    const sourceRoot = localWorkspaceDirectory || currentDirectory;
    if (tabExistsFor(localSourceKey(sourceRoot), entry.path)) {
      switchToTab(tabId(localSourceKey(sourceRoot), entry.path));
      return;
    }

    setBusy(true);
    setError(null);
    const response = await remoteApi.readLocalFile(entry.path);
    setBusy(false);

    if (!response.ok) {
      setError(response.error);
      setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
      return;
    }

    setLocalFile({ path: response.file.path });
    adoptFileIntoTab({ sourceKey: localSourceKey(sourceRoot), kind: "local", path: response.file.path, label: basename(response.file.path), file: response.file });
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
        if (isConnectionLostError(response.error)) {
          handleRemoteConnectionLoss(connectionLostMessage(connection.host));
        } else {
          setError(response.error);
          setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
        }
        return;
      }

      captureScrollRatio(previewRef, scrollRatioRef);
      // A conflict only arises when we have unsaved edits AND the server copy
      // actually differs from our base. An unchanged re-fetch keeps the edits (the
      // reducer treats byte-identical content as a no-op), so it must not claim a
      // newer file was found or leave Save stuck behind a phantom conflict.
      const raisedConflict = wasDirty && response.file.content !== content;
      applyRemoteFile(response.file);
      setStatus((current) => ({
        ...current,
        state: watching ? "watching" : "connected",
        message: raisedConflict ? "Remote refresh found a newer file; review the conflict." : "Remote file refreshed",
        metadata: response.file.metadata
      }));
      showDocumentRefreshNotice(raisedConflict ? "newer file found" : "file refreshed");
    } finally {
      setBusy(false);
      setDocumentRefreshing(false);
    }
  }

  function startFind(query = findQuery) {
    if (documentSource === "none") return;
    setFindOpen(true);
    setFindActiveIndex(0);
    if (typeof query === "string") setFindQuery(normalizeFindQuery(query));
  }

  function updateFindQuery(value) {
    setFindQuery(value);
    setFindActiveIndex(0);
  }

  const handleSearchResultCount = useCallback((count) => {
    const safeCount = Math.max(0, Number(count) || 0);
    setFindMatchCount(safeCount);
    setFindActiveIndex((current) => (safeCount ? wrapIndex(current, safeCount) : 0));
  }, []);

  function moveFind(delta) {
    if (!findOpen) setFindOpen(true);
    setFindActiveIndex((current) => current + delta);
  }

  async function copyDocumentText() {
    if (!canCopyDocument) return false;
    const ok = await copyCodeText(editorContent);
    if (ok) {
      setStatus((current) => ({ ...current, message: "Copied document" }));
      showCopyNotice("Copied document");
      return true;
    }
    setError({ code: "COPY_FAILED", message: "Unable to copy the document." });
    return false;
  }

  async function copySelectionText(selectedText) {
    const ok = await copyCodeText(selectedText);
    if (ok) {
      setStatus((current) => ({ ...current, message: "Copied selection" }));
      showCopyNotice("Copied selection");
    } else {
      setError({ code: "COPY_FAILED", message: "Unable to copy the selection." });
    }
    return ok;
  }

  async function exportCurrentDocument() {
    if (!canDownloadDocument) return false;

    setBusy(true);
    setError(null);
    try {
      const response = await remoteApi.saveTextAs({
        content: editorContent,
        defaultPath: basename(selectedPath),
        title: "Download current Markdown file"
      });
      if (!response?.ok) {
        setError(response?.error || { message: "Unable to download the current document." });
        setStatus((current) => ({
          ...current,
          state: "error",
          message: response?.error?.message || "Unable to download the current document."
        }));
        return false;
      }
      if (!response.canceled) {
        setStatus((current) => ({ ...current, message: "Downloaded remote file" }));
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  function openNewFileDialog(directory = currentDirectory) {
    if (!canCreateFile) return;
    setContextMenu(null);
    setNewFileDialog({ open: true, directory: directory || currentDirectory });
  }

  async function createBlankFile(name) {
    const directory = newFileDialog.directory || currentDirectory;
    if (!directory || !canCreateFile) return false;
    if (!activeTabId && !confirmDiscardEdits("create a new file")) return false;

    setBusy(true);
    setError(null);
    try {
      if (watching) {
        await remoteApi.stopWatching();
        setWatching(false);
      }

      const response =
        documentSource === "remote"
          ? await remoteApi.createRemoteFile({ directory, name })
          : await remoteApi.createLocalFile({ directory, name });

      if (!response?.ok) {
        if (documentSource === "remote" && isConnectionLostError(response?.error)) {
          handleRemoteConnectionLoss(connectionLostMessage(connection.host));
        } else {
          const nextError = response?.error || { message: "Unable to create the file." };
          setError(nextError);
          setStatus((current) => ({ ...current, state: "error", message: nextError.message }));
        }
        return false;
      }

      const createdPath = response.path || response.file?.path;
      if (response.entries && directory === currentDirectory) setFileEntries(response.entries);
      if (response.entries) {
        setChildrenByDir((prev) => (prev[directory] ? { ...prev, [directory]: response.entries } : prev));
      }

      if (documentSource === "remote") {
        setConnection((current) => ({ ...current, remotePath: createdPath }));
        adoptFileIntoTab({
          sourceKey: remoteSourceKey(connection),
          kind: "remote",
          path: createdPath,
          label: basename(createdPath),
          file: response.file
        });
        const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
        rememberSourceSession(
          buildRemoteSourceSession(connection, dirname(createdPath), createdPath, activeSession?.kind === "remote" ? activeSession.id : "")
        );
        setStatus((current) => ({ ...current, state: "connected", message: "Created remote file" }));
      } else {
        const sourceRoot = localWorkspaceDirectory || currentDirectory;
        setLocalFile({ path: response.file.path });
        adoptFileIntoTab({
          sourceKey: localSourceKey(sourceRoot),
          kind: "local",
          path: response.file.path,
          label: basename(response.file.path),
          file: response.file
        });
        const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
        if (activeSession?.kind === "local-folder") {
          rememberSourceSession(buildLocalFolderSourceSession(activeSession.rootPath || sourceRoot, directory, response.file.path, activeSession.id));
        } else {
          rememberSourceSession(buildLocalFileSourceSession(response.file.path, directory));
        }
        setStatus({ state: "idle", message: "Created local file", checkedAt: null, metadata: response.file.metadata });
      }

      setNewFileDialog({ open: false, directory: "" });
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function downloadRemoteEntry(entry) {
    if (!entry || entry.type === "directory") return false;
    setBusy(true);
    setError(null);
    try {
      const response = await remoteApi.downloadRemoteFile(entry.path);
      if (!response?.ok) {
        if (isConnectionLostError(response?.error)) {
          handleRemoteConnectionLoss(connectionLostMessage(connection.host));
        } else {
          const nextError = response?.error || { message: "Unable to download the remote file." };
          setError(nextError);
          setStatus((current) => ({ ...current, state: "error", message: nextError.message }));
        }
        return false;
      }
      if (!response.canceled) {
        setStatus((current) => ({ ...current, state: "connected", message: `Downloaded ${entry.name}` }));
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function copyEntryContents(entry) {
    if (!entry || entry.type === "directory") return false;
    if (documentSource === "sample" && entry.path === sampleEntry.path) {
      const ok = await copyCodeText(editorContent);
      if (ok) {
        setStatus((current) => ({ ...current, message: "Copied sample.md" }));
        showCopyNotice("Copied sample.md");
      }
      return ok;
    }

    const response = documentSource === "remote" ? await remoteApi.openFile(entry.path) : await remoteApi.readLocalFile(entry.path);
    if (!response?.ok) {
      if (documentSource === "remote" && isConnectionLostError(response?.error)) {
        handleRemoteConnectionLoss(connectionLostMessage(connection.host));
      } else {
        const nextError = response?.error || { message: "Unable to read the file." };
        setError(nextError);
        setStatus((current) => ({ ...current, state: "error", message: nextError.message }));
      }
      return false;
    }
    const ok = await copyCodeText(response.file.content);
    if (ok) {
      setStatus((current) => ({ ...current, message: `Copied ${entry.name}` }));
      showCopyNotice(`Copied ${entry.name}`);
    }
    return ok;
  }

  async function copyPathText(pathText) {
    if (!pathText) return false;
    const ok = await copyCodeText(pathText);
    if (ok) {
      setStatus((current) => ({ ...current, message: "Copied path" }));
      showCopyNotice("Copied path");
    }
    return ok;
  }

  function openContextMenuAt(x, y, items) {
    const actionableItems = items.filter(Boolean);
    if (actionableItems.length === 0) return;
    setContextMenu({
      x,
      y,
      items: actionableItems
    });
  }

  function openContextMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    openContextMenuAt(event.clientX, event.clientY, items);
  }

  function documentActionItems(selectedText = "") {
    return [
      selectedText && {
        label: "Copy selection",
        icon: Copy,
        onSelect: () => copySelectionText(selectedText)
      },
      selectedText && {
        label: "Find selection",
        icon: Search,
        onSelect: () => startFind(selectedText)
      },
      {
        label: "Copy all",
        icon: Copy,
        disabled: !canCopyDocument,
        onSelect: copyDocumentText
      },
      canDownloadDocument && {
        label: "Download",
        icon: Download,
        disabled: busy,
        onSelect: exportCurrentDocument
      },
      canCreateFile && {
        label: "New file",
        icon: FilePlus,
        disabled: busy,
        onSelect: () => openNewFileDialog(currentDirectory)
      }
    ];
  }

  function handleDocumentContextMenu(event, detail = {}) {
    const selectedText = normalizeSelectedText(detail.selectedText);
    openContextMenu(event, documentActionItems(selectedText));
  }

  function openDocumentActions(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenuAt(rect.right - 184, rect.bottom + 6, documentActionItems());
  }

  function handleFileContextMenu(event, entry) {
    if (!entry) return;
    const isDir = entry.type === "directory";
    const isRemoteTree = connected;
    const isLocalTree = !connected && documentSource === "local";
    const isSampleTree = !connected && documentSource === "sample";
    const canReadEntry = isRemoteTree || isLocalTree || isSampleTree;

    openContextMenu(event, [
      {
        label: isDir ? "Open folder" : "Open",
        icon: isDir ? Folder : File,
        disabled: busy || (!isDir && !entry.isMarkdown),
        onSelect: () => (isRemoteTree ? openEntry(entry) : isSampleTree ? openLocalSample() : openLocalEntry(entry))
      },
      isDir &&
        canCreateFile && {
          label: "New file here",
          icon: FilePlus,
          disabled: busy,
          onSelect: () => openNewFileDialog(entry.path)
        },
      isDir &&
        (isRemoteTree || isLocalTree) && {
          label: "Set as source root",
          icon: Folder,
          disabled: busy,
          onSelect: () => setDirectoryAsSource(entry.path)
        },
      !isDir && {
        label: "Copy contents",
        icon: Copy,
        disabled: busy || !entry.isMarkdown || !canReadEntry,
        onSelect: () => copyEntryContents(entry)
      },
      !isDir &&
        isRemoteTree && {
          label: "Download",
          icon: Download,
          disabled: busy || !entry.isMarkdown,
          onSelect: () => downloadRemoteEntry(entry)
        },
      {
        label: "Copy path",
        icon: Copy,
        onSelect: () => copyPathText(entry.path)
      }
    ]);
  }

  function handleSourceContextMenu(event, source) {
    if (!source) return;
    const session = source.session;

    openContextMenu(event, [
      source.kind === "remote-live" && {
        label: "Edit connection",
        icon: Settings,
        onSelect: () => setConnectionPaletteOpen(true)
      },
      source.kind === "remote-live" && {
        label: "Disconnect",
        icon: X,
        disabled: busy,
        onSelect: disconnect
      },
      source.kind === "sample" && {
        label: "Open",
        icon: Folder,
        disabled: busy || documentSource === "sample",
        onSelect: openLocalSample
      },
      session &&
        session.id !== activeSessionId && {
          label: "Open",
          icon: Folder,
          disabled: busy,
          onSelect: () => openSourceSession(session)
        },
      session?.kind === "remote" && {
        label: "Edit connection",
        icon: Settings,
        onSelect: () => editSourceSessionConnection(session)
      },
      session?.kind === "remote" &&
        session.id === activeSessionId && {
          label: "Disconnect",
          icon: X,
          disabled: busy,
          onSelect: disconnect
        },
      source.kind === "sample" && {
        label: "Close",
        icon: X,
        onSelect: closeSampleSource
      },
      session?.kind?.startsWith("local") &&
        session.id === activeSessionId && {
          label: "Close",
          icon: X,
          onSelect: closeLocalSource
        },
      session &&
        session.id !== activeSessionId && {
          label: "Forget",
          icon: X,
          onSelect: () => forgetSourceSession(session.id)
        },
      session?.title && {
        label: "Copy path",
        icon: Copy,
        onSelect: () => copyPathText(session.title)
      },
      source.kind === "remote-live" &&
        sourceLabel && {
          label: "Copy path",
          icon: Copy,
          onSelect: () => copyPathText(selectedPath || currentDirectory || sourceLabel)
      }
    ]);
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
    setActiveTabId(null);
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
    setActiveTabId(null);
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

    if (connected || localWorkspaceDirectory) {
      // Refresh in place: re-list the current browse root and any expanded
      // folders WITHOUT moving the source identity (localWorkspaceDirectory), so
      // open tabs survive a refresh even after drilling into a subfolder.
      const listDir = (dir) => (connected ? remoteApi.listDirectory(dir) : remoteApi.listLocalDirectory(dir));
      setTreeLoading(true);
      setError(null);
      try {
        const rootResponse = await listDir(currentDirectory);
        if (!rootResponse.ok) {
          if (connected && isConnectionLostError(rootResponse.error)) {
            handleRemoteConnectionLoss(connectionLostMessage(connection.host));
          } else {
            setError(rootResponse.error);
            setStatus((current) => ({ ...current, state: "error", message: rootResponse.error.message }));
          }
          return;
        }
        setFileEntries(rootResponse.entries);
        const expanded = [...expandedDirs];
        if (expanded.length) {
          const updates = {};
          for (const dir of expanded) {
            const childResponse = await listDir(dir);
            if (childResponse.ok) {
              updates[dir] = childResponse.entries;
            } else if (connected && isConnectionLostError(childResponse.error)) {
              // A drop while re-listing an expanded subfolder must trigger recovery,
              // not be silently swallowed (leaving a stale, dead tree with no prompt).
              handleRemoteConnectionLoss(connectionLostMessage(connection.host));
              return;
            }
            // A non-fatal single-folder error keeps the previously-cached children.
          }
          setChildrenByDir((prev) => ({ ...prev, ...updates }));
        }
        showTreeRefreshNotice("tree refreshed");
      } finally {
        setTreeLoading(false);
      }
      return;
    }

    if (!confirmDiscardEdits("reload the local sample")) return;
    const refreshed = await refreshLocalSample();
    if (refreshed) showTreeRefreshNotice("sample reloaded");
  }

  // Promote the folder currently shown in the tree to be the source root, so it
  // is remembered, displayed in Sources, and restored next time. Remote sources
  // are keyed by connection (tabs unaffected); local sources are keyed by their
  // directory, so re-key any open tabs onto the new root to keep them.
  async function setDirectoryAsSource(directory = currentDirectory) {
    if (!directory) return;

    if (directory !== currentDirectory) {
      setTreeLoading(true);
      setError(null);
      try {
        const response = connected
          ? await remoteApi.listDirectory(directory)
          : await remoteApi.listLocalDirectory(directory);
        if (!response.ok) {
          if (connected && isConnectionLostError(response.error)) {
            handleRemoteConnectionLoss(connectionLostMessage(connection.host));
          } else {
            setError(response.error);
            setStatus((current) => ({ ...current, state: "error", message: response.error.message }));
          }
          return;
        }
        setFileEntries(response.entries);
      } finally {
        setTreeLoading(false);
      }
    }

    if (connected) {
      setConnection((current) => ({ ...current, remoteDirectory: directory }));
      const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
      rememberSourceSession(
        buildRemoteSourceSession(connection, directory, "", activeSession?.kind === "remote" ? activeSession.id : "")
      );
      setCurrentDirectory(directory);
      showTreeRefreshNotice("source root set");
      return;
    }

    if (localWorkspaceDirectory) {
      const oldKey = localSourceKey(localWorkspaceDirectory);
      const newKey = localSourceKey(directory);
      if (oldKey !== newKey) {
        const activeTab = tabs.find((tab) => tab.id === activeTabId);
        setTabs((prev) => rekeyTabsForSource(prev, oldKey, newKey));
        if (activeTab && activeTab.sourceKey === oldKey) {
          setActiveTabId(tabId(newKey, activeTab.path));
        }
      }
      setLocalWorkspaceDirectory(directory);
      setCurrentDirectory(directory);
      const activeSession = sourceSessions.find((session) => session.id === activeSessionId);
      rememberSourceSession(
        buildLocalFolderSourceSession(directory, directory, "", activeSession?.kind === "local-folder" ? activeSession.id : "")
      );
      showTreeRefreshNotice("source root set");
    }
  }

  function setCurrentDirectoryAsSource() {
    void setDirectoryAsSource(currentDirectory);
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
        setCurrentDirectory(directory);
        setFileEntries(entriesResponse.ok ? entriesResponse.entries : []);
        adoptFileIntoTab({ sourceKey: localSourceKey(directory), kind: "local", path: fileResponse.file.path, label: basename(fileResponse.file.path), file: fileResponse.file });
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
        adoptFileIntoTab({ sourceKey: localSourceKey(directory), kind: "local", path: fileResponse.file.path, label: basename(fileResponse.file.path), file: fileResponse.file });
        setStatus({ state: "idle", message: "Restored local folder", checkedAt: null, metadata: fileResponse.file.metadata });
        rememberSourceSession(buildLocalFolderSourceSession(session.rootPath || directory, directory, fileResponse.file.path, session.id));
        return;
      }

      setLocalFile(null);
      setSelectedPath("");
      setActiveTabId(null);
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
  const onEditorChange = useCallback((valueOrEvent) => {
    const value = typeof valueOrEvent === "string" ? valueOrEvent : valueOrEvent?.target?.value ?? "";
    dispatchDocument({ type: "EDIT", value });
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
      // A drop mid-overwrite must tear down the session like saveCurrentFile does,
      // rather than leaving a raw error with the conflict banner stuck and the UI
      // still believing it is connected.
      if (documentSource === "remote" && isConnectionLostError(response?.error)) {
        handleRemoteConnectionLoss(connectionLostMessage(connection.host));
        return;
      }
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
      if (isConnectionLostError(response.error)) {
        handleRemoteConnectionLoss(connectionLostMessage(connection.host));
        return;
      }
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

  function startOutlineHover() {
    if (outlineHoverTimerRef.current) {
      window.clearTimeout(outlineHoverTimerRef.current);
      outlineHoverTimerRef.current = null;
    }
    setOutlineHovering(true);
  }

  function endOutlineHover() {
    if (outlineHoverTimerRef.current) window.clearTimeout(outlineHoverTimerRef.current);
    outlineHoverTimerRef.current = window.setTimeout(() => {
      setOutlineHovering(false);
      outlineHoverTimerRef.current = null;
    }, 280);
  }

  function jumpToHeading(heading, index) {
    if (!heading) return;

    function performScroll() {
      const pane = previewRef.current;
      if (!pane) return;
      let target = pane.querySelector(`#tether-h-${heading.line}`);
      // Fallback: headings render in document order, so the Nth outline entry maps
      // to the Nth rendered heading even if a line anchor is unavailable.
      if (!target && Number.isInteger(index)) {
        target = pane.querySelectorAll("h1,h2,h3,h4,h5,h6")[index] || null;
      }
      if (!target) return;
      const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 16;
      pane.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      setActiveHeadingId(heading.id);
    }

    if (viewMode === EDITOR_MODE_SOURCE) {
      // The inline surface must be mounted before an outline target can scroll.
      setViewMode(EDITOR_MODE_WYSIWYG);
      window.requestAnimationFrame(() => window.requestAnimationFrame(performScroll));
    } else {
      performScroll();
    }
  }

  function openSidebarFromRail() {
    if (compactLayout) {
      setSidebarPeeking(true);
      return;
    }
    setSidebarCollapsedPreference(false);
  }

  function toggleSidebarFromHeader() {
    // While peeking, the header button pins the flyout open (expands flush).
    if (sidebarPeeking) {
      setSidebarPeeking(false);
      if (!compactLayout) setSidebarCollapsedPreference(false);
      return;
    }
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
  openFileActionRef.current = () => {
    if (busy) return;
    setConnectionPaletteOpen(false);
    setSettingsPanelOpen(false);
    openLocalFile();
  };
  openFolderActionRef.current = () => {
    if (busy) return;
    setConnectionPaletteOpen(false);
    setSettingsPanelOpen(false);
    openLocalDirectory();
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
          onMouseEnter={() => {
            if (sidebarRailMode) setSidebarPeeking(true);
          }}
          onMouseLeave={() => setSidebarPeeking(false)}
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
              </div>
              <button
                className="icon-button compact panel-toggle"
                title={sidebarPeeking ? "Keep sidebar open" : headerToggleTitle}
                onClick={toggleSidebarFromHeader}
              >
                {sidebarPeeking ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
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
              onSourceContextMenu={handleSourceContextMenu}
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
              expandedDirs={expandedDirs}
              childrenByDir={childrenByDir}
              loadingDirs={loadingDirs}
              sampleSourceOpen={sampleSourceOpen}
              localFile={localFile}
              rootLabel={rootLabel}
              selectedPath={selectedPath}
              sourceLoading={Boolean(sourceOpening)}
              sourceLoadingMessage={sourceOpening?.message}
              sourceLoadingTitle={sourceOpening?.title}
              treeLoading={treeLoading}
              onOpenEntry={connected ? openEntry : openLocalEntry}
              onToggleDir={toggleDir}
              onEnterDir={enterDirectory}
              onSetSource={setCurrentDirectoryAsSource}
              onRefresh={refreshSidebarTree}
              onLoadSample={openLocalSample}
              onFileContextMenu={handleFileContextMenu}
            />

          </div>

          <div className="sidebar-rail">
            <button
              className="rail-brand"
              type="button"
              title={railToggleTitle}
              aria-label={railToggleTitle}
              onClick={openSidebarFromRail}
            >
              <TetherGlyph />
            </button>
            <div className="rail-divider" />
            <span className="rail-source-indicator" title={sourceLabel} aria-label={sourceLabel}>
              {connected ? <span className="status-dot pulse" /> : <Folder size={14} />}
            </span>
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
        />

      )}

      <main className={`workspace ${conflict && !zenMode ? "has-conflict" : ""}`}>
        {!zenMode && (
          <header className="document-toolbar">
            <div className="document-title" title={toolbarDocumentTitle}>
              <span className={`document-path ${documentSource === "none" ? "is-empty" : ""}`}>{toolbarDocumentLabel}</span>
              {dirty && <span className="dirty-dot" title="Unsaved changes" />}
            </div>
            <div className="toolbar-actions">
              {documentSource !== "none" && (
                <>
                  <button
                    className="icon-button compact toolbar-icon-action editor-mode-switch"
                    aria-label={viewMode === EDITOR_MODE_WYSIWYG ? "Open Markdown source" : "Return to inline editor"}
                    title={viewMode === EDITOR_MODE_WYSIWYG ? "Markdown source" : "Inline editor"}
                    onClick={() =>
                      setViewMode(viewMode === EDITOR_MODE_WYSIWYG ? EDITOR_MODE_SOURCE : EDITOR_MODE_WYSIWYG)
                    }
                  >
                    {viewMode === EDITOR_MODE_WYSIWYG ? <Code2 size={15} /> : <PenLine size={15} />}
                  </button>
                  <div className="toolbar-divider" />
                </>
              )}
              {documentSource === "remote" && (
                <>
                  <button
                    className={`icon-button compact toolbar-icon-action ${documentRefreshing ? "loading" : ""}`}
                    disabled={!canRefreshDocument || busy || documentRefreshing}
                    aria-busy={documentRefreshing}
                    aria-label={documentRefreshing ? "Refreshing current file" : "Refresh current file"}
                    onClick={refreshCurrentFile}
                    title={documentRefreshing ? "Refreshing current file" : "Refresh once"}
                  >
                    <RefreshCw size={13} />
                    <span className="action-label">{documentRefreshing ? "refreshing" : "refresh"}</span>
                  </button>
                  <button
                    className={`icon-button compact toolbar-icon-action watch-chip ${watching ? "active" : ""}`}
                    disabled={!connected || !selectedPath || busy}
                    aria-label={watching ? "Stop watching remote changes" : "Watch remote changes"}
                    onClick={toggleWatching}
                    title={watching ? "Stop watching" : "Watch remote changes"}
                  >
                    <span className={watching ? "status-dot pulse" : "status-dot"} />
                    <span className="action-label">{watching ? "watching" : "watch"}</span>
                  </button>
                </>
              )}
              {documentSource !== "none" && (
                <button
                  className={`icon-button compact ${findOpen ? "active" : ""}`}
                  type="button"
                  title="Find in document"
                  aria-label="Find in document"
                  aria-pressed={findOpen}
                  onClick={() => startFind()}
                >
                  <Search size={14} />
                </button>
              )}
              {documentSource !== "none" && (
                <button
                  className="save-button"
                  disabled={!canSave || busy}
                  onClick={saveCurrentFile}
                  title={canSave ? "Save" : "No changes to save"}
                  aria-label="Save current document"
                >
                  <Save size={13} />
                </button>
              )}
              {documentSource !== "none" && (
                <button
                  className="icon-button compact"
                  type="button"
                  title="Document actions"
                  aria-label="Document actions"
                  aria-haspopup="menu"
                  onClick={openDocumentActions}
                >
                  <MoreHorizontal size={14} />
                </button>
              )}
              {documentSource !== "none" && <div className="toolbar-divider" />}
              <button
                className="icon-button compact"
                type="button"
                title={`Theme: ${preferences.theme}${preferences.theme === "system" ? ` (${resolvedTheme})` : ""}`}
                aria-label="Cycle theme"
                onClick={() => {
                  const next = preferences.theme === "system" ? "dark" : preferences.theme === "dark" ? "light" : "system";
                  updatePreference("theme", next);
                }}
              >
                {preferences.theme === "system" ? <SunMoon size={14} /> : preferences.theme === "dark" ? <Moon size={14} /> : <Sun size={14} />}
              </button>
              {documentSource !== "none" && (
                <button
                  className={`icon-button compact ${outlineOpen || outlineHovering ? "active" : ""}`}
                  title="Document outline"
                  aria-label="Toggle document outline"
                  aria-pressed={outlineOpen}
                  onClick={() => setOutlineOpen((open) => !open)}
                  onMouseEnter={startOutlineHover}
                  onMouseLeave={endOutlineHover}
                >
                  <List size={14} />
                </button>
              )}
              {documentSource !== "none" && (
                <button className="icon-button compact" title="Zen reading" aria-label="Zen reading" onClick={() => setZenMode(true)}>
                  <Maximize2 size={14} />
                </button>
              )}
              <button className="icon-button compact" title="Settings" aria-label="Settings" onClick={() => setSettingsPanelOpen(true)}>
                <Settings size={14} />
              </button>
            </div>
          </header>
        )}

        {!zenMode && findOpen && documentSource !== "none" && (
          <FindBar
            activeIndex={findActiveIndex}
            inputRef={findInputRef}
            matchCount={findMatchCount}
            query={findQuery}
            onChange={updateFindQuery}
            onClose={() => setFindOpen(false)}
            onNext={() => moveFind(1)}
            onPrevious={() => moveFind(-1)}
          />
        )}

        {!zenMode && sourceTabs.length > 0 && (
          <TabStrip
            tabs={sourceTabs}
            activeTabId={activeTabId}
            activeDirty={dirty}
            onSelect={switchToTab}
            onClose={closeTab}
          />
        )}

        {conflict && !zenMode && (
          <div className="conflict-banner">
            <AlertTriangle size={14} />
            <span>
              <strong>conflict</strong> — {documentTitle} changed
              {connected && connection.host ? ` on ${connection.host}` : ""} while you were editing
            </span>
            <button disabled={busy} onClick={useLatestRemote}>take theirs</button>
            <button className="warn" disabled={busy} onClick={keepLocalEditsAndOverwrite}>
              keep mine — overwrite
            </button>
          </div>
        )}

        {documentSource === "none" && !zenMode && !sourceOpening ? (
          <ContentEmptyState
            onConnect={() => setConnectionPaletteOpen(true)}
            onOpenLocalFolder={openLocalDirectory}
          />
        ) : (
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
            dirty={dirty}
            documentId={activeTabId || `${documentSource}:${selectedPath || documentTitle}`}
            documentEyebrow={documentEyebrow}
            editorContent={editorContent}
            LoadingGlyph={TetherGlyph}
            loading={Boolean(sourceOpening)}
            loadingMessage={sourceOpening?.message}
            loadingTitle={sourceOpening?.title}
            onContextMenu={handleDocumentContextMenu}
            onEditorChange={onEditorChange}
            onNotice={showCopyNotice}
            onSearchResultCount={handleSearchResultCount}
            previewRef={previewRef}
            searchActiveIndex={findActiveIndex}
            searchQuery={findOpen ? findQuery : ""}
            sourceLabel={sourceLabel}
            textAlignment={preferences.textAlignment}
            viewMode={zenMode ? EDITOR_MODE_WYSIWYG : viewMode}
          />
        </React.Suspense>
        )}

        {!zenMode && (
          <StatusBar
            detached={documentSource === "none"}
            lineCount={lineCount}
            statusLabel={tetherPing?.message || statusLabel}
            syncLabel={syncLabel}
            tone={tetherPing?.tone || sourceTone}
            wordCount={wordCount}
          />
        )}

        {copyNotice && (
          <div className="copy-notice" role="status" aria-live="polite">
            {copyNotice}
          </div>
        )}

        {!zenMode && (outlineOpen || outlineHovering) && documentSource !== "none" && (
          <div
            className="outline-flyout"
            role="region"
            aria-label="Document outline"
            onMouseEnter={startOutlineHover}
            onMouseLeave={endOutlineHover}
          >
            <div className="outline-flyout-header">
              <span>outline</span>
              <button
                className="outline-flyout-close"
                type="button"
                title="Close outline"
                aria-label="Close outline"
                onClick={() => { setOutlineOpen(false); setOutlineHovering(false); }}
              >
                ×
              </button>
            </div>
            <OutlinePanel headings={outline} activeId={activeHeadingId} onJump={jumpToHeading} />
          </div>
        )}

        {zenMode && (
          <button className="zen-exit" onClick={() => setZenMode(false)} title="Exit zen — Esc">
            esc
          </button>
        )}
      </main>

      <ConnectionPalette
        busy={busy}
        connected={connected}
        connection={connection}
        connectionProfile={connectionProfile}
        currentDirectory={currentDirectory}
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
      <NewFileDialog
        busy={busy}
        directory={newFileDialog.directory}
        open={newFileDialog.open}
        onClose={() => setNewFileDialog({ open: false, directory: "" })}
        onCreate={createBlankFile}
      />
      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
    </div>
  );
}


function TabStrip({ tabs, activeTabId, activeDirty, onSelect, onClose }) {
  if (tabs.length === 0) return null;
  return (
    <div className="tab-strip" role="tablist" aria-label="Open documents">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const dirty = active ? activeDirty : Boolean(tab.doc && tab.doc.dirty);
        return (
          <div key={tab.id} className={`tab ${active ? "active" : ""}`} role="tab" aria-selected={active}>
            <button className="tab-label" type="button" title={tab.path} onClick={() => onSelect(tab.id)}>
              {dirty && <span className="tab-dirty" aria-hidden="true" />}
              <span>{tab.label}</span>
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${tab.label}`}
              title="Close tab"
              onClick={() => onClose(tab.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ContentEmptyState({ onConnect, onOpenLocalFolder }) {
  return (
    <div className="content-empty" role="region" aria-label="No source connected">
      <TetherGlyph dashed />
      <div className="content-empty-title">no source connected</div>
      <p className="content-empty-text">Connect to a host over SSH, or open a local folder to start reading.</p>
      <div className="content-empty-actions">
        <button className="empty-connect" type="button" onClick={onConnect}>
          {hotkey("k")} connect
        </button>
        <button className="empty-open" type="button" onClick={onOpenLocalFolder}>
          open local folder
        </button>
      </div>
    </div>
  );
}

function FindBar({ activeIndex, inputRef, matchCount, query, onChange, onClose, onNext, onPrevious }) {
  const activeLabel = query ? (matchCount ? `${wrapIndex(activeIndex, matchCount) + 1} / ${matchCount}` : "no matches") : "";

  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <Search size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        aria-label="Find text"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.shiftKey ? onPrevious() : onNext();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in document"
        spellCheck="false"
      />
      <span className={`find-count ${query && !matchCount ? "empty" : ""}`} aria-live="polite">
        {activeLabel}
      </span>
      <button type="button" className="icon-button compact" title="Previous match" aria-label="Previous match" onClick={onPrevious}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className="icon-button compact" title="Next match" aria-label="Next match" onClick={onNext}>
        <ChevronDown size={14} />
      </button>
      <button type="button" className="icon-button compact" title="Close find" aria-label="Close find" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

function ContextMenu({ menu, onClose }) {
  if (!menu) return null;
  const left = typeof window === "undefined" ? menu.x : Math.max(8, Math.min(menu.x, window.innerWidth - 196));
  const top = typeof window === "undefined" ? menu.y : Math.max(8, Math.min(menu.y, window.innerHeight - 240));

  return (
    <div
      className="context-menu"
      role="menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              if (!item.disabled) item.onSelect?.();
            }}
          >
            {Icon ? <Icon size={14} aria-hidden="true" /> : <span className="context-menu-spacer" aria-hidden="true" />}
            <span>{item.label}</span>
          </button>
        );
      })}
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

function normalizeFindQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeSelectedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function wrapIndex(index, count) {
  if (!count) return 0;
  return ((index % count) + count) % count;
}

function normalizeMarkdownFileName(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "untitled.md";
  const fileName = trimmed.split(/[\\/]/).filter(Boolean).pop() || "untitled.md";
  return /\.[A-Za-z0-9]+$/.test(fileName) ? fileName : `${fileName}.md`;
}

function joinBrowserPath(directory, fileName) {
  const base = String(directory || ".").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base || base === ".") return fileName;
  return `${base}/${fileName}`;
}

function saveTextAsBrowserDownload(content, defaultPath = "document.md") {
  try {
    const fileName = basename(defaultPath) || "document.md";
    const blob = new Blob([content || ""], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true, canceled: false, path: fileName };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "DOWNLOAD_FAILED",
        message: error?.message || "Unable to save the document."
      }
    };
  }
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
  const restoredRemotePath = session.selectedPath || session.directory || connection.remotePath || connection.remoteDirectory || "";
  return {
    ...defaultConnection,
    ...connection,
    password: "",
    passphrase: "",
    remotePath: restoredRemotePath,
    remoteDirectory: ""
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

// A stable key that groups open tabs by source (survives reconnects).
function remoteSourceKey(connection) {
  return getRemoteSourceSessionId(connection) || "remote";
}

function localSourceKey(directory) {
  return `local:${directory || "local"}`;
}

function sourceKeyFor(documentSource, connection, localWorkspaceDirectory, localFile) {
  if (documentSource === "remote") return remoteSourceKey(connection);
  if (documentSource === "local") {
    return localSourceKey(localWorkspaceDirectory || (localFile ? localDirname(localFile.path) : ""));
  }
  if (documentSource === "sample") return "sample";
  return "none";
}

function docFromFile(file) {
  return {
    content: file.content,
    editorContent: file.content,
    fileVersion: file.version,
    dirty: false,
    conflict: false,
    remoteShadow: null
  };
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
