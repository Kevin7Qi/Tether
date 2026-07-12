import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import {
  codeBoundaryDeletionKeyDirection,
  codeBoundaryDeletionDirection,
  codeBoundaryNavigationKeyDirection,
  codeBoundaryNavigationDirection,
  codeBoundaryNavigationSourceOffset,
  codeBoundarySelectionKeyDirection,
  codeBoundarySelectionDirection,
  codeBoundarySourcePosition,
  codeContentSourcePosition,
  tetherCodeLanguageLabel,
  tetherCodeLanguages,
} from "../src/renderer/lib/codeEditor.js";

function codeState(head, length = 10, empty = true) {
  return {
    doc: { length, lines: 1, lineAt: () => ({ number: 1 }) },
    selection: { ranges: [{ empty, head }] }
  };
}

test("CodeMirror shift-arrows hand off only at a collapsed horizontal or vertical boundary", () => {
  const middleLine = EditorState.create({ doc: "first\nmiddle\nlast", selection: { anchor: 8 } });
  assert.equal(codeBoundarySelectionDirection(codeState(0), "Shift-ArrowLeft"), "backward");
  assert.equal(codeBoundarySelectionDirection(codeState(0), "Shift-ArrowUp"), "backward");
  assert.equal(codeBoundarySelectionDirection(codeState(10), "Shift-ArrowRight"), "forward");
  assert.equal(codeBoundarySelectionDirection(codeState(10), "Shift-ArrowDown"), "forward");
  assert.equal(codeBoundarySelectionDirection(codeState(1), "Shift-ArrowLeft"), null);
  assert.equal(codeBoundarySelectionDirection(codeState(1), "Shift-ArrowUp"), "backward");
  assert.equal(codeBoundarySelectionDirection(codeState(9), "Shift-ArrowRight"), null);
  assert.equal(codeBoundarySelectionDirection(codeState(9), "Shift-ArrowDown"), "forward");
  assert.equal(codeBoundarySelectionDirection(middleLine, "Shift-ArrowUp"), null);
  assert.equal(codeBoundarySelectionDirection(middleLine, "Shift-ArrowDown"), null);
  assert.equal(codeBoundarySelectionDirection(codeState(0, 10, false), "Shift-ArrowLeft"), null);
  assert.equal(codeBoundarySelectionDirection({ doc: { length: 10 }, selection: { ranges: [] } }, "Shift-ArrowLeft"), null);
});

test("CodeMirror boundary selection ignores unshifted and command-modified arrows", () => {
  assert.equal(
    codeBoundarySelectionKeyDirection(codeState(0), { key: "ArrowLeft", shiftKey: true }),
    "backward"
  );
  assert.equal(codeBoundarySelectionKeyDirection(codeState(0), { key: "ArrowLeft", shiftKey: false }), null);
  assert.equal(
    codeBoundarySelectionKeyDirection(codeState(0), { key: "ArrowLeft", shiftKey: true, metaKey: true }),
    null
  );
});

test("CodeMirror ordinary arrows leave a fenced block at its source boundaries", () => {
  const firstLine = EditorState.create({ doc: "first\nsecond", selection: { anchor: 3 } });
  const lastLine = EditorState.create({ doc: "first\nsecond", selection: { anchor: 8 } });

  assert.equal(codeBoundaryNavigationDirection(codeState(0), "ArrowLeft"), "backward");
  assert.equal(codeBoundaryNavigationDirection(codeState(10), "ArrowRight"), "forward");
  assert.equal(codeBoundaryNavigationDirection(firstLine, "ArrowUp"), "backward");
  assert.equal(codeBoundaryNavigationDirection(lastLine, "ArrowDown"), "forward");
  assert.equal(codeBoundaryNavigationDirection(firstLine, "ArrowLeft"), null);
  assert.equal(codeBoundaryNavigationDirection(lastLine, "ArrowRight"), null);
  assert.equal(codeBoundaryNavigationDirection(codeState(0, 10, false), "ArrowLeft"), null);
});

test("CodeMirror boundary arrows enter the adjacent fenced-source character", () => {
  const source = "````js meta=live\nfirst\nsecond\n````";
  const content = "first\nsecond";
  const contentStart = source.indexOf("\n") + 1;
  const contentEnd = contentStart + content.length;
  const closingStart = contentEnd + 1;

  assert.equal(
    codeBoundaryNavigationSourceOffset(source, content, "ArrowLeft", 0),
    contentStart - 1
  );
  assert.equal(
    codeBoundaryNavigationSourceOffset(source, content, "ArrowRight", content.length),
    contentEnd + 1
  );
  assert.equal(codeBoundaryNavigationSourceOffset(source, content, "ArrowUp", 3), 3);
  assert.equal(
    codeBoundaryNavigationSourceOffset(source, content, "ArrowDown", content.indexOf("second") + 3),
    closingStart + 3
  );
});

