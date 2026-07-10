# Tether

Tether is a desktop WYSIWYG Markdown editor for documents that live locally or in an SSH/SFTP workspace. Markdown syntax stays underneath, but the default editing experience is the rendered document itself—closer to Typora than a source-and-preview tool.

The app is built for notes, project documentation, and reference material that should remain portable Markdown without pulling an entire remote repository onto the current machine.

## Highlights

- Open Markdown files from local disk, local folders, or SSH/SFTP.
- Browse remote and local folders from a persistent source sidebar.
- Write directly in the rendered document with inline formatting controls and slash commands.
- Edit tables, task lists, fenced code blocks, links, and LaTeX math in place.
- Switch to a line-numbered Markdown source view when exact syntax control is useful.
- Save the same Markdown back to local disk or SFTP.
- Watch remote files with SFTP polling and keep the last good render visible if refresh fails.
- Remember recently opened sources without storing passwords or private key contents.
- Resolve SSH config, common private key paths, and SSH agent auth in Auto mode.
- Package as a portable Windows app for direct use without a development server.

## Interface

Tether starts in a document-first layout: sources and files on the left, one editable document in the main pane, and compact controls in the top bar. `write` is the default inline editor; `md` is the raw Markdown escape hatch. The editor is loaded lazily so the source browser and app shell can become interactive first.

Select text to reveal formatting controls, type `/` on an empty line to insert a block, or use the document actions menu for copy and download operations. Zen mode keeps the inline editor and removes surrounding chrome.

## Install

```sh
npm install
```

## Development

Run the desktop app with the Vite renderer server:

```sh
npm run dev
```

The development server defaults to `http://127.0.0.1:3000`. Set `REMOTE_MD_PORT` to use another port.

Build the renderer:

```sh
npm run build
```

Run Electron against the built renderer:

```sh
npm start
```

Run backend tests:

```sh
npm run test:backend
```

## Portable Windows Build

Create a portable Windows package:

```sh
npm run package:win
```

The package is written to:

```text
release/Tether-win32-x64/Tether.exe
```

Keep the generated files in `release/Tether-win32-x64` together; `Tether.exe` depends on the adjacent Electron runtime files.

## SSH Usage

Tether supports password, private key, SSH config, and SSH agent authentication. In most cases, leave authentication set to Auto.

Auto mode can use:

- `Host`, `HostName`, `User`, `Port`, and `IdentityFile` entries from `~/.ssh/config`.
- Common key paths such as `~/.ssh/id_ed25519` and `~/.ssh/id_rsa`.
- The local SSH agent when available.

The remote Markdown path is optional. If it is blank, Tether connects to the SFTP working directory first and lets you browse from there.

## SSH Smoke Test

Run a read-only connection test:

```sh
REMOTE_MD_HOST=docs.example.com REMOTE_MD_USERNAME=deploy npm run ssh:smoke
```

Useful options:

- `REMOTE_MD_PATH`: read a specific Markdown file.
- `REMOTE_MD_FIND_MARKDOWN=1`: search the remote working directory for Markdown files.
- `REMOTE_MD_WATCH_ONCE=1`: verify one polling update.
- `REMOTE_MD_WRITE_PATH`: test save and restore against an existing test file.
- `REMOTE_MD_TEMP_WRITE=1`: create, verify, and delete a temporary remote Markdown file.

## Architecture

Tether keeps file access in the Electron main process and exposes a narrow IPC bridge to the renderer.

- `src/main/main.cjs`: Electron window, app lifecycle, native dialogs, IPC handlers, local file grants, and app state persistence.
- `src/main/preload.cjs`: renderer-safe API bridge.
- `src/main/remoteFileProvider.cjs`: SSH/SFTP connection, directory listing, stat, read, write, polling, SSH config resolution, and host key checks.
- `src/renderer/App.jsx`: React app shell, source/session state, sidebar, toolbar, settings, local/remote workflow, and document state.
- `src/renderer/DocumentSurface.jsx`: lazy boundary for inline/source modes, document search, outline anchors, and source editing.
- `src/renderer/WysiwygSurface.jsx`: Milkdown/Crepe lifecycle, controlled Markdown synchronization, and editor accessibility/failure handling.
- `src/shared/connectionLossConfig.json`: shared connection-loss definitions used by both Electron and the renderer.
- `src/renderer/styles.css`: application layout, themes, Markdown typography, editor styling, and responsive behavior.

## Security Model

- Passwords, passphrases, and private key contents are not persisted.
- Private key files are read only by the main process when connecting.
- The renderer receives file contents and metadata, not raw credentials.
- Local files and folders must be selected through the native picker before the app can reopen them.
- Remote host keys are checked with a trust-on-first-use workflow.
- External Markdown links open outside the app instead of navigating the Electron window.

## Status

Tether is under active development. The core local-file, remote-file, inline editing, source editing, saving, polling, conflict protection, and portable Windows packaging flows are implemented. The next major work areas are installer packaging, richer asset handling for pasted images, stronger conflict review, and optional remote watcher support.

## License

This repository is currently distributed without an open-source license. All rights are reserved unless a license file is added.
