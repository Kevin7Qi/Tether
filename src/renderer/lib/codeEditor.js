import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  indentUnit,
  syntaxHighlighting
} from "@codemirror/language";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { sourceTabEdit } from "./sourceEditing.js";

const tetherCodeViews = new WeakMap();

export function isEditorHistoryShortcut(event) {
  if (!event || event.altKey || !(event.metaKey || event.ctrlKey)) return false;
  const key = String(event.key || "").toLowerCase();
  return key === "z" || (key === "y" && !event.shiftKey);
}

export function shouldRestoreEditorHistoryFocus(activeElement, editorHost) {
  const ownerDocument = editorHost?.ownerDocument;
  return !activeElement
    || activeElement === ownerDocument?.body
    || activeElement === ownerDocument?.documentElement
    || Boolean(editorHost?.contains?.(activeElement));
}

export function restoreCodeViewFocusAfterHistory(codeView, scheduleFrame = globalThis.requestAnimationFrame) {
  if (!codeView || typeof scheduleFrame !== "function") return false;
  scheduleFrame(() => scheduleFrame(() => {
    const dom = codeView.dom;
    const ownerDocument = dom?.ownerDocument;
    const activeElement = ownerDocument?.activeElement;
    const canRestore = dom?.isConnected && (
      !activeElement
      || activeElement === ownerDocument?.body
      || activeElement === ownerDocument?.documentElement
      || dom.contains(activeElement)
    );
    if (canRestore && !codeView.hasFocus) codeView.focus();
  }));
  return true;
}

export function isEditorSelectAllShortcut(event) {
  return Boolean(event)
    && !event.altKey
    && !event.shiftKey
    && Boolean(event.metaKey || event.ctrlKey)
    && String(event.key || "").toLowerCase() === "a";
}

export function codeTabEdit(state, outdent = false) {
  const ranges = state?.selection?.ranges || [];
  if (ranges.length !== 1 || !state?.doc) return null;
  const selection = ranges[0];
  const source = state.doc.toString();
  const edit = sourceTabEdit(source, selection.from, selection.to, outdent);
  const backward = selection.anchor > selection.head;
  return {
    value: edit.value,
    changed: edit.value !== source,
    anchor: backward ? edit.selectionEnd : edit.selectionStart,
    head: backward ? edit.selectionStart : edit.selectionEnd
  };
}

export function codeBoundarySelectionDirection(state, key) {
  const ranges = state?.selection?.ranges || [];
  if (ranges.length !== 1) return null;
  const head = ranges[0].head;
  const line = state.doc.lineAt(head);
  if (key === "Shift-ArrowLeft" && head === 0) return "backward";
  if (key === "Shift-ArrowUp" && line.number === 1) return "backward";
  if (key === "Shift-ArrowRight" && head === state.doc.length) return "forward";
  if (key === "Shift-ArrowDown" && line.number === state.doc.lines) return "forward";
  return null;
}

export function codeBoundarySelectionKeyDirection(state, event) {
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  return codeBoundarySelectionDirection(state, `Shift-${event.key}`);
}

export function codeBoundaryNavigationDirection(state, key) {
  const ranges = state?.selection?.ranges || [];
  if (ranges.length !== 1 || !ranges[0].empty) return null;
  const head = ranges[0].head;
  const line = state.doc.lineAt(head);
  if (key === "ArrowLeft" && head === 0) return "backward";
  if (key === "ArrowUp" && line.number === 1) return "backward";
  if (key === "ArrowRight" && head === state.doc.length) return "forward";
  if (key === "ArrowDown" && line.number === state.doc.lines) return "forward";
  return null;
}

export function codeBoundaryNavigationKeyDirection(state, event) {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  return codeBoundaryNavigationDirection(state, event.key);
}

export function codeBoundaryDeletionDirection(state, key) {
  const ranges = state?.selection?.ranges || [];
  if (ranges.length !== 1 || !ranges[0].empty) return null;
  const head = ranges[0].head;
  if (key === "Backspace" && head === 0) return "backward";
  if (key === "Delete" && head === state.doc.length) return "forward";
  return null;
}

export function codeBoundaryDeletionKeyDirection(state, event) {
  // Word/line deletion modifiers still consume the immediately adjacent
  // physical newline before they can reach the word or line on the fence.
  // Hand those keys into the source control just like native Source mode.
  // Keep Shift-Delete native because it is the platform cut shortcut.
  if (event.shiftKey) return null;
  return codeBoundaryDeletionDirection(state, event.key);
}

