import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";
import "katex/dist/katex.min.css";

function DocumentSurface({
  content,
  copyText,
  dirty,
  documentEyebrow,
  editorContent,
  LoadingGlyph,
  loading,
  loadingMessage,
  loadingTitle,
  onContextMenu,
  onEditorChange,
  onSearchResultCount,
  previewRef,
  searchActiveIndex = 0,
  searchQuery = "",
  sourceLabel,
  textAlignment = "smart",
  viewMode
}) {
  const gutterRef = useRef(null);
  const textareaRef = useRef(null);
  const scrollSyncRef = useRef(false);
  const showEditor = viewMode === "source" || viewMode === "split";
  const showPreview = viewMode === "preview" || viewMode === "split";
  const showEyebrow = documentEyebrow && documentEyebrow !== "No source";
  const lineNumbers = useMemo(() => {
    const lineCount = Math.max(editorContent.split(/\r\n|\r|\n/).length, 1);
    return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  }, [editorContent]);

  useEffect(() => {
    if (!showEditor || !gutterRef.current || !textareaRef.current) return;
    // Track the textarea via transform, not scrollTop: long lines give the
    // textarea a horizontal scrollbar that shortens its scroll range, so a
    // scrollTop-synced gutter would clamp early and drift near the bottom.
    gutterRef.current.style.transform = `translateY(${-textareaRef.current.scrollTop}px)`;
  }, [editorContent, showEditor]);

  function syncScrollRatio(source, target) {
    if (!source || !target || scrollSyncRef.current) return;
    const sourceMax = source.scrollHeight - source.clientHeight;
    if (sourceMax <= 0) return;
    const targetMax = target.scrollHeight - target.clientHeight;
    scrollSyncRef.current = true;
    target.scrollTop = (source.scrollTop / sourceMax) * targetMax;
    window.requestAnimationFrame(() => {
      scrollSyncRef.current = false;
    });
  }

  function syncLineNumberScroll(event) {
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`;
    }
    if (viewMode === "split") syncScrollRatio(event.currentTarget, previewRef?.current);
  }

  function syncPreviewScroll(event) {
    if (viewMode === "split") syncScrollRatio(event.currentTarget, textareaRef.current);
  }

  useEffect(() => {
    if (!showPreview || loading) return undefined;
    const pane = previewRef?.current;
    const article = pane?.querySelector(".markdown-document");
    if (!article) return undefined;

    let raf = 0;
    function run() {
      raf = 0;
      markLooseJustification(article, textAlignment);
    }
    function schedule() {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        raf = window.requestAnimationFrame(run);
      });
    }

    schedule();
    const ResizeObserverClass = window.ResizeObserver;
    const observer = ResizeObserverClass ? new ResizeObserverClass(schedule) : null;
    observer?.observe(article);
    window.addEventListener("resize", schedule);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      clearLooseJustification(article);
    };
  }, [content, loading, previewRef, showPreview, textAlignment, viewMode]);

  useEffect(() => {
    if (loading) return undefined;
    const query = searchQuery.trim();
    const pane = previewRef?.current;
    const article = pane?.querySelector(".markdown-document");
    const highlightSupported = hasHighlightApi();

    clearSearchHighlights();
    clearDomSearchMarks(article);

    if (!query) {
      onSearchResultCount?.(0);
      return undefined;
    }

    if (showPreview && article) {
      const matches = collectSearchMatches(article, query);
      const ranges = matches.map((match) => match.range);
      const activeIndex = getActiveSearchIndex(searchActiveIndex, ranges.length);
      onSearchResultCount?.(ranges.length);

      if (highlightSupported) {
        const passiveRanges = ranges.filter((_, index) => index !== activeIndex);
        CSS.highlights.set("tether-search", new Highlight(...passiveRanges));
        if (ranges[activeIndex]) CSS.highlights.set("tether-search-active", new Highlight(ranges[activeIndex]));
      } else {
        const marks = applyDomSearchMarks(matches, activeIndex);
        if (marks[activeIndex]) {
          scrollElementIntoPane(marks[activeIndex], pane);
          return () => {
            clearDomSearchMarks(article);
            clearSearchHighlights();
          };
        }
      }

      if (ranges[activeIndex]) {
        scrollRangeIntoPane(ranges[activeIndex], pane);
      }

      return () => {
        clearDomSearchMarks(article);
        clearSearchHighlights();
      };
    }

    if (showEditor && textareaRef.current) {
      const ranges = findTextRanges(editorContent, query);
      const activeIndex = getActiveSearchIndex(searchActiveIndex, ranges.length);
      onSearchResultCount?.(ranges.length);
      if (ranges[activeIndex]) {
        selectTextareaRange(textareaRef.current, ranges[activeIndex]);
      }
    } else {
      onSearchResultCount?.(0);
    }

    return () => {
      clearDomSearchMarks(article);
      clearSearchHighlights();
    };
  }, [
    content,
    editorContent,
    loading,
    onSearchResultCount,
    previewRef,
    searchActiveIndex,
    searchQuery,
    showEditor,
    showPreview,
    viewMode
  ]);

  function handlePreviewContextMenu(event) {
    const selection = getWindowSelectionText();
    onContextMenu?.(event, { surface: "preview", selectedText: selection });
  }

  function handleEditorContextMenu(event) {
    const textarea = textareaRef.current;
    const selectedText = textarea ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) : "";
    onContextMenu?.(event, { surface: "editor", selectedText });
  }

  if (loading) {
    return (
      <DocumentLoading
        LoadingGlyph={LoadingGlyph}
        loadingMessage={loadingMessage}
        loadingTitle={loadingTitle}
        previewRef={previewRef}
      />
    );
  }

  return (
    <div className={`document-grid mode-${viewMode}`}>
      {showEditor && (
        <section className="editor-pane" aria-label="Markdown source editor">
          <div className="pane-title">
            <span>Source</span>
            {dirty && <strong>Unsaved</strong>}
          </div>
          <div className="source-editor">
            <div className="line-gutter" aria-hidden="true">
              <pre ref={gutterRef} className="line-gutter-track">
                {lineNumbers}
              </pre>
            </div>
            <textarea
              ref={textareaRef}
              spellCheck="false"
              value={editorContent}
              onChange={onEditorChange}
              onContextMenu={handleEditorContextMenu}
              onScroll={syncLineNumberScroll}
              aria-label="Markdown source"
              wrap="off"
            />
          </div>
        </section>
      )}

      {showPreview && (
        <section
          ref={previewRef}
          className="preview-pane"
          aria-label="Rendered Markdown preview"
          onContextMenu={handlePreviewContextMenu}
          onScroll={syncPreviewScroll}
        >
          <article className={`markdown-document alignment-${textAlignment}`} lang="en">
            {showEyebrow && (
              <div className="markdown-eyebrow">
                <span>{documentEyebrow}</span>
                <i />
                <span>{sourceLabel}</span>
              </div>
            )}
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                a: LinkRenderer,
                pre: PreRenderer,
                code: (props) => <CodeRenderer {...props} copyText={copyText} />,
                h1: HeadingRenderer,
                h2: HeadingRenderer,
                h3: HeadingRenderer,
                h4: HeadingRenderer,
                h5: HeadingRenderer,
                h6: HeadingRenderer
              }}
            >
              {content}
            </ReactMarkdown>
          </article>
        </section>
      )}
    </div>
  );
}

function DocumentLoading({ LoadingGlyph, loadingMessage, loadingTitle, previewRef }) {
  return (
    <div className="document-grid mode-preview is-loading">
      <section ref={previewRef} className="preview-pane preview-loading-pane" aria-label="Opening document">
        <article className="document-loading" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true">
            {LoadingGlyph ? <LoadingGlyph pingKey="loading" /> : null}
          </span>
          <strong>{loadingTitle || "opening source"}</strong>
          <span>{loadingMessage || "Preparing the Markdown view."}</span>
        </article>
      </section>
    </div>
  );
}

function LinkRenderer(props) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

// Tag headings with a stable anchor keyed on their source line so the outline
// panel can scroll to them. The line matches lib/outline.js parseOutline().
function HeadingRenderer({ node, children, ...props }) {
  const level = Math.min(Math.max(Number(String(node?.tagName || "h1").slice(1)) || 1, 1), 6);
  const line = node?.position?.start?.line;
  const Tag = `h${level}`;
  return (
    <Tag id={line ? `tether-h-${line}` : undefined} {...props}>
      {children}
    </Tag>
  );
}

function PreRenderer({ children }) {
  return <>{children}</>;
}

function CodeRenderer({ inline, className = "", children, copyText, node, ...props }) {
  const rawCode = String(children ?? "");
  const languageMatch = /language-([\w-]+)/i.exec(className);
  const language = normalizeCodeLanguage(languageMatch?.[1] || "");
  const isBlock = !inline && (languageMatch || rawCode.includes("\n"));

  if (isBlock) {
    return <CodeBlock code={rawCode.replace(/\n$/, "")} copyText={copyText} language={language} />;
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function CodeBlock({ code, copyText, language }) {
  const [copyStatus, setCopyStatus] = useState("idle");
  const copyTimerRef = useRef(null);
  const normalizedCode = useMemo(() => code.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), [code]);
  const lines = useMemo(() => splitCodeLines(normalizedCode), [normalizedCode]);
  const tokenizedLines = useMemo(
    () => lines.map((line) => highlightCodeLine(line, language)),
    [lines, language]
  );
  const languageLabel = getCodeLanguageLabel(language);
  const copied = copyStatus === "copied";
  const copyFailed = copyStatus === "failed";

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function copyCode() {
    const ok = await copyText?.(normalizedCode);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    setCopyStatus(ok ? "copied" : "failed");
    copyTimerRef.current = window.setTimeout(() => {
      setCopyStatus("idle");
      copyTimerRef.current = null;
    }, 1600);
  }

  return (
    <div className={`code-block ${getCodeLanguageClass(language)}`}>
      <div className="code-block-toolbar">
        <span>{languageLabel}</span>
        <button
          className={`code-copy-button ${copied ? "copied" : ""} ${copyFailed ? "failed" : ""}`}
          type="button"
          onClick={copyCode}
          aria-label={copied ? "Code copied" : copyFailed ? "Copy failed" : "Copy code block"}
          title={copied ? "Copied" : copyFailed ? "Copy failed" : "Copy code"}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "copied" : copyFailed ? "failed" : "copy"}</span>
        </button>
      </div>
      <div className="code-block-body">
        <pre className="code-line-numbers" aria-hidden="true">
          {lines.map((_, index) => (
            <span className="code-line-number" key={`line-number-${index}`}>
              {index + 1}
            </span>
          ))}
        </pre>
        <pre className="code-block-pre">
          <code>
            {tokenizedLines.map((tokens, lineIndex) => (
              <span className="code-line" key={`code-line-${lineIndex}`}>
                {tokens.map((token, tokenIndex) => renderCodeToken(token, tokenIndex))}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}

function renderCodeToken(token, index) {
  if (!token.type) return <React.Fragment key={index}>{token.text}</React.Fragment>;
  return (
    <span className={`code-token token-${token.type}`} key={index}>
      {token.text}
    </span>
  );
}

const CODE_LANGUAGE_ALIASES = {
  bash: "shell",
  cjs: "javascript",
  cmd: "shell",
  conf: "text",
  cpp: "cpp",
  csharp: "csharp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  html: "markup",
  ini: "text",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "java",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  patch: "diff",
  powershell: "powershell",
  ps1: "powershell",
  py: "python",
  python: "python",
  rb: "ruby",
  rs: "rust",
  rust: "rust",
  scss: "css",
  sh: "shell",
  shell: "shell",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell"
};

const CODE_LANGUAGE_LABELS = {
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "diff",
  go: "Go",
  javascript: "JavaScript",
  json: "JSON",
  java: "Java",
  markdown: "Markdown",
  markup: "HTML",
  powershell: "PowerShell",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  shell: "Shell",
  sql: "SQL",
  text: "plain text",
  typescript: "TypeScript",
  yaml: "YAML"
};

const JS_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "export", "extends", "false", "finally", "for", "from", "function", "if",
  "import", "in", "instanceof", "let", "new", "null", "of", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with", "yield"
]);

const TS_KEYWORDS = new Set([
  ...JS_KEYWORDS,
  "abstract", "as", "declare", "enum", "implements", "interface", "keyof", "namespace", "private",
  "protected", "public", "readonly", "type"
]);

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while",
  "with", "yield"
]);

const SHELL_KEYWORDS = new Set([
  "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in",
  "local", "then", "while"
]);

const C_LIKE_KEYWORDS = new Set([
  "auto", "bool", "break", "case", "catch", "char", "class", "const", "continue", "default",
  "delete", "do", "double", "else", "enum", "extern", "false", "float", "for", "if", "inline",
  "int", "long", "namespace", "new", "nullptr", "private", "protected", "public", "return",
  "short", "sizeof", "static", "struct", "switch", "template", "this", "throw", "true", "try",
  "typedef", "typename", "union", "unsigned", "using", "void", "volatile", "while"
]);

const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "defer", "default", "else", "fallthrough", "for",
  "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select",
  "struct", "switch", "type", "var"
]);

const RUST_KEYWORDS = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
  "use", "where", "while"
]);

const JAVA_KEYWORDS = new Set([
  ...C_LIKE_KEYWORDS,
  "abstract", "boolean", "extends", "final", "implements", "import", "interface", "native",
  "package", "synchronized", "throws", "transient"
]);

const SQL_KEYWORDS = new Set([
  "alter", "and", "as", "asc", "by", "case", "create", "delete", "desc", "distinct", "drop",
  "else", "end", "from", "group", "having", "insert", "into", "is", "join", "left", "limit",
  "not", "null", "on", "or", "order", "right", "select", "set", "then", "union", "update",
  "values", "when", "where"
]);

const COMMON_BUILTINS = new Set([
  "Array", "Boolean", "Date", "Error", "JSON", "Map", "Math", "Number", "Object", "Promise",
  "Set", "String", "console", "document", "process", "window"
]);

function normalizeCodeLanguage(language) {
  const normalized = String(language || "")
    .trim()
    .toLowerCase()
    .replace(/^language-/, "");
  return CODE_LANGUAGE_ALIASES[normalized] || normalized || "text";
}

function getCodeLanguageLabel(language) {
  return CODE_LANGUAGE_LABELS[language] || language || "plain text";
}

function getCodeLanguageClass(language) {
  return `language-${String(language || "text").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "text"}`;
}

function splitCodeLines(code) {
  const lines = String(code || "").split("\n");
  return lines.length ? lines : [""];
}

function highlightCodeLine(line, language) {
  const group = getCodeLanguageGroup(language);

  if (!line) return [];
  if (group === "diff") return highlightDiffLine(line);
  if (group === "markdown") return highlightMarkdownLine(line);
  if (group === "markup") return highlightMarkupLine(line);
  if (group === "json") return highlightDataLine(line, "json");
  if (group === "yaml") return highlightDataLine(line, "yaml");
  if (group === "css") return highlightCssLine(line);

  return highlightGenericCodeLine(line, group);
}

function getCodeLanguageGroup(language) {
  if (["javascript", "typescript", "python", "shell", "powershell", "c", "cpp", "csharp", "go", "rust", "java", "ruby", "sql"].includes(language)) {
    return language;
  }
  if (language === "markup") return "markup";
  if (language === "json") return "json";
  if (language === "yaml") return "yaml";
  if (language === "css") return "css";
  if (language === "markdown") return "markdown";
  if (language === "diff") return "diff";
  return "text";
}

function highlightDiffLine(line) {
  if (/^\+/.test(line) && !/^\+\+\+/.test(line)) return [{ text: line, type: "inserted" }];
  if (/^-/.test(line) && !/^---/.test(line)) return [{ text: line, type: "deleted" }];
  if (/^@@/.test(line)) return [{ text: line, type: "keyword" }];
  if (/^(diff|index|\+\+\+|---)\b/.test(line)) return [{ text: line, type: "comment" }];
  return [{ text: line, type: "" }];
}

function highlightMarkdownLine(line) {
  if (/^\s*(`{3,}|~{3,})/.test(line)) return [{ text: line, type: "comment" }];

  const heading = line.match(/^(\s{0,3}#{1,6})(\s+.*)?$/);
  if (heading) {
    return [
      { text: heading[1], type: "keyword" },
      { text: heading[2] || "", type: "heading" }
    ];
  }

  const quote = line.match(/^(\s*>+\s?)(.*)$/);
  if (quote) {
    return [
      { text: quote[1], type: "comment" },
      ...highlightInlineCode(quote[2])
    ];
  }

  const list = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/);
  if (list) {
    return [
      { text: list[1], type: "keyword" },
      ...highlightInlineCode(list[2])
    ];
  }

  return highlightInlineCode(line);
}

