import assert from "node:assert/strict";
import test from "node:test";
import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import {
  adjacentCodeSourceOffset,
  codeBoundaryDeletionKeyDirection,
  codeBoundaryDeletionDirection,
  codeContentOffsetAtSourceOffset,
  codeBoundaryNavigationKeyDirection,
  codeBoundaryNavigationPosition,
  codeBoundaryNavigationDirection,
  codeBoundaryNavigationSourceOffset,
  codeBoundarySelectionKeyDirection,
  codeBoundarySelectionDirection,
  codeBoundarySourcePosition,
  codeBoundaryWordJumpDirection,
  codeContentSourcePosition,
  codeToCodeDragRange,
  codeDragDocumentRange,
  codeLineEndSourceOffset,
  codeLineStartSourceOffset,
  codeOuterHistoryDirection,
  codeOptionVerticalSelection,
  codeSourceOnlyHistoryDirection,
  codeTabEdit,
  documentDragIntoCodeRange,
  emptyCodeClosingFenceSourceOffset,
  emptyCodeEnterSource,
  isCodeSourceNativeNoopShortcut,
  isEditorHistoryShortcut,
  isEditorSelectAllShortcut,
  restoreCodeViewFocusAfterHistory,
  shouldRestoreEditorHistoryFocus,
  tetherCodeExtensions,
  tetherCodeLanguageLabel,
  tetherCodeLanguages,
} from "../src/renderer/lib/codeEditor.js";

test("vertical entry into code lands on its physical edge source line", () => {
  assert.equal(adjacentCodeSourceOffset("```javascript\ncode\n```", "down", 4), 4);
  assert.equal(adjacentCodeSourceOffset("```javascript\ncode\n```", "down", 99), 13);
  assert.equal(adjacentCodeSourceOffset("```javascript\ncode\n```", "up", 2), 21);
  assert.equal(adjacentCodeSourceOffset("---\r\ntitle: Demo\r\n---", "up", 2), 20);
  assert.equal(adjacentCodeSourceOffset("    first\n\tsecond", "down", 3), 3);
  assert.equal(adjacentCodeSourceOffset("    first\n\tsecond", "up", 2), 12);
});

test("editor history shortcuts include undo and redo without matching unrelated modifiers", () => {
  assert.equal(isEditorHistoryShortcut({ key: "z", metaKey: true }), true);
  assert.equal(isEditorHistoryShortcut({ key: "Z", metaKey: true, shiftKey: true }), true);
  assert.equal(isEditorHistoryShortcut({ key: "z", ctrlKey: true }), true);
  assert.equal(isEditorHistoryShortcut({ key: "y", ctrlKey: true }), true);
  assert.equal(isEditorHistoryShortcut({ key: "Y", metaKey: true }), true);
  assert.equal(isEditorHistoryShortcut({ key: "z", metaKey: true, altKey: true }), false);
  assert.equal(isEditorHistoryShortcut({ key: "y", metaKey: true, shiftKey: true }), false);
  assert.equal(isEditorHistoryShortcut({ key: "z" }), false);
});

test("code editor history shortcuts target the canonical Markdown document first", () => {
  assert.equal(codeOuterHistoryDirection({ key: "z", metaKey: true }), "undo");
  assert.equal(codeOuterHistoryDirection({ key: "Z", metaKey: true, shiftKey: true }), "redo");
  assert.equal(codeOuterHistoryDirection({ key: "y", ctrlKey: true }), "redo");
  assert.equal(codeOuterHistoryDirection({ key: "z" }), null);
});

test("history focus restoration accepts the document shell and surviving editor descendants", () => {
  const body = {};
  const documentElement = {};
  const descendant = {};
  const external = {};
  const editorHost = {
    ownerDocument: { body, documentElement },
    contains: (element) => element === descendant
  };
  assert.equal(shouldRestoreEditorHistoryFocus(null, editorHost), true);
  assert.equal(shouldRestoreEditorHistoryFocus(body, editorHost), true);
  assert.equal(shouldRestoreEditorHistoryFocus(documentElement, editorHost), true);
  assert.equal(shouldRestoreEditorHistoryFocus(descendant, editorHost), true);
  assert.equal(shouldRestoreEditorHistoryFocus(external, editorHost), false);
});