export function codeBoundarySourcePosition(blockPosition, contentLength, direction) {
  return direction === "backward"
    ? codeContentSourcePosition(blockPosition, 0)
    : codeContentSourcePosition(blockPosition, contentLength);
}

export function codeContentSourcePosition(blockPosition, contentOffset) {
  return blockPosition + 1 + Math.max(0, contentOffset);
}

export function codeDragDocumentRange(
  blockPosition,
  contentLength,
  codeAnchor,
  targetPosition
) {
  const blockEnd = blockPosition + Math.max(0, contentLength) + 2;
  if (targetPosition >= blockPosition && targetPosition <= blockEnd) return null;
  return {
    anchor: codeContentSourcePosition(blockPosition, Math.min(Math.max(0, codeAnchor), contentLength)),
    head: Math.max(0, targetPosition)
  };
}

export function documentDragIntoCodeRange(
  blockPosition,
  contentLength,
  documentAnchor,
  codeHead
) {
  const reversed = codeDragDocumentRange(
    blockPosition,
    contentLength,
    codeHead,
    documentAnchor
  );
  return reversed ? { anchor: reversed.head, head: reversed.anchor } : null;
}

function closingFenceLineStart(source) {
  const openingLineEnd = source.indexOf("\n");
  if (openingLineEnd < 0) return null;
  const openingLine = source.slice(0, openingLineEnd).replace(/\r$/, "");
  const lineStart = source.lastIndexOf("\n") + 1;
  const closingLine = source.slice(lineStart).replace(/\r$/, "");
  if (/^---[\t ]*$/.test(openingLine) && /^(?:---|\.\.\.)[\t ]*$/.test(closingLine)) {
    return lineStart;
  }
  const opening = openingLine.match(/^[\t ]{0,3}(`{3,}|~{3,})/);
  if (!opening) return null;

  const closing = closingLine.match(/^[\t ]{0,3}(`{3,}|~{3,})[\t ]*$/);
  if (!closing || closing[1][0] !== opening[1][0] || closing[1].length < opening[1].length) {
    return null;
  }
  return lineStart;
}