function highlightInlineCode(line) {
  return tokenizeWithPattern(line, /(`[^`]*`|\*\*[^*]+\*\*|\*[^*]+\*)/g, (match) => {
    if (match.startsWith("`")) return "string";
    return "keyword";
  });
}

function highlightMarkupLine(line) {
  return tokenizeWithPattern(
    line,
    /(<!--.*?-->|<!\[CDATA\[.*?\]\]>|<\/?[A-Za-z][\w:-]*|\/?>|[A-Za-z_:][\w:.-]*(?=\s*=)|=(?!=)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
    (match) => {
      if (match.startsWith("<!--") || match.startsWith("<![")) return "comment";
      if (match.startsWith("<")) return "tag";
      if (match === ">" || match === "/>" || match === "=") return "punctuation";
      if (match.startsWith("\"") || match.startsWith("'")) return "string";
      return "attr";
    }
  );
}

function highlightDataLine(line, kind) {
  const pattern =
    kind === "json"
      ? /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}\[\],:])/g
      : /(#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[\w.-]+(?=\s*:)|\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b|[{}\[\],:|-])/g;

  return tokenizeWithPattern(line, pattern, (match, index) => {
    const remainder = line.slice(index + match.length).trimStart();
    if (match.startsWith("#")) return "comment";
    if (match.startsWith("\"") || match.startsWith("'")) return remainder.startsWith(":") ? "property" : "string";
    if (/^[\w.-]+$/.test(match) && remainder.startsWith(":")) return "property";
    if (/^(true|false|null|yes|no|on|off)$/i.test(match)) return "keyword";
    if (/^-?\d/.test(match)) return "number";
    return "punctuation";
  });
}

