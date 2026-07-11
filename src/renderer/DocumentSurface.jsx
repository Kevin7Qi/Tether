import React, { useEffect, useMemo, useRef } from "react";
import WysiwygSurface from "./WysiwygSurface.jsx";
import { EDITOR_MODE_READING, EDITOR_MODE_SOURCE } from "./lib/editorModes.js";
import { parseOutline } from "./lib/outline.js";

const DOM_SHOW_TEXT = 4;
const DOM_FILTER_ACCEPT = 1;
const DOM_FILTER_REJECT = 2;

function DocumentSurface({
  copyText,
  dirty,
  documentId,
  documentEyebrow,
  editorApiRef,
  editorContent,
  LoadingGlyph,
  loading,
  loadingMessage,
  loadingTitle,
  onContextMenu,
  onEditorChange,
  onNotice,
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
  const showSource = viewMode === EDITOR_MODE_SOURCE;
  const showWysiwyg = !showSource;
  const readingMode = viewMode === EDITOR_MODE_READING;
  const showEyebrow = documentEyebrow && documentEyebrow !== "No source";
  const lineNumbers = useMemo(() => {
    const lineCount = Math.max(editorContent.split(/\r\n|\r|\n/).length, 1);
    return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  }, [editorContent]);

  useEffect(() => {
    if (!showSource || !gutterRef.current || !textareaRef.current) return;
    gutterRef.current.style.transform = `translateY(${-textareaRef.current.scrollTop}px)`;
  }, [editorContent, showSource]);

  useEffect(() => {
    if (!showWysiwyg || loading) return undefined;
    const pane = previewRef?.current;
    if (!pane) return undefined;

    let raf = 0;
    raf = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(() => {
        const headings = pane.querySelectorAll(
          ".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6"
        );
        const outline = parseOutline(editorContent);
        headings.forEach((heading, index) => {
          const item = outline[index];
          if (item) heading.id = `tether-h-${item.line}`;
        });
      });
    });

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [editorContent, loading, previewRef, showWysiwyg]);

  useEffect(() => {
    if (!showWysiwyg || loading) return undefined;
    const editor = previewRef?.current?.querySelector(".ProseMirror");
    if (!editor) return undefined;

    let raf = 0;
    function run() {
      raf = 0;
      markSmartJustification(editor, textAlignment);
    }
    function schedule() {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        raf = window.requestAnimationFrame(run);
      });
    }

    schedule();
    const observer = window.ResizeObserver ? new ResizeObserver(schedule) : null;
    observer?.observe(editor);
    window.addEventListener("resize", schedule);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      clearSmartJustification(editor);
    };
  }, [editorContent, loading, previewRef, showWysiwyg, textAlignment]);

  useEffect(() => {
    if (loading) return undefined;
    const query = searchQuery.trim();
    const pane = previewRef?.current;
    const editableRoot = pane?.querySelector(".ProseMirror");

    clearSearchHighlights();
    if (!query) {
      onSearchResultCount?.(0);
      return undefined;
    }

    if (showWysiwyg && editableRoot) {
      const ranges = collectSearchRanges(editableRoot, query);
      const activeIndex = getActiveSearchIndex(searchActiveIndex, ranges.length);
      onSearchResultCount?.(ranges.length);

      if (hasHighlightApi()) {
        const passiveRanges = ranges.filter((_, index) => index !== activeIndex);
        CSS.highlights.set("tether-search", new Highlight(...passiveRanges));
        if (ranges[activeIndex]) CSS.highlights.set("tether-search-active", new Highlight(ranges[activeIndex]));
      }
      if (ranges[activeIndex]) scrollRangeIntoPane(ranges[activeIndex], pane);

      return clearSearchHighlights;
    }

    if (showSource && textareaRef.current) {
      const ranges = findTextRanges(editorContent, query);
      const activeIndex = getActiveSearchIndex(searchActiveIndex, ranges.length);
      onSearchResultCount?.(ranges.length);
      if (ranges[activeIndex]) selectTextareaRange(textareaRef.current, ranges[activeIndex]);
    } else {
      onSearchResultCount?.(0);
    }

    return clearSearchHighlights;
  }, [
    editorContent,
    loading,
    onSearchResultCount,
    previewRef,
    searchActiveIndex,
    searchQuery,
    showSource,
    showWysiwyg
  ]);

  function syncLineNumberScroll(event) {
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`;
    }
  }

  function handleWysiwygContextMenu(event) {
    onContextMenu?.(event, {
      surface: readingMode ? "reading" : "wysiwyg",
      selectedText: getWindowSelectionText()
    });
  }

  function handleSourceContextMenu(event) {
    const textarea = textareaRef.current;
    const selectedText = textarea ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) : "";
    onContextMenu?.(event, { surface: "source", selectedText });
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
      {showSource && (
        <section className="editor-pane" aria-label="Markdown source editor">
          <div className="pane-title">
            <span>Markdown source</span>
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
              aria-label="Markdown source"
              spellCheck="false"
              value={editorContent}
              wrap="off"
              onChange={onEditorChange}
              onContextMenu={handleSourceContextMenu}
              onScroll={syncLineNumberScroll}
            />
          </div>
        </section>
      )}

      {showWysiwyg && (
        <section
          ref={previewRef}
          className={`preview-pane wysiwyg-pane ${readingMode ? "reading-pane" : ""}`}
          aria-label={readingMode ? "Markdown reading view" : "Inline Markdown editor"}
          onContextMenu={handleWysiwygContextMenu}
        >
          <div className="wysiwyg-document-shell">
            {showEyebrow && (
              <div className="markdown-eyebrow">
                <span>{documentEyebrow}</span>
                <i />
                <span>{sourceLabel}</span>
              </div>
            )}
            <div className={`wysiwyg-alignment alignment-${textAlignment}`}>
              <WysiwygSurface
                content={editorContent}
                documentId={documentId}
                editorApiRef={editorApiRef}
                onChange={onEditorChange}
                onCopy={copyText}
                onNotice={onNotice}
                readOnly={readingMode}
              />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function DocumentLoading({ LoadingGlyph, loadingMessage, loadingTitle, previewRef }) {
  return (
    <div className="document-grid mode-wysiwyg is-loading">
      <section ref={previewRef} className="preview-pane preview-loading-pane" aria-label="Opening document">
        <article className="document-loading" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true">
            {LoadingGlyph ? <LoadingGlyph pingKey="loading" /> : null}
          </span>
          <strong>{loadingTitle || "opening source"}</strong>
          <span>{loadingMessage || "Preparing the Markdown editor."}</span>
        </article>
      </section>
    </div>
  );
}

function hasHighlightApi() {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
}

function clearSearchHighlights() {
  if (!hasHighlightApi()) return;
  CSS.highlights.delete("tether-search");
  CSS.highlights.delete("tether-search-active");
}

function collectSearchRanges(root, query) {
  const ranges = [];
  const needle = query.toLowerCase();
  if (!needle) return ranges;

  const walker = document.createTreeWalker(root, DOM_SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return DOM_FILTER_REJECT;
      if (node.parentElement?.closest("button, input, textarea, .milkdown-toolbar, .milkdown-slash-menu")) {
        return DOM_FILTER_REJECT;
      }
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
      ranges.push(range);
      index = lowerText.indexOf(needle, index + needle.length);
    }
  }

  return ranges;
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

function scrollRangeIntoPane(range, pane) {
  const rect = range.getBoundingClientRect?.() || range.getClientRects?.()[0];
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

function markSmartJustification(editor, textAlignment) {
  clearSmartJustification(editor);
  if (textAlignment !== "smart") return;

  for (const block of editor.querySelectorAll("p")) {
    if (block.closest("li, blockquote, pre, .milkdown-code-block, table")) continue;
    if (blockSupportsSmartJustification(block)) block.classList.add("smart-justify");
  }
}

function clearSmartJustification(editor) {
  editor?.querySelectorAll(".smart-justify").forEach((node) => node.classList.remove("smart-justify"));
}

function blockSupportsSmartJustification(block) {
  const text = (block.textContent || "").replace(/\s+/g, " ").trim();
  if (text.length < 160 || block.querySelector("code, .katex, [data-type='math_inline']")) return false;

  const rects = collectWordRects(block);
  if (rects.length < 18) return false;

  const blockWidth = block.getBoundingClientRect().width;
  if (blockWidth < 420) return false;
  const lines = groupRectsByLine(rects);
  if (lines.length < 2) return false;

  // Measure the paragraph in its natural left-aligned state. Only justify
  // lines that are already dense enough; sparse lines, lists, quotes and
  // inline code remain left aligned instead of being stretched apart.
  return lines.slice(0, -1).every((line) => {
    if (line.length < 5) return false;
    const sorted = [...line].sort((left, right) => left.left - right.left);
    const occupiedWidth = sorted[sorted.length - 1].right - sorted[0].left;
    return occupiedWidth >= blockWidth * 0.72;
  });
}

function collectWordRects(root) {
  const rects = [];
  const walker = document.createTreeWalker(root, DOM_SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return DOM_FILTER_REJECT;
      if (node.parentElement?.closest(".katex, button, input, textarea, .tether-continuous-source")) {
        return DOM_FILTER_REJECT;
      }
      return DOM_FILTER_ACCEPT;
    }
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(node.nodeValue || ""))) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) {
          rects.push({ top: rect.top, left: rect.left, right: rect.right });
        }
      }
      range.detach?.();
    }
  }

  return rects.sort((left, right) => left.top - right.top || left.left - right.left);
}

function groupRectsByLine(rects) {
  const lines = [];
  for (const rect of rects) {
    const line = lines.find((candidate) => Math.abs(candidate.top - rect.top) < 3);
    if (line) line.rects.push(rect);
    else lines.push({ top: rect.top, rects: [rect] });
  }
  return lines.map((line) => line.rects);
}

export default React.memo(DocumentSurface);