function sourceLinesWithOffsets(source) {
  const lines = [];
  let start = 0;
  for (const match of source.matchAll(/\r\n|\n/g)) {
    lines.push({ start, text: source.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  lines.push({ start, text: source.slice(start) });
  return lines;
}

export function adjacentCodeSourceOffset(source, direction, column = 0) {
  const lines = sourceLinesWithOffsets(String(source ?? ""));
  const line = direction === "up" ? lines.at(-1) : lines[0];
  if (!line) return 0;
  const visualText = line.text.replace(/\r$/, "");
  const boundedColumn = Math.max(0, Math.min(visualText.length, Number(column) || 0));
  return line.start + boundedColumn;
}

function indentationColumns(prefix) {
  let columns = 0;
  for (const character of prefix) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else return -1;
  }
  return columns;
}

function indentedCodeLayout(source, content) {
  const sourceLines = sourceLinesWithOffsets(source);
  const contentLines = String(content ?? "").split("\n");
  if (sourceLines.length !== contentLines.length) return null;

  let contentStart = 0;
  const lines = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const sourceLine = sourceLines[index];
    const contentLine = contentLines[index];
    if (!sourceLine.text.endsWith(contentLine)) return null;
    const prefix = sourceLine.text.slice(0, sourceLine.text.length - contentLine.length);
    if (contentLine && indentationColumns(prefix) < 4) return null;
    if (!contentLine && /[^\t ]/.test(prefix)) return null;
    const sourceStart = sourceLine.start + prefix.length;
    lines.push({
      contentStart,
      contentEnd: contentStart + contentLine.length,
      sourceLineStart: sourceLine.start,
      sourceStart,
      sourceEnd: sourceStart + contentLine.length
    });
    contentStart += contentLine.length + (index + 1 < contentLines.length ? 1 : 0);
  }
  return { lines };
}

export function codeLineStartSourceOffset(source, content, contentHead = 0) {
  const layout = indentedCodeLayout(String(source ?? ""), String(content ?? ""));
  if (!layout) return null;
  const boundedHead = Math.max(0, Math.min(String(content ?? "").length, Number(contentHead) || 0));
  const line = layout.lines.find(({ contentStart, contentEnd }) =>
    boundedHead >= contentStart && boundedHead <= contentEnd
  ) || layout.lines.at(-1);
  if (!line || line.sourceLineStart >= line.sourceStart) return null;
  return line.sourceLineStart;
}

export function codeLineEndSourceOffset(source, content) {
  const value = String(source ?? "");
  if (String(content ?? "") !== "") return null;
  const openingEnd = value.indexOf("\n");
  if (openingEnd < 0) return null;
  const contentStart = openingEnd + 1;
  return closingFenceLineStart(value) === contentStart ? value.length : null;
}

export function emptyCodeEnterSource(source) {
  const value = String(source ?? "");
  const openingEnd = value.indexOf("\n");
  if (openingEnd < 0) return null;
  const contentStart = openingEnd + 1;
  if (closingFenceLineStart(value) !== contentStart) return null;
  const lineEnding = value[openingEnd - 1] === "\r" ? "\r\n" : "\n";
  return `${value.slice(0, contentStart)}${lineEnding}${value.slice(contentStart)}`;
}

export function emptyCodeSourceHistoryDirection(event, source, history, contentLength = 0) {
  if (!history || contentLength !== 0 || !isEditorHistoryShortcut(event)) return null;
  const key = String(event.key || "").toLowerCase();
  const redo = key === "y" || (key === "z" && event.shiftKey);
  if (redo && history.state === "undone" && source === history.beforeSource) return "redo";
  if (!redo && history.state === "applied" && source === history.afterSource) return "undo";
  return null;
}

export function codeContentOffsetAtSourceOffset(source, content, sourceOffset) {
  const indented = indentedCodeLayout(source, content);
  if (indented) {
    for (const line of indented.lines) {
      if (sourceOffset >= line.sourceStart && sourceOffset <= line.sourceEnd) {
        return line.contentStart + sourceOffset - line.sourceStart;
      }
    }
    return null;
  }

  const openingEnd = source.indexOf("\n");
  if (openingEnd < 0) return null;
  const contentStart = openingEnd + 1;
  const closingStart = closingFenceLineStart(source);
  let contentEnd = closingStart ?? source.length;
  if (closingStart != null && contentEnd > contentStart && source[contentEnd - 1] === "\n") {
    contentEnd -= 1;
    if (contentEnd > contentStart && source[contentEnd - 1] === "\r") contentEnd -= 1;
  }
  const normalize = (value) => value.replace(/\r\n/g, "\n");
  if (closingStart == null && normalize(source.slice(contentStart, contentEnd)) !== content) {
    if (contentEnd > contentStart && source[contentEnd - 1] === "\n") {
      contentEnd -= 1;
      if (contentEnd > contentStart && source[contentEnd - 1] === "\r") contentEnd -= 1;
    }
  }
  if (normalize(source.slice(contentStart, contentEnd)) !== content) return null;
  if (sourceOffset < contentStart || sourceOffset > contentEnd) return null;
  return normalize(source.slice(contentStart, sourceOffset)).length;
}

export function codeBoundaryNavigationSourceOffset(source, content, key, contentHead = 0) {
  const indented = indentedCodeLayout(source, content);
  if (indented) {
    const first = indented.lines[0];
    if (key === "ArrowLeft") return Math.max(0, first.sourceStart - 1);
    if (key === "ArrowUp") return Math.min(first.sourceStart, Math.max(0, contentHead));
    return source.length;
  }

  const openingEnd = source.indexOf("\n");
  if (openingEnd < 0) return key === "ArrowLeft" || key === "ArrowUp" ? 0 : source.length;

  const contentStart = openingEnd + 1;
  const contentEnd = Math.min(source.length, contentStart + content.length);
  const boundedHead = Math.max(0, Math.min(content.length, contentHead));
  const contentLineStart = content.lastIndexOf("\n", Math.max(0, boundedHead - 1)) + 1;
  const column = boundedHead - contentLineStart;
  const closingStart = closingFenceLineStart(source) ?? source.length;

  if (key === "ArrowLeft") {
    // Treat CRLF as the single source-file newline it represents. Returning
    // openingEnd here would place the raw-source caret between `\r` and `\n`,
    // a position normal editor navigation never exposes.
    return source.slice(Math.max(0, contentStart - 2), contentStart) === "\r\n"
      ? contentStart - 2
      : Math.max(0, contentStart - 1);
  }
  if (key === "ArrowRight") {
    // A semantic empty value can represent either `~~~\n~~~` or
    // `~~~\n\n~~~`. In the former the caret is directly before the closing
    // marker, while in the latter it occupies the physical blank content line.
    if (!content) return Math.min(source.length, closingStart + (closingStart === contentStart ? 1 : 0));
    return closingStart;
  }
  if (key === "ArrowUp") {
    const openingVisualEnd = source[openingEnd - 1] === "\r" ? openingEnd - 1 : openingEnd;
    return Math.min(openingVisualEnd, column);
  }
  if (key === "ArrowDown") {
    const closingLength = closingStart < source.length ? Math.max(0, source.length - closingStart) : 0;
    return closingStart + Math.min(closingLength, column);
  }
  return key === "Home" ? contentStart : contentEnd;
}

const tetherCodeViewBridge = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    tetherCodeViews.set(view.dom, view);
  }

  destroy() {
    tetherCodeViews.delete(this.view.dom);
  }
});