function highlightCssLine(line) {
  return tokenizeWithPattern(
    line,
    /(\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms)?\b|--?[\w-]+(?=\s*:)|[.#]?[_a-zA-Z-][\w-]*(?=\s*[,{])|\b(?:var|calc|min|max|clamp|url|rgb|rgba|hsl|hsla|linear-gradient|color-mix)\b|[{}():;,>+~])/g,
    (match) => {
      if (match.startsWith("/*")) return "comment";
      if (match.startsWith("\"") || match.startsWith("'")) return "string";
      if (match.startsWith("#") || /^-?\d/.test(match)) return "number";
      if (/^--?[\w-]+$/.test(match)) return "property";
      if (/^(var|calc|min|max|clamp|url|rgb|rgba|hsl|hsla|linear-gradient|color-mix)$/.test(match)) return "function";
      if (/^[.#]?[_a-zA-Z-]/.test(match)) return "tag";
      return "punctuation";
    }
  );
}

const GENERIC_PATTERN_CACHE = new Map();
const DOM_SHOW_TEXT = 4;
const DOM_FILTER_ACCEPT = 1;
const DOM_FILTER_REJECT = 2;

function getGenericPattern(group) {
  let pattern = GENERIC_PATTERN_CACHE.get(group);
  if (!pattern) {
    const commentSource = getCommentPatternSource(group);
    pattern = new RegExp(
      `(${commentSource}|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`|\\b\\d+(?:\\.\\d+)?\\b|\\b[A-Za-z_$][\\w$]*\\b|[{}()[\\].,;:+\\-*/%=!<>|&?~^@]+)`,
      "g"
    );
    GENERIC_PATTERN_CACHE.set(group, pattern);
  }
  return pattern;
}

function highlightGenericCodeLine(line, group) {
  const keywords = getKeywordSet(group);
  const pattern = getGenericPattern(group);

  return tokenizeWithPattern(line, pattern, (match, index) => {
    if (isCommentToken(match, group)) return "comment";
    if (match.startsWith("\"") || match.startsWith("'") || match.startsWith("`")) return "string";
    if (/^\d/.test(match)) return "number";
    if (/^[A-Za-z_$]/.test(match)) {
      const lower = match.toLowerCase();
      const next = nextNonSpace(line, index + match.length);
      const previous = previousNonSpace(line, index - 1);

      if (keywords.has(match) || keywords.has(lower)) return "keyword";
      if (COMMON_BUILTINS.has(match) || COMMON_BUILTINS.has(lower)) return "builtin";
      if (next === "(") return "function";
      if (previous === "." || next === ":") return "property";
      return "variable";
    }

    return /[{}()[\].,;]/.test(match) ? "punctuation" : "operator";
  });
}

function getKeywordSet(group) {
  if (group === "javascript") return JS_KEYWORDS;
  if (group === "typescript") return TS_KEYWORDS;
  if (group === "python") return PYTHON_KEYWORDS;
  if (group === "shell" || group === "powershell") return SHELL_KEYWORDS;
  if (group === "go") return GO_KEYWORDS;
  if (group === "rust") return RUST_KEYWORDS;
  if (group === "java") return JAVA_KEYWORDS;
  if (group === "sql") return SQL_KEYWORDS;
  if (group === "c" || group === "cpp" || group === "csharp") return C_LIKE_KEYWORDS;
  return JS_KEYWORDS;
}

function getCommentPatternSource(group) {
  if (group === "python" || group === "shell" || group === "powershell" || group === "ruby") return "#.*$";
  if (group === "sql") return "--.*$|/\\*.*?\\*/";
  return "\\/\\/.*$|\\/\\*.*?\\*\\/";
}

function isCommentToken(token, group) {
  if (token.startsWith("/*") || token.startsWith("//") || token.startsWith("--")) return true;
  return (group === "python" || group === "shell" || group === "powershell" || group === "ruby") && token.startsWith("#");
}

function tokenizeWithPattern(line, pattern, classify) {
  const tokens = [];
  let lastIndex = 0;
  let match;

  pattern.lastIndex = 0;
  while ((match = pattern.exec(line))) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index), type: "" });
    }
    tokens.push({ text: match[0], type: classify(match[0], match.index) });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex), type: "" });
  }

  return tokens;
}

