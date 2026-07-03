import { Fragment } from "react";
import { ArrowRight, ChevronRight, File, FileText, Folder, FolderOpen, Pin, RefreshCw, Settings } from "lucide-react";
import { canGoUp, formatSidebarDirectoryPath, localCanGoUp, localParentPath, parentRemotePath } from "../lib/paths.js";
import { statusTextForLoading } from "../lib/format.js";
import { hotkey } from "../lib/constants.js";

function FileTreeRows({ entries, depth, expandedDirs, childrenByDir, loadingDirs, selectedPath, onToggle, onOpen, onEnter, onContextMenu }) {
  return entries.map((entry) => {
    const isDir = entry.type === "directory";
    const expanded = isDir && expandedDirs.has(entry.path);
    const children = childrenByDir[entry.path];
    const indent = 6 + depth * 13;
    const unsupported = !isDir && !entry.isMarkdown;
    return (
      <Fragment key={entry.path}>
        <button
          className={`file-row tree-row ${entry.path === selectedPath ? "active" : ""} ${entry.name.startsWith(".") ? "muted" : ""} ${unsupported ? "disabled" : ""}`}
          style={{ paddingLeft: `${indent}px` }}
          aria-disabled={unsupported ? "true" : undefined}
          onClick={() => {
            if (unsupported) return;
            isDir ? onToggle(entry) : onOpen(entry);
          }}
          onContextMenu={(event) => onContextMenu?.(event, entry)}
          title={entry.path}
          aria-expanded={isDir ? expanded : undefined}
        >
          <span className="tree-twist" aria-hidden="true">
            {isDir ? <ChevronRight size={13} className={`tree-chevron ${expanded ? "open" : ""}`} /> : null}
          </span>
          {isDir ? <Folder size={15} /> : <File size={15} />}
          <span>{entry.name}</span>
          {isDir && loadingDirs.has(entry.path) ? (
            <RefreshCw size={12} className="tree-spin" />
          ) : isDir ? (
            <span
              className="tree-enter"
              role="button"
              tabIndex={-1}
              title="Open this folder as the root"
              aria-label={`Open ${entry.name} as the root folder`}
              onClick={(event) => {
                event.stopPropagation();
                onEnter(entry);
              }}
            >
              <ArrowRight size={13} />
            </span>
          ) : null}
        </button>
        {expanded && children && children.length > 0 && (
          <FileTreeRows
            entries={children}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            childrenByDir={childrenByDir}
            loadingDirs={loadingDirs}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onOpen={onOpen}
            onEnter={onEnter}
            onContextMenu={onContextMenu}
          />
        )}
        {expanded && children && children.length === 0 && (
          <div className="tree-empty" style={{ paddingLeft: `${indent + 14}px` }}>
            empty
          </div>
        )}
      </Fragment>
    );
  });
}

export function TetherGlyph({ dashed = false, pingKey = null }) {
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

export function DocumentSurfaceFallback({ loadingMessage, loadingTitle, previewRef }) {
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

export function SourcesPanel({
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
  onSourceContextMenu,
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
        <div
          className={`source-row ${documentSource === "remote" ? "active" : ""}`}
          aria-label="Remote source"
          onContextMenu={(event) => onSourceContextMenu?.(event, { kind: "remote-live" })}
        >
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
            ×
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
            onContextMenu={(event) => onSourceContextMenu?.(event, { kind: session.kind, session })}
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
                ×
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
                ×
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
                ×
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
          onContextMenu={(event) => onSourceContextMenu?.(event, { kind: "sample" })}
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
            ×
          </button>
        </div>
      )}
      <button className="source-row add-source" type="button" onClick={onOpenPalette}>
        <span className="source-icon">+</span>
        <span className="source-name">add source</span>
        <span className="source-kbd">{hotkey("k")}</span>
      </button>
    </section>
  );
}

