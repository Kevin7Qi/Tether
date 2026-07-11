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
  assert.match(styles, /milkdown-table-block table\s*\{[^}]*table-layout:\s*auto/s);
  assert.match(styles, /table:not\(:has\(\[data-colwidth\]\)\) col\s*\{[^}]*width:\s*auto !important/s);
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
  assert.match(wysiwyg, /copyIcon,\s*copyText: "Copy",\s*onCopy:/s);
});