function nextNonSpace(line, index) {
  const match = line.slice(index).match(/\S/);
  return match ? match[0] : "";
}

function previousNonSpace(line, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (/\S/.test(line[cursor])) return line[cursor];
  }
  return "";
}

function markLooseJustification(article, textAlignment) {
  clearLooseJustification(article);
  if (textAlignment !== "smart") return;

  for (const block of article.querySelectorAll("p, li, blockquote")) {
    if (block.closest("pre, .code-block")) continue;
    if (blockHasLooseJustification(block)) block.classList.add("loose-justify");
  }
}

function clearLooseJustification(article) {
  article?.querySelectorAll(".loose-justify").forEach((node) => node.classList.remove("loose-justify"));
}

function blockHasLooseJustification(block) {
  const text = block.textContent || "";
  if (text.trim().length < 80) return false;

  const rects = collectWordRects(block);
  if (rects.length < 6) return false;

  const blockWidth = block.getBoundingClientRect().width;
  const fontSize = Number.parseFloat(window.getComputedStyle(block).fontSize) || 16;
  const gapLimit = Math.max(20, Math.min(44, fontSize * 1.55));
  const lines = groupRectsByLine(rects);

  return lines.some((line) => {
    if (line.length < 3) return false;
    const sorted = line.sort((left, right) => left.left - right.left);
    const left = sorted[0].left;
    const right = sorted[sorted.length - 1].right;
    if (right - left < blockWidth * 0.62) return false;
    return sorted.some((rect, index) => {
      const next = sorted[index + 1];
      if (!next) return false;
      return next.left - rect.right > gapLimit;
    });
  });
}

