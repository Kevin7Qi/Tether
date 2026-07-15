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
import { editorViewCtx, parserCtx, remarkStringifyOptionsCtx, serializerCtx } from "@milkdown/kit/core";
import {
  createCodeBlockInputRule,
  headingKeymap,
  listItemKeymap,
  remarkHtmlTransformer,
  remarkInlineLinkPlugin
} from "@milkdown/kit/preset/commonmark";
import { strikethroughInputRule } from "@milkdown/kit/preset/gfm";
import { Slice } from "@milkdown/kit/prose/model";
import { AllSelection, TextSelection } from "@milkdown/kit/prose/state";
import { redo as redoProseMirror, undo as undoProseMirror } from "@milkdown/kit/prose/history";
import {
  codeBoundaryDeletionKeyDirection,
  codeBoundaryNavigationSourceOffset,
  codeBoundaryNavigationKeyDirection,
  codeBoundarySelectionKeyDirection,
  codeBoundarySourcePosition,
  codeContentSourcePosition,
  codeDragDocumentRange,
  codeLineEndSourceOffset,
  codeLineStartSourceOffset,
  codeOuterHistoryDirection,
  codeTabEdit,
  codeSourceOnlyHistoryDirection,
  documentDragIntoCodeRange,
  emptyCodeClosingFenceSourceOffset,
  emptyCodeEnterSource,
  isEditorHistoryShortcut,
  isEditorSelectAllShortcut,
  shouldRestoreEditorHistoryFocus,
  tetherCodeExtensions,
  tetherCodeLanguageLabel,
  tetherCodeLanguages,
  tetherCodeViewForElement
} from "./lib/codeEditor.js";
import { normalizeSerializedMarkdown, tetherStringifyOptions } from "./lib/markdownStyle.js";
import {
  codeSemanticSignature,
  sourceFaithfulCodeBlockEnterShortcut,
  sourceFaithfulCodeBlockInputRule,
  sourceFaithfulCodeBlockSchema,
  sourceFaithfulFenceRemark
} from "./lib/markdownFence.js";
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
import {
  renderedBlockHtmlRemark,
  renderedBlockHtmlSchema,
  renderedInlineHtmlRemark,
  renderedInlineHtmlSchema
} from "./lib/markdownHtml.js";
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
  applyDocumentSourceJump,
  activateDocumentSourceSelection,
  activateMarkdownBlockSourceAt,
  activateMarkdownSourceAt,
  activateMarkdownTableSourceAt,
  continuousMarkdownSource,
  documentSourceSegments,
  documentSourceOffsetAtPosition,
  documentSourceUnitStartOffset,
  enclosingCodeBlock,
  flushActiveMarkdownSource,
  externalMarkdownTransactionMeta,
  markdownSourceTargetFromPointer,
  markdownSyntaxPlugin,
  isSourceInputComposing,
  sourceCaretOffset,
  sourceDocumentJumpEdge,
  sourceFaithfulHeadingKeymapConfig,
  sourceFaithfulHeadingBackspaceKeymap,
  sourceFaithfulListItemKeymapConfig,
  sourceFaithfulOrderedListSplitKeymap,
  sourceLineJumpEdge,
  sourceSelectionRangeAfterMotion,
  sourceWordOffset,
  sourceWordSelectionRange,
  replaceSourceSelectionTransaction,
  structuralMarkerBackspaceKeymap
} from "./lib/markdownSyntaxPlugin.js";

