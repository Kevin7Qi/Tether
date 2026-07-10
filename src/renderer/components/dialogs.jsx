import { useEffect, useRef, useState } from "react";
import { FilePlus, FileText, FolderOpen } from "lucide-react";
import { applyConnectionTarget, formatConnectionTarget } from "../lib/format.js";
import { useDialogFocus } from "../lib/useDialogFocus.js";
import { PAGE_WIDTH_MAX, PAGE_WIDTH_MIN, PAGE_WIDTH_STEP, clampPageWidth, hotkey } from "../lib/constants.js";

export function ConnectionPalette({
  busy,
  connected,
  connection,
  connectionProfile,
  currentDirectory,
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
  const dialogRef = useRef(null);
  useDialogFocus(open, dialogRef);
  if (!open) return null;

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <div
        className="connection-palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-palette-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="palette-header">
          <span id="connection-palette-title">{connected ? "edit connection" : "open / connect"}</span>
          <button className="esc-chip" type="button" onClick={onClose}>
            esc
          </button>
        </div>

        <div className="palette-scroll-body">
        <div className="target-input">
          <span>❯</span>
          {/* Uncontrolled: typing (e.g. the ":" before a path) is never eaten by
              the canonical re-format. It reseeds from defaultValue each time the
              palette opens, since the input remounts when `open` flips. When
              connected with no explicit path, seed with the folder being browsed
              so the line shows where you are, not just the host. */}
          <input
            defaultValue={formatConnectionTarget({
              ...connection,
              remotePath: connection.remotePath || (connected ? currentDirectory || "" : "")
            })}
            onChange={(event) => applyConnectionTarget(event.target.value, onUpdate)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || busy) return;
              event.preventDefault();
              onConnect();
            }}
            placeholder="user@host:/folder or /file.md — empty browses home"
            spellCheck="false"
          />
        </div>
        <p className="palette-helper">host aliases from ~/.ssh/config work · empty path browses from home</p>

        <div className="palette-section">
          <div className="palette-label">local</div>
          <div className="palette-local-actions">
            <button type="button" onClick={onOpenLocalDirectory}>
              <FolderOpen size={13} />
              open folder…
              <span className="palette-kbd">{hotkey("o", { shift: true })}</span>
            </button>
            <button type="button" onClick={onOpenLocalFile}>
              <FileText size={13} />
              open file…
              <span className="palette-kbd">{hotkey("o")}</span>
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
        </div>

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
            {connected ? "reconnect" : "connect"} ↵
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConnectionPanel({
  connected,
  connection,
  connectionProfile,
  defaultPrivateKeyPath,
  error,
  onChoosePrivateKey,
  onUpdate,
  status
}) {
  // Folded by default — the smart ❯ target input covers the common connect; the
  // section auto-opens only when there is an error to surface and correct.
  const [optionsOpen, setOptionsOpen] = useState(Boolean(error));

  // A connect error that arrives while the palette is already open should reveal
  // the fields so the user can correct them.
  useEffect(() => {
    if (error) setOptionsOpen(true);
  }, [error]);

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

      <details
        className="palette-disclosure"
        open={optionsOpen}
        onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
      >
        <summary>auth &amp; options</summary>
        <div className="disclosure-body">
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
            placeholder="Held in memory only — never written to disk"
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

      <Field label="Remote Path (folder or file)">
        <input
          value={connection.remotePath}
          autoComplete="off"
          onChange={(event) => onUpdate("remotePath", event.target.value)}
          placeholder="Optional: /srv/docs  or  /srv/docs/readme.md"
        />
      </Field>
        </div>
      </details>

      {connectionProfile && (
        <details className="palette-disclosure">
          <summary>
            <span className="diag-dot" aria-hidden="true" /> diagnostics
          </summary>
          <div className="disclosure-body">
            <ConnectionProfile profile={connectionProfile} />
          </div>
        </details>
      )}
    </section>
  );
}

export function SegmentedControl({ ariaLabel, options, value, onChange }) {
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

export function PageWidthControl({ value, onChange }) {
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

export function ConnectionProfile({ profile }) {
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

export function SettingsPanel({ open, preferences, onClose, onUpdate }) {
  const dialogRef = useRef(null);
  useDialogFocus(open, dialogRef);
  if (!open) return null;

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <div className="settings-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-panel-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="palette-header">
          <span id="settings-panel-title">settings</span>
          <button className="esc-chip" type="button" onClick={onClose}>
            esc
          </button>
        </div>

        <section className="settings-section">
          <div className="palette-label">appearance</div>

          <div className="settings-row">
            <strong className="settings-key">theme</strong>
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
            <strong className="settings-key">accent</strong>
            <div className="accent-picker" role="group" aria-label="Accent color">
              {[
                { label: "phosphor", value: "phosphor" },
                { label: "amber", value: "amber" },
                { label: "cobalt", value: "cobalt" }
              ].map((accent) => (
                <button
                  key={accent.value}
                  aria-label={`${accent.label} accent`}
                  aria-pressed={preferences.accent === accent.value}
                  className={`accent-option accent-${accent.value} ${preferences.accent === accent.value ? "active" : ""}`}
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
            <strong className="settings-key">reading font</strong>
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
            <strong className="settings-key">width</strong>
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

export function NewFileDialog({ busy, directory, open, onClose, onCreate }) {
  const dialogRef = useRef(null);
  const [name, setName] = useState("");
  useDialogFocus(open, dialogRef);

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  if (!open) return null;

  async function submit(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    const created = await onCreate(name);
    if (created) setName("");
  }

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <form
        className="new-file-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-file-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="palette-header">
          <span id="new-file-title">new file</span>
          <button className="esc-chip" type="button" onClick={onClose}>
            esc
          </button>
        </div>

        <div className="new-file-target" title={directory || ""}>
          <span>folder</span>
          <strong>{directory || "current folder"}</strong>
        </div>

        <label className="field">
          <span>file name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="notes.md"
            spellCheck="false"
          />
        </label>

        <div className="new-file-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="save-button" disabled={busy || !name.trim()}>
            <FilePlus size={13} />
            <span>create</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export function StatusBar({ detached, lineCount, statusLabel, syncLabel, tone, wordCount }) {
  const showDot = tone === "watching" || tone === "conflict" || tone === "error";
  const metrics = [`${wordCount}w`, `${lineCount}L`, "utf-8", syncLabel].filter(Boolean);
  // The metrics span is aria-hidden (its glyphs read poorly), so fold the metrics
  // into the footer's label to keep them available to assistive technology.
  const ariaLabel = detached ? `Status: ${statusLabel}` : `Status: ${[statusLabel, ...metrics].join("; ")}`;

  return (
    <footer className="status-bar" aria-label={ariaLabel} aria-live="polite">
      <span className="status-cluster">
        {showDot && <span className={`status-dot ${tone === "watching" ? "pulse" : ""} ${tone}`} />}
        <span className="status-primary">{statusLabel}</span>
      </span>
      <span className="status-spacer" />
      {!detached && (
        <span className="status-metrics" aria-hidden="true">
          {metrics.map((metric) => (
            <span className="status-metric" key={metric}>
              {metric}
            </span>
          ))}
        </span>
      )}
    </footer>
  );
}

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