function collectWordRects(root) {
  const rects = [];
  const walker = document.createTreeWalker(root, DOM_SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return DOM_FILTER_REJECT;
      if (isInsideMeasurementSkip(node.parentElement)) return DOM_FILTER_REJECT;
      return DOM_FILTER_ACCEPT;
    }
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || "";
    const pattern = /\S+/g;
    let match;

    while ((match = pattern.exec(text))) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) {
          rects.push({
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width
          });
        }
      }
      range.detach?.();
    }
  }

  return rects.sort((left, right) => left.top - right.top || left.left - right.left);
}

function isInsideMeasurementSkip(element) {
  return Boolean(element?.closest(".katex, .markdown-eyebrow, .code-block-toolbar, .code-line-numbers, button"));
}

function groupRectsByLine(rects) {
  const lines = [];

  for (const rect of rects) {
    const line = lines.find((candidate) => Math.abs(candidate.top - rect.top) < 3);
    if (line) {
      line.rects.push(rect);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ top: rect.top, bottom: rect.bottom, rects: [rect] });
    }
  }

  return lines.map((line) => line.rects);
}

function hasHighlightApi() {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
}

function clearSearchHighlights() {
  if (!hasHighlightApi()) return;
  CSS.highlights.delete("tether-search");
  CSS.highlights.delete("tether-search-active");
}