test("empty code blocks still traverse their opening newline and closing fence", () => {
  const source = "~~~text\n~~~";
  const contentStart = source.indexOf("\n") + 1;
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowLeft", 0), contentStart - 1);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowRight", 0), contentStart + 1);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowUp", 0), 0);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowDown", 0), contentStart);
});

test("empty fenced blocks distinguish a physical blank content line from the closing fence", () => {
  const source = "~~~~text\n\n~~~~~";
  const closingStart = source.lastIndexOf("\n") + 1;
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowRight", 0), closingStart);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowDown", 0), closingStart);
});

test("vertical fence navigation preserves columns with CRLF source", () => {
  const source = "```js\r\ncode\r\n```";
  const closingStart = source.lastIndexOf("\n") + 1;
  assert.equal(codeBoundaryNavigationSourceOffset(source, "code", "ArrowUp", 6), 4);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "code", "ArrowDown", 3), closingStart + 3);
});

test("CodeMirror boundary navigation ignores shifted and command-modified arrows", () => {
  assert.equal(
    codeBoundaryNavigationKeyDirection(codeState(0), { key: "ArrowLeft", shiftKey: false }),
    "backward"
  );
  assert.equal(
    codeBoundaryNavigationKeyDirection(codeState(0), { key: "ArrowLeft", shiftKey: true }),
    null
  );
  assert.equal(
    codeBoundaryNavigationKeyDirection(codeState(0), { key: "ArrowLeft", shiftKey: false, metaKey: true }),
    null
  );
});

test("CodeMirror deletion exposes hidden fenced source only at content boundaries", () => {
  assert.equal(codeBoundaryDeletionDirection(codeState(0), "Backspace"), "backward");
  assert.equal(codeBoundaryDeletionDirection(codeState(10), "Delete"), "forward");
  assert.equal(codeBoundaryDeletionDirection(codeState(1), "Backspace"), null);
  assert.equal(codeBoundaryDeletionDirection(codeState(9), "Delete"), null);
  assert.equal(codeBoundaryDeletionDirection(codeState(0, 10, false), "Backspace"), null);
  assert.equal(codeBoundaryDeletionDirection(codeState(0), "Delete"), null);
});

test("CodeMirror fence deletion ignores modifiers and targets the adjacent source newline", () => {
  assert.equal(
    codeBoundaryDeletionKeyDirection(codeState(0), { key: "Backspace", shiftKey: false }),
    "backward"
  );
  assert.equal(
    codeBoundaryDeletionKeyDirection(codeState(0), { key: "Backspace", altKey: true }),
    null
  );
  assert.equal(codeBoundarySourcePosition(20, 12, "backward"), 21);
  assert.equal(codeBoundarySourcePosition(20, 12, "forward"), 33);
  assert.equal(codeContentSourcePosition(20, 7), 28);
});

test("code language choices use stable Markdown fence identifiers", () => {
  assert.deepEqual(
    tetherCodeLanguages.map(({ name }) => name),
    [
      "js", "ts", "json", "css", "scss", "sass", "html", "xml", "markdown", "python", "sql", "yaml",
      "cpp", "csharp", "go", "java", "kotlin", "swift", "rust", "ruby", "shell", "powershell", "toml",
      "lua", "diff"
    ]
  );
  for (const { name, alias } of tetherCodeLanguages) {
    assert.ok(alias.includes(name), `${name} should load from its own picker value`);
  }
});

test("code language labels stay readable for canonical fence IDs and aliases", () => {
  assert.equal(tetherCodeLanguageLabel("js"), "JavaScript");
  assert.equal(tetherCodeLanguageLabel("javascript"), "JavaScript");
  assert.equal(tetherCodeLanguageLabel("tsx"), "TypeScript");
  assert.equal(tetherCodeLanguageLabel("cs"), "C#");
  assert.equal(tetherCodeLanguageLabel("cpp"), "C/C++");
  assert.equal(tetherCodeLanguageLabel(""), "Text");
  assert.equal(tetherCodeLanguageLabel("mermaid"), "mermaid");
});
