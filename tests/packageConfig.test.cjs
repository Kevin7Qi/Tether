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
  assert.doesNotMatch(main, /role:\s*"editMenu"/);
  assert.match(main, /accelerator:\s*"CmdOrCtrl\+Z"/);
  assert.match(main, /accelerator:\s*"Shift\+CmdOrCtrl\+Z"/);
  assert.match(main, /sendEditorCommand\("undo", browserWindow\)/);
  assert.match(main, /webContents\.send\("editor:command", command\)/);
  assert.match(preload, /onEditorCommand: \(callback\) => subscribe\("editor:command", callback\)/);
  assert.match(app, /remoteApi\.onEditorCommand\(\(command\) =>/);
  assert.match(app, /window\.setTimeout\(\(\) =>[\s\S]*dispatchEditorHistoryCommand\(command\);[\s\S]*\}, 50\)/);
  assert.match(app, /dispatchEditorHistoryCommand\(command\)/);
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
  assert.match(styles, /cm-editor\.cm-focused \.cm-activeLine/);
  assert.match(styles, /\.tools button\.copy-button\s*\{[^}]*opacity:\s*0/s);
  assert.match(styles, /is-reading \.milkdown-code-block \.language-button svg\s*\{[^}]*display:\s*none/s);
  assert.match(codeEditor, /&\.cm-focused \.cm-activeLine/);
  assert.match(codeEditor, /indentUnit\.of\("\\t"\)/);
  assert.match(surface, /removeAttribute\("data-tether-fence"\)/);
  assert.match(surface, /renderLanguage: tetherCodeLanguageLabel/);
  assert.match(surface, /codeBoundaryNavigationKeyDirection/);
  assert.match(surface, /codeBoundaryDeletionKeyDirection/);
  assert.match(surface, /codeTabEdit/);
  assert.match(surface, /emptyCodeEnterSource/);
  assert.match(surface, /emptyCodeSourceHistoryDirection/);
  assert.match(surface, /undo as undoProseMirror/);
  assert.match(surface, /redo as redoProseMirror/);
  assert.match(surface, /fenceSourceSignature: codeSemanticSignature/);
  assert.match(surface, /const codeBlock = enclosingCodeBlock/);
  assert.match(surface, /initialSelectionDirection: selectionMotion/);
  assert.match(surface, /codeBoundaryNavigationSourceOffset/);
  assert.match(surface, /continuousMarkdownSource/);
  assert.match(surface, /control\.setAttribute\("aria-disabled", "true"\)/);
  assert.match(styles, /textarea\.tether-continuous-source\.is-code_block/);
  assert.match(surface, /use\(sourceFaithfulFenceRemark\)/);
  assert.match(surface, /use\(sourceFaithfulCodeBlockSchema\)/);
  assert.match(surface, /use\(sourceFaithfulMathRemark\)/);
  assert.match(surface, /use\(sourceFaithfulInlineMathSchema\)/);
  assert.match(surface, /use\(renderedInlineHtmlRemark\)/);
  assert.match(surface, /use\(renderedInlineHtmlSchema\)/);
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
  assert.match(styles, /\.milkdown-list-item-block > \.list-item\s*\{[^}]*--tether-list-marker-width:\s*20px[^}]*--tether-list-line-height:\s*1\.72em[^}]*gap:\s*2px[^}]*list-style:\s*none/s);
  assert.match(styles, /\.label-wrapper,\s*\.tether-wysiwyg \.ProseMirror \.milkdown-list-item-block \.label\s*\{[^}]*width:\s*var\(--tether-list-marker-width\)/s);
  assert.match(styles, /\.label-wrapper\s*\{[^}]*height:\s*var\(--tether-list-line-height\)[^}]*flex:\s*0 0 var\(--tether-list-marker-width\)[^}]*align-items:\s*center/s);
  assert.match(styles, /\.milkdown-list-item-block li \.label-wrapper \.label\s*\{[^}]*height:\s*100%[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*padding:\s*0[^}]*text-align:\s*center[^}]*line-height:\s*1[^}]*transform:\s*translateY\(2px\)/s);
  assert.match(styles, /\.label\.bullet,\s*\.tether-wysiwyg \.ProseMirror \.milkdown-list-item-block \.label\.ordered\s*\{[^}]*color:\s*var\(--ink\)/s);
  assert.match(styles, /\.milkdown-list-item-block \.label svg\s*\{[^}]*display:\s*block[^}]*width:\s*17px[^}]*height:\s*17px/s);
  assert.match(styles, /\.label\.ordered\s*\{[^}]*justify-content:\s*center[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(styles, /transform:\s*translateY\(2px\) scaleX\(var\(--tether-list-marker-scale, 1\)\)/);
  assert.match(styles, /\.label\.ordered\[data-marker-digits="2"\]\s*\{[^}]*--tether-list-marker-scale:\s*0\.84/s);
  assert.match(styles, /\.label\.ordered\[data-marker-digits="9"\]\s*\{[^}]*justify-content:\s*flex-end[^}]*font-size:\s*0\.68em[^}]*padding-inline-end:\s*3px[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(styles, /label-wrapper:has\(\.label\.ordered\)/);
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
  assert.match(surface, /sourceWordSelectionRange\(currentOffset, targetOffset\)/);
  assert.match(surface, /addEventListener\("keydown", handleCodeWordJump, true\)/);
  assert.match(surface, /removeEventListener\("keydown", handleCodeWordJump, true\)/);
});