function collectSearchMatches(root, query) {
  const matches = [];
  const needle = query.toLowerCase();
  if (!needle) return matches;

  const walker = document.createTreeWalker(root, DOM_SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return DOM_FILTER_REJECT;
      if (isInsideSearchSkip(node.parentElement)) return DOM_FILTER_REJECT;
      return DOM_FILTER_ACCEPT;
    }
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || "";
    const lowerText = text.toLowerCase();
    let index = lowerText.indexOf(needle);

    while (index !== -1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      matches.push({ node, start: index, end: index + query.length, range });
      index = lowerText.indexOf(needle, index + needle.length);
    }
  }

  return matches;
}

function isInsideSearchSkip(element) {
  return Boolean(element?.closest(".markdown-eyebrow, .code-block-toolbar, .code-line-numbers, button, input, textarea"));
}

function findTextRanges(text, query) {
  const ranges = [];
  const needle = query.toLowerCase();
  if (!needle) return ranges;

  const lowerText = String(text || "").toLowerCase();
  let index = lowerText.indexOf(needle);
  while (index !== -1) {
    ranges.push({ start: index, end: index + query.length });
    index = lowerText.indexOf(needle, index + needle.length);
  }
  return ranges;
}

function getActiveSearchIndex(index, count) {
  if (!count) return -1;
  return ((index % count) + count) % count;
}