function replaceAllMarkdown(markdown) {
  return (ctx) => {
    const view = ctx.get(editorViewCtx);
    const doc = ctx.get(parserCtx)(markdown);
    if (!doc) return;
    view.dispatch(
      view.state.tr
        .replace(0, view.state.doc.content.size, new Slice(doc.content, 0, 0))
        .setMeta(externalMarkdownTransactionMeta, true)
    );
  };
}

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
      },
      runHistoryCommand: (command) => {
        if (readOnlyRef.current || !["undo", "redo"].includes(command)) return false;
        const host = hostRef.current;
        const activeElement = host?.ownerDocument?.activeElement;
        const activeCodeEditor = activeElement?.closest?.(".cm-editor");
        // Crepe may portal a code node view beside the React host even though
        // it belongs to this ProseMirror document. Treat that focused editor as
        // part of the surface for canonical history routing.
        if (!host?.contains(activeElement) && !activeCodeEditor) return false;
        if (
          activeElement?.matches?.("input, textarea")
          && !activeElement.closest?.(".cm-editor")
        ) return false;
        const crepe = crepeRef.current;
        if (!crepe) return false;
        const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
        const historyCommand = command === "undo" ? undoProseMirror : redoProseMirror;
        return Boolean(historyCommand(view.state, view.dispatch));
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
    let codeSourceOnlyHistory = null;
    const ensureSyntheticTrailing = (event = null) => {
      // Composition owns the editor until it commits. Even a history-free
      // structural transaction can make the browser restart or drop an IME
      // candidate, so postpone this housekeeping to the resulting update.
      if (isSourceInputComposing(event)) return;
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
    const focusTableTextFromPointer = (event) => {
      if (readOnlyRef.current || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const paragraph = target?.closest(".milkdown-table-block table p");
      if (!paragraph || target?.closest("button, input, textarea")) return;
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      const pointerTarget = view ? markdownSourceTargetFromPointer(view, event) : null;
      if (!view || !pointerTarget) return;
      pendingTableDrag = { view, anchor: pointerTarget.position };
      activateMarkdownSourceAt(view, pointerTarget.position, {
        atomPosition: pointerTarget.atomPosition ?? null,
        sourceOffset: pointerTarget.sourceOffset ?? null
      });
      // The table node view otherwise turns a click near a cell-text edge into
      // a paragraph NodeSelection. Own the captured pointer so a text caret wins.
      event.preventDefault();
      event.stopPropagation();
    };
    const updateTableDragSelection = (event) => {
      const pending = pendingTableDrag;
      if (!pending || readOnlyRef.current || (event.type === "mousemove" && !(event.buttons & 1))) return;
      const target = markdownSourceTargetFromPointer(pending.view, event);
      if (!target || target.position === pending.anchor) return;
      const doc = pending.view.state.doc;
      const anchor = Math.max(0, Math.min(doc.content.size, pending.anchor));
      const head = Math.max(0, Math.min(doc.content.size, target.position));
      const selection = TextSelection.create(doc, anchor, head);
      const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
      if (!serializer || !activateDocumentSourceSelection(pending.view, selection, serializer)) {
        pending.view.dispatch(pending.view.state.tr.setSelection(selection).scrollIntoView());
        pending.view.focus();
      }
    };
    const finishTableDragSelection = (event) => {
      if (!pendingTableDrag) return;
      updateTableDragSelection(event);
      pendingTableDrag = null;
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
    const handleCodeWordJump = (event) => {
      if (readOnlyRef.current || isSourceInputComposing(event)) return;
      if (
        !event.altKey
        || event.ctrlKey
        || event.metaKey
        || !["ArrowLeft", "ArrowRight"].includes(event.key)
      ) return;
      const target = event.target instanceof Element ? event.target : null;
      const codeView = tetherCodeViewForElement(target);
      const selection = codeView?.state.selection.main;
      const direction = event.key === "ArrowLeft" ? "backward" : "forward";
      const atBoundary = direction === "backward"
        ? selection?.head === 0
        : selection?.head === codeView?.state.doc.length;
      if (!codeView || !selection || !atBoundary || (!selection.empty && !event.shiftKey)) return;

      const block = target?.closest(".milkdown-code-block");
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
      if (!block || !view || !serializer) return;
      let codeBlock;
      try {
        codeBlock = enclosingCodeBlock(view.state.doc, view.posAtDOM(block, 0, -1));
      } catch {
        return;
      }
      if (!codeBlock) return;
      const unit = {
        from: codeBlock.position,
        to: codeBlock.position + codeBlock.node.nodeSize,
        kind: "block",
        name: "code_block"
      };
      const source = continuousMarkdownSource(view.state, unit, serializer);
      const currentOffset = sourceCaretOffset(
        view.state,
        unit,
        source,
        codeContentSourcePosition(codeBlock.position, selection.head),
        null,
        serializer
      );
      const targetOffset = sourceWordOffset(source, currentOffset, direction);
      if (targetOffset === currentOffset) return;
      const anchorOffset = event.shiftKey
        ? sourceCaretOffset(
            view.state,
            unit,
            source,
            codeContentSourcePosition(codeBlock.position, selection.anchor),
            null,
            serializer
          )
        : currentOffset;
      event.preventDefault();
      event.stopImmediatePropagation();
      activateMarkdownSourceAt(view, codeBlock.position, {
        explicitUnitPosition: codeBlock.position,
        sourceOffset: targetOffset,
        initialSourceSelection: event.shiftKey
          ? sourceWordSelectionRange(anchorOffset, targetOffset)
          : null
      });
    };
    const handleCodeDocumentJump = (event) => {
      if (readOnlyRef.current || isSourceInputComposing(event)) return;
      if (!sourceDocumentJumpEdge(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const codeView = tetherCodeViewForElement(target);
      const block = target?.closest(".milkdown-code-block");
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
      if (!codeView || !block || !view || !serializer) return;

      let codeBlock;
      try {
        codeBlock = enclosingCodeBlock(view.state.doc, view.posAtDOM(block, 0, -1));
      } catch {
        return;
      }
      if (!codeBlock) return;
      const codeSelection = codeView.state.selection.main;
      const sourceOffsetForCodePosition = (position) => documentSourceOffsetAtPosition(
        view.state,
        codeContentSourcePosition(codeBlock.position, position),
        serializer,
        "forward"
      );
      const sourceHead = sourceOffsetForCodePosition(codeSelection.head);
      const sourceAnchor = sourceOffsetForCodePosition(codeSelection.anchor);
      if (!Number.isFinite(sourceHead)) return;
      if (!applyDocumentSourceJump(view, event, serializer, sourceHead, sourceAnchor)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const handleCodeLineJump = (event) => {
      if (readOnlyRef.current || isSourceInputComposing(event)) return;
      const lineEdge = sourceLineJumpEdge(event);
      if (!lineEdge) return;
      const target = event.target instanceof Element ? event.target : null;
      const codeView = tetherCodeViewForElement(target);
      const block = target?.closest(".milkdown-code-block");
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
      if (!codeView || !block || !view || !serializer) return;

      let codeBlock;
      try {
        codeBlock = enclosingCodeBlock(view.state.doc, view.posAtDOM(block, 0, -1));
      } catch {
        return;
      }
      if (!codeBlock) return;
      const codeSelection = codeView.state.selection.main;
      const unit = {
        from: codeBlock.position,
        to: codeBlock.position + codeBlock.node.nodeSize,
        kind: "block",
        name: "code_block"
      };
      const source = continuousMarkdownSource(view.state, unit, serializer);
      const targetOffset = lineEdge === "start"
        ? codeLineStartSourceOffset(
            source,
            codeBlock.node.textContent,
            codeSelection.head
          )
        : codeLineEndSourceOffset(source, codeBlock.node.textContent);
      if (!Number.isFinite(targetOffset)) return;
      const anchorOffset = sourceCaretOffset(
        view.state,
        unit,
        source,
        codeContentSourcePosition(codeBlock.position, codeSelection.anchor),
        null,
        serializer
      );
      if (!event.shiftKey && targetOffset === anchorOffset && codeSelection.empty) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      activateMarkdownSourceAt(view, codeBlock.position, {
        explicitUnitPosition: codeBlock.position,
        sourceOffset: targetOffset,
        initialSourceSelection: event.shiftKey
          ? sourceWordSelectionRange(anchorOffset, targetOffset)
          : null
      });
    };
    const replaceCodeSourceOnlyInsertion = (event, replacement) => {
      if (readOnlyRef.current || isSourceInputComposing(event) || typeof replacement !== "string") {
        return false;
      }
      const target = event.target instanceof Element ? event.target : null;
      const codeView = tetherCodeViewForElement(target);
      const codeSelection = codeView?.state.selection.main;
      const block = target?.closest(".milkdown-code-block");
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      const parser = crepeRef.current?.editor.action((ctx) => ctx.get(parserCtx));
      const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
      if (
        !codeView
        || !codeSelection?.empty
        || codeView.state.doc.length !== 0
        || !block
        || !view
        || !parser
        || !serializer
      ) return false;

      let codeBlock;
      try {
        codeBlock = enclosingCodeBlock(view.state.doc, view.posAtDOM(block, 0, -1));
      } catch {
        return false;
      }
      if (!codeBlock) return false;
      const unit = {
        from: codeBlock.position,
        to: codeBlock.position + codeBlock.node.nodeSize,
        kind: "block",
        name: "code_block"
      };
      const source = continuousMarkdownSource(view.state, unit, serializer);
      const localOffset = emptyCodeClosingFenceSourceOffset(source, codeBlock.node.textContent);
      const documentSource = Number.isFinite(localOffset)
        ? documentSourceSegments(view.state, serializer)
        : null;
      const unitStart = documentSource
        ? documentSourceUnitStartOffset(view.state, unit, serializer)
        : null;
      if (!documentSource || !Number.isFinite(unitStart)) return false;
      const sourceOffset = unitStart + localOffset;
      const sourceSelection = {
        anchor: sourceOffset,
        head: sourceOffset,
        fullSource: documentSource.fullSource,
        boundary: codeContentSourcePosition(codeBlock.position, 0)
      };
      const beforeContent = codeView.state.doc.toString();
      const transaction = replaceSourceSelectionTransaction(
        view.state,
        sourceSelection,
        replacement,
        parser
      );
      if (!transaction) return false;

      event.preventDefault();
      event.stopImmediatePropagation();
      view.dispatch(transaction.scrollIntoView());
      const afterSelection = view.state.selection;
      const afterCodeBlock = enclosingCodeBlock(view.state.doc, afterSelection.head);
      if (afterCodeBlock) {
        const afterUnit = {
          from: afterCodeBlock.position,
          to: afterCodeBlock.position + afterCodeBlock.node.nodeSize,
          kind: "block",
          name: "code_block"
        };
        codeSourceOnlyHistory = {
          beforeSource: source,
          afterSource: continuousMarkdownSource(view.state, afterUnit, serializer),
          beforeContent,
          afterContent: afterCodeBlock.node.textContent,
          state: "applied"
        };
        scheduleCodeFocusRestore({
          position: afterCodeBlock.position,
          head: afterSelection.$from.parentOffset
        });
      } else {
        codeSourceOnlyHistory = null;
      }
      return true;
    };
    const handleCodeSourceOnlyBeforeInput = (event) => {
      if (!["insertText", "insertReplacementText"].includes(event.inputType)) return;
      if (typeof event.data !== "string" || event.data === "") return;
      replaceCodeSourceOnlyInsertion(event, event.data);
    };
    const handleCodeSourceOnlyTransfer = (event) => {
      const transfer = event.clipboardData || event.dataTransfer;
      if (!transfer) return;
      const hasImageFile = Array.from(transfer.items || transfer.files || []).some((item) =>
        item.type?.startsWith("image/")
      );
      if (hasImageFile) return;
      const text = transfer.getData?.("text/plain");
      if (!text) return;
      replaceCodeSourceOnlyInsertion(event, text);
    };
    const handleCodeBoundaryKey = (event) => {
      if (readOnlyRef.current) return;
      if (isSourceInputComposing(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const codeView = tetherCodeViewForElement(target);
      if (codeView && codeSourceOnlyHistory && isEditorHistoryShortcut(event)) {
        const block = target?.closest(".milkdown-code-block");
        const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
        const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
        if (block && view && serializer) {
          let codeBlock;
          try {
            codeBlock = enclosingCodeBlock(view.state.doc, view.posAtDOM(block, 0, -1));
          } catch {
            codeBlock = null;
          }
          if (codeBlock) {
            const source = continuousMarkdownSource(view.state, {
              from: codeBlock.position,
              to: codeBlock.position + codeBlock.node.nodeSize,
              kind: "block",
              name: "code_block"
            }, serializer);
            const direction = codeSourceOnlyHistoryDirection(
              event,
              source,
              codeView.state.doc.toString(),
              codeSourceOnlyHistory
            );
            const command = direction === "undo"
              ? undoProseMirror
              : direction === "redo" ? redoProseMirror : null;
            if (command?.(view.state, view.dispatch)) {
              event.preventDefault();
              event.stopImmediatePropagation();
              codeSourceOnlyHistory.state = direction === "undo" ? "undone" : "applied";
              return;
            }
          }
        }
      }
      if (codeView && isEditorHistoryShortcut(event)) {
        const direction = codeOuterHistoryDirection(event);
        const view = direction
          ? crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx))
          : null;
        const command = direction === "undo"
          ? undoProseMirror
          : direction === "redo" ? redoProseMirror : null;
        // The ProseMirror document is canonical even while CodeMirror owns the
        // focused code UI. Prefer its history whenever it has an entry; this
        // keeps source-spanning edits reversible after they rebuild the node.
        // If it has nothing to undo/redo, leave the shortcut to CodeMirror.
        if (view && command?.(view.state, view.dispatch)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      if (
        codeView
        && event.key === "Enter"
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && codeView.state.doc.length === 0
        && codeView.state.selection.main.empty
      ) {
        const block = target?.closest(".milkdown-code-block");
        const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
        const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
        if (block && view && serializer) {
          let codeBlock;
          try {
            codeBlock = enclosingCodeBlock(view.state.doc, view.posAtDOM(block, 0, -1));
          } catch {
            codeBlock = null;
          }
          if (codeBlock) {
            const unit = {
              from: codeBlock.position,
              to: codeBlock.position + codeBlock.node.nodeSize,
              kind: "block",
              name: "code_block"
            };
            const source = continuousMarkdownSource(view.state, unit, serializer);
            const nextSource = emptyCodeEnterSource(source);
            if (nextSource) {
              event.preventDefault();
              event.stopImmediatePropagation();
              const { node, position } = codeBlock;
              codeSourceOnlyHistory = {
                beforeSource: source,
                afterSource: nextSource,
                beforeContent: "",
                afterContent: "",
                state: "applied"
              };
              view.dispatch(view.state.tr.setNodeMarkup(position, undefined, {
                ...node.attrs,
                fenceSource: nextSource,
                fenceSourceSignature: codeSemanticSignature({
                  value: node.textContent,
                  lang: node.attrs.language,
                  meta: node.attrs.meta
                })
              }).scrollIntoView());
              return;
            }
          }
        }
      }
      if (
        codeView
        && event.key === "Tab"
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
      ) {
        const edit = codeTabEdit(codeView.state, event.shiftKey);
        if (!edit) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const transaction = {
          selection: { anchor: edit.anchor, head: edit.head },
          scrollIntoView: true
        };
        if (edit.changed) {
          transaction.changes = {
            from: 0,
            to: codeView.state.doc.length,
            insert: edit.value
          };
        }
        codeView.dispatch(transaction);
        return;
      }
      if (codeView && isEditorSelectAllShortcut(event)) {
        const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
        if (!view) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
        view.focus();
        return;
      }
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
        const codeSelection = codeView.state.selection.main;
        const codeHead = codeSelection.head;
        const selectionMotion = event.key === "ArrowUp"
          ? "up"
          : event.key === "ArrowDown"
            ? "down"
            : selectionDirection;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!codeSelection.empty) {
          const unit = {
            from: blockPosition,
            to: blockPosition + node.nodeSize,
            kind: "block",
            name: "code_block"
          };
          const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
          if (!serializer) return;
          const source = continuousMarkdownSource(view.state, unit, serializer);
          const anchorOffset = sourceCaretOffset(
            view.state,
            unit,
            source,
            codeContentSourcePosition(blockPosition, codeSelection.anchor),
            null,
            serializer
          );
          const headOffset = sourceCaretOffset(
            view.state,
            unit,
            source,
            codeContentSourcePosition(blockPosition, codeHead),
            null,
            serializer
          );
          const initialSourceSelection = sourceSelectionRangeAfterMotion(
            source,
            anchorOffset,
            headOffset,
            selectionMotion
          );
          const sourceOffset = initialSourceSelection.direction === "backward"
            ? initialSourceSelection.start
            : initialSourceSelection.end;
          activateMarkdownSourceAt(view, codeBlock.position, {
            explicitUnitPosition: blockPosition,
            sourceOffset,
            initialSourceSelection
          });
          return;
        }
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
    let pendingCodeDrag = null;
    let pendingDocumentDrag = null;
    let pendingTableDrag = null;
    let codeDragFinishFrame = 0;
    let historyFocusFrame = 0;
    let lastFocusedCodeTarget = null;
    const codeFocusTargetFromElement = (targetElement) => {
      const originalCodeView = tetherCodeViewForElement(targetElement);
      const originalView = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      const block = targetElement?.closest(".milkdown-code-block");
      if (!originalCodeView || !originalView || !block) return null;
      try {
        const codeBlock = enclosingCodeBlock(
          originalView.state.doc,
          originalView.posAtDOM(block, 0, -1)
        ) || enclosingCodeBlock(
          originalView.state.doc,
          originalView.state.selection.head
        );
        return codeBlock ? {
          position: codeBlock.position,
          head: originalCodeView.state.selection.main.head
        } : null;
      } catch {
        return null;
      }
    };
    const scheduleCodeFocusRestore = (codeTarget) => {
      if (historyFocusFrame) window.cancelAnimationFrame(historyFocusFrame);
      const restore = (remaining) => {
        historyFocusFrame = window.requestAnimationFrame(() => {
          historyFocusFrame = 0;
          if (disposed || !host.isConnected) return;
          // Give the code node view two frames to tear down and rebuild before
          // focusing it; focusing the outgoing instance only loses the caret
          // again when Milkdown replaces its DOM.
          if (remaining > 6) {
            restore(remaining - 1);
            return;
          }
          const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
          if (!view) return;
          const active = host.ownerDocument.activeElement;
          if (!shouldRestoreEditorHistoryFocus(active, host)) return;
          const activeCodeView = tetherCodeViewForElement(
            active instanceof Element ? active : null
          );
          if (activeCodeView?.hasFocus) return;

          if (codeTarget) {
            const selectedCode = enclosingCodeBlock(
              view.state.doc,
              view.state.selection.head
            );
            const targetPosition = selectedCode?.position ?? codeTarget.position;
            const node = view.state.doc.nodeAt(targetPosition);
            const nodeDOM = node?.type.name === "code_block"
              ? view.nodeDOM(targetPosition)
              : null;
            const rebuiltCodeView = nodeDOM instanceof Element
              ? tetherCodeViewForElement(nodeDOM.querySelector(".cm-content"))
              : null;
            if (rebuiltCodeView) {
              const mappedHead = selectedCode?.position === targetPosition
                ? view.state.selection.head - targetPosition - 1
                : codeTarget.head;
              const head = Math.max(
                0,
                Math.min(rebuiltCodeView.state.doc.length, mappedHead)
              );
              rebuiltCodeView.dispatch({ selection: { anchor: head }, scrollIntoView: true });
              rebuiltCodeView.focus();
              return;
            }
          }
          if (remaining > 1) restore(remaining - 1);
          else view.focus();
        });
      };
      restore(8);
    };
    const rememberCodeFocus = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      lastFocusedCodeTarget = codeFocusTargetFromElement(target);
    };
    const restoreFocusAfterHistory = (event) => {
      if (readOnlyRef.current || !isEditorHistoryShortcut(event)) return;
      const target = event.target;
      if (!(target instanceof Node) || !host.contains(target)) return;
      const targetElement = target instanceof Element ? target : target.parentElement;
      const codeTarget = codeFocusTargetFromElement(targetElement) || lastFocusedCodeTarget;
      if (codeTarget) scheduleCodeFocusRestore(codeTarget);
    };
    const beginCodeDragSelection = (event) => {
      if (readOnlyRef.current || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const codeView = tetherCodeViewForElement(target);
      const block = target?.closest(".milkdown-code-block");
      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      if (!target || !view) return;
      pendingCodeDrag = null;
      pendingDocumentDrag = null;
      if (!codeView || !block) {
        if (
          !view.dom.contains(target)
          || target.closest("button, input, textarea, select, .tether-continuous-source")
        ) return;
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (hit) pendingDocumentDrag = { anchor: hit.pos };
        return;
      }
      let blockPosition;
      try {
        blockPosition = view.posAtDOM(block, 0, -1);
      } catch {
        return;
      }
      const codeBlock = enclosingCodeBlock(view.state.doc, blockPosition);
      if (!codeBlock) return;
      pendingCodeDrag = { block, blockPosition: codeBlock.position, codeView };
    };
    const finishCodeDragSelection = (event) => {
      const pending = pendingCodeDrag;
      const pendingDocument = pendingDocumentDrag;
      pendingCodeDrag = null;
      pendingDocumentDrag = null;
      if ((!pending && !pendingDocument) || readOnlyRef.current) return;
      if (pendingDocument) {
        const targetAtPoint = document.elementFromPoint(event.clientX, event.clientY);
        const block = targetAtPoint?.closest(".milkdown-code-block");
        const codeView = tetherCodeViewForElement(targetAtPoint);
        if (!block || !codeView) return;
        const point = { left: event.clientX, top: event.clientY };
        if (codeDragFinishFrame) window.cancelAnimationFrame(codeDragFinishFrame);
        codeDragFinishFrame = window.requestAnimationFrame(() => {
          codeDragFinishFrame = 0;
          const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
          const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
          if (!view || !serializer || !block.isConnected) return;
          let blockPosition;
          try {
            blockPosition = view.posAtDOM(block, 0, -1);
          } catch {
            return;
          }
          const codeBlock = enclosingCodeBlock(view.state.doc, blockPosition);
          const codeHead = codeView.posAtCoords({ x: point.left, y: point.top });
          if (!codeBlock || codeHead == null) return;
          const range = documentDragIntoCodeRange(
            codeBlock.position,
            codeBlock.node.content.size,
            pendingDocument.anchor,
            codeHead
          );
          if (!range) return;
          const anchor = Math.min(range.anchor, view.state.doc.content.size);
          const head = Math.min(range.head, view.state.doc.content.size);
          activateDocumentSourceSelection(
            view,
            TextSelection.create(view.state.doc, anchor, head),
            serializer
          );
        });
        return;
      }
      // CodeMirror captures the pointer, so mouseup.target can still be inside
      // the code DOM after the pointer has visibly crossed into surrounding
      // prose. Geometry is the authoritative boundary here.
      const blockRect = pending.block.getBoundingClientRect();
      const endedInsideBlock = event.clientX >= blockRect.left
        && event.clientX <= blockRect.right
        && event.clientY >= blockRect.top
        && event.clientY <= blockRect.bottom;
      const hostRect = host.getBoundingClientRect();
      const endedInsideHost = event.clientX >= hostRect.left
        && event.clientX <= hostRect.right
        && event.clientY >= hostRect.top
        && event.clientY <= hostRect.bottom;
      if (endedInsideBlock || !endedInsideHost) return;
      const point = { left: event.clientX, top: event.clientY };
      if (codeDragFinishFrame) window.cancelAnimationFrame(codeDragFinishFrame);
      codeDragFinishFrame = window.requestAnimationFrame(() => {
        codeDragFinishFrame = 0;
        const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
        const serializer = crepeRef.current?.editor.action((ctx) => ctx.get(serializerCtx));
        if (!view || !serializer || !pending.block.isConnected) return;
        const hit = view.posAtCoords(point);
        const node = view.state.doc.nodeAt(pending.blockPosition);
        if (!hit || node?.type.name !== "code_block") return;
        const range = codeDragDocumentRange(
          pending.blockPosition,
          node.content.size,
          pending.codeView.state.selection.main.anchor,
          hit.pos
        );
        if (!range) return;
        const anchor = Math.min(range.anchor, view.state.doc.content.size);
        const head = Math.min(range.head, view.state.doc.content.size);
        activateDocumentSourceSelection(
          view,
          TextSelection.create(view.state.doc, anchor, head),
          serializer
        );
      });
    };
    const prepareMarkdownWidgets = () => {
      const readOnly = readOnlyRef.current;
      const editorView = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
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
        let frontmatter = false;
        if (editorView) {
          try {
            frontmatter = Boolean(
              enclosingCodeBlock(editorView.state.doc, editorView.posAtDOM(block, 0, -1))
                ?.node.attrs.frontmatterBlock
            );
          } catch {
            frontmatter = false;
          }
        }
        block.classList.toggle("tether-frontmatter-block", frontmatter);
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
        const frontmatter = Boolean(control.closest(".tether-frontmatter-block"));
        if (readOnly || frontmatter) {
          control.setAttribute("tabindex", "-1");
          control.setAttribute("aria-disabled", "true");
          if (frontmatter) {
            control.disabled = true;
            control.setAttribute("title", "YAML front matter");
          }
        } else {
          control.removeAttribute("tabindex");
          control.removeAttribute("aria-disabled");
          control.disabled = false;
          control.removeAttribute("title");
        }
      });
    };
    refreshWidgetsRef.current = prepareMarkdownWidgets;
    const previewObserver = new MutationObserver(prepareMarkdownWidgets);
    host.addEventListener("mousedown", ensureSyntheticTrailingAfterPointer, true);
    host.addEventListener("keydown", ensureSyntheticTrailing, true);
    host.addEventListener("keydown", restoreFocusAfterHistory, true);
    host.addEventListener("focusin", rememberCodeFocus, true);
    host.addEventListener("beforeinput", handleCodeSourceOnlyBeforeInput, true);
    host.addEventListener("paste", handleCodeSourceOnlyTransfer, true);
    host.addEventListener("drop", handleCodeSourceOnlyTransfer, true);
    host.addEventListener("beforeinput", ensureSyntheticTrailing, true);
    host.addEventListener("paste", ensureSyntheticTrailing, true);
    host.addEventListener("drop", ensureSyntheticTrailing, true);
    host.addEventListener("keydown", handleCodeWordJump, true);
    host.addEventListener("keydown", handleCodeDocumentJump, true);
    host.addEventListener("keydown", handleCodeLineJump, true);
    host.addEventListener("keydown", handleCodeBoundaryKey, true);
    host.addEventListener("mousedown", beginCodeDragSelection, true);
    host.addEventListener("mousedown", focusTableTextFromPointer, true);
    window.addEventListener("mousemove", updateTableDragSelection, true);
    window.addEventListener("mouseup", finishTableDragSelection, true);
    window.addEventListener("mouseup", finishCodeDragSelection, true);
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
    void crepe.editor.remove(remarkHtmlTransformer);
    void crepe.editor.remove(remarkInlineLinkPlugin);
    void crepe.editor.remove(strikethroughInputRule);
    void crepe.editor.remove(createCodeBlockInputRule);
    crepe.editor
      .use(sourceFaithfulFenceRemark)
      .use(sourceFaithfulCodeBlockSchema)
      .use(sourceFaithfulCodeBlockInputRule)
      .use(sourceFaithfulCodeBlockEnterShortcut)
      .use(sourceFaithfulMathRemark)
      .use(sourceFaithfulInlineMathSchema)
      .use(renderedBlockHtmlRemark)
      .use(renderedBlockHtmlSchema)
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
        if (lastFocusedCodeTarget) scheduleCodeFocusRestore(lastFocusedCodeTarget);
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
          crepe.editor.action(replaceAllMarkdown(latestMarkdown));
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
      host.removeEventListener("keydown", restoreFocusAfterHistory, true);
      host.removeEventListener("focusin", rememberCodeFocus, true);
      host.removeEventListener("beforeinput", handleCodeSourceOnlyBeforeInput, true);
      host.removeEventListener("paste", handleCodeSourceOnlyTransfer, true);
      host.removeEventListener("drop", handleCodeSourceOnlyTransfer, true);
      host.removeEventListener("beforeinput", ensureSyntheticTrailing, true);
      host.removeEventListener("paste", ensureSyntheticTrailing, true);
      host.removeEventListener("drop", ensureSyntheticTrailing, true);
      host.removeEventListener("keydown", handleCodeWordJump, true);
      host.removeEventListener("keydown", handleCodeDocumentJump, true);
      host.removeEventListener("keydown", handleCodeLineJump, true);
      host.removeEventListener("keydown", handleCodeBoundaryKey, true);
      host.removeEventListener("mousedown", beginCodeDragSelection, true);
      host.removeEventListener("mousedown", focusTableTextFromPointer, true);
      window.removeEventListener("mousemove", updateTableDragSelection, true);
      window.removeEventListener("mouseup", finishTableDragSelection, true);
      window.removeEventListener("mouseup", finishCodeDragSelection, true);
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
      if (codeDragFinishFrame) window.cancelAnimationFrame(codeDragFinishFrame);
      if (historyFocusFrame) window.cancelAnimationFrame(historyFocusFrame);
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
    crepe.editor.action(replaceAllMarkdown(nextMarkdown));
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