test("CodeMirror history refocuses a connected editor without stealing external focus", () => {
  const body = {};
  const documentElement = {};
  const external = {};
  const frames = [];
  let focusCount = 0;
  const ownerDocument = { activeElement: body, body, documentElement };
  const dom = {
    isConnected: true,
    ownerDocument,
    contains: () => false
  };
  const codeView = {
    dom,
    hasFocus: false,
    focus: () => { focusCount += 1; }
  };
  const schedule = (callback) => frames.push(callback);

  assert.equal(restoreCodeViewFocusAfterHistory(codeView, schedule), true);
  assert.equal(focusCount, 0);
  frames.shift()();
  assert.equal(focusCount, 0);
  frames.shift()();
  assert.equal(focusCount, 1);

  ownerDocument.activeElement = external;
  assert.equal(restoreCodeViewFocusAfterHistory(codeView, schedule), true);
  frames.shift()();
  frames.shift()();
  assert.equal(focusCount, 1);
});

test("editor Select All shortcuts escalate from CodeMirror to the Markdown document", () => {
  assert.equal(isEditorSelectAllShortcut({ key: "a", metaKey: true }), true);
  assert.equal(isEditorSelectAllShortcut({ key: "A", ctrlKey: true }), true);
  assert.equal(isEditorSelectAllShortcut({ key: "a", metaKey: true, shiftKey: true }), false);
  assert.equal(isEditorSelectAllShortcut({ key: "a", metaKey: true, altKey: true }), false);
  assert.equal(isEditorSelectAllShortcut({ key: "a" }), false);
  assert.equal(isEditorSelectAllShortcut({ key: "z", metaKey: true }), false);
});

test("CodeMirror-only structural shortcuts stay inert like native source controls", () => {
  assert.equal(isCodeSourceNativeNoopShortcut({
    key: "ArrowUp",
    metaKey: true,
    altKey: true
  }), true);
  assert.equal(isCodeSourceNativeNoopShortcut({
    key: "ArrowDown",
    ctrlKey: true,
    altKey: true
  }), true);
  assert.equal(isCodeSourceNativeNoopShortcut({ key: "Enter", metaKey: true }), true);
  assert.equal(isCodeSourceNativeNoopShortcut({ key: "Enter", ctrlKey: true }), true);
  assert.equal(isCodeSourceNativeNoopShortcut({
    key: "ArrowUp",
    metaKey: true,
    altKey: true,
    shiftKey: true
  }), false);
  assert.equal(isCodeSourceNativeNoopShortcut({ key: "Enter", metaKey: true, altKey: true }), false);
  assert.equal(isCodeSourceNativeNoopShortcut({ key: "Enter" }), false);
});

test("CodeMirror Tab edits preserve the source editor's literal bytes and selection", () => {
  const collapsed = EditorState.create({ doc: "alpha", selection: { anchor: 2 } });
  assert.deepEqual(codeTabEdit(collapsed), {
    value: "al\tpha",
    changed: true,
    anchor: 3,
    head: 3
  });

  const forward = EditorState.create({
    doc: "one\ntwo\nthree",
    selection: { anchor: 1, head: 8 }
  });
  assert.deepEqual(codeTabEdit(forward), {
    value: "\tone\n\ttwo\nthree",
    changed: true,
    anchor: 2,
    head: 10
  });

  const backward = EditorState.create({
    doc: "one\ntwo\nthree",
    selection: { anchor: 8, head: 1 }
  });
  assert.deepEqual(codeTabEdit(backward), {
    value: "\tone\n\ttwo\nthree",
    changed: true,
    anchor: 10,
    head: 2
  });
});

test("CodeMirror Shift-Tab removes tabs or one four-space source indentation unit", () => {
  const selection = EditorState.create({
    doc: "\talpha\n    beta\ngamma",
    selection: { anchor: 0, head: 16 }
  });
  assert.deepEqual(codeTabEdit(selection, true), {
    value: "alpha\nbeta\ngamma",
    changed: true,
    anchor: 0,
    head: 11
  });

  const unchanged = EditorState.create({ doc: "alpha", selection: { anchor: 2 } });
  assert.deepEqual(codeTabEdit(unchanged, true), {
    value: "alpha",
    changed: false,
    anchor: 2,
    head: 2
  });
  assert.equal(codeTabEdit({ selection: { ranges: [] }, doc: unchanged.doc }), null);
});