const tetherCodeHistoryFocus = EditorView.domEventHandlers({
  keydown(event, codeView) {
    if (isEditorHistoryShortcut(event)) restoreCodeViewFocusAfterHistory(codeView);
    return false;
  }
});

export function tetherCodeViewForElement(element) {
  const editor = typeof Element !== "undefined" && element instanceof Element
    ? element.closest(".cm-editor")
    : null;
  return editor ? tetherCodeViews.get(editor) || null : null;
}

function legacySupport(parser) {
  return new LanguageSupport(StreamLanguage.define(parser));
}

export const tetherCodeLanguages = [
  LanguageDescription.of({
    // An empty language name intentionally clears the Markdown fence info
    // string. Crepe's picker renders it through tetherCodeLanguageLabel as
    // “Text”, while the no-op mode also removes any previously active syntax
    // highlighting instead of leaving stale colors behind.
    name: "",
    alias: ["text", "plain", "plaintext", "plain text"],
    extensions: [],
    load: async () => legacySupport({
      startState: () => null,
      token: (stream) => {
        stream.skipToEnd();
        return null;
      }
    })
  }),
  LanguageDescription.of({
    name: "js",
    alias: ["javascript", "jsx", "mjs", "cjs"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true }))
  }),
  LanguageDescription.of({
    name: "ts",
    alias: ["typescript", "tsx"],
    extensions: ["ts", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true, typescript: true }))
  }),
  LanguageDescription.of({
    name: "json",
    alias: ["jsonc"],
    extensions: ["json", "jsonc"],
    load: () => import("@codemirror/lang-json").then(({ json }) => json())
  }),
  LanguageDescription.of({
    name: "css",
    alias: [],
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then(({ css }) => css())
  }),
  LanguageDescription.of({
    name: "scss",
    alias: [],
    extensions: ["scss"],
    load: () => import("@codemirror/lang-sass").then(({ sass }) => sass())
  }),
  LanguageDescription.of({
    name: "sass",
    alias: [],
    extensions: ["sass"],
    load: () => import("@codemirror/lang-sass").then(({ sass }) => sass({ indented: true }))
  }),
  LanguageDescription.of({
    name: "html",
    alias: ["htm", "markup"],
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then(({ html }) => html())
  }),
  LanguageDescription.of({
    name: "xml",
    alias: ["svg"],
    extensions: ["xml", "svg"],
    load: () => import("@codemirror/lang-xml").then(({ xml }) => xml())
  }),
  LanguageDescription.of({
    name: "markdown",
    alias: ["md", "mdown", "mkd"],
    extensions: ["md", "markdown", "mdown", "mkd"],
    load: () => import("@codemirror/lang-markdown").then(({ markdown }) => markdown())
  }),
  LanguageDescription.of({
    name: "python",
    alias: ["py"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then(({ python }) => python())
  }),
  LanguageDescription.of({
    name: "sql",
    alias: [],
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then(({ sql }) => sql())
  }),
  LanguageDescription.of({
    name: "yaml",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then(({ yaml }) => yaml())
  }),
  LanguageDescription.of({
    name: "cpp",
    alias: ["c", "h", "cc", "cxx", "hpp", "c++"],
    extensions: ["c", "h", "cc", "cpp", "cxx", "hpp"],
    load: () => import("@codemirror/lang-cpp").then(({ cpp }) => cpp())
  }),
  LanguageDescription.of({
    name: "csharp",
    alias: ["cs", "c#"],
    extensions: ["cs"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then(({ csharp }) => legacySupport(csharp))
  }),
  LanguageDescription.of({
    name: "go",
    alias: ["golang"],
    extensions: ["go"],
    load: () => import("@codemirror/lang-go").then(({ go }) => go())
  }),
  LanguageDescription.of({
    name: "java",
    alias: [],
    extensions: ["java"],
    load: () => import("@codemirror/lang-java").then(({ java }) => java())
  }),
  LanguageDescription.of({
    name: "kotlin",
    alias: ["kt", "kts"],
    extensions: ["kt", "kts"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then(({ kotlin }) => legacySupport(kotlin))
  }),
  LanguageDescription.of({
    name: "swift",
    alias: [],
    extensions: ["swift"],
    load: () => import("@codemirror/legacy-modes/mode/swift").then(({ swift }) => legacySupport(swift))
  }),
  LanguageDescription.of({
    name: "rust",
    alias: ["rs"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then(({ rust }) => rust())
  }),
  LanguageDescription.of({
    name: "ruby",
    alias: ["rb"],
    extensions: ["rb"],
    load: () => import("@codemirror/legacy-modes/mode/ruby").then(({ ruby }) => legacySupport(ruby))
  }),
  LanguageDescription.of({
    name: "shell",
    alias: ["bash", "cmd", "sh", "zsh"],
    extensions: ["sh", "bash", "zsh"],
    load: () => import("@codemirror/legacy-modes/mode/shell").then(({ shell }) => legacySupport(shell))
  }),
  LanguageDescription.of({
    name: "powershell",
    alias: ["ps1"],
    extensions: ["ps1"],
    load: () =>
      import("@codemirror/legacy-modes/mode/powershell").then(({ powerShell }) => legacySupport(powerShell))
  }),
  LanguageDescription.of({
    name: "toml",
    alias: [],
    extensions: ["toml"],
    load: () => import("@codemirror/legacy-modes/mode/toml").then(({ toml }) => legacySupport(toml))
  }),
  LanguageDescription.of({
    name: "lua",
    alias: [],
    extensions: ["lua"],
    load: () => import("@codemirror/legacy-modes/mode/lua").then(({ lua }) => legacySupport(lua))
  }),
  LanguageDescription.of({
    name: "diff",
    alias: ["patch"],
    extensions: ["diff", "patch"],
    load: () => import("@codemirror/legacy-modes/mode/diff").then(({ diff }) => legacySupport(diff))
  })
];

const tetherCodeLanguageLabels = {
  cpp: "C/C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  js: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  lua: "Lua",
  markdown: "Markdown",
  powershell: "PowerShell",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  sass: "Sass",
  scss: "SCSS",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  xml: "XML",
  yaml: "YAML"
};

export function tetherCodeLanguageLabel(value) {
  const source = String(value || "");
  if (!source) return "Text";
  const normalized = source.toLowerCase();
  const language = tetherCodeLanguages.find(
    ({ name, alias }) => name.toLowerCase() === normalized || alias.includes(normalized)
  );
  return language ? tetherCodeLanguageLabels[language.name] : source;
}

const tetherCodeTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--ink)"
  },
  ".cm-content": {
    caretColor: "var(--accent)"
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)"
  },
  "&.cm-focused .cm-activeLine, &.cm-focused .cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)"
  },
  ".cm-gutters": {
    color: "var(--ink3)"
  }
});

const tetherHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: "var(--syntax-variable)" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--syntax-function)" },
  { tag: [tags.number, tags.bool, tags.atom], color: "var(--syntax-number)" },
  { tag: [tags.operator, tags.operatorKeyword, tags.separator], color: "var(--syntax-operator)" },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: "var(--syntax-string)" },
  { tag: [tags.tagName, tags.typeName, tags.className], color: "var(--syntax-tag)" },
  { tag: tags.attributeName, color: "var(--syntax-attr)" },
  { tag: [tags.meta, tags.comment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.heading, color: "var(--ink)", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.invalid, color: "var(--syntax-deleted)" }
]);

export const tetherCodeExtensions = [
  tetherCodeViewBridge,
  tetherCodeHistoryFocus,
  indentUnit.of("\t"),
  tetherCodeTheme,
  syntaxHighlighting(tetherHighlightStyle)
];
