import { useRef } from "react";
import { FileText, FolderOpen, Monitor, Moon, Sun } from "lucide-react";
import { applyConnectionTarget, formatConnectionTarget } from "../lib/format.js";
import { useDialogFocus } from "../lib/useDialogFocus.js";
import { PAGE_WIDTH_MAX, PAGE_WIDTH_MIN, PAGE_WIDTH_STEP, clampPageWidth } from "../lib/constants.js";

export function ConnectionPalette({
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

export function ThemeSwitch({ value, resolvedTheme, onChange }) {
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

export function StatusBar({ lineCount, statusLabel, syncLabel, tone, wordCount }) {
  const showStatusDot = tone === "watching" || tone === "conflict" || tone === "error";
  const metrics = [`${wordCount}w`, `${lineCount}L`, "utf-8", syncLabel].filter(Boolean);

  return (
    <footer className="status-bar" aria-label={`Status: ${statusLabel}`} aria-live="polite">
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

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