test("CodeMirror language auto-indentation uses the same literal tab as source Tab edits", () => {
  const state = EditorState.create({ extensions: tetherCodeExtensions });
  assert.equal(state.facet(indentUnit), "\t");
});

function codeState(head, length = 10, empty = true) {
  return {
    doc: { length, lines: 1, lineAt: () => ({ number: 1 }) },
    selection: { ranges: [{ empty, head }] }
  };
}

test("CodeMirror shift-arrows hand off at collapsed and extended selection heads", () => {
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
  assert.equal(codeBoundarySelectionDirection(codeState(0, 10, false), "Shift-ArrowLeft"), "backward");
  assert.equal(codeBoundarySelectionDirection(codeState(10, 10, false), "Shift-ArrowRight"), "forward");
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
  assert.equal(
    codeBoundarySelectionKeyDirection(codeState(0), {
      key: "ArrowUp",
      shiftKey: true,
      altKey: true
    }),
    "backward"
  );
  assert.equal(
    codeBoundarySelectionKeyDirection(codeState(0), {
      key: "ArrowLeft",
      shiftKey: true,
      altKey: true
    }),
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

test("CodeMirror vertical arrows collapse extended selections toward the physical fence line", () => {
  const forward = EditorState.create({
    doc: "first\nsecond",
    selection: { anchor: 2, head: 8 }
  });
  const backward = EditorState.create({
    doc: "first\nsecond",
    selection: { anchor: 8, head: 2 }
  });
  for (const state of [forward, backward]) {
    assert.equal(codeBoundaryNavigationDirection(state, "ArrowUp"), "backward");
    assert.equal(codeBoundaryNavigationPosition(state, "ArrowUp"), 2);
    assert.equal(codeBoundaryNavigationDirection(state, "ArrowDown"), "forward");
    assert.equal(codeBoundaryNavigationPosition(state, "ArrowDown"), 8);
  }

  const middle = EditorState.create({
    doc: "first\nmiddle\nlast",
    selection: { anchor: 7, head: 10 }
  });
  assert.equal(codeBoundaryNavigationDirection(middle, "ArrowUp"), null);
  assert.equal(codeBoundaryNavigationDirection(middle, "ArrowDown"), null);
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

test("raw fenced-source offsets map back into visible CodeMirror content", () => {
  const source = "```js\r\nalpha\r\nbeta\r\n```";
  const content = "alpha\nbeta";
  assert.equal(
    codeContentOffsetAtSourceOffset(source, content, source.indexOf("beta") + 2),
    content.indexOf("beta") + 2
  );
  assert.equal(
    codeContentOffsetAtSourceOffset(source, content, source.indexOf("```", 3)),
    null
  );
  assert.equal(codeContentOffsetAtSourceOffset("```js\n```", "", "```js\n".length), 0);
});

test("front matter maps like a fenced YAML editing block", () => {
  const source = "---\r\ntitle: Demo\r\n---";
  const content = "title: Demo";
  const contentStart = source.indexOf("\n") + 1;
  const closingStart = source.lastIndexOf("\n") + 1;
  assert.equal(
    codeContentOffsetAtSourceOffset(source, content, source.indexOf("Demo") + 2),
    content.indexOf("Demo") + 2
  );
  assert.equal(codeContentOffsetAtSourceOffset(source, content, 1), null);
  assert.equal(codeBoundaryNavigationSourceOffset(source, content, "ArrowLeft", 0), contentStart - 2);
  assert.equal(codeBoundaryNavigationSourceOffset(source, content, "ArrowRight", content.length), closingStart);
  assert.equal(codeBoundaryNavigationSourceOffset(source, content, "ArrowDown", 3), closingStart + 3);
});

test("indented code maps hidden line prefixes without inventing fences", () => {
  const source = "    alpha\r\n\tbeta";
  const content = "alpha\nbeta";
  assert.equal(
    codeContentOffsetAtSourceOffset(source, content, source.indexOf("beta") + 2),
    content.indexOf("beta") + 2
  );
  assert.equal(codeContentOffsetAtSourceOffset(source, content, 2), null);
  assert.equal(codeBoundaryNavigationSourceOffset(source, content, "ArrowLeft", 0), 3);
  assert.equal(codeBoundaryNavigationSourceOffset(source, content, "ArrowUp", 3), 3);
  assert.equal(
    codeBoundaryNavigationSourceOffset(source, content, "ArrowRight", content.length),
    source.length
  );
  assert.equal(
    codeBoundaryNavigationSourceOffset(source, content, "ArrowDown", content.length),
    source.length
  );

  assert.equal(codeBoundaryNavigationSourceOffset("\talpha", "alpha", "ArrowLeft", 0), 0);
});

test("indented code line-start jumps reach physical source column zero", () => {
  const source = "    alpha beta\r\n\tsecond line\n    third";
  const content = "alpha beta\nsecond line\nthird";

  assert.equal(codeLineStartSourceOffset(source, content, 5), 0);
  assert.equal(
    codeLineStartSourceOffset(source, content, content.indexOf("second") + 4),
    source.indexOf("\tsecond")
  );
  assert.equal(
    codeLineStartSourceOffset(source, content, content.indexOf("third") + 2),
    source.indexOf("    third")
  );
  assert.equal(codeLineStartSourceOffset("```js\nalpha\n```", "alpha", 3), null);
  assert.equal(codeLineStartSourceOffset("---\ntitle: Demo\n---", "title: Demo", 4), null);
});

test("empty closed code line-end jumps reach the physical closing marker", () => {
  assert.equal(codeLineEndSourceOffset("```text\n```", ""), "```text\n```".length);
  assert.equal(codeLineEndSourceOffset("~~~\r\n~~~~  ", ""), "~~~\r\n~~~~  ".length);
  assert.equal(codeLineEndSourceOffset("---\ntitle: Demo\n---", "title: Demo"), null);
  assert.equal(codeLineEndSourceOffset("---\n---", ""), "---\n---".length);
  assert.equal(codeLineEndSourceOffset("```text\n\n```", ""), null);
  assert.equal(codeLineEndSourceOffset("```text\ncode\n```", "code"), null);
  assert.equal(codeLineEndSourceOffset("```text\n", ""), null);
  assert.equal(codeLineEndSourceOffset("    ", ""), null);
});

test("empty code insertion targets the start of the immediate closing marker", () => {
  assert.equal(emptyCodeClosingFenceSourceOffset("```text\n```", ""), "```text\n".length);
  assert.equal(emptyCodeClosingFenceSourceOffset("~~~\r\n~~~~  ", ""), "~~~\r\n".length);
  assert.equal(emptyCodeClosingFenceSourceOffset("---\n---", ""), "---\n".length);
  assert.equal(emptyCodeClosingFenceSourceOffset("```text\n\n```", ""), null);
  assert.equal(emptyCodeClosingFenceSourceOffset("```text\ncode\n```", "code"), null);
  assert.equal(emptyCodeClosingFenceSourceOffset("```text\n", ""), null);
});

test("empty code blocks still traverse their opening newline and closing fence", () => {
  const source = "~~~text\n~~~";
  const contentStart = source.indexOf("\n") + 1;
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowLeft", 0), contentStart - 1);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowRight", 0), contentStart + 1);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowUp", 0), 0);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowDown", 0), contentStart);
});

test("one Enter in a physically empty closed fence inserts exactly one source newline", () => {
  assert.equal(emptyCodeEnterSource("```js\n```"), "```js\n\n```");
  assert.equal(emptyCodeEnterSource("~~~\r\n~~~"), "~~~\r\n\r\n~~~");
  assert.equal(emptyCodeEnterSource("```js\n\n```"), null);
  assert.equal(emptyCodeEnterSource("```js\ncode\n```"), null);
  assert.equal(emptyCodeEnterSource("```js\n"), null);
});

test("source-only code edits join CodeMirror's undo and redo sequence", () => {
  const history = {
    beforeSource: "```js\n```",
    afterSource: "```js\n\n```",
    beforeContent: "",
    afterContent: "",
    state: "applied"
  };
  assert.equal(
    codeSourceOnlyHistoryDirection(
      { key: "z", metaKey: true },
      history.afterSource,
      history.afterContent,
      history
    ),
    "undo"
  );
  assert.equal(
    codeSourceOnlyHistoryDirection(
      { key: "z", metaKey: true },
      history.afterSource,
      "changed",
      history
    ),
    null
  );
  history.state = "undone";
  assert.equal(
    codeSourceOnlyHistoryDirection(
      { key: "z", metaKey: true, shiftKey: true },
      history.beforeSource,
      history.beforeContent,
      history
    ),
    "redo"
  );
  assert.equal(
    codeSourceOnlyHistoryDirection(
      { key: "y", ctrlKey: true },
      history.beforeSource,
      history.beforeContent,
      history
    ),
    "redo"
  );
  assert.equal(
    codeSourceOnlyHistoryDirection(
      { key: "z", metaKey: true },
      history.beforeSource,
      history.beforeContent,
      history
    ),
    null
  );

  history.state = "applied";
  history.afterSource = "```js\nx```";
  history.afterContent = "x```";
  assert.equal(
    codeSourceOnlyHistoryDirection(
      { key: "z", metaKey: true },
      history.afterSource,
      history.afterContent,
      history
    ),
    "undo"
  );
});

test("empty fenced blocks distinguish a physical blank content line from the closing fence", () => {
  const source = "~~~~text\n\n~~~~~";
  const closingStart = source.lastIndexOf("\n") + 1;
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowRight", 0), closingStart);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowDown", 0), closingStart);
});

