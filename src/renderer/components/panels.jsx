import { File, FileText, Folder, FolderOpen, RefreshCw, Settings } from "lucide-react";
import { canGoUp, formatSidebarDirectoryPath, localCanGoUp, localParentPath, parentRemotePath } from "../lib/paths.js";
import { statusTextForLoading } from "../lib/format.js";

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

export function FilesPanel({
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
