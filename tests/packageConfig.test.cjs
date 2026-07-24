const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));

test("macOS packaging includes shared main-process runtime files", () => {
  assert.ok(packageJson.build.files.includes("src/shared/**"));
  assert.match(packageJson.scripts["package:mac"], /verify-mac-package\.cjs/);
});

test("Markdown files can open from the OS, app menu, or drag and drop", () => {
  const main = fs.readFileSync(path.join(root, "src", "main", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "main", "preload.cjs"), "utf8");
  const app = fs.readFileSync(path.join(root, "src", "renderer", "App.jsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");
  const associations = packageJson.build.fileAssociations?.[0];
  assert.deepEqual(associations?.ext, ["md", "markdown", "mdown", "mkd"]);
  assert.equal(associations?.role, "Editor");
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("open-file"/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /externalDocumentPathsFromArgv\(commandLine, workingDirectory\)/);
  assert.match(main, /externalDocumentPathsFromArgv\(process\.argv\.slice\(1\)\)/);
  assert.match(main, /mainWindow\.webContents\.send\("local:externalOpen", response\)/);
  assert.match(main, /ipcMain\.handle\("local:openDroppedFile"/);
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.match(preload, /onExternalOpen: \(callback\) => subscribeExternalOpen\(callback\)/);
  assert.match(preload, /externalOpenReady: \(\) => ipcRenderer\.send\("local:externalOpenReady"\)/);
  assert.match(app, /requestAnimationFrame\(\(\) => remoteApi\.externalOpenReady\(\)\)/);
  assert.match(app, /remoteApi\.onExternalOpen/);
  assert.match(app, /window\.addEventListener\("drop", onDrop\)/);
  assert.match(app, /Drop Markdown file to open/);
  assert.match(styles, /\.file-drop-overlay/);
});

test("real Electron editor verification keeps its windows hidden", () => {
  const main = fs.readFileSync(path.join(root, "src", "main", "main.cjs"), "utf8");
  const verifier = fs.readFileSync(path.join(root, "scripts", "verify-editor-parity.mjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "main", "preload.cjs"), "utf8");
  const markerVerifier = fs.readFileSync(
    path.join(root, "scripts", "verify-list-marker-alignment.mjs"),
    "utf8"
  );
  const backgroundElectron = fs.readFileSync(
    path.join(root, "scripts", "background-electron.mjs"),
    "utf8"
  );
  assert.match(main, /process\.env\.TETHER_EDITOR_PARITY === "1"/);
  assert.match(main, /setActivationPolicy\("accessory"\)/);
  assert.match(main, /process\.platform !== "darwin" \|\| editorParityRun/);
  assert.match(main, /!app\.isPackaged && !editorParityRun/);
  assert.match(main, /show:\s*!editorParityRun/);
  assert.match(main, /focusable:\s*!editorParityRun/);
  assert.match(main, /skipTaskbar:\s*editorParityRun/);
  assert.match(main, /hiddenInMissionControl:\s*editorParityRun/);
  assert.match(main, /backgroundThrottling:\s*!editorParityRun/);
  assert.match(main, /offscreen:\s*editorParityRun/);
  assert.match(verifier, /TETHER_EDITOR_PARITY:\s*"1"/);
  assert.match(verifier, /prepareBackgroundElectron\(electronPath\)/);
  assert.match(verifier, /TETHER_PARITY_WINDOWS_PER_PROCESS \|\| "0"/);
  assert.match(verifier, /maxWindowsPerElectronSession[\s\S]*?: 4;/);
  assert.match(verifier, /sessionWindowCount >= maxWindowsPerElectronSession/);
  assert.match(verifier, /async function stopSession\(force = false\)/);
  assert.match(verifier, /await stopSession\(true\)/);
  assert.match(verifier, /process\.exit\(exitCode\)/);
  assert.match(main, /ipcMain\.on\("test:resetEditorParity"/);
  assert.match(main, /ipcMain\.handle\("test:sendNativeKey"/);
  assert.match(main, /!editorParityRun/);
  assert.match(main, /createWindow\(\{ deferLoad: true \}\)/);
  assert.match(preload, /resetEditorParity: \(fixture\) => ipcRenderer\.send\("test:resetEditorParity", fixture\)/);
  assert.match(preload, /sendNativeKeyForTest: \(keyCode, modifiers\)/);
  assert.match(verifier, /connectRendererTarget\(outgoingTargetId\)/);
  assert.match(verifier, /window\.remoteMarkdown\.resetEditorParity/);
  assert.match(verifier, /window\.localStorage\.clear\(\)/);
  assert.match(verifier, /TETHER_PARITY_CASE === "source-selection-movement"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-extended-word-navigation"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-extended-vertical-navigation"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-option-vertical-navigation"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-shift-option-vertical-selection"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-native-noop-shortcuts"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-native-control-shortcuts"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "platform-native-shortcuts"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "platform-native-navigation"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "platform-native-option-navigation"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-editing-history"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "external-markdown-open"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "source-control-select-all"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "source-line-delete"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "source-word-delete"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "inline-source-tab"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "inline-source-line-jumps"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "inline-source-multiline-paste"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "inline-source-enter"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-boundary-deletion"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "prose-select-all-editing"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "structural-marker-navigation"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "block-atom-traversal"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "block-atom-cut-paste"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "multiline-code-block-layout"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "code-crlf-clipboard"/);
  assert.match(verifier, /TETHER_PARITY_CASE === "soft-line-editing"/);
  assert.match(verifier, /Soft-line Copy emitted/);
  assert.match(verifier, /Soft-line Cut emitted/);
  assert.match(verifier, /tetherGetLoadedSource/);
  assert.match(
    fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8"),
    /host\.tetherGetLoadedSource = getLoadedSource/
  );
  assert.match(backgroundElectron, /Add :LSBackgroundOnly bool true/);
  assert.match(backgroundElectron, /Add :LSUIElement bool true/);
  assert.match(backgroundElectron, /"--force", "--deep", "--sign", "-"/);
  assert.match(
    fs.readFileSync(path.join(root, "scripts", "run-background-electron.mjs"), "utf8"),
    /Background Electron exited/
  );
  assert.match(packageJson.scripts["verify:list-markers"], /run-background-electron\.mjs/);
  assert.match(markerVerifier, /setActivationPolicy\("accessory"\)/);
  assert.match(markerVerifier, /show:\s*false/);
  assert.match(markerVerifier, /focusable:\s*false/);
  assert.match(markerVerifier, /skipTaskbar:\s*true/);
  assert.match(markerVerifier, /hiddenInMissionControl:\s*true/);
  assert.match(markerVerifier, /backgroundThrottling:\s*false/);
});

test("file move and delete operations are bridged through guarded main-process APIs", () => {
  const main = fs.readFileSync(path.join(root, "src", "main", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "main", "preload.cjs"), "utf8");
  const app = fs.readFileSync(path.join(root, "src", "renderer", "App.jsx"), "utf8");
  const panels = fs.readFileSync(path.join(root, "src", "renderer", "components", "panels.jsx"), "utf8");
  assert.match(main, /ipcMain\.handle\("local:moveFile"/);
  assert.match(main, /ipcMain\.handle\("local:deleteFile"/);
  assert.match(main, /assertLocalPathGranted\(payload\.path, \{ markdownFile: true \}\)/);
  assert.match(main, /ipcMain\.handle\("remote:moveFile"/);
  assert.match(main, /ipcMain\.handle\("remote:deleteFile"/);
  assert.match(preload, /moveLocalFile: \(payload\) => ipcRenderer\.invoke\("local:moveFile", payload\)/);
  assert.match(preload, /deleteLocalFile: \(filePath\) => ipcRenderer\.invoke\("local:deleteFile", filePath\)/);
  assert.match(preload, /moveRemoteFile: \(payload\) => ipcRenderer\.invoke\("remote:moveFile", payload\)/);
  assert.match(preload, /deleteRemoteFile: \(remotePath\) => ipcRenderer\.invoke\("remote:deleteFile", remotePath\)/);
  assert.match(app, /label: "Move…"/);
  assert.match(app, /label: "Delete…"/);
  assert.match(app, /FILE_HAS_UNSAVED_EDITS/);
  assert.match(app, /session\.kind === "local-file"[\s\S]*title: movedPath[\s\S]*rootPath: localDirname\(movedPath\)/);
  assert.match(app, /if \(session\.kind === "local-file"\) return \[\]/);
  assert.match(app, /onFileActions=\{openFileActions\}/);
  assert.match(panels, /aria-label=\{`Actions for \$\{entry\.name\}`\}/);
  assert.match(panels, /onActions\?\.\(event, entry\)/);
});

test("file dialogs show full wrapping paths instead of truncating them", () => {
  const dialogs = fs.readFileSync(path.join(root, "src", "renderer", "components", "dialogs.jsx"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");
  assert.match(dialogs, /displayName \? "full path" : "folder"/);
  assert.match(dialogs, /export function MoveFileDialog/);
  assert.match(dialogs, /export function DeleteFileDialog/);
  assert.match(styles, /\.new-file-target strong\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s);
  assert.doesNotMatch(styles, /\.new-file-target strong\s*\{[^}]*text-overflow:\s*ellipsis/s);
});

test("Windows portable packaging includes shared main-process runtime files", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "package-win-portable.cjs"), "utf8");
  assert.match(source, /path\.join\(root, "src", "shared"\)/);
  assert.match(source, /path\.join\(appDir, "src", "shared"\)/);
});

test("packaged macOS builds keep the bundle icon instead of overriding it with a PNG", () => {
  const source = fs.readFileSync(path.join(root, "src", "main", "main.cjs"), "utf8");
  assert.match(source, /app\.dock && !app\.isPackaged/);
});

test("macOS menu history commands route into the focused renderer editor", () => {
  const main = fs.readFileSync(path.join(root, "src", "main", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "main", "preload.cjs"), "utf8");
  const app = fs.readFileSync(path.join(root, "src", "renderer", "App.jsx"), "utf8");
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.doesNotMatch(main, /role:\s*"editMenu"/);
  assert.match(main, /accelerator:\s*"CmdOrCtrl\+Z"/);
  assert.match(main, /accelerator:\s*"Shift\+CmdOrCtrl\+Z"/);
  assert.match(main, /sendEditorCommand\("undo", browserWindow\)/);
  assert.match(main, /webContents\.send\("editor:command", command\)/);
  assert.match(preload, /onEditorCommand: \(callback\) => subscribe\("editor:command", callback\)/);
  assert.match(app, /remoteApi\.onEditorCommand\(\(command\) =>/);
  assert.match(app, /window\.setTimeout\(\(\) =>[\s\S]*runHistoryCommand\?\.\(command\)[\s\S]*dispatchEditorHistoryCommand\(command\);[\s\S]*\}, 50\)/);
  assert.match(app, /dispatchEditorHistoryCommand\(command\)/);
  assert.match(app, /scheduleEditorHistoryFocusRestore\(document, historyTarget\)/);
  assert.match(surface, /runHistoryCommand: \(command\) =>[\s\S]*undoProseMirror[\s\S]*redoProseMirror/);
  assert.match(surface, /if \(!host\?\.isConnected\) return false/);
  assert.match(surface, /view\.dom\.tetherRunBoundaryHistory\?\.\(command\)/);
});

test("renderer bundles real italic faces while font synthesis is disabled", () => {
  const source = fs.readFileSync(path.join(root, "src", "renderer", "App.jsx"), "utf8");
  assert.match(source, /instrument-sans\/latin-400-italic\.css/);
  assert.match(source, /instrument-sans\/latin-600-italic\.css/);
  assert.match(source, /newsreader\/latin-400-italic\.css/);
  assert.match(source, /newsreader\/latin-600-italic\.css/);
});

test("document loading uses the centered preview-pane layout contract", () => {
  const source = fs.readFileSync(path.join(root, "src", "renderer", "DocumentSurface.jsx"), "utf8");
  const start = source.indexOf("function DocumentLoading");
  const end = source.indexOf("function hasHighlightApi", start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /document-grid mode-wysiwyg is-loading/);
});

test("WYSIWYG tables use content-driven columns instead of equal fixed widths", () => {
  const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(styles, /milkdown-table-block table\s*\{[^}]*table-layout:\s*auto/s);
  assert.match(styles, /table:not\(:has\(\[data-colwidth\]\)\) col\s*\{[^}]*width:\s*auto !important/s);
  assert.match(surface, /markdownSourceTargetFromPointer/);
  assert.match(surface, /mousedown", focusTableTextFromPointer, true/);
  assert.match(surface, /mousemove", updateTableDragSelection, true/);
});

test("fenced code blocks keep readable source typography and focused-only line feedback", () => {
  const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");
  const codeEditor = fs.readFileSync(path.join(root, "src", "renderer", "lib", "codeEditor.js"), "utf8");
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");

  assert.match(styles, /milkdown-code-block \.cm-scroller\s*\{[^}]*font-size:\s*13px[^}]*font-weight:\s*400/s);
  assert.match(styles, /milkdown-code-block \.cm-content\s*\{[^}]*min-height:\s*1\.62em/s);
  assert.match(styles, /milkdown-code-block \.cm-foldGutter\s*\{[^}]*display:\s*none !important/s);
  assert.match(styles, /milkdown-code-block\s*\{[^}]*padding:\s*4px 0 10px/s);
  assert.match(styles, /milkdown-code-block \.tools\s*\{[^}]*min-height:\s*24px/s);
  assert.match(styles, /cm-editor\.cm-focused \.cm-activeLine/);
  assert.match(styles, /\.tools button\.copy-button\s*\{[^}]*opacity:\s*0/s);
  assert.match(styles, /language-button\[data-expanded="true"\]\)\s*\{[^}]*overflow:\s*visible/s);
  assert.match(styles, /is-reading \.milkdown-code-block \.language-button svg\s*\{[^}]*display:\s*none/s);
  assert.match(codeEditor, /&\.cm-focused \.cm-activeLine/);
  assert.match(codeEditor, /indentUnit\.of\("\\t"\)/);
  assert.match(surface, /removeAttribute\("data-tether-fence"\)/);
  assert.match(surface, /renderLanguage: tetherCodeLanguageLabel/);
  assert.match(surface, /labelNode\.nodeValue = renderedLanguage/);
  assert.match(surface, /codeBoundaryNavigationKeyDirection/);
  assert.match(surface, /codeBoundaryNavigationPosition/);
  assert.match(surface, /codeOptionVerticalSelection/);
  assert.match(surface, /codeBoundaryWordJumpDirection/);
  assert.match(surface, /codeBoundaryDeletionKeyDirection/);
  assert.match(surface, /codeTabEdit/);
  assert.match(surface, /emptyCodeEnterSource/);
  assert.match(surface, /codeSourceOnlyHistoryDirection/);
  assert.match(surface, /undo as undoProseMirror/);
  assert.match(surface, /redo as redoProseMirror/);
  assert.match(surface, /fenceSourceSignature: codeSemanticSignature/);
  assert.match(surface, /node\.attrs\.frontmatterBlock/);
  assert.match(surface, /tether-frontmatter-block/);
  assert.match(surface, /control\.disabled = true/);
  assert.match(surface, /const codeBlock = enclosingCodeBlock/);
  assert.match(surface, /initialSelectionDirection: selectionMotion/);
  assert.match(surface, /codeBoundaryNavigationSourceOffset/);
  assert.match(surface, /continuousMarkdownSource/);
  assert.match(surface, /control\.setAttribute\("aria-disabled", "true"\)/);
  assert.match(surface, /draftEventTarget\.addEventListener\(markdownSourceDraftEvent, handleMarkdownSourceDraft\)/);
  assert.match(surface, /onChangeRef\.current\?\.\(markdown\)/);
  assert.doesNotMatch(surface, /feature\/block-edit/);
  assert.doesNotMatch(surface, /addFeature\(blockEdit/);
  assert.match(styles, /textarea\.tether-continuous-source\.is-code_block/);
  assert.match(surface, /use\(sourceFaithfulFenceRemark\)/);
  assert.match(surface, /use\(sourceFaithfulCodeBlockSchema\)/);
  assert.match(surface, /remove\(createCodeBlockInputRule\)/);
  assert.match(surface, /use\(sourceFaithfulCodeBlockInputRule\)/);
  assert.match(surface, /use\(sourceFaithfulCodeBlockEnterShortcut\)/);
  assert.match(surface, /use\(sourceFaithfulMathRemark\)/);
  assert.match(surface, /use\(sourceFaithfulInlineMathSchema\)/);
  assert.match(surface, /remove\(remarkHtmlTransformer\)/);
  assert.match(surface, /use\(renderedBlockHtmlRemark\)/);
  assert.match(surface, /use\(renderedBlockHtmlSchema\)/);
  assert.match(surface, /use\(renderedInlineHtmlRemark\)/);
  assert.match(surface, /use\(renderedInlineHtmlSchema\)/);
  assert.match(styles, /\.tether-html-block\.is-rendered/);
  assert.match(styles, /\.tether-html-block-literal/);
  assert.match(styles, /kbd\[data-md-html-inline\]/);
  assert.match(surface, /use\(sourceFaithfulFootnoteRemark\)/);
  assert.match(surface, /use\(sourceFaithfulFootnoteDefinitionSchema\)/);
  assert.match(surface, /use\(sourceFaithfulFootnoteReferenceSchema\)/);
  assert.match(styles, /dl\[data-type="footnote_definition"\]/);
  assert.match(surface, /use\(sourceFaithfulParagraphRemark\)/);
  assert.match(surface, /use\(sourceFaithfulParagraphSchema\)/);
  assert.match(surface, /use\(sourceFaithfulBlockquoteRemark\)/);
  assert.match(surface, /use\(sourceFaithfulBlockquoteSchema\)/);
  assert.match(surface, /use\(sourceFaithfulAttentionRemark\)/);
  assert.match(surface, /use\(sourceFaithfulEmphasisSchema\)/);
  assert.match(surface, /use\(sourceFaithfulStrongSchema\)/);
  assert.match(surface, /use\(serializationAttentionGroupSchema\)/);
  assert.match(surface, /use\(sourceFaithfulAttentionSerializer\)/);
  assert.match(surface, /use\(sourceFaithfulHeadingRemark\)/);
  assert.match(surface, /use\(sourceFaithfulHeadingSchema\)/);
  assert.match(surface, /use\(sourceFaithfulHeadingBackspaceKeymap\)/);
  assert.match(styles, /data-md-heading-style="setext"/);
  assert.match(surface, /use\(sourceFaithfulRuleRemark\)/);
  assert.match(surface, /use\(sourceFaithfulRuleSchema\)/);
  assert.match(surface, /use\(sourceFaithfulHardBreakRemark\)/);
  assert.match(surface, /use\(sourceFaithfulHardBreakSchema\)/);
  assert.match(surface, /remove\(remarkLineBreak\)/);
  assert.match(surface, /use\(sourceFaithfulInlineCodeRemark\)/);
  assert.match(surface, /use\(sourceFaithfulInlineCodeSchema\)/);
  assert.match(surface, /remove\(strikethroughInputRule\)/);
  assert.match(surface, /use\(sourceFaithfulStrikeRemark\)/);
  assert.match(surface, /use\(sourceFaithfulStrikeSchema\)/);
  assert.match(surface, /use\(sourceFaithfulStrikeInputRule\)/);
  assert.match(surface, /use\(sourceFaithfulTableRemark\)/);
  assert.match(surface, /use\(sourceFaithfulTableSchema\)/);
  assert.match(surface, /remove\(remarkInlineLinkPlugin\)/);
  assert.match(surface, /use\(sourceFaithfulReferenceRemark\)/);
  assert.match(surface, /use\(sourceFaithfulReferenceLinkSchema\)/);
  assert.match(surface, /use\(sourceFaithfulReferenceImageSchema\)/);
  assert.match(surface, /use\(sourceFaithfulReferenceDefinitionSchema\)/);
  assert.match(surface, /use\(sourceFaithfulReferenceSyncPlugin\)/);
  assert.match(surface, /use\(sourceFaithfulBulletRemark\)/);
  assert.match(surface, /use\(sourceFaithfulBulletListSchema\)/);
  assert.match(surface, /use\(sourceFaithfulOrderedListSchema\)/);
  assert.match(surface, /use\(sourceFaithfulOrderedParenInputRule\)/);
  assert.match(surface, /use\(sourceFaithfulTaskListItemSchema\)/);
  assert.match(surface, /use\(sourceFaithfulListItemView\)/);
  assert.match(surface, /use\(sourceFaithfulUpperTaskInputRule\)/);
  assert.match(surface, /use\(sourceFaithfulBulletInputPlugin\)/);
  assert.match(surface, /use\(sourceFaithfulOrderedListSplitKeymap\)/);
});

test("long inline Markdown source stays inside the document column", () => {
  const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");
  assert.match(styles, /input\.tether-continuous-source\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s);
});

test("rendered lists use compact indentation and intentional marker colors", () => {
  const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");
  assert.match(styles, /\.ProseMirror ul,\s*\.tether-wysiwyg \.ProseMirror ol\s*\{[^}]*padding-inline-start:\s*0/s);
  assert.match(styles, /\.ProseMirror ul,\s*\.tether-wysiwyg \.ProseMirror ol\s*\{[^}]*--tether-list-item-gap:\s*2px/s);
  assert.match(styles, /\.ProseMirror ol:has\([\s\S]*data-marker-digits="9"[\s\S]*\)\s*\{[^}]*--tether-list-item-gap:\s*28px/s);
  assert.match(styles, /\.milkdown-list-item-block > \.list-item\s*\{[^}]*--tether-list-marker-width:\s*18px[^}]*--tether-list-line-height:\s*1\.72em[^}]*gap:\s*var\(--tether-list-item-gap, 2px\)[^}]*list-style:\s*none/s);
  assert.match(styles, /\.label-wrapper,\s*\.tether-wysiwyg \.ProseMirror \.milkdown-list-item-block \.label\s*\{[^}]*width:\s*var\(--tether-list-marker-width\)/s);
  assert.match(styles, /\.label-wrapper\s*\{[^}]*height:\s*var\(--tether-list-line-height\)[^}]*flex:\s*0 0 var\(--tether-list-marker-width\)[^}]*align-items:\s*center/s);
  assert.match(styles, /\.milkdown-list-item-block li \.label-wrapper \.label\s*\{[^}]*height:\s*100%[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*padding:\s*0[^}]*text-align:\s*center[^}]*line-height:\s*1[^}]*translateY\(var\(--tether-list-marker-shift, 2px\)\)/s);
  assert.match(styles, /\.label\.bullet,\s*\.tether-wysiwyg \.ProseMirror \.milkdown-list-item-block \.label\.ordered\s*\{[^}]*color:\s*var\(--ink\)/s);
  assert.match(styles, /\.milkdown-list-item-block \.label svg\s*\{[^}]*display:\s*block[^}]*width:\s*16px[^}]*height:\s*16px/s);
  assert.match(styles, /\.label\.ordered\s*\{[^}]*justify-content:\s*center[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(styles, /\.label\.ordered\s*\{[^}]*--tether-list-marker-shift:\s*2\.1px/s);
  assert.match(styles, /\.label\.ordered\s*\{[^}]*width:\s*max-content[^}]*min-width:\s*var\(--tether-list-marker-width\)[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(styles, /--tether-list-marker-scale|scaleX\(/);
  assert.match(styles, /\.list-item:has\(\s*> \.label-wrapper > \.label\.checked\s*\) > \.children > \.content-dom > :not\(ul, ol\)\s*\{[^}]*text-decoration:\s*line-through/s);
  assert.doesNotMatch(styles, /\.list-item:has\(\.label\.checked\) \.content-dom/);
});

test("CodeMirror document jumps are bridged through the source-faithful document mapping", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(surface, /const handleCodeDocumentJump = \(event\) =>/);
  assert.match(surface, /sourceDocumentJumpEdge\(event\)/);
  assert.match(surface, /documentSourceOffsetAtPosition\(/);
  assert.match(surface, /applyDocumentSourceJump\(view, event, serializer, sourceHead, sourceAnchor\)/);
  assert.match(surface, /addEventListener\("keydown", handleCodeDocumentJump, true\)/);
  assert.match(surface, /removeEventListener\("keydown", handleCodeDocumentJump, true\)/);
});

test("CodeMirror word jumps enter hidden fence source with exact Shift selection", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(surface, /const handleCodeWordJump = \(event\) =>/);
  assert.match(surface, /sourceWordOffset\(source, currentOffset, direction\)/);
  assert.match(surface, /sourceWordSelectionRange\(anchorOffset, targetOffset\)/);
  assert.match(surface, /addEventListener\("keydown", handleCodeWordJump, true\)/);
  assert.match(surface, /removeEventListener\("keydown", handleCodeWordJump, true\)/);
});

test("CodeMirror line-edge jumps enter hidden indented and empty-fence source", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(surface, /const handleCodeLineJump = \(event\) =>/);
  assert.match(surface, /const lineEdge = sourceLineJumpEdge\(event\)/);
  assert.match(surface, /codeLineStartSourceOffset\(/);
  assert.match(surface, /codeLineEndSourceOffset\(source, codeBlock\.node\.textContent\)/);
  assert.match(surface, /sourceWordSelectionRange\(anchorOffset, targetOffset\)/);
  assert.match(surface, /addEventListener\("keydown", handleCodeLineJump, true\)/);
  assert.match(surface, /removeEventListener\("keydown", handleCodeLineJump, true\)/);
});

test("CodeMirror text insertion at an immediate closing fence edits literal Markdown source", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(surface, /const replaceCodeSourceOnlyInsertion = \(event, replacement\) =>/);
  assert.match(surface, /emptyCodeClosingFenceSourceOffset\(source, codeBlock\.node\.textContent\)/);
  assert.match(surface, /documentSourceUnitStartOffset\(view\.state, unit, serializer\)/);
  assert.match(surface, /replaceSourceSelectionTransaction\(/);
  assert.match(surface, /codeSourceOnlyHistory = \{/);
  assert.match(surface, /afterContent: afterCodeBlock\.node\.textContent/);
  assert.match(surface, /const handleCodeSourceOnlyBeforeInput = \(event\) =>/);
  assert.match(surface, /const handleCodeSourceOnlyTransfer = \(event\) =>/);
  assert.match(surface, /addEventListener\("beforeinput", handleCodeSourceOnlyBeforeInput, true\)/);
  assert.match(surface, /addEventListener\("paste", handleCodeSourceOnlyTransfer, true\)/);
  assert.match(surface, /addEventListener\("drop", handleCodeSourceOnlyTransfer, true\)/);
  assert.match(surface, /removeEventListener\("beforeinput", handleCodeSourceOnlyBeforeInput, true\)/);
  assert.match(surface, /removeEventListener\("paste", handleCodeSourceOnlyTransfer, true\)/);
  assert.match(surface, /removeEventListener\("drop", handleCodeSourceOnlyTransfer, true\)/);
});

test("CodeMirror clipboard operations use physical Markdown source ranges", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(surface, /const handleCodeSourceClipboard = \(event\) =>/);
  assert.match(surface, /documentSourceOffsetAtPosition\([\s\S]*selection\.anchor/);
  assert.match(surface, /documentSourceOffsetAtPosition\([\s\S]*selection\.head/);
  assert.match(surface, /event\.clipboardData\.setData\("text\/plain", selectedText\)/);
  assert.match(surface, /tetherReplaceExactSourceSelection\?\.\(sourceSelection, ""\)/);
  assert.match(surface, /addEventListener\("copy", handleCodeSourceClipboard, true\)/);
  assert.match(surface, /addEventListener\("cut", handleCodeSourceClipboard, true\)/);
  assert.match(surface, /removeEventListener\("copy", handleCodeSourceClipboard, true\)/);
  assert.match(surface, /removeEventListener\("cut", handleCodeSourceClipboard, true\)/);
});

test("CodeMirror plain-text paste uses canonical Markdown source history", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(surface, /const replaceCodeSourceTransfer = \(event, replacement\) =>/);
  assert.match(surface, /documentSourceOffsetAtPosition\([\s\S]*codeContentSourcePosition\(codeBlock\.position, selection\.anchor\)/);
  assert.match(surface, /tetherReplaceExactSourceSelection\?\.\(sourceSelection, replacement\)/);
  assert.match(surface, /replaceCodeSourceOnlyInsertion\(event, text\)[\s\S]*replaceCodeSourceTransfer\(event, text\)/);
  assert.match(syntax, /const replaceExactSourceSelection = \(sourceSelection, replacement\) =>/);
  assert.match(syntax, /dispatchExactEdit\([\s\S]*\{ isolatedHistory: true \}/);
  assert.match(syntax, /tetherReplaceExactSourceSelection = replaceExactSourceSelection/);
});

test("extended CodeMirror selections continue through physical fence source", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(surface, /codeBoundaryWordJumpDirection\(codeView\.state, event\)/);
  assert.doesNotMatch(surface, /!selection\.empty && !event\.shiftKey/);
  assert.match(surface, /codeContentSourcePosition\(codeBlock\.position, selection\.anchor\)/);
  assert.match(surface, /if \(!codeSelection\.empty\)[\s\S]*sourceSelectionRangeAfterMotion\(/);
  assert.match(surface, /initialSourceSelection[\s\S]*activateMarkdownSourceAt/);
  assert.match(surface, /isEditorSelectAllShortcut\(event\)[\s\S]*activateDocumentSourceSelection\([\s\S]*new AllSelection/);
});

test("code history changes restore the same embedded editor focus", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  const codeEditor = fs.readFileSync(path.join(root, "src", "renderer", "lib", "codeEditor.js"), "utf8");
  assert.match(codeEditor, /EditorView\.domEventHandlers\(\{[\s\S]*isEditorHistoryShortcut\(event\)[\s\S]*restoreCodeViewFocusAfterHistory\(codeView\)/);
  assert.match(surface, /addEventListener\("focusin", rememberCodeFocus, true\)/);
  assert.match(surface, /removeEventListener\("focusin", rememberCodeFocus, true\)/);
  assert.match(surface, /listener\.markdownUpdated\([\s\S]*scheduleCodeFocusRestore\(lastFocusedCodeTarget\)/);
  assert.match(surface, /tetherRunBoundaryHistory\?\.\(direction\)[\s\S]*settleCodeHistoryFocus\(view, false\)/);
  assert.match(surface, /lastFocusedCodeTarget[\s\S]*!historyCommandPending[\s\S]*!activeDocumentSourceSelection\(currentView\?\.state\)/);
  assert.match(surface, /activeDocumentSourceSelection\(view\.state\)[\s\S]*lastFocusedCodeTarget = null;[\s\S]*view\.dom\.focus\(\)/);
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /const deleteExactSource = \(view, direction, mode = "character"\) =>[\s\S]*\{ isolatedHistory: true \}/);
  assert.match(syntax, /addEventListener\("keydown", captureExactDeletion, true\)/);
  assert.match(syntax, /view\.dom\.tetherRunBoundaryHistory = runBoundaryHistory/);
  assert.match(syntax, /delete view\.dom\.tetherRunBoundaryHistory/);
  assert.match(
    syntax,
    /editor\.closest\("\.ProseMirror"\)\?\.tetherRunBoundaryHistory\?\.\(command\)/
  );
});

test("macOS source-native no-op shortcuts are intercepted before structured editor keymaps", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  const codeEditor = fs.readFileSync(path.join(root, "src", "renderer", "lib", "codeEditor.js"), "utf8");
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(codeEditor, /export function isMacSourceControlNoopShortcut\(/);
  assert.match(codeEditor, /export function isMacSourceNativeNoopShortcut\(/);
  assert.match(surface, /const handleSourceNativeNoopShortcut = \(event\) =>/);
  assert.match(surface, /isMacSourceNativeNoopShortcut\(event\)/);
  assert.match(surface, /addEventListener\("keydown", handleSourceNativeNoopShortcut, true\)/);
  assert.match(surface, /removeEventListener\("keydown", handleSourceNativeNoopShortcut, true\)/);
  assert.match(syntax, /if \(isMacSourceNativeNoopShortcut\(event\)\)[\s\S]*event\.preventDefault\(\)/);
});

test("exact source selections capture copy and cut before DOM reconciliation", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /const capturedExactClipboardEvents = new WeakSet\(\)/);
  assert.match(syntax, /const captureExactClipboard = \(event\) =>/);
  assert.match(syntax, /sourceSelectionText\(sourceSelection\)/);
  assert.match(syntax, /sourceClipboardEdit\([\s\S]*sourceSelection/);
  assert.match(syntax, /addEventListener\("copy", captureExactClipboard, true\)/);
  assert.match(syntax, /addEventListener\("cut", captureExactClipboard, true\)/);
  assert.match(syntax, /removeEventListener\("copy", captureExactClipboard, true\)/);
  assert.match(syntax, /removeEventListener\("cut", captureExactClipboard, true\)/);
  assert.match(syntax, /if \(capturedExactClipboardEvents\.has\(event\)\) return true/);
  assert.match(syntax, /queueMicrotask\(\(\) => \{[\s\S]*dispatchExactEdit\(/);
  assert.match(syntax, /normalizeEmptyMarkdownDocument\(parser\(nextSource\), nextSource\)/);
  assert.match(syntax, /normalizeEmptyMarkdownDocument\([\s\S]*ctx\.get\(parserCtx\)\(step\.source\),[\s\S]*step\.source/);
});

test("multi-click activation carries word and line selection into raw Markdown controls", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /pointerClickCount: Math\.max\(1, Number\(event\?\.detail\) \|\| 1\)/);
  assert.match(syntax, /initialPointerSelection: target\.pointerClickCount \?\? 1/);
  assert.match(syntax, /sourcePointerSelectionRange\(/);
  assert.match(syntax, /pointerClickCount = Math\.max\(continuedClickCount, event\.detail\)/);
  assert.match(syntax, /sourcePointerSelectionRange\(editor\.value, caret, pointerClickCount\)/);
  assert.match(syntax, /editor\.setSelectionRange\(/);
});

test("temporary Markdown source controls hand document jumps back to the full source map", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(syntax, /const documentJumpEdge = sourceDocumentJumpEdge\(event\)/);
  assert.match(
    syntax,
    /finishKeyboardHandoff\([\s\S]*onDocumentJump\(shortcut, sourceSelection, mapping\)/
  );
  assert.match(syntax, /const jumpFromSource = \(event, localSelection, mapping = null\) =>/);
  assert.match(syntax, /baseOffset \+ localSelection\.head/);
  assert.match(syntax, /baseOffset \+ localSelection\.anchor/);
  assert.match(syntax, /meta\?\.action === "source-selection"[\s\S]*pendingActivation = false/);
  assert.match(syntax, /focusProseMirrorRoot\(view\)[\s\S]*view\.focus\(\)/);
  assert.match(syntax, /if \(target\.kind === "gap"\)[\s\S]*dispatchFocusedSourceSelection\(/);
  assert.match(
    syntax,
    /transaction\.selectionSet[\s\S]*pluginState\.sourceSelection[\s\S]*return pluginState/
  );
  assert.match(
    syntax,
    /mousedown\(view, event\)[\s\S]*sourceSelection[\s\S]*setMeta\(markdownSyntaxKey, "close"\)/
  );
  assert.match(syntax, /const finishKeyboardHandoff = [\s\S]*finish\(commit, afterFinish, true\)/);
  assert.match(syntax, /finishKeyboardHandoff\(true, \(mapping\) => \{[\s\S]*onBoundaryNavigate/);
  assert.match(syntax, /const sameType = documentSource\.segments[\s\S]*candidate\.node\.type\.name === unit\.name/);
  assert.match(syntax, /mappedNode\?\.type\.name === unit\.name[\s\S]*mappedFrom \+ mappedNode\.nodeSize/);
  assert.match(syntax, /const boundaryGap = unit\.kind === "block"[\s\S]*documentSourceUnitBoundaryGapTarget/);
  assert.match(syntax, /documentSourceUnitBoundaryGapTarget\([\s\S]*source\.length/);
  assert.match(syntax, /transaction\.setMeta\(markdownSyntaxKey, \{ action: "exact-source-edit" \}\)/);
  assert.match(syntax, /\["smart-input", "exact-source-edit"\]\.includes/);
  assert.match(syntax, /exactSourceDispatchDepth \+= 1[\s\S]*view\.dispatch[\s\S]*exactSourceDispatchDepth -= 1/);
  assert.match(syntax, /appendTransaction[\s\S]*if \(exactSourceDispatchDepth > 0\) return null/);
  assert.match(
    syntax,
    /shouldRejectStaleExactSourceReplacement\([\s\S]*protectedExactSource[\s\S]*serializer/
  );
  assert.match(surface, /function replaceAllMarkdown[\s\S]*setMeta\(externalMarkdownTransactionMeta, true\)/);
});

test("temporary Markdown source controls keep extended selections exact across their boundaries", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /inlineSourceBoundarySelectionDirection\([\s\S]*editor\.selectionDirection/);
  assert.match(syntax, /const localSelection = lineJumpEdge[\s\S]*\|\| wordJumpDirection[\s\S]*\|\| verticalDirection[\s\S]*\|\| boundarySelectionDirection[\s\S]*sourceInputSelection\(/);
  assert.match(syntax, /onBoundarySelect\([\s\S]*localSelection/);
  assert.match(syntax, /const selectFromBoundary = \(direction, localSelection, mapping = null\) =>/);
  assert.match(syntax, /sourceSelectionAcrossUnitBoundary\([\s\S]*action: "source-selection"/);
  assert.match(syntax, /blockSourceBoundarySelectionDirection\([\s\S]*editor\.selectionDirection/);
  assert.match(syntax, /verticalColumn/);
});

test("temporary Markdown source controls continue Option-word navigation across their boundaries", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /const wordJumpDirection = lineJumpEdge \? null : sourceInputWordJumpDirection\(/);
  assert.match(syntax, /onWordJump\([\s\S]*localSelection/);
  assert.match(syntax, /const wordJumpFromSource = \(/);
  assert.match(syntax, /sourceWordSelectionAcrossUnitBoundary\(/);
  assert.match(syntax, /documentPositionAtSourceOffset\(/);
  assert.match(syntax, /focusExactEditSelection\(editorView\)/);
});

test("temporary Markdown source controls bridge pointer drags into rendered prose", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /pointerDragWindow\?\.addEventListener\("mouseup", handlePointerDragEnd, true\)/);
  assert.match(syntax, /finish\(true, \(mapping\) => onPointerDrag\(localAnchor, pointer, mapping\)\)/);
  assert.match(syntax, /const dragFromSource = \(localAnchor, event, mapping = null\) =>/);
  assert.match(syntax, /documentSourceOffsetFromPointerTarget\(/);
  assert.match(syntax, /sourcePointerDragSelection\(/);
  assert.match(syntax, /action: "source-selection"/);
});

test("exact source-only selections own line and word jump commands", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /const navigateExactSourceSelection = \(view, event\) =>/);
  assert.match(syntax, /navigationWindow\?\.addEventListener\("keydown", captureExactNavigation, true\)/);
  assert.match(syntax, /export function applyDocumentSourceWordJump\([\s\S]*sourceSelectionWordJump\(/);
  assert.match(syntax, /const lineJumpEdge = sourceLineJumpEdge\(event\);[\s\S]*sourceSelectionLineJump\(/);
  assert.match(syntax, /sourceSelectionWordJump\([\s\S]*activateDocumentSourceOffset\(/);
  assert.match(syntax, /sourceSelectionLineJump\([\s\S]*activateDocumentSourceOffset\(/);
});

test("exact source-only selections keep Tab indentation inside the Markdown document", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /sourceSelection[\s\S]*event\.key === "Tab"[\s\S]*sourceSelectionTabEdit\(/);
  assert.match(syntax, /sourceSelectionTabEdit\([\s\S]*replaceSourceSelectionTransaction\(/);
  assert.match(syntax, /dispatchExactEdit\([\s\S]*fullSelection,[\s\S]*next/);
});

test("exact source edits preserve source-only carets or refocus the rendered surface", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /function focusExactEditSelection\(view\)/);
  assert.match(syntax, /focusCodeContentOffset\(/);
  assert.match(syntax, /function pruneStaleCodeBlockDom\(view\)/);
  assert.match(syntax, /view\.nodeDOM\(position\)/);
  assert.match(syntax, /requestAnimationFrame\(\(\) => pruneStaleCodeBlockDom\(view\)\)/);
  assert.match(syntax, /const dispatchExactEdit = \(/);
  assert.match(syntax, /const preserveSourcePosition = afterTarget\?\.kind === "gap"/);
  assert.match(syntax, /afterTarget\.node\.type\.name === "code_block"/);
  assert.match(syntax, /preserveSourcePosition[\s\S]*activateDocumentSourceOffset\(/);
  assert.match(syntax, /focusExactEditSelection\(view\);/);
  assert.match(syntax, /const captureExactTyping = \(event\) =>/);
  assert.match(syntax, /addEventListener\("keydown", captureExactTyping, true\)/);
  assert.match(syntax, /removeEventListener\("keydown", captureExactTyping, true\)/);
  assert.ok((syntax.match(/dispatchExactEdit\(/g) || []).length >= 5);
});

test("temporary source handoffs install their destination before fallback closure", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /function finishUnchangedSourceHandoff\([\s\S]*afterFinish\(null\)[\s\S]*editor\?\.isConnected\) onCancel\(\)/);
  assert.match(syntax, /else finishUnchangedSourceHandoff\([\s\S]*editor,[\s\S]*onCancel,[\s\S]*afterFinish/);
});

test("source gap handoffs bias the hidden caret in the traversal direction", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /function markdownGapSelectionAt\([\s\S]*direction === "backward" \? -1 : 1/);
  assert.match(syntax, /markdownGapSelectionAt\([\s\S]*boundaryGap\.position,[\s\S]*direction/);
});

test("source selections leaving temporary controls transfer focus before dispatch", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  const selectFromBoundary = syntax.slice(
    syntax.indexOf("const selectFromBoundary ="),
    syntax.indexOf("const jumpFromSource =")
  );
  const exactBranchStart = selectFromBoundary.indexOf("if (exactSelection) {");
  const exactBranch = selectFromBoundary.slice(
    exactBranchStart,
    selectFromBoundary.indexOf("return;", exactBranchStart)
  );
  assert.match(
    exactBranch,
    /if \(exactSelection\) \{[\s\S]*markdownGapSelectionAt\([\s\S]*dispatchFocusedSourceSelection\([\s\S]*action: "source-selection"/
  );
  assert.doesNotMatch(exactBranch, /textSelectionAcrossBoundary\(/);
  assert.doesNotMatch(exactBranch, /editorView\.dispatch\(/);
});

test("active blockquotes expose their source marker and use structural Backspace semantics", () => {
  const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");

  assert.match(styles, /blockquote\.tether-active-markdown-block::before\s*\{[^}]*content:\s*">"/s);
  assert.match(styles, /is-reading \.ProseMirror blockquote\.tether-active-markdown-block::before/);
  assert.match(surface, /use\(structuralMarkerBackspaceKeymap\)/);
  assert.match(syntax, /type\.name === "blockquote"/);
  assert.match(syntax, /return lift\(state, dispatch, view\)/);
});

test("the saved text-alignment preference reaches the inline editor", () => {
  const app = fs.readFileSync(path.join(root, "src", "renderer", "App.jsx"), "utf8");
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "DocumentSurface.jsx"), "utf8");
  const dialogs = fs.readFileSync(path.join(root, "src", "renderer", "components", "dialogs.jsx"), "utf8");
  assert.match(app, /textAlignment=\{preferences\.textAlignment\}/);
  assert.match(surface, /alignment-\$\{textAlignment\}/);
  assert.match(dialogs, /ariaLabel="Text alignment"/);
});

test("reading view mounts the Markdown surface in readonly mode", () => {
  const app = fs.readFileSync(path.join(root, "src", "renderer", "App.jsx"), "utf8");
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "DocumentSurface.jsx"), "utf8");
  const wysiwyg = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  assert.match(app, /EDITOR_MODE_READING/);
  assert.match(surface, /readOnly=\{readingMode\}/);
  // Reading <-> editing toggles in place on a single editor instance.
  assert.match(wysiwyg, /crepe\.setReadonly\(readOnly\)/);
  assert.match(wysiwyg, /if \(!readOnlyRef\.current\) return;/);
  assert.match(wysiwyg, /beforeinput", blockReadingCodeInteraction, true/);
  assert.match(wysiwyg, /const label = "Copy formula"/);
  assert.match(wysiwyg, /aria-label", "Copy inline formula"/);
  assert.match(wysiwyg, /aria-label", "Edit table Markdown source"/);
  assert.match(wysiwyg, /tether-content-copy/);
  assert.match(wysiwyg, /markSyntheticTrailingParagraph/);
  assert.match(wysiwyg, /normalizeInitialEmptyMarkdown\(crepe, latestMarkdown\)/);
  assert.match(wysiwyg, /setNodeAttribute\(position, "tetherSyntheticTrailing", true\)/);
  assert.match(wysiwyg, /copyIcon,\s*copyText: "Copy",\s*onCopy:/s);
});