test("vertical fence navigation preserves columns with CRLF source", () => {
  const source = "```js\r\ncode\r\n```";
  const contentStart = source.indexOf("\n") + 1;
  const closingStart = source.lastIndexOf("\n") + 1;
  assert.equal(
    codeBoundaryNavigationSourceOffset(source, "code", "ArrowLeft", 0),
    contentStart - 2
  );
  assert.equal(codeBoundaryNavigationSourceOffset(source, "code", "ArrowUp", 6), 4);
  assert.equal(codeBoundaryNavigationSourceOffset(source, "code", "ArrowDown", 3), closingStart + 3);
});

test("empty CRLF fences never expose a caret between carriage return and line feed", () => {
  const source = "~~~text\r\n~~~";
  const contentStart = source.indexOf("\n") + 1;
  assert.equal(
    codeBoundaryNavigationSourceOffset(source, "", "ArrowLeft", 0),
    contentStart - 2
  );
  assert.equal(codeBoundaryNavigationSourceOffset(source, "", "ArrowRight", 0), contentStart + 1);
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
  assert.equal(
    codeBoundaryNavigationKeyDirection(codeState(0), { key: "ArrowUp", altKey: true }),
    "backward"
  );
  assert.equal(
    codeBoundaryNavigationKeyDirection(codeState(0), { key: "ArrowLeft", altKey: true }),
    null
  );
});

