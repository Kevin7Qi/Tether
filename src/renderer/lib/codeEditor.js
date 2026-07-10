import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

function legacySupport(parser) {
  return new LanguageSupport(StreamLanguage.define(parser));
}

export const tetherCodeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx", "mjs", "cjs"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true }))
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx"],
    extensions: ["ts", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then(({ javascript }) => javascript({ jsx: true, typescript: true }))
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json", "jsonc"],
    extensions: ["json", "jsonc"],
    load: () => import("@codemirror/lang-json").then(({ json }) => json())
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then(({ css }) => css())
  }),
  LanguageDescription.of({
    name: "SCSS",
    alias: ["scss", "sass"],
    extensions: ["scss", "sass"],
    load: () => import("@codemirror/lang-sass").then(({ sass }) => sass())
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html", "htm", "markup"],
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then(({ html }) => html())
  }),
  LanguageDescription.of({
    name: "XML",
    alias: ["xml", "svg"],
    extensions: ["xml", "svg"],
    load: () => import("@codemirror/lang-xml").then(({ xml }) => xml())
  }),
  LanguageDescription.of({
    name: "Markdown",
    alias: ["md", "markdown", "mdown", "mkd"],
    extensions: ["md", "markdown", "mdown", "mkd"],
    load: () => import("@codemirror/lang-markdown").then(({ markdown }) => markdown())
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py", "python"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then(({ python }) => python())
  }),
  LanguageDescription.of({
    name: "SQL",
    alias: ["sql"],
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then(({ sql }) => sql())
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yaml", "yml"],
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then(({ yaml }) => yaml())
  }),
  LanguageDescription.of({
    name: "C/C++",
    alias: ["c", "h", "cc", "cpp", "cxx", "hpp"],
    extensions: ["c", "h", "cc", "cpp", "cxx", "hpp"],
    load: () => import("@codemirror/lang-cpp").then(({ cpp }) => cpp())
  }),
  LanguageDescription.of({
    name: "C#",
    alias: ["cs", "csharp"],
    extensions: ["cs"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then(({ csharp }) => legacySupport(csharp))
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    extensions: ["go"],
    load: () => import("@codemirror/lang-go").then(({ go }) => go())
  }),
  LanguageDescription.of({
    name: "Java",
    alias: ["java", "kt", "kotlin"],
    extensions: ["java", "kt"],
    load: () => import("@codemirror/lang-java").then(({ java }) => java())
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs", "rust"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then(({ rust }) => rust())
  }),
  LanguageDescription.of({
    name: "Ruby",
    alias: ["rb", "ruby"],
    extensions: ["rb"],
    load: () => import("@codemirror/legacy-modes/mode/ruby").then(({ ruby }) => legacySupport(ruby))
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["bash", "cmd", "sh", "shell", "zsh"],
    extensions: ["sh", "bash", "zsh"],
    load: () => import("@codemirror/legacy-modes/mode/shell").then(({ shell }) => legacySupport(shell))
  }),
  LanguageDescription.of({
    name: "PowerShell",
    alias: ["powershell", "ps1"],
    extensions: ["ps1"],
    load: () =>
      import("@codemirror/legacy-modes/mode/powershell").then(({ powerShell }) => legacySupport(powerShell))
  }),
  LanguageDescription.of({
    name: "Diff",
    alias: ["diff", "patch"],
    extensions: ["diff", "patch"],
    load: () => import("@codemirror/legacy-modes/mode/diff").then(({ diff }) => legacySupport(diff))
  })
];

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
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "transparent"
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

export const tetherCodeExtensions = [tetherCodeTheme, syntaxHighlighting(tetherHighlightStyle)];