test("code history changes restore the same embedded editor focus", () => {
  const surface = fs.readFileSync(path.join(root, "src", "renderer", "WysiwygSurface.jsx"), "utf8");
  const codeEditor = fs.readFileSync(path.join(root, "src", "renderer", "lib", "codeEditor.js"), "utf8");
  assert.match(codeEditor, /EditorView\.domEventHandlers\(\{[\s\S]*isEditorHistoryShortcut\(event\)[\s\S]*restoreCodeViewFocusAfterHistory\(codeView\)/);
  assert.match(surface, /addEventListener\("focusin", rememberCodeFocus, true\)/);
  assert.match(surface, /removeEventListener\("focusin", rememberCodeFocus, true\)/);
  assert.match(surface, /listener\.markdownUpdated\([\s\S]*scheduleCodeFocusRestore\(lastFocusedCodeTarget\)/);
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
  assert.match(syntax, /const documentJumpEdge = sourceDocumentJumpEdge\(event\)/);
  assert.match(syntax, /finish\(true, \(mapping\) => onDocumentJump\(shortcut, sourceSelection, mapping\)\)/);
  assert.match(syntax, /const jumpFromSource = \(event, localSelection, mapping = null\) =>/);
  assert.match(syntax, /baseOffset \+ localSelection\.head/);
  assert.match(syntax, /baseOffset \+ localSelection\.anchor/);
});

test("exact source edits refocus the surviving rendered editing surface", () => {
  const syntax = fs.readFileSync(path.join(root, "src", "renderer", "lib", "markdownSyntaxPlugin.js"), "utf8");
  assert.match(syntax, /function focusExactEditSelection\(view\)/);
  assert.match(syntax, /focusCodeContentOffset\(/);
  assert.match(syntax, /function pruneStaleCodeBlockDom\(view\)/);
  assert.match(syntax, /view\.nodeDOM\(position\)/);
  assert.match(syntax, /requestAnimationFrame\(\(\) => pruneStaleCodeBlockDom\(view\)\)/);
  assert.ok((syntax.match(/focusExactEditSelection\((?:view|_view)\);/g) || []).length >= 5);
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
  assert.match(wysiwyg, /setNodeAttribute\(position, "tetherSyntheticTrailing", true\)/);
  assert.match(wysiwyg, /copyIcon,\s*copyText: "Copy",\s*onCopy:/s);
});