test("Option-Up and Option-Down navigate code without reordering source lines", () => {
  const source = "alpha\nbeta\ngamma";
  const state = EditorState.create({
    doc: source,
    selection: { anchor: 8 }
  });
  assert.deepEqual(codeOptionVerticalSelection(state, {
    key: "ArrowUp",
    altKey: true
  }), { anchor: 2, head: 2 });
  assert.deepEqual(codeOptionVerticalSelection(state, {
    key: "ArrowDown",
    altKey: true
  }), { anchor: 13, head: 13 });
  assert.deepEqual(codeOptionVerticalSelection(state, {
    key: "ArrowUp",
    altKey: true,
    shiftKey: true
  }), { anchor: 8, head: 2 });
  assert.deepEqual(codeOptionVerticalSelection(state, {
    key: "ArrowDown",
    altKey: true,
    shiftKey: true
  }), { anchor: 8, head: 13 });
  assert.equal(state.doc.toString(), source);

  const extended = EditorState.create({
    doc: source,
    selection: { anchor: 1, head: 8 }
  });
  assert.equal(codeOptionVerticalSelection(extended, {
    key: "ArrowUp",
    altKey: true
  }), null);
  assert.deepEqual(codeOptionVerticalSelection(extended, {
    key: "ArrowDown",
    altKey: true
  }), { anchor: 13, head: 13 });
});