function applyDomSearchMarks(matches, activeIndex) {
  const marks = [];

  [...matches].reverse().forEach((match, reverseIndex) => {
    const originalIndex = matches.length - reverseIndex - 1;
    const range = document.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);

    const mark = document.createElement("mark");
    mark.className = `tether-search-mark ${originalIndex === activeIndex ? "active" : ""}`;
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    marks[originalIndex] = mark;
  });

  return marks;
}

function clearDomSearchMarks(root) {
  root?.querySelectorAll("mark.tether-search-mark").forEach((mark) => {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
    parent?.normalize?.();
  });
}

function scrollRangeIntoPane(range, pane) {
  const rect = range.getBoundingClientRect?.() || range.getClientRects?.()[0];
  if (!rect || !pane) return;

  const paneRect = pane.getBoundingClientRect();
  pane.scrollTo({
    top: Math.max(0, pane.scrollTop + rect.top - paneRect.top - 84),
    behavior: "smooth"
  });
}

function scrollElementIntoPane(element, pane) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || !pane) return;

  const paneRect = pane.getBoundingClientRect();
  pane.scrollTo({
    top: Math.max(0, pane.scrollTop + rect.top - paneRect.top - 84),
    behavior: "smooth"
  });
}

function selectTextareaRange(textarea, range) {
  textarea.setSelectionRange(range.start, range.end);
  const textBefore = textarea.value.slice(0, range.start);
  const lineIndex = textBefore.split(/\r\n|\r|\n/).length - 1;
  const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 2);
}

function getWindowSelectionText() {
  try {
    return window.getSelection?.()?.toString() || "";
  } catch {
    return "";
  }
}

export default React.memo(DocumentSurface);