export function OutlinePanel({ headings, activeId, onJump }) {
  if (headings.length === 0) {
    return <div className="outline-empty">no headings in this document</div>;
  }

  return (
    <div className="outline-list" aria-label="Document outline">
      {headings.map((heading, index) => (
        <button
          key={heading.id}
          type="button"
          className={`outline-row level-${heading.level} ${heading.id === activeId ? "active" : ""}`}
          style={{ paddingLeft: `${10 + (heading.level - 1) * 13}px` }}
          title={heading.text}
          aria-current={heading.id === activeId ? "true" : undefined}
          onClick={() => onJump(heading, index)}
        >
          <span>{heading.text}</span>
        </button>
      ))}
    </div>
  );
}

export function FilesPanel({
  connected,
  currentDirectory,
  documentSource,
  entries,
  expandedDirs,
  childrenByDir,
  loadingDirs,
  sampleSourceOpen,
  localFile,
  rootLabel,
  selectedPath,
  sourceLoading,
  sourceLoadingMessage,
  sourceLoadingTitle,
  treeLoading,
  onOpenEntry,
  onToggleDir,
  onEnterDir,
  onSetSource,
  onRefresh,
  onLoadSample,
  onFileContextMenu
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
          {(connected || showLocalTree) && (
            <button
              className="path-action"
              type="button"
              title="Set this folder as the source root"
              aria-label="Set this folder as the source root"
              onClick={onSetSource}
            >
              <Pin size={11} />
            </button>
          )}
          {canRefreshTree && (
            <button
              className={`path-action path-refresh ${treeLoading ? "loading" : ""}`}
              type="button"
              disabled={treeLoading}
              aria-busy={treeLoading}
              title="Refresh tree"
              aria-label="Refresh tree"
              onClick={onRefresh}
            >
              <RefreshCw size={11} />
            </button>
          )}
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
          <button
            className="file-row active"
            onClick={onLoadSample}
            onContextMenu={(event) =>
              onFileContextMenu?.(event, { name: "sample.md", path: "samples/sample.md", type: "file", isMarkdown: true })
            }
          >
            <FileText size={16} />
            <span>sample.md</span>
          </button>
        )}

        {!showSourceLoading && documentSource === "none" && <div className="empty-state">no files</div>}

        {!showSourceLoading && connected && canGoUp(currentDirectory) && (
          <button
            className="file-row tree-row"
            style={{ paddingLeft: "6px" }}
            onClick={() =>
              onEnterDir({
                name: "..",
                path: parentRemotePath(currentDirectory),
                type: "directory"
              })
            }
            onContextMenu={(event) =>
              onFileContextMenu?.(event, {
                name: "..",
                path: parentRemotePath(currentDirectory),
                type: "directory"
              })
            }
          >
            <span className="tree-twist" aria-hidden="true" />
            <FolderOpen size={15} />
            <span>..</span>
          </button>
        )}

        {!showSourceLoading && showLocalTree && localCanGoUp(currentDirectory) && (
          <button
            className="file-row tree-row"
            style={{ paddingLeft: "6px" }}
            onClick={() =>
              onEnterDir({
                name: "..",
                path: localParentPath(currentDirectory),
                type: "directory",
                isMarkdown: true
              })
            }
            onContextMenu={(event) =>
              onFileContextMenu?.(event, {
                name: "..",
                path: localParentPath(currentDirectory),
                type: "directory",
                isMarkdown: true
              })
            }
          >
            <span className="tree-twist" aria-hidden="true" />
            <FolderOpen size={15} />
            <span>..</span>
          </button>
        )}

        {!showSourceLoading && (connected || showLocalTree) && entries.length === 0 && (
          <div className="empty-state">{treeLoading ? "loading…" : "no files in this folder"}</div>
        )}

        {!showSourceLoading && (connected || showLocalTree) && (
          <FileTreeRows
            entries={entries}
            depth={0}
            expandedDirs={expandedDirs}
            childrenByDir={childrenByDir}
            loadingDirs={loadingDirs}
            selectedPath={selectedPath}
            onToggle={onToggleDir}
            onOpen={onOpenEntry}
            onEnter={onEnterDir}
            onContextMenu={onFileContextMenu}
          />
        )}
      </div>
    </section>
  );
}