test("CodeMirror word jumps continue from an extended selection head into fence source", () => {
  assert.equal(
    codeBoundaryWordJumpDirection(codeState(0, 10, false), {
      key: "ArrowLeft",
      altKey: true
    }),
    "backward"
  );
  assert.equal(
    codeBoundaryWordJumpDirection(codeState(10, 10, false), {
      key: "ArrowRight",
      altKey: true
    }),
    "forward"
  );
  assert.equal(
    codeBoundaryWordJumpDirection(codeState(1, 10, false), {
      key: "ArrowLeft",
      altKey: true
    }),
    null
  );
  assert.equal(
    codeBoundaryWordJumpDirection(codeState(0), {
      key: "ArrowLeft",
      altKey: true,
      metaKey: true
    }),
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

test("CodeMirror fence deletion preserves native word and line modifiers at the source newline", () => {
  assert.equal(
    codeBoundaryDeletionKeyDirection(codeState(0), { key: "Backspace", shiftKey: false }),
    "backward"
  );
  assert.equal(
    codeBoundaryDeletionKeyDirection(codeState(0), { key: "Backspace", altKey: true }),
    "backward"
  );
  assert.equal(
    codeBoundaryDeletionKeyDirection(codeState(0), { key: "Backspace", metaKey: true }),
    "backward"
  );
  assert.equal(
    codeBoundaryDeletionKeyDirection(codeState(10), { key: "Delete", ctrlKey: true }),
    "forward"
  );
  assert.equal(
    codeBoundaryDeletionKeyDirection(codeState(0), { key: "Backspace", shiftKey: true }),
    null
  );
  assert.equal(codeBoundarySourcePosition(20, 12, "backward"), 21);
  assert.equal(codeBoundarySourcePosition(20, 12, "forward"), 33);
  assert.equal(codeContentSourcePosition(20, 7), 28);
});

test("code mouse drags bridge a CodeMirror anchor to surrounding document prose", () => {
  assert.deepEqual(codeDragDocumentRange(20, 12, 5, 40), { anchor: 26, head: 40 });
  assert.deepEqual(codeDragDocumentRange(20, 12, 5, 8), { anchor: 26, head: 8 });
  assert.deepEqual(codeDragDocumentRange(20, 12, 99, 40), { anchor: 33, head: 40 });
  assert.equal(codeDragDocumentRange(20, 12, 5, 20), null);
  assert.equal(codeDragDocumentRange(20, 12, 5, 34), null);
  assert.deepEqual(documentDragIntoCodeRange(20, 12, 8, 5), { anchor: 8, head: 26 });
  assert.deepEqual(documentDragIntoCodeRange(20, 12, 40, 99), { anchor: 40, head: 33 });
  assert.equal(documentDragIntoCodeRange(20, 12, 22, 5), null);
  assert.deepEqual(codeToCodeDragRange(20, 12, 5, 50, 8, 3), {
    anchor: 26,
    head: 54
  });
  assert.deepEqual(codeToCodeDragRange(50, 8, 3, 20, 12, 5), {
    anchor: 54,
    head: 26
  });
  assert.deepEqual(codeToCodeDragRange(20, 12, 99, 50, 8, -4), {
    anchor: 33,
    head: 51
  });
  assert.equal(codeToCodeDragRange(20, 12, 5, 20, 12, 8), null);
});

test("code language choices include a real plain-text option and stable Markdown fence identifiers", async () => {
  assert.deepEqual(
    tetherCodeLanguages.map(({ name }) => name),
    [
      "", "js", "ts", "json", "css", "scss", "sass", "html", "xml", "markdown", "python", "sql", "yaml",
      "cpp", "csharp", "go", "java", "kotlin", "swift", "rust", "ruby", "shell", "powershell", "toml",
      "lua", "diff"
    ]
  );
  for (const { name, alias } of tetherCodeLanguages) {
    assert.ok(alias.includes(name), `${name} should load from its own picker value`);
  }
  assert.ok(tetherCodeLanguages[0].alias.includes("text"));
  assert.ok(await tetherCodeLanguages[0].load(), "plain text should actively clear stale syntax highlighting");
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
