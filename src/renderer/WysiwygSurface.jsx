import { useEffect, useRef, useState } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { latex } from "@milkdown/crepe/feature/latex";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { editorViewCtx, remarkStringifyOptionsCtx, serializerCtx } from "@milkdown/kit/core";
import { headingKeymap, listItemKeymap, remarkInlineLinkPlugin } from "@milkdown/kit/preset/commonmark";
import { strikethroughInputRule } from "@milkdown/kit/preset/gfm";
import { replaceAll } from "@milkdown/kit/utils";
import {
  codeBoundaryDeletionKeyDirection,
  codeBoundaryNavigationSourceOffset,
  codeBoundaryNavigationKeyDirection,
  codeBoundarySelectionKeyDirection,
  codeBoundarySourcePosition,
  codeContentSourcePosition,
  tetherCodeExtensions,
  tetherCodeLanguageLabel,
  tetherCodeLanguages,
  tetherCodeViewForElement
} from "./lib/codeEditor.js";
import { normalizeSerializedMarkdown, tetherStringifyOptions } from "./lib/markdownStyle.js";
import { sourceFaithfulCodeBlockSchema, sourceFaithfulFenceRemark } from "./lib/markdownFence.js";
import {
  sourceFaithfulBlockquoteRemark,
  sourceFaithfulBlockquoteSchema
} from "./lib/markdownBlockquote.js";
import {
  sourceFaithfulAttentionRemark,
  sourceFaithfulAttentionSerializer,
  sourceFaithfulEmphasisSchema,
  sourceFaithfulStrongSchema,
  serializationAttentionGroupSchema
} from "./lib/markdownAttention.js";
import { sourceFaithfulHeadingRemark, sourceFaithfulHeadingSchema } from "./lib/markdownHeading.js";
import { sourceFaithfulRuleRemark, sourceFaithfulRuleSchema } from "./lib/markdownRule.js";
import { sourceFaithfulHardBreakRemark, sourceFaithfulHardBreakSchema } from "./lib/markdownBreak.js";
import { sourceFaithfulInlineCodeRemark, sourceFaithfulInlineCodeSchema } from "./lib/markdownInlineCode.js";
import { sourceFaithfulInlineMathSchema, sourceFaithfulMathRemark } from "./lib/markdownMath.js";
import { sourceFaithfulParagraphRemark, sourceFaithfulParagraphSchema } from "./lib/markdownParagraph.js";
import {
  documentGaps,
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "./lib/markdownDocument.js";
import { renderedInlineHtmlRemark, renderedInlineHtmlSchema } from "./lib/markdownHtml.js";
import {
  sourceFaithfulFootnoteDefinitionSchema,
  sourceFaithfulFootnoteReferenceSchema,
  sourceFaithfulFootnoteRemark
} from "./lib/markdownFootnote.js";
import { sourceFaithfulTableRemark, sourceFaithfulTableSchema } from "./lib/markdownTable.js";
import {
  sourceFaithfulStrikeInputRule,
  sourceFaithfulStrikeRemark,
  sourceFaithfulStrikeSchema
} from "./lib/markdownStrike.js";
import {
  sourceFaithfulReferenceDefinitionSchema,
  sourceFaithfulReferenceImageSchema,
  sourceFaithfulReferenceLinkSchema,
  sourceFaithfulReferenceRemark,
  sourceFaithfulReferenceSyncPlugin
} from "./lib/markdownReference.js";
import {
  sourceFaithfulBulletInputPlugin,
  sourceFaithfulBulletListSchema,
  sourceFaithfulBulletRemark,
  sourceFaithfulListItemView,
  sourceFaithfulOrderedListSchema,
  sourceFaithfulOrderedParenInputRule,
  sourceFaithfulTaskListItemSchema,
  sourceFaithfulUpperTaskInputRule
} from "./lib/markdownList.js";
import {
  activateMarkdownBlockSourceAt,
  activateMarkdownSourceAt,
  activateMarkdownTableSourceAt,
  continuousMarkdownSource,
  enclosingCodeBlock,
  flushActiveMarkdownSource,
  markdownSyntaxPlugin,
  sourceFaithfulHeadingKeymapConfig,
  sourceFaithfulHeadingBackspaceKeymap,
  sourceFaithfulListItemKeymapConfig,
  sourceFaithfulOrderedListSplitKeymap,
  structuralMarkerBackspaceKeymap
} from "./lib/markdownSyntaxPlugin.js";

const copyIcon = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect width="13" height="13" x="9" y="9" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>`;

function codeSourceFromBlock(block) {
  const lines = [...(block?.querySelectorAll(".cm-line") || [])];
  if (lines.length) return lines.map((line) => line.textContent || "").join("\n");
  return block?.querySelector("pre code")?.textContent || "";
}

function contentCopyButton() {
  const label = "Copy formula";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tether-content-copy";
  button.dataset.copyKind = "formula";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("contenteditable", "false");
  button.innerHTML = `${copyIcon}<span>Copy</span>`;
  return button;
}

function markSyntheticTrailingParagraph(crepe, allowStructuralFallback = false) {
  const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const { doc } = view.state;
  const rootTrailing = doc.lastChild;
  const gaps = documentGaps(doc.attrs.markdownBlockGaps);
  const previous = doc.childCount > 1 ? doc.child(doc.childCount - 2) : null;
  let trailing = rootTrailing;
  let position = doc.content.size - (trailing?.nodeSize || 0);
  let nestedContainer = null;
  if (
    allowStructuralFallback
    && rootTrailing?.type.name === "footnote_definition"
    && rootTrailing.lastChild?.type.name === "paragraph"
    && !rootTrailing.lastChild.content.size
  ) {
    trailing = rootTrailing.lastChild;
    nestedContainer = rootTrailing.type.name;
    position = doc.content.size
      - rootTrailing.nodeSize
      + 1
      + rootTrailing.content.size
      - trailing.nodeSize;
  }
  const structuralFallback = allowStructuralFallback && (
    nestedContainer === "footnote_definition"
    || ["footnote_definition", "table"].includes(previous?.type.name)
  );
  if (
    trailing?.type.name !== "paragraph"
    || trailing.content.size
    || trailing.attrs.tetherSyntheticTrailing
    || (gaps?.length !== doc.childCount && !structuralFallback)
  ) return doc;

  view.dispatch(
    view.state.tr
      .setNodeAttribute(position, "tetherSyntheticTrailing", true)
      .setMeta("addToHistory", false)
  );
  return view.state.doc;
}

export default function WysiwygSurface({
  content,
  documentId,
  editorApiRef,
  onChange,
  onCopy,
  onNotice,
  readOnly = false
}) {
  const hostRef = useRef(null);
  const crepeRef = useRef(null);
  const contentRef = useRef(content);
  const onChangeRef = useRef(onChange);
  const onCopyRef = useRef(onCopy);
  const onNoticeRef = useRef(onNotice);
  const readOnlyRef = useRef(readOnly);
  const lastMarkdownRef = useRef(content);
  const baselineMarkdownRef = useRef(content);
  // The source text the current baseline serialization corresponds to, so a
  // document that returns to its loaded state (e.g. via undo) can report the
  // original file text and clear the unsaved marker.
  const baselineSourceRef = useRef(content);
  // The document model is a stronger undo-baseline signal than serialization:
  // transient normalization can spell the same restored document differently.
  const baselineDocRef = useRef(null);
  const applyingExternalRef = useRef(false);
  const hasUserChangeRef = useRef(false);
  const refreshWidgetsRef = useRef(null);
  const [state, setState] = useState("loading");

  contentRef.current = content;
  onChangeRef.current = onChange;
  onCopyRef.current = onCopy;
  onNoticeRef.current = onNotice;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    if (!editorApiRef) return undefined;
    editorApiRef.current = {
      // Commit any in-progress inline source edit and return the up-to-date
      // markdown when it differs from what onChange has already reported as
      // the clean baseline; null means "nothing pending".
      flushPendingEdits: () => {
        const crepe = crepeRef.current;
        if (!crepe) return null;
        let view = null;
        try {
          view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
          flushActiveMarkdownSource(view.dom);
        } catch {
          return null;
        }
        const settledDoc = markSyntheticTrailingParagraph(crepe, true);
        const markdown = normalizeSerializedMarkdown(
          crepe.getMarkdown(),
          settledDoc,
          baselineSourceRef.current
        );
        lastMarkdownRef.current = markdown;
        if (markdown === baselineMarkdownRef.current) {
          return hasUserChangeRef.current ? baselineSourceRef.current : null;
        }
        hasUserChangeRef.current = true;
        return markdown;
      }
    };
    return () => {
      editorApiRef.current = null;
    };
  }, [editorApiRef]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let disposed = false;
    let created = false;
    let copyFeedbackTimer = 0;
    let settleFrame = 0;
    let secondSettleFrame = 0;
    const ensureSyntheticTrailing = () => {
      const crepe = crepeRef.current;
      if (!crepe) return;
      const before = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
      const after = markSyntheticTrailingParagraph(crepe, true);
      if (after === before) return;
      const markdown = normalizeSerializedMarkdown(
        crepe.getMarkdown(),
        after,
        baselineSourceRef.current
      );
      lastMarkdownRef.current = markdown;
      if (markdown === baselineMarkdownRef.current) {
        baselineDocRef.current = after;
        hasUserChangeRef.current = false;
        if (!applyingExternalRef.current) onChangeRef.current?.(baselineSourceRef.current);
        return;
      }
      hasUserChangeRef.current = true;
      if (!applyingExternalRef.current) onChangeRef.current?.(markdown);
    };
    const ensureSyntheticTrailingAfterPointer = () => {
      ensureSyntheticTrailing();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!disposed && host.isConnected) ensureSyntheticTrailing();
        });
      });
    };
    const blockTransientImage = (event) => {
      const transfer = event.clipboardData || event.dataTransfer;
      const hasImageFile = Array.from(transfer?.items || transfer?.files || []).some((item) =>
        item.type?.startsWith("image/")
      );
      if (!hasImageFile) return;
      event.preventDefault();
      event.stopPropagation();
      onNoticeRef.current?.("Paste a Markdown image URL; embedded image files are not stored yet");
    };
    const blockReadingCodeInteraction = (event) => {
      if (!readOnlyRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".tether-content-copy, .copy-button")) return;
      const block = target?.closest(".milkdown-code-block");
      if (!block || block.querySelector(".preview-panel")) return;
      if (["keydown", "beforeinput"].includes(event.type)) event.preventDefault();
      event.stopPropagation();
      if (["click", "dblclick"].includes(event.type)) {
        requestAnimationFrame(() => block.querySelector(".cm-editor")?.blur());
      }
    };
    const copyRenderedContent = async (event) => {
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      const inlineMath = readOnlyRef.current
        ? target?.closest("span[data-type='math_inline'].tether-reading-math")
        : null;
      const copyButton = target?.closest(".tether-content-copy");
      if (!inlineMath && !copyButton) return;

      const block = copyButton?.closest(".milkdown-code-block");
      const source = inlineMath?.getAttribute("data-value")
        || codeSourceFromBlock(block)
        || "";
      if (!source) return;

      event.preventDefault();
      event.stopPropagation();
      const feedbackTarget = inlineMath || copyButton;
      const copied = await onCopyRef.current?.(source);
      feedbackTarget.dataset.copyState = copied ? "copied" : "failed";
      const buttonLabel = copyButton?.querySelector("span");
      if (buttonLabel) buttonLabel.textContent = copied ? "Copied" : "Retry";
      onNoticeRef.current?.(copied ? "Formula copied" : "Could not copy formula");
      if (copyFeedbackTimer) window.clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = window.setTimeout(() => {
        feedbackTarget.removeAttribute("data-copy-state");
        if (buttonLabel) buttonLabel.textContent = "Copy";
        copyFeedbackTimer = 0;
      }, 1400);
    };
    const activateTableSource = (event) => {
      if (readOnlyRef.current) return;
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest(".tether-table-source");
      if (!button) return;
      const tableBlock = button.closest(".milkdown-table-block");
      const tableElement = tableBlock?.querySelector("table");
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      if (!view || !tableElement) return;
      let position;
      try {
        position = view.posAtDOM(tableElement, 0, -1);
      } catch {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activateMarkdownTableSourceAt(view, position);
    };
    const activateBlockFormulaSource = (event) => {
      if (readOnlyRef.current) return;
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".tether-content-copy")) return;
      const preview = target?.closest(".milkdown-code-block .preview-panel");
      const block = preview?.closest(".milkdown-code-block");
      if (!preview || !block) return;
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      if (!view) return;

      let blockPosition;
      try {
        blockPosition = view.posAtDOM(block, 0, -1);
      } catch {
        return;
      }
      const codeBlock = view.state.doc.nodeAt(blockPosition);
      const ratio = event.type === "mousedown" && preview.clientWidth > 0
        ? Math.max(0, Math.min(1, (event.clientX - preview.getBoundingClientRect().left) / preview.clientWidth))
        : 0;
      const position = blockPosition + 1 + Math.round(ratio * (codeBlock?.textContent.length || 0));
      event.preventDefault();
      event.stopPropagation();
      activateMarkdownBlockSourceAt(view, position);
    };
    const handleCodeBoundaryKey = (event) => {
      if (readOnlyRef.current) return;
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof Element ? event.target : null;
      const codeView = tetherCodeViewForElement(target);
      const selectionDirection = codeView
        ? codeBoundarySelectionKeyDirection(codeView.state, event)
        : null;
      const navigationDirection = codeView && !selectionDirection
        ? codeBoundaryNavigationKeyDirection(codeView.state, event)
        : null;
      const deletionDirection = codeView && !selectionDirection && !navigationDirection
        ? codeBoundaryDeletionKeyDirection(codeView.state, event)
        : null;
      const direction = selectionDirection || navigationDirection || deletionDirection;
      if (!direction) return;
      const block = target?.closest(".milkdown-code-block");
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      if (!block || !view) return;

      let domPosition;
      try {
        domPosition = view.posAtDOM(block, 0, -1);
      } catch {
        return;
      }
      const codeBlock = enclosingCodeBlock(view.state.doc, domPosition);
      if (!codeBlock) return;
      const { position: blockPosition, node } = codeBlock;
      if (selectionDirection) {
        const codeHead = codeView.state.selection.main.head;
        const selectionMotion = event.key === "ArrowUp"
          ? "up"
          : event.key === "ArrowDown"
            ? "down"
            : selectionDirection;
        event.preventDefault();
        event.stopImmediatePropagation();
        activateMarkdownSourceAt(
          view,
          codeContentSourcePosition(blockPosition, codeHead),
          {
            explicitUnitPosition: blockPosition,
            initialSelectionDirection: selectionMotion
          }
        );
        return;
      }
      if (deletionDirection) {
        event.preventDefault();
        event.stopImmediatePropagation();
        activateMarkdownSourceAt(
          view,
          codeBoundarySourcePosition(blockPosition, node.content.size, deletionDirection),
          {
            explicitUnitPosition: blockPosition,
            initialDeleteDirection: deletionDirection
          }
        );
        return;
      }
      const codeHead = codeView.state.selection.main.head;
      const unit = {
        from: blockPosition,
        to: blockPosition + node.nodeSize,
        kind: "block",
        name: "code_block"
      };
      const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
      if (!serializer) return;
      const source = continuousMarkdownSource(view.state, unit, serializer);
      const sourceOffset = codeBoundaryNavigationSourceOffset(
        source,
        node.textContent,
        event.key,
        codeHead
      );
      event.preventDefault();
      event.stopImmediatePropagation();
      activateMarkdownSourceAt(
        view,
        codeBoundarySourcePosition(blockPosition, node.content.size, direction),
        {
          explicitUnitPosition: blockPosition,
          sourceOffset
        }
      );
    };
    const prepareMarkdownWidgets = () => {
      const readOnly = readOnlyRef.current;
      host.querySelectorAll(".milkdown-code-block .preview-panel").forEach((preview) => {
        let copyButton = preview.querySelector(".tether-content-copy");
        if (!copyButton) {
          copyButton = contentCopyButton();
          preview.appendChild(copyButton);
        }
        if (readOnly) {
          preview.removeAttribute("tabindex");
          preview.removeAttribute("role");
          preview.removeAttribute("aria-label");
          preview.removeAttribute("title");
          preview.classList.add("tether-reading-math-block");
        } else {
          preview.classList.remove("tether-reading-math-block");
          preview.tabIndex = 0;
          preview.setAttribute("role", "button");
          preview.setAttribute("aria-label", "Edit block formula");
          preview.setAttribute("title", "Click to edit formula");
        }
      });
      host.querySelectorAll(".milkdown-code-block:not(:has(.preview-panel))").forEach((block) => {
        // CodeMirror is the single editing surface for fenced content. Avoid
        // drawing fake fence text around it: source-looking glyphs that cannot
        // receive the caret make keyboard navigation dishonest and confusing.
        block.removeAttribute("data-tether-fence");
        block.querySelector(".codemirror-host")?.removeAttribute("data-tether-fence");
      });
      host.querySelectorAll(".milkdown-table-block").forEach((tableBlock) => {
        const existing = tableBlock.querySelector(":scope > .tether-table-source");
        if (readOnly) {
          existing?.remove();
          return;
        }
        if (existing) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tether-table-source";
        button.setAttribute("aria-label", "Edit table Markdown source");
        button.setAttribute("title", "Edit table as Markdown");
        button.setAttribute("contenteditable", "false");
        button.innerHTML = `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m8 9-3 3 3 3"></path>
            <path d="m16 9 3 3-3 3"></path>
            <path d="m14 5-4 14"></path>
          </svg>
          <span>Source</span>`;
        tableBlock.appendChild(button);
      });
      host.querySelectorAll("span[data-type='math_inline']").forEach((math) => {
        if (readOnly) {
          math.classList.add("tether-reading-math");
          math.tabIndex = 0;
          math.setAttribute("role", "button");
          math.setAttribute("aria-label", "Copy inline formula");
          math.setAttribute("title", "Copy formula");
        } else {
          math.classList.remove("tether-reading-math");
          math.removeAttribute("tabindex");
          math.removeAttribute("role");
          math.removeAttribute("aria-label");
          math.removeAttribute("title");
          math.removeAttribute("data-copy-state");
        }
      });
      host.querySelectorAll(".milkdown-code-block .cm-content").forEach((content) => {
        content.setAttribute("contenteditable", readOnly ? "false" : "true");
      });
      host.querySelectorAll(".milkdown-code-block .cm-editor").forEach((control) => {
        if (readOnly) control.setAttribute("tabindex", "-1");
        else control.removeAttribute("tabindex");
      });
      host.querySelectorAll(".milkdown-code-block .language-button").forEach((control) => {
        if (readOnly) {
          control.setAttribute("tabindex", "-1");
          control.setAttribute("aria-disabled", "true");
        } else {
          control.removeAttribute("tabindex");
          control.removeAttribute("aria-disabled");
        }
      });
    };
    refreshWidgetsRef.current = prepareMarkdownWidgets;
    const previewObserver = new MutationObserver(prepareMarkdownWidgets);
    host.addEventListener("mousedown", ensureSyntheticTrailingAfterPointer, true);
    host.addEventListener("keydown", ensureSyntheticTrailing, true);
    host.addEventListener("beforeinput", ensureSyntheticTrailing, true);
    host.addEventListener("paste", ensureSyntheticTrailing, true);
    host.addEventListener("drop", ensureSyntheticTrailing, true);
    host.addEventListener("keydown", handleCodeBoundaryKey, true);
    host.addEventListener("paste", blockTransientImage, true);
    host.addEventListener("drop", blockTransientImage, true);
    host.addEventListener("click", blockReadingCodeInteraction, true);
    host.addEventListener("dblclick", blockReadingCodeInteraction, true);
    host.addEventListener("keydown", blockReadingCodeInteraction, true);
    host.addEventListener("beforeinput", blockReadingCodeInteraction, true);
    host.addEventListener("click", copyRenderedContent, true);
    host.addEventListener("keydown", copyRenderedContent, true);
    host.addEventListener("mousedown", activateTableSource, true);
    host.addEventListener("keydown", activateTableSource, true);
    host.addEventListener("mousedown", activateBlockFormulaSource, true);
    host.addEventListener("keydown", activateBlockFormulaSource, true);
    previewObserver.observe(host, { childList: true, subtree: true });
    const initialMarkdown = contentRef.current || "";
    lastMarkdownRef.current = initialMarkdown;
    applyingExternalRef.current = true;
    hasUserChangeRef.current = false;
    setState("loading");

    const crepe = new CrepeBuilder({
      root: host,
      defaultValue: initialMarkdown
    });
    crepe
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(blockEdit)
      .addFeature(placeholder, { text: "Start writing…", mode: "doc" })
      .addFeature(toolbar)
      .addFeature(codeMirror, {
        extensions: tetherCodeExtensions,
        languages: tetherCodeLanguages,
        renderLanguage: tetherCodeLanguageLabel,
        copyIcon,
        copyText: "Copy",
        onCopy: () => onNoticeRef.current?.("Code copied"),
        previewOnlyByDefault: true
      })
      .addFeature(table)
      .addFeature(latex);
    crepe.setReadonly(readOnlyRef.current);
    void crepe.editor.remove(remarkInlineLinkPlugin);
    void crepe.editor.remove(strikethroughInputRule);
    crepe.editor
      .use(sourceFaithfulFenceRemark)
      .use(sourceFaithfulCodeBlockSchema)
      .use(sourceFaithfulMathRemark)
      .use(sourceFaithfulInlineMathSchema)
      .use(renderedInlineHtmlRemark)
      .use(renderedInlineHtmlSchema)
      .use(sourceFaithfulFootnoteDefinitionSchema)
      .use(sourceFaithfulFootnoteReferenceSchema)
      .use(sourceFaithfulDocumentRemark)
      .use(sourceFaithfulDocumentSchema)
      .use(sourceFaithfulParagraphRemark)
      .use(sourceFaithfulParagraphSchema)
      .use(sourceFaithfulBlockquoteSchema)
      .use(sourceFaithfulAttentionRemark)
      .use(sourceFaithfulEmphasisSchema)
      .use(sourceFaithfulStrongSchema)
      .use(serializationAttentionGroupSchema)
      .use(sourceFaithfulAttentionSerializer)
      .use(sourceFaithfulHeadingRemark)
      .use(sourceFaithfulHeadingSchema)
      .use(sourceFaithfulRuleRemark)
      .use(sourceFaithfulRuleSchema)
      .use(sourceFaithfulHardBreakRemark)
      .use(sourceFaithfulHardBreakSchema)
      .use(sourceFaithfulInlineCodeRemark)
      .use(sourceFaithfulInlineCodeSchema)
      .use(sourceFaithfulStrikeRemark)
      .use(sourceFaithfulStrikeSchema)
      .use(sourceFaithfulStrikeInputRule)
      .use(sourceFaithfulTableRemark)
      .use(sourceFaithfulTableSchema)
      .use(sourceFaithfulReferenceRemark)
      .use(sourceFaithfulReferenceLinkSchema)
      .use(sourceFaithfulReferenceImageSchema)
      .use(sourceFaithfulReferenceDefinitionSchema)
      .use(sourceFaithfulReferenceSyncPlugin)
      .use(sourceFaithfulBulletRemark)
      .use(sourceFaithfulBlockquoteRemark)
      .use(sourceFaithfulFootnoteRemark)
      .use(sourceFaithfulBulletListSchema)
      .use(sourceFaithfulOrderedListSchema)
      .use(sourceFaithfulOrderedParenInputRule)
      .use(sourceFaithfulTaskListItemSchema)
      .use(sourceFaithfulListItemView)
      .use(sourceFaithfulUpperTaskInputRule)
      .use(sourceFaithfulBulletInputPlugin)
      .use(sourceFaithfulOrderedListSplitKeymap)
      .use(sourceFaithfulHeadingBackspaceKeymap)
      .use(structuralMarkerBackspaceKeymap)
      .use(markdownSyntaxPlugin);
    crepe.editor.config((ctx) => {
      ctx.update(headingKeymap.key, sourceFaithfulHeadingKeymapConfig);
      ctx.update(listItemKeymap.key, sourceFaithfulListItemKeymapConfig);
      ctx.update(remarkStringifyOptionsCtx, (options) => tetherStringifyOptions(options));
    });

    crepe.on((listener) => {
      listener.markdownUpdated((ctx, rawMarkdown) => {
        let currentDoc = null;
        try {
          currentDoc = ctx.get(editorViewCtx).state.doc;
        } catch {
          // The view may be between replacement and teardown. The loaded
          // source still supplies the correct terminal-newline convention.
        }
        const markdown = normalizeSerializedMarkdown(
          rawMarkdown,
          currentDoc,
          baselineSourceRef.current
        );
        lastMarkdownRef.current = markdown;
        if (applyingExternalRef.current) return;
        if (!hasUserChangeRef.current && markdown === baselineMarkdownRef.current) return;
        const isBaselineDocument = Boolean(currentDoc && baselineDocRef.current?.eq(currentDoc));
        if (isBaselineDocument || markdown === baselineMarkdownRef.current) {
          hasUserChangeRef.current = false;
          onChangeRef.current?.(baselineSourceRef.current);
          return;
        }
        hasUserChangeRef.current = true;
        onChangeRef.current?.(markdown);
      });
    });

    crepe
      .create()
      .then(() => {
        created = true;
        if (disposed) {
          void crepe.destroy();
          return;
        }

        crepeRef.current = crepe;
        const editor = host.querySelector(".ProseMirror");
        editor?.setAttribute("aria-label", readOnlyRef.current ? "Markdown reading view" : "Markdown document editor");
        editor?.setAttribute("lang", "en");
        editor?.setAttribute("spellcheck", readOnlyRef.current ? "false" : "true");
        prepareMarkdownWidgets();
        const latestMarkdown = contentRef.current || "";
        if (latestMarkdown !== initialMarkdown) {
          crepe.editor.action(replaceAll(latestMarkdown));
        }
        lastMarkdownRef.current = latestMarkdown;
        settleFrame = window.requestAnimationFrame(() => {
          secondSettleFrame = window.requestAnimationFrame(() => {
            if (disposed || crepeRef.current !== crepe) return;
            baselineDocRef.current = markSyntheticTrailingParagraph(crepe, true);
            baselineMarkdownRef.current = normalizeSerializedMarkdown(
              crepe.getMarkdown(),
              baselineDocRef.current,
              latestMarkdown
            );
            baselineSourceRef.current = latestMarkdown;
            hasUserChangeRef.current = false;
            applyingExternalRef.current = false;
            setState("ready");
          });
        });
      })
      .catch((error) => {
        applyingExternalRef.current = false;
        console.error("Tether inline editor failed to start", error);
        if (!disposed) setState("error");
      });

    return () => {
      disposed = true;
      host.removeEventListener("mousedown", ensureSyntheticTrailingAfterPointer, true);
      host.removeEventListener("keydown", ensureSyntheticTrailing, true);
      host.removeEventListener("beforeinput", ensureSyntheticTrailing, true);
      host.removeEventListener("paste", ensureSyntheticTrailing, true);
      host.removeEventListener("drop", ensureSyntheticTrailing, true);
      host.removeEventListener("keydown", handleCodeBoundaryKey, true);
      host.removeEventListener("paste", blockTransientImage, true);
      host.removeEventListener("drop", blockTransientImage, true);
      host.removeEventListener("click", blockReadingCodeInteraction, true);
      host.removeEventListener("dblclick", blockReadingCodeInteraction, true);
      host.removeEventListener("keydown", blockReadingCodeInteraction, true);
      host.removeEventListener("beforeinput", blockReadingCodeInteraction, true);
      host.removeEventListener("click", copyRenderedContent, true);
      host.removeEventListener("keydown", copyRenderedContent, true);
      host.removeEventListener("mousedown", activateTableSource, true);
      host.removeEventListener("keydown", activateTableSource, true);
      host.removeEventListener("mousedown", activateBlockFormulaSource, true);
      host.removeEventListener("keydown", activateBlockFormulaSource, true);
      previewObserver.disconnect();
      if (refreshWidgetsRef.current === prepareMarkdownWidgets) refreshWidgetsRef.current = null;
      if (copyFeedbackTimer) window.clearTimeout(copyFeedbackTimer);
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
      if (secondSettleFrame) window.cancelAnimationFrame(secondSettleFrame);
      if (crepeRef.current === crepe) crepeRef.current = null;
      if (created) void crepe.destroy();
    };
  }, [documentId]);

  // Reading <-> editing flips in place: the same editor instance stays mounted,
  // preserving scroll position, cursor, and the rendered DOM.
  useEffect(() => {
    const crepe = crepeRef.current;
    const host = hostRef.current;
    if (!crepe || !host || state !== "ready") return;
    if (readOnly) {
      try {
        const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
        flushActiveMarkdownSource(view.dom);
      } catch {
        // The editor is mid-teardown; nothing to flush.
      }
    }
    crepe.setReadonly(readOnly);
    const editor = host.querySelector(".ProseMirror");
    editor?.setAttribute("aria-label", readOnly ? "Markdown reading view" : "Markdown document editor");
    editor?.setAttribute("spellcheck", readOnly ? "false" : "true");
    // Re-run the widget pass so reading affordances (math copy targets, table
    // source buttons, code block focus) match the new mode.
    refreshWidgetsRef.current?.();
  }, [readOnly, state]);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (!crepe || state !== "ready") return;
    const nextMarkdown = content || "";
    if (nextMarkdown === lastMarkdownRef.current) return;

    applyingExternalRef.current = true;
    crepe.editor.action(replaceAll(nextMarkdown));
    lastMarkdownRef.current = nextMarkdown;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (crepeRef.current !== crepe) return;
        const nextDoc = markSyntheticTrailingParagraph(crepe, true);
        baselineMarkdownRef.current = normalizeSerializedMarkdown(
          crepe.getMarkdown(),
          nextDoc,
          nextMarkdown
        );
        baselineSourceRef.current = nextMarkdown;
        baselineDocRef.current = nextDoc;
        hasUserChangeRef.current = false;
        applyingExternalRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [content, state]);

  return (
    <div className={`tether-wysiwyg ${readOnly ? "is-reading" : "is-editing"} ${state === "ready" ? "is-ready" : "is-loading"}`}>
      <div ref={hostRef} className="tether-wysiwyg-host" />
      {state === "loading" && <div className="wysiwyg-status">{readOnly ? "Preparing reading view…" : "Preparing inline editor…"}</div>}
      {state === "error" && (
        <div className="wysiwyg-status error" role="alert">
          The inline editor could not start. Switch to Markdown source to keep editing.
        </div>
      )}
    </div>
  );
}
