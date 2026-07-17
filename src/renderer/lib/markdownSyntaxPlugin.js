import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { joinBackward, joinForward, lift } from "@milkdown/kit/prose/commands";
import {
  closeHistory,
  redo as redoProseMirror,
  undo as undoProseMirror
} from "@milkdown/kit/prose/history";
import { liftListItem, splitListItem } from "@milkdown/kit/prose/schema-list";
import { AllSelection, EditorState, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose, $shortcut } from "@milkdown/kit/utils";
import { documentGaps, normalizeEmptyMarkdownDocument } from "./markdownDocument.js";
import { tableCellSourceOffsetAtPosition } from "./markdownTable.js";
import {
  adjacentCodeSourceOffset,
  codeContentOffsetAtSourceOffset,
  codeOuterHistoryDirection,
  isEditorHistoryShortcut,
  isEditorSelectAllShortcut,
  tetherCodeViewForElement
} from "./codeEditor.js";
import { decodedMarkdownSourceOffset, sourceTabEdit } from "./sourceEditing.js";
import { normalizeSerializedMarkdown } from "./markdownStyle.js";

export { sourceTabEdit } from "./sourceEditing.js";

const markdownSyntaxKey = new PluginKey("TETHER_MARKDOWN_SYNTAX");
export const externalMarkdownTransactionMeta = "tetherExternalMarkdown";
export const markdownSourceDraftEvent = "tether-markdown-source-draft";

export function activeDocumentSourceSelection(state) {
  return state ? markdownSyntaxKey.getState(state)?.sourceSelection || null : null;
}

export function publishMarkdownSourceDraft(view, markdown) {
  const EventType = view?.dom?.ownerDocument?.defaultView?.CustomEvent;
  if (typeof markdown !== "string" || !EventType || !view.dom.isConnected) return;
  view.dom.dispatchEvent(new EventType(markdownSourceDraftEvent, {
    bubbles: true,
    detail: { markdown }
  }));
}

function serializeMarkdownDocument(doc, serializer) {
  return normalizeSerializedMarkdown(serializer(doc), doc);
}

export function isUnmarkedFullDocumentReplacement(transaction, state) {
  if (
    !transaction?.docChanged
    || transaction.getMeta(externalMarkdownTransactionMeta)
    || Object.keys(transaction.meta || {}).length
    || transaction.steps.length !== 1
  ) return false;
  const [step] = transaction.steps;
  return step?.from === 0 && step?.to === state.doc.content.size;
}

export function isUnmarkedCodeBlockDeletion(transaction, state) {
  if (
    !transaction?.docChanged
    || transaction.getMeta(externalMarkdownTransactionMeta)
    || Object.keys(transaction.meta || {}).length
    || transaction.steps.length !== 1
  ) return false;
  const [step] = transaction.steps;
  const node = Number.isFinite(step?.from) ? state.doc.nodeAt(step.from) : null;
  return node?.type.name === "code_block"
    && step.to === step.from + node.nodeSize
    && step.slice?.size === 0;
}

export function isUnmarkedCodeBlockBoundaryMutation(transaction, state) {
  if (
    !transaction?.docChanged
    || transaction.getMeta(externalMarkdownTransactionMeta)
    || transaction.getMeta(markdownSyntaxKey)
  ) return false;
  const codeBlocks = [];
  state.doc.descendants((node, position) => {
    if (node.type.name === "code_block") codeBlocks.push({ position, node });
    return true;
  });
  if (!codeBlocks.length) return false;
  let nextCodeBlockCount = 0;
  transaction.doc.descendants((node) => {
    if (node.type.name === "code_block") nextCodeBlockCount += 1;
    return true;
  });
  if (nextCodeBlockCount < codeBlocks.length) return true;
  return transaction.steps.some((step) => {
    if (!Number.isFinite(step?.from) || !Number.isFinite(step?.to)) return false;
    return codeBlocks.some(({ position, node }) => {
      const end = position + node.nodeSize;
      return (step.from <= position && step.to > position)
        || (step.from < end && step.to >= end);
    });
  });
}

export function shouldRejectStaleExactSourceReplacement(
  transaction,
  state,
  protectedSource,
  serializer
) {
  if (protectedSource == null || typeof serializer !== "function") return false;
  return serializeMarkdownDocument(transaction.doc, serializer) !== protectedSource
    && (
      isUnmarkedFullDocumentReplacement(transaction, state)
      || isUnmarkedCodeBlockBoundaryMutation(transaction, state)
    );
}

const supportedMarks = ["inlineCode", "link", "strike_through", "strong", "emphasis", "html_inline"];
const sourceBlockNames = new Set(["bullet_list", "ordered_list", "blockquote", "footnote_definition"]);
const structuralSourceBlockNames = new Set([...sourceBlockNames, "heading"]);
const tableNames = new Set(["table", "table_row", "table_cell", "table_header"]);
const sourceAtomNames = new Set([
  "image",
  "hr",
  "footnote_reference",
  "html",
  "html_block",
  "math_inline",
  "hardbreak",
  "link_definition"
]);
const explicitSourceBlockNames = new Set(["paragraph", "code_block", ...structuralSourceBlockNames]);
// Structural blocks stay in their rendered node views during ordinary editing.
// CodeMirror's hidden fence newline is handled separately by the host: only an
// actual deletion of that syntax opens the complete fenced source temporarily.
const sourceDeletionBlockNames = new Set();
const literalTextblockDecodeOptions = { skipMarkdownDelimiters: true };

const inactivePluginState = () => ({
  active: false,
  atomPosition: null,
  literalSourceUnit: null,
  clickPosition: null,
  sourceOffset: null,
  explicitUnitPosition: null,
  initialDeleteDirection: null,
  initialSelectionDirection: null,
  initialSourceSelection: null,
  initialPointerSelection: 0,
  focusLock: false,
  sourceSelection: null
});

export function activateMarkdownSourceAt(view, position, options = {}) {
  const {
    atomPosition = null,
    literalSourceUnit = null,
    explicitUnitPosition = null,
    sourceOffset = null,
    initialDeleteDirection = null,
    initialSelectionDirection = null,
    initialSourceSelection = null,
    initialPointerSelection = 0,
    focusLock = false
  } = options;
  const resolved = view.state.doc.resolve(Math.min(position, view.state.doc.content.size));
  const selection = markdownSourceSelectionAt(view.state.doc, resolved.pos, atomPosition);
  view.dispatch(
    view.state.tr
      .setSelection(selection)
      .setMeta(markdownSyntaxKey, {
        action: "activate",
        atomPosition,
        literalSourceUnit,
        explicitUnitPosition,
        clickPosition: selection.from,
        sourceOffset,
        initialDeleteDirection,
        initialSelectionDirection,
        initialSourceSelection,
        initialPointerSelection,
        focusLock
      })
  );
  view.focus();
}

export function markdownSourceSelectionAt(doc, position, atomPosition = null) {
  const bounded = Math.max(0, Math.min(position, doc.content.size));
  const resolved = doc.resolve(bounded);
  if (atomPosition == null) {
    if (resolved.parent.isTextblock) return TextSelection.create(doc, bounded);
    const direct = doc.nodeAt(bounded);
    if (direct?.isTextblock) {
      return TextSelection.create(doc, Math.min(doc.content.size, bounded + 1));
    }
  }
  return Selection.near(resolved);
}

function documentSourceSelectionCarrier(state, sourceSelection, serializer) {
  const boundary = Math.max(
    0,
    Math.min(Number(sourceSelection?.boundary) || 0, state.doc.content.size)
  );
  if (
    sourceSelection
    && sourceSelection.anchor !== sourceSelection.head
    && typeof serializer === "function"
  ) {
    if (sourceSelectionSpansDocumentUnits(state, sourceSelection, serializer)) {
      return new AllSelection(state.doc);
    }
    const target = documentSourceTarget(
      state,
      sourceSelection.head,
      serializer,
      "forward"
    );
    if (
      target?.kind === "block"
      && target.node.type.name === "code_block"
      && NodeSelection.isSelectable(target.node)
    ) return NodeSelection.create(state.doc, target.position);
  }
  return markdownSourceSelectionAt(state.doc, boundary);
}

export function markdownGapSelectionAt(doc, position, direction) {
  const bounded = Math.max(0, Math.min(position, doc.content.size));
  return Selection.near(
    doc.resolve(bounded),
    direction === "backward" ? -1 : 1
  );
}

export function focusProseMirrorRoot(view) {
  // ProseMirror considers a focused CodeMirror descendant to be focused too,
  // so view.focus() can leave keyboard input in the code block after a jump
  // into a virtual source selection. Blur that descendant first, then use the
  // view's focus method so ProseMirror also synchronizes the DOM selection to
  // the transaction selection. Focusing view.dom directly leaves the browser's
  // old DOM range behind, so the next character can land in unrelated prose or
  // replace the adjacent code block instead of editing the exact source gap.
  const activeElement = view.dom.ownerDocument?.activeElement;
  if (activeElement !== view.dom && view.dom.contains(activeElement)) {
    activeElement.blur?.();
  }
  view.focus();
}

export function dispatchFocusedSourceSelection(view, transaction) {
  const activeElement = view.dom.ownerDocument?.activeElement;
  if (activeElement !== view.dom && view.dom.contains(activeElement)) {
    activeElement.blur?.();
  }
  // Move keyboard ownership away from an embedded editor without asking
  // ProseMirror to restore its still-stale code selection. Once the exact
  // source transaction is installed, view.focus() can safely synchronize the
  // browser range to that new selection.
  view.dom.focus();
  view.dispatch(transaction);
  const sourceSelection = transaction?.getMeta?.(markdownSyntaxKey)?.sourceSelection;
  const carrier = view.state?.selection;
  const rootOwnedCarrier = carrier instanceof AllSelection
    || (carrier instanceof NodeSelection && carrier.node?.type.name === "code_block");
  if (
    sourceSelection
    && sourceSelection.anchor !== sourceSelection.head
    && rootOwnedCarrier
  ) {
    // A non-collapsed physical range can use a node/caret only as an internal
    // carrier. Calling view.focus() asks an embedded node view to own that
    // carrier and can redirect keyboard input into CodeMirror. The root is the
    // actual editor for this source range, and exact handlers own its input.
    view.dom.focus();
  } else {
    view.focus();
  }
}

function pruneStaleCodeBlockDom(view) {
  if (!view?.dom?.isConnected) return;
  const activeElement = view.dom.ownerDocument?.activeElement;
  let removedFocusedNode = false;
  view.dom.querySelectorAll(":scope > .milkdown-code-block").forEach((block) => {
    let mappedDom = null;
    try {
      const position = view.posAtDOM(block, 0, -1);
      mappedDom = view.nodeDOM(position);
    } catch {
      // A node view removed from the ProseMirror document has no valid mapping.
    }
    const stillMapped = mappedDom === block
      || mappedDom?.contains?.(block)
      || block.contains(mappedDom);
    if (stillMapped) return;
    if (activeElement && block.contains(activeElement)) removedFocusedNode = true;
    block.remove();
  });
  if (removedFocusedNode) focusProseMirrorRoot(view);
}

function focusExactEditSelection(view) {
  const codeBlock = enclosingCodeBlock(view.state.doc, view.state.selection.head);
  if (codeBlock && view.state.selection.empty) {
    const contentOffset = Math.max(
      0,
      Math.min(
        codeBlock.node.content.size,
        view.state.selection.head - codeBlock.position - 1
      )
    );
    focusCodeContentOffset(
      view,
      codeBlock.position,
      contentOffset,
      () => focusProseMirrorRoot(view)
    );
  } else {
    focusProseMirrorRoot(view);
  }
  requestAnimationFrame(() => pruneStaleCodeBlockDom(view));
}

export function documentGapSourceSelection(target, sourceOffset) {
  if (target?.kind !== "gap" || !target.documentSource) return null;
  const fullSource = target.documentSource.fullSource;
  const head = Math.max(0, Math.min(fullSource.length, Number(sourceOffset) || 0));
  const before = target.beforeSegment;
  const after = target.afterSegment;
  return {
    anchor: head,
    head,
    fullSource,
    boundary: target.position,
    gapStart: target.gapFrom,
    gapEnd: target.gapTo,
    beforeFrom: before?.position ?? null,
    beforeTo: before ? before.position + before.node.nodeSize : null,
    afterFrom: after?.position ?? null,
    afterTo: after ? after.position + after.node.nodeSize : null
  };
}

export function documentGapFocusDirection(target, fallback = "forward") {
  const beforeIsCode = target?.beforeSegment?.node?.type?.name === "code_block";
  const afterIsCode = target?.afterSegment?.node?.type?.name === "code_block";
  if (afterIsCode && !beforeIsCode) return "backward";
  if (beforeIsCode && !afterIsCode) return "forward";
  return fallback === "backward" ? "backward" : "forward";
}

function activateDocumentSourceOffset(
  view,
  sourceSelection,
  sourceOffset,
  affinity,
  serializer
) {
  const target = documentSourceTarget(view.state, sourceOffset, serializer, affinity);
  if (!target) return false;
  if (target.kind === "gap") {
    const gapSelection = documentGapSourceSelection(target, sourceOffset);
    if (!gapSelection) return false;
    dispatchFocusedSourceSelection(
      view,
      view.state.tr
        .setSelection(markdownGapSelectionAt(
          view.state.doc,
          target.position,
          documentGapFocusDirection(target, affinity)
        ))
        .setMeta(markdownSyntaxKey, {
          action: "source-selection",
          sourceSelection: gapSelection
        })
        .scrollIntoView()
    );
    return true;
  }
  if (target.kind === "block") {
    if (target.node.type.name === "code_block") {
      const blockSource = target.documentSource.fullSource.slice(
        target.segment.from,
        target.segment.to
      );
      const contentOffset = codeContentOffsetAtSourceOffset(
        blockSource,
        target.node.textContent,
        target.sourceOffset
      );
      if (contentOffset != null) {
        focusCodeContentOffset(
          view,
          target.position,
          contentOffset,
          () => activateMarkdownSourceAt(view, target.position, {
            explicitUnitPosition: target.position,
            sourceOffset: target.sourceOffset
          })
        );
        return true;
      }
    }
    // Once a hidden marker or root gap has been traversed, return to the
    // rendered caret as soon as this physical source offset corresponds to a
    // visible text position. Opening a raw paragraph control here makes the
    // next arrow jump across the paragraph instead of advancing one source
    // character, and can leave the browser reconciling against the old fence.
    const renderedPosition = documentPositionAtSourceOffset(
      view.state,
      sourceOffset,
      serializer
    );
    if (renderedPosition != null) {
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, renderedPosition))
          .setMeta(markdownSyntaxKey, "close")
          .scrollIntoView()
      );
      focusExactEditSelection(view);
      return true;
    }
    const options = sourceAtomNames.has(target.node.type.name)
      ? { atomPosition: target.position, sourceOffset: target.sourceOffset }
      : { explicitUnitPosition: target.position, sourceOffset: target.sourceOffset };
    activateMarkdownSourceAt(view, target.position, options);
    return true;
  }

  const before = target.beforeSegment;
  const after = target.afterSegment;
  dispatchFocusedSourceSelection(
    view,
    view.state.tr
      .setSelection(markdownSourceSelectionAt(view.state.doc, target.position))
      .setMeta(markdownSyntaxKey, {
        action: "source-selection",
        sourceSelection: {
          ...sourceSelection,
          anchor: target.sourceOffset,
          head: target.sourceOffset,
          fullSource: target.documentSource.fullSource,
          boundary: target.position,
          ...(before
            ? {
                beforeFrom: before.position,
                beforeTo: before.position + before.node.nodeSize
              }
            : {}),
          ...(after
            ? {
                afterFrom: after.position,
                afterTo: after.position + after.node.nodeSize
              }
            : {}),
          gapStart: target.gapFrom,
          gapEnd: target.gapTo
        }
      })
  );
  return true;
}

function codeViewAtBlockPosition(view, blockPosition) {
  const nodeDOM = view.nodeDOM(blockPosition);
  const codeElement = nodeDOM instanceof Element
    ? nodeDOM.querySelector(".cm-content")
    : null;
  return tetherCodeViewForElement(codeElement);
}

function focusCodeContentOffset(
  view,
  blockPosition,
  contentOffset,
  onUnavailable = null,
  attempts = 6
) {
  const apply = (codeView) => {
    const offset = Math.max(0, Math.min(codeView.state.doc.length, contentOffset));
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(
          view.state.doc,
          blockPosition + 1 + offset
        ))
        .setMeta(markdownSyntaxKey, "close")
    );
    codeView.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
    codeView.focus();
  };
  const codeView = codeViewAtBlockPosition(view, blockPosition);
  if (codeView) {
    apply(codeView);
    return;
  }

  const boundedOffset = Math.max(
    0,
    Math.min(view.state.doc.nodeAt(blockPosition)?.content.size ?? 0, contentOffset)
  );
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(
        view.state.doc,
        blockPosition + 1 + boundedOffset
      ))
      .setMeta(markdownSyntaxKey, "close")
      .scrollIntoView()
  );
  const retry = (remaining) => requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    const mounted = codeViewAtBlockPosition(view, blockPosition);
    if (mounted) {
      apply(mounted);
      return;
    }
    if (remaining > 1) retry(remaining - 1);
    else if (onUnavailable) onUnavailable();
  });
  retry(attempts);
}

function blockSyntaxAtPosition(state, position, allowedNames) {
  const bounded = Math.max(0, Math.min(position, state.doc.content.size));
  const direct = state.doc.nodeAt(bounded);
  if (direct && allowedNames.has(direct.type.name)) {
    return {
      from: bounded,
      to: bounded + direct.nodeSize,
      kind: "block",
      name: direct.type.name
    };
  }

  const resolved = state.doc.resolve(bounded);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (!allowedNames.has(node.type.name)) continue;
    return {
      from: resolved.before(depth),
      to: resolved.after(depth),
      kind: "block",
      name: node.type.name
    };
  }
  return false;
}

export function markdownTableSyntaxAt(state, position) {
  return blockSyntaxAtPosition(state, position, new Set(["table"]));
}

export function activateMarkdownTableSourceAt(view, position) {
  const unit = markdownTableSyntaxAt(view.state, position);
  if (!unit) return false;
  activateMarkdownSourceAt(view, unit.from, { explicitUnitPosition: unit.from });
  return true;
}

export function activateMarkdownBlockSourceAt(view, position) {
  const unit = blockSyntaxAtPosition(view.state, position, explicitSourceBlockNames);
  if (!unit) return false;
  activateMarkdownSourceAt(view, position, { explicitUnitPosition: unit.from });
  return true;
}

export function activeMarkdownSyntax(state) {
  const { selection } = state;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;

  const marks = selection.$from.marks().filter((mark) => supportedMarks.includes(mark.type.name));
  if (!marks.length) return null;

  // Inline code owns its contents; Markdown inside it is literal text.
  const activeMarks = marks.some((mark) => mark.type.name === "inlineCode")
    ? marks.filter((mark) => mark.type.name === "inlineCode")
    : marks;
  const cursorOffset = selection.$from.parentOffset;
  const runForMark = (activeMark) => {
    const runs = [];
    let current = null;
    selection.$from.parent.forEach((node, offset) => {
      const hasMark = node.isText && node.marks.some((nodeMark) => nodeMark.eq(activeMark));
      if (!hasMark) {
        if (current) runs.push(current);
        current = null;
        return;
      }
      const end = offset + node.nodeSize;
      if (!current) current = { from: offset, to: end };
      else current.to = end;
    });
    if (current) runs.push(current);
    return runs.find(({ from, to }) => cursorOffset >= from && cursorOffset <= to) || null;
  };
  const activeRuns = activeMarks.map(runForMark);
  if (activeRuns.some((run) => !run)) return null;

  // Use the smallest balanced span containing every active mark. Taking only
  // their intersection invents delimiters for partial nesting—for example the
  // inner word of `**outer *inner* outer**` would incorrectly become
  // `***inner***` in the source control.
  const run = activeRuns.reduce((combined, current) => ({
    from: Math.min(combined.from, current.from),
    to: Math.max(combined.to, current.to)
  }));

  const parentStart = selection.$from.start();
  return {
    from: parentStart + run.from,
    to: parentStart + run.to,
    kind: "inline",
    names: activeMarks.map((mark) => mark.type.name)
  };
}

export function inlineMarkdownSyntaxAtPosition(state, position) {
  const bounded = Math.max(0, Math.min(position, state.doc.content.size));
  const selection = TextSelection.create(state.doc, bounded);
  return activeMarkdownSyntax({ doc: state.doc, selection });
}

export function activeMarkdownBlockSyntax(state) {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock) return null;

  // A table remains a visual grid while the caret is inside cell text. Its
  // hidden pipe grammar is entered explicitly from a cell boundary below.
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    if (tableNames.has($from.node(depth).type.name)) return null;
  }

  if ($from.parent.type.name === "code_block") {
    return {
      from: $from.before($from.depth),
      to: $from.after($from.depth),
      kind: "block",
      name: "code_block"
    };
  }

  if ($from.parent.type.name === "heading") {
    return {
      from: $from.before($from.depth),
      to: $from.after($from.depth),
      kind: "block",
      name: "heading"
    };
  }

  // Pick the outermost complete source block. A nested list serialized alone
  // loses the indentation and container prefixes that physically precede its
  // marker; the outer source block retains those real cursor coordinates.
  for (let depth = 1; depth < $from.depth; depth += 1) {
    const name = $from.node(depth).type.name;
    if (!sourceBlockNames.has(name)) continue;
    return {
      from: $from.before(depth),
      to: $from.after(depth),
      kind: "block",
      name
    };
  }

  return null;
}

export function structuralBoundarySourceTarget(state, key) {
  const { selection } = state;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;
  const direction = key === "ArrowLeft"
    ? selection.$from.parentOffset === 0 ? "backward" : null
    : key === "ArrowRight" && selection.$from.parentOffset === selection.$from.parent.content.size
      ? "forward"
      : null;
  if (!direction) return null;

  // A formatted run at the visible textblock edge is closer to the caret in
  // the physical Markdown than an enclosing list/quote marker. Enter that
  // inline source first so `* **Bold**` traverses the `**` before `* `.
  const inlineUnit = activeMarkdownSyntax(state);
  if (
    inlineUnit
    && (direction === "backward"
      ? selection.from === inlineUnit.from
      : selection.from === inlineUnit.to)
  ) return { unit: inlineUnit, direction, position: selection.from };

  // Cell text is not physically adjacent across a GFM table boundary: pipes,
  // padding and sometimes the alignment row sit between visible positions.
  // Hand into the exact table source so horizontal arrows traverse those real
  // characters instead of silently sticking to or appending inside the cell.
  const tableUnit = markdownTableSyntaxAt(state, selection.from);
  if (tableUnit) return { unit: tableUnit, direction, position: selection.from };

  const unit = activeMarkdownBlockSyntax(state);
  if (!unit || !structuralSourceBlockNames.has(unit.name)) return null;
  return { unit, direction, position: selection.from };
}

export function sourceLineJumpEdge(event) {
  if (!event || event.altKey || event.ctrlKey) return null;
  if (!event.metaKey && event.key === "Home") return "start";
  if (!event.metaKey && event.key === "End") return "end";
  if (event.metaKey && event.key === "ArrowLeft") return "start";
  if (event.metaKey && event.key === "ArrowRight") return "end";
  return null;
}

export function sourceDocumentJumpEdge(event) {
  if (!event || event.altKey) return null;
  if (event.metaKey && !event.ctrlKey && event.key === "ArrowUp") return "start";
  if (event.metaKey && !event.ctrlKey && event.key === "ArrowDown") return "end";
  if ((event.metaKey || event.ctrlKey) && event.key === "Home") return "start";
  if ((event.metaKey || event.ctrlKey) && event.key === "End") return "end";
  return null;
}

const sourceWordCharacter = /[\p{L}\p{N}_]/u;

function sourceCharacterKind(character) {
  if (/\s/u.test(character)) return "space";
  return sourceWordCharacter.test(character) ? "word" : "punctuation";
}

export function sourceWordOffset(source, offset, direction) {
  const bounded = Math.max(0, Math.min(source.length, offset));
  if (!source || !["backward", "forward"].includes(direction)) return bounded;
  const boundaries = sourceCaretBoundaries(source);
  const segments = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const value = source.slice(start, end);
    return { start, end, kind: sourceCharacterKind(value) };
  });
  if (direction === "backward") {
    let index = segments.findLastIndex((segment) => segment.start < bounded);
    let next = bounded;
    while (index >= 0 && segments[index].kind === "space") {
      next = segments[index].start;
      index -= 1;
    }
    if (index < 0) return 0;
    const kind = segments[index].kind;
    while (index >= 0 && segments[index].kind === kind) {
      next = segments[index].start;
      index -= 1;
    }
    return next;
  }
  let index = segments.findIndex((segment) => segment.end > bounded);
  if (index < 0) return source.length;
  let next = bounded;
  while (index < segments.length && segments[index].kind === "space") {
    next = segments[index].end;
    index += 1;
  }
  if (index >= segments.length) return source.length;
  const kind = segments[index].kind;
  while (index < segments.length && segments[index].kind === kind) {
    next = segments[index].end;
    index += 1;
  }
  return next;
}

export function sourceWordDeleteOffset(source, offset, direction) {
  const value = String(source ?? "");
  const bounded = Math.max(0, Math.min(value.length, Number(offset) || 0));
  if (!value || !["backward", "forward"].includes(direction)) return bounded;
  const line = sourceLineBounds(value, bounded);
  if (direction === "backward" && bounded === line.start) {
    return sourceOffsetAfterCharacter(value, bounded, "backward");
  }
  if (direction === "forward" && bounded === line.end) {
    return sourceOffsetAfterCharacter(value, bounded, "forward");
  }

  const boundaries = sourceCaretBoundaries(value)
    .filter((boundary) => boundary >= line.start && boundary <= line.end);
  const segments = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const segment = value.slice(start, end);
    return { start, end, value: segment, kind: sourceCharacterKind(segment) };
  });
  let position = bounded;
  let kind = null;
  if (direction === "backward") {
    let index = segments.findLastIndex((segment) => segment.start < bounded);
    while (index >= 0) {
      const segment = segments[index];
      if (kind != null && segment.kind !== kind) break;
      if (segment.value !== " " || position !== bounded) kind = segment.kind;
      position = segment.start;
      index -= 1;
    }
    return position;
  }
  let index = segments.findIndex((segment) => segment.end > bounded);
  while (index >= 0 && index < segments.length) {
    const segment = segments[index];
    if (kind != null && segment.kind !== kind) break;
    if (segment.value !== " " || position !== bounded) kind = segment.kind;
    position = segment.end;
    index += 1;
  }
  return position;
}

export function sourceLineDeleteOffset(source, offset, direction) {
  const value = String(source ?? "");
  const bounded = Math.max(0, Math.min(value.length, Number(offset) || 0));
  if (!value || !["backward", "forward"].includes(direction)) return bounded;
  const line = sourceLineBounds(value, bounded);
  if (direction === "backward") {
    return bounded > line.start
      ? line.start
      : sourceOffsetAfterCharacter(value, bounded, "backward");
  }
  return bounded < line.end
    ? line.end
    : sourceOffsetAfterCharacter(value, bounded, "forward");
}

export function sourceWordSelectionRange(anchor, head) {
  return {
    start: Math.min(anchor, head),
    end: Math.max(anchor, head),
    direction: head < anchor ? "backward" : head > anchor ? "forward" : "none"
  };
}

export function sourceSelectionRangeAfterMotion(source, anchor, head, motion) {
  if (!source || !["backward", "forward", "up", "down"].includes(motion)) return null;
  const step = sourceInitialSelectionRange(source, head, motion);
  const nextHead = step.direction === "backward"
    ? step.start
    : step.direction === "forward" ? step.end : head;
  return sourceWordSelectionRange(anchor, nextHead);
}

export function sourcePointerSelectionRange(source, caret, clickCount = 1) {
  const bounded = Math.max(0, Math.min(source.length, caret));
  if (clickCount < 2) return null;
  if (clickCount >= 3) {
    const line = sourceLineBounds(source, bounded);
    return {
      start: line.start,
      end: line.lineBreak < 0 ? line.end : line.lineBreak + 1,
      direction: "forward"
    };
  }
  if (!source) return { start: 0, end: 0, direction: "none" };
  const boundaries = sourceCaretBoundaries(source);
  const segments = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return { start, end, kind: sourceCharacterKind(source.slice(start, end)) };
  });
  let index = segments.findIndex((segment) => bounded < segment.end);
  if (index < 0) index = segments.length - 1;
  if (
    index > 0
    && bounded === segments[index].start
    && segments[index].kind !== "word"
    && segments[index - 1].kind === "word"
  ) index -= 1;
  const kind = segments[index].kind;
  let first = index;
  let last = index;
  while (first > 0 && segments[first - 1].kind === kind) first -= 1;
  while (last + 1 < segments.length && segments[last + 1].kind === kind) last += 1;
  return {
    start: segments[first].start,
    end: segments[last].end,
    direction: "forward"
  };
}

export function sourceWordJumpTarget(state, event, serializer) {
  if (
    !state?.selection?.empty
    || !event?.altKey
    || event.ctrlKey
    || event.metaKey
    || !["ArrowLeft", "ArrowRight"].includes(event.key)
    || typeof serializer !== "function"
  ) return null;
  const direction = event.key === "ArrowLeft" ? "backward" : "forward";
  const adjacent = markdownBoundarySourceTarget(state, direction);
  if (adjacent) {
    const unit = markdownDeletionSourceUnit(state, adjacent);
    if (!unit) return null;
    const source = continuousMarkdownSource(state, unit, serializer);
    const currentOffset = adjacent.edge === "end" ? source.length : 0;
    const targetOffset = sourceWordOffset(source, currentOffset, direction);
    if (targetOffset === currentOffset) return null;
    return { ...adjacent, unit, source, currentOffset, targetOffset, direction };
  }

  const structural = structuralBoundarySourceTarget(state, event.key);
  if (!structural) return null;
  const source = continuousMarkdownSource(state, structural.unit, serializer);
  const currentOffset = sourceCaretOffset(
    state,
    structural.unit,
    source,
    structural.position,
    null,
    serializer
  );
  const targetOffset = sourceWordOffset(source, currentOffset, direction);
  if (targetOffset === currentOffset) return null;
  return {
    ...structural,
    source,
    currentOffset,
    targetOffset,
    atomPosition: null,
    explicitUnitPosition: structural.unit.from
  };
}

export function sourceWordDeletionTargetEdit(
  state,
  direction,
  parser,
  serializer
) {
  if (
    !state?.selection?.empty
    || !["backward", "forward"].includes(direction)
    || typeof parser !== "function"
    || typeof serializer !== "function"
  ) return null;
  const target = sourceWordJumpTarget(state, {
    key: direction === "backward" ? "ArrowLeft" : "ArrowRight",
    altKey: true
  }, serializer);
  if (!target?.unit) return null;
  const documentSource = documentSourceSegments(state, serializer);
  const unitStart = documentSourceUnitStartOffset(state, target.unit, serializer);
  if (!documentSource || !Number.isFinite(unitStart)) return null;
  const currentOffset = unitStart + target.currentOffset;
  const historySelection = {
    anchor: currentOffset,
    head: currentOffset,
    fullSource: documentSource.fullSource,
    boundary: target.position
  };
  const wordEdit = sourceSelectionWordDelete(historySelection, direction);
  if (!wordEdit?.changed) return null;
  const transaction = replaceSourceSelectionTransaction(
    state,
    wordEdit.deletionSelection,
    "",
    parser,
    wordEdit.afterSelection.head
  );
  return transaction ? {
    transaction,
    historySelection,
    editSelection: wordEdit.deletionSelection,
    afterSelection: wordEdit.afterSelection
  } : null;
}

export function sourceLineDeletionTargetEdit(
  state,
  direction,
  parser,
  serializer
) {
  if (
    !state?.selection?.empty
    || !["backward", "forward"].includes(direction)
    || typeof parser !== "function"
    || typeof serializer !== "function"
  ) return null;
  const documentSource = documentSourceSegments(state, serializer);
  const currentOffset = documentSourceOffsetAtPosition(
    state,
    state.selection.head,
    serializer,
    direction === "backward" ? "forward" : "backward"
  );
  if (!documentSource || !Number.isFinite(currentOffset)) return null;
  const historySelection = {
    anchor: currentOffset,
    head: currentOffset,
    fullSource: documentSource.fullSource,
    boundary: state.selection.head
  };
  const lineEdit = sourceSelectionLineDelete(historySelection, direction);
  if (!lineEdit?.changed) return null;
  const transaction = replaceSourceSelectionTransaction(
    state,
    lineEdit.deletionSelection,
    "",
    parser,
    lineEdit.afterSelection.head
  );
  return transaction ? {
    transaction,
    historySelection,
    editSelection: lineEdit.deletionSelection,
    afterSelection: lineEdit.afterSelection
  } : null;
}

export function sourceLineJumpTarget(state, edge, serializer) {
  const { selection } = state;
  if (
    !selection?.empty
    || !selection.$from.parent.isTextblock
    || !["start", "end"].includes(edge)
    || typeof serializer !== "function"
  ) return null;

  const unit = markdownTableSyntaxAt(state, selection.from) || activeMarkdownBlockSyntax(state);
  if (!unit || unit.name === "code_block") return null;
  const source = continuousMarkdownSource(state, unit, serializer);
  const caretOffset = sourceCaretOffset(
    state,
    unit,
    source,
    selection.from,
    null,
    serializer
  );
  const bounds = sourceLineBounds(source, caretOffset);
  const boundaryOffset = edge === "start" ? bounds.start : bounds.end;
  const visibleBoundaryPosition = edge === "start"
    ? selection.$from.start()
    : selection.$from.end();
  const visibleBoundaryOffset = sourceCaretOffset(
    state,
    unit,
    source,
    visibleBoundaryPosition,
    null,
    serializer
  );

  // If the rendered text edge already is the physical Markdown line edge,
  // native Home/End is exact and should remain visually stable.
  if (boundaryOffset === visibleBoundaryOffset) return null;
  return { unit, source, caretOffset, boundaryOffset };
}

export function markdownAtomSyntaxAt(state, position) {
  const node = state.doc.nodeAt(position);
  if (!node || !sourceAtomNames.has(node.type.name)) return null;
  if (
    node.type.name === "hardbreak"
    && node.attrs.isInline
    && !String(node.attrs.markdownMarker || "").length
  ) return null;

  return {
    from: position,
    to: position + node.nodeSize,
    kind: node.isInline ? "inline" : "block",
    name: node.type.name
  };
}

export function sourceAtomNearPosition(state, position) {
  const bounded = Math.max(0, Math.min(position, state.doc.content.size));
  for (const candidate of [bounded, bounded - 1, bounded + 1]) {
    if (candidate < 0 || candidate > state.doc.content.size) continue;
    const atom = markdownAtomSyntaxAt(state, candidate);
    if (atom) return atom;
  }
  return null;
}

export function activeMarkdownAtomSyntax(state) {
  const { selection } = state;
  return selection.node ? markdownAtomSyntaxAt(state, selection.from) : null;
}

function serializeInlineRange(state, from, to, serializer) {
  const paragraph = state.schema.nodes.paragraph.create(null, state.doc.slice(from, to).content);
  const doc = state.schema.nodes.doc.create(null, [paragraph]);
  return serializer(doc).trimEnd();
}

function serializeBlockNode(schema, node, serializer) {
  if (!node) return "";
  const doc = schema.nodes.doc.create(null, [node]);
  return serializer(doc).trimEnd();
}

export function inlineSourceWithReferenceDefinitions(state, source) {
  const definitions = [];
  state.doc.descendants((node) => {
    if (node.type.name === "link_definition" && node.attrs.definitionSource) {
      definitions.push(node.attrs.definitionSource);
    }
  });
  return definitions.length ? `${source}\n\n${definitions.join("\n")}` : source;
}

export function continuousMarkdownSource(state, unit, serializer) {
  if (!unit) return "";
  if (typeof unit.source === "string") return unit.source;
  if (unit.name === "hardbreak") {
    const node = state.doc.nodeAt(unit.from);
    const marker = node?.attrs.markdownMarker;
    if (node?.attrs.isInline) return String(marker || "");
    return marker === "\\" || /^ {2,}$/.test(marker || "") ? marker : "\\";
  }
  return unit.kind === "inline"
    ? serializeInlineRange(state, unit.from, unit.to, serializer)
    : serializeBlockNode(state.schema, state.doc.nodeAt(unit.from), serializer);
}

export function sourceAwareClipboardText(state, serializer) {
  const { selection } = state;
  if (selection.empty || typeof serializer !== "function") return null;
  if (selection.node) {
    const node = selection.node;
    return continuousMarkdownSource(state, {
      from: selection.from,
      to: selection.to,
      kind: node.isInline ? "inline" : "block",
      name: node.type.name
    }, serializer);
  }
  if (selection.from === 0 && selection.to === state.doc.content.size) {
    return serializeMarkdownDocument(state.doc, serializer);
  }

  if (!selection.$from.sameParent(selection.$to) || !selection.$from.parent.isTextblock) {
    const sourceSelection = sourceSelectionFromDocumentSelection(state, serializer);
    if (sourceSelection) return sourceSelectionText(sourceSelection);
    const source = serializer(state.doc.cut(selection.from, selection.to));
    return source.replace(/\r?\n$/, "");
  }
  let hasMarkdownSource = false;
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (sourceAtomNames.has(node.type.name)) hasMarkdownSource = true;
    if (node.isText && node.marks.some((mark) => supportedMarks.includes(mark.type.name))) {
      hasMarkdownSource = true;
    }
    return !hasMarkdownSource;
  });
  if (!hasMarkdownSource) return null;
  const sourceSelection = sourceSelectionFromDocumentSelection(state, serializer, selection);
  if (sourceSelection) return sourceSelectionText(sourceSelection);
  const source = serializer(state.doc.cut(selection.from, selection.to));
  return source.replace(/\r?\n$/, "");
}

function serializedCaretOffset(state, unit, source, position, serializer) {
  if (unit.kind === "block" && position <= unit.from) return 0;
  let marker = "\uE000";
  while (source.includes(marker)) marker += "\uE001";

  const transaction = state.tr.insertText(marker, position, position);
  const markedState = { schema: state.schema, doc: transaction.doc };
  const markerInsideUnit = position >= unit.from && position < unit.to;
  const markedUnit = {
    ...unit,
    to: markerInsideUnit ? unit.to + marker.length : unit.to
  };
  const markedSource = continuousMarkdownSource(markedState, markedUnit, serializer);
  const markerOffset = markedSource.indexOf(marker);
  return markerOffset >= 0 ? markerOffset : null;
}

function structuralSourceMetadata(state, unit) {
  if (unit.kind !== "block") return null;
  const unitNode = state.doc.nodeAt(unit.from);
  const attrs = unitNode?.attrs || {};
  const rawSource = unit.name === "bullet_list" || unit.name === "ordered_list"
    ? attrs.listSource
    : unit.name === "blockquote"
      ? attrs.blockquoteSource
      : unit.name === "footnote_definition"
        ? attrs.footnoteDefinitionSource
        : null;
  const sourceStart = unit.name === "bullet_list" || unit.name === "ordered_list"
    ? attrs.listSourceStart
    : unit.name === "blockquote"
      ? attrs.blockquoteSourceStart
      : unit.name === "footnote_definition"
        ? attrs.footnoteDefinitionSourceStart
        : null;
  return { rawSource, sourceStart };
}

function exactStructuralBoundaryOffset(state, unit, source, position) {
  const metadata = structuralSourceMetadata(state, unit);
  if (!metadata) return null;
  const { rawSource, sourceStart } = metadata;
  if (rawSource !== source || !Number.isFinite(sourceStart)) return null;

  const resolved = state.doc.resolve(position);
  const paragraph = resolved.parent;
  if (paragraph.type.name !== "paragraph") return null;
  const coordinate = resolved.parentOffset === 0
    ? paragraph.attrs.markdownSourceStart
    : resolved.parentOffset === paragraph.content.size
      ? paragraph.attrs.markdownSourceEnd
      : null;
  if (!Number.isFinite(coordinate)) return null;
  return Math.max(0, Math.min(source.length, coordinate - sourceStart));
}

export function structuralSourceHandoffTarget(
  state,
  position,
  direction,
  serializer,
  moveIntoAdjacentCharacter = false
) {
  if (!["backward", "forward"].includes(direction) || typeof serializer !== "function") return null;
  const bounded = Math.max(0, Math.min(position, state.doc.content.size));
  const boundaryState = {
    doc: state.doc,
    schema: state.schema,
    selection: TextSelection.create(state.doc, bounded)
  };
  const blockUnit = activeMarkdownBlockSyntax(boundaryState);
  if (!blockUnit || !structuralSourceBlockNames.has(blockUnit.name)) return null;

  const blockSource = continuousMarkdownSource(boundaryState, blockUnit, serializer);
  let edge = sourceCaretOffset(
    boundaryState,
    blockUnit,
    blockSource,
    bounded,
    null,
    serializer
  );

  // Raw list/quote/footnote coordinates already point before/after all inline
  // delimiters. A generated heading source maps the ProseMirror caret inside
  // those delimiters, so translate it to the outer edge of the inline token.
  const metadata = structuralSourceMetadata(boundaryState, blockUnit);
  const hasExactCoordinates = metadata?.rawSource === blockSource
    && Number.isFinite(metadata?.sourceStart);
  if (!hasExactCoordinates) {
    const inlineUnit = activeMarkdownSyntax(boundaryState);
    if (inlineUnit) {
      const inlineSource = continuousMarkdownSource(boundaryState, inlineUnit, serializer);
      const inlineCaret = sourceCaretOffset(
        boundaryState,
        inlineUnit,
        inlineSource,
        bounded,
        null,
        serializer
      );
      edge = direction === "backward"
        ? edge - inlineCaret
        : edge + inlineSource.length - inlineCaret;
    }
  }

  const hasAdjacentSourceCharacter = direction === "backward"
    ? edge > 0
    : edge < blockSource.length;
  if (!hasAdjacentSourceCharacter) return null;

  const assoc = direction === "backward" ? -1 : 1;
  const sourceOffset = Math.max(
    0,
    Math.min(blockSource.length, edge + (moveIntoAdjacentCharacter ? assoc : 0))
  );
  return { unit: blockUnit, source: blockSource, sourceOffset };
}

export function sourceCaretOffset(
  state,
  unit,
  source,
  clickPosition,
  explicitOffset = null,
  serializer = null
) {
  if (Number.isFinite(explicitOffset)) {
    return Math.max(0, Math.min(source.length, explicitOffset));
  }
  if (!Number.isFinite(clickPosition)) return source.length;

  const position = Math.max(0, Math.min(clickPosition, state.doc.content.size));
  if (unit.name === "hardbreak" && position >= unit.from && position <= unit.to) {
    // A hard break's temporary source contains only its marker; inserting a
    // mapping sentinel before the atom replaces `nodeAt(unit.from)` with text,
    // so the generic serializer cannot locate that sentinel. Map the two real
    // atom boundaries directly to the marker's physical source boundaries.
    return position === unit.from ? 0 : source.length;
  }
  if (unit.name === "table") {
    const tableOffset = tableCellSourceOffsetAtPosition(state, position, source, "forward");
    if (tableOffset != null) return tableOffset;
  }
  const exactBoundary = exactStructuralBoundaryOffset(state, unit, source, position);
  if (exactBoundary != null) return exactBoundary;
  if (serializer && position >= unit.from && position <= unit.to) {
    try {
      const serializedOffset = serializedCaretOffset(state, unit, source, position, serializer);
      if (serializedOffset != null) return serializedOffset;
    } catch {
      // Fall through to the text-based mapping for unusual custom nodes.
    }
  }

  if (unit.kind === "inline" && position >= unit.from && position <= unit.to) {
    const plainText = state.doc.textBetween(unit.from, unit.to, "", "");
    const sourceStart = plainText ? source.indexOf(plainText) : -1;
    if (sourceStart >= 0) {
      return Math.max(sourceStart, Math.min(source.length, sourceStart + position - unit.from));
    }
  }

  const resolved = state.doc.resolve(position);
  if (resolved.parent.isTextblock) {
    const parentText = resolved.parent.textContent;
    const sourceStart = parentText ? source.indexOf(parentText) : -1;
    if (sourceStart >= 0) {
      return Math.max(sourceStart, Math.min(source.length, sourceStart + resolved.parentOffset));
    }
  }
  return source.length;
}

// Refocus the document only when nothing else took focus in the meantime, so
// closing a source editor never steals focus from e.g. the find input.
function refocusView(view) {
  if (!view.dom.isConnected) return;
  const active = view.dom.ownerDocument?.activeElement || null;
  if (!active || active === view.dom.ownerDocument?.body || view.dom.contains(active)) {
    view.focus();
  }
}

function closeSourceEditor(view) {
  view.dispatch(view.state.tr.setMeta(markdownSyntaxKey, "close"));
  requestAnimationFrame(() => refocusView(view));
}

function selectionAfter(transaction, position) {
  const resolvedPosition = Math.max(0, Math.min(position, transaction.doc.content.size));
  return transaction.setSelection(Selection.near(transaction.doc.resolve(resolvedPosition), 1));
}

function dispatchSourceReplacement(view, transaction, afterCommit, sync = false) {
  const mapping = transaction.mapping;
  // A temporary source control is one logical editing session. Once it is
  // committed (including by Save), keep that session distinct from the next
  // reconstructed control so Undo never merges two separately saved edits.
  view.dispatch(closeHistory(transaction).scrollIntoView());
  if (sync) {
    if (afterCommit) afterCommit(mapping);
    return;
  }
  requestAnimationFrame(() => {
    if (afterCommit) afterCommit(mapping);
    else refocusView(view);
  });
}

// Inline controls edit a physical source slice. Build that exact full-document
// draft before parsing so a transient unmatched delimiter is not normalized or
// escaped merely because the rendered model cannot represent it byte-for-byte.
function inlineSourceDocumentEdit(state, unit, source, serializer) {
  if (unit?.kind !== "inline" || typeof serializer !== "function") return null;
  const documentSource = documentSourceSegments(state, serializer);
  const segment = documentSource?.segments.find(({ position, node }) =>
    unit.from >= position && unit.to <= position + node.nodeSize
  );
  if (!segment) return null;

  const segmentSource = documentSource.fullSource.slice(segment.from, segment.to);
  const currentSource = continuousMarkdownSource(state, unit, serializer);
  if (!currentSource) return null;
  const blockUnit = {
    from: segment.position,
    to: segment.position + segment.node.nodeSize,
    kind: "block",
    name: segment.node.type.name
  };
  const caret = sourceCaretOffset(
    state,
    blockUnit,
    segmentSource,
    unit.from,
    null,
    serializer
  );
  const occurrences = [];
  let cursor = 0;
  while (cursor <= segmentSource.length - currentSource.length) {
    const found = segmentSource.indexOf(currentSource, cursor);
    if (found < 0) break;
    occurrences.push(found);
    cursor = found + Math.max(1, currentSource.length);
  }
  const explicitSourceStart = Number.isFinite(unit.segmentSourceOffset)
    && unit.segmentSourceOffset >= 0
    && segmentSource.slice(
      unit.segmentSourceOffset,
      unit.segmentSourceOffset + currentSource.length
    ) === currentSource
    ? unit.segmentSourceOffset
    : null;
  if (!occurrences.length && explicitSourceStart == null) return null;
  const sourceStart = explicitSourceStart ?? occurrences.reduce((best, candidate) => {
    const containsCaret = caret >= candidate && caret <= candidate + currentSource.length;
    const bestContainsCaret = caret >= best && caret <= best + currentSource.length;
    if (containsCaret !== bestContainsCaret) return containsCaret ? candidate : best;
    return Math.abs(candidate - caret) < Math.abs(best - caret) ? candidate : best;
  });
  const nextSegmentSource = `${segmentSource.slice(0, sourceStart)}${source}${
    segmentSource.slice(sourceStart + currentSource.length)
  }`;
  return {
    fullSource: `${documentSource.fullSource.slice(0, segment.from)}${nextSegmentSource}${documentSource.fullSource.slice(segment.to)}`,
    nextSegmentSource,
    segment
  };
}

function replaceInlineSource(view, parser, serializer, unit, source, afterCommit = null, sync = false) {
  const documentEdit = inlineSourceDocumentEdit(view.state, unit, source, serializer);
  const parsed = parser(inlineSourceWithReferenceDefinitions(view.state, source));
  const firstBlock = parsed?.firstChild;
  const replacement = firstBlock?.isTextblock
    ? firstBlock.content
    : source
      ? Fragment.from(view.state.schema.text(source))
      : Fragment.empty;
  let transaction = view.state.tr.replaceWith(unit.from, unit.to, replacement);
  if (documentEdit) {
    const parsedDocument = parser(documentEdit.fullSource);
    const parsedSegment = parsedDocument?.childCount > documentEdit.segment.index
      ? parsedDocument.child(documentEdit.segment.index)
      : null;
    const position = documentEdit.segment.position;
    const current = transaction.doc.nodeAt(position);
    if (parsedSegment?.type === current?.type) {
      transaction = transaction.setNodeMarkup(position, undefined, {
        ...current.attrs,
        ...parsedSegment.attrs
      });
    }
  }
  transaction = selectionAfter(transaction, unit.from + replacement.size);
  transaction.setMeta(markdownSyntaxKey, "close");
  dispatchSourceReplacement(view, transaction, afterCommit, sync);
}

export function hardbreakSourceReplacement(schema, node, source) {
  const isHardbreak = source === "\\" || /^ {2,}$/.test(source);
  return isHardbreak
    ? Fragment.from(node.type.create({
        ...node.attrs,
        isInline: false,
        markdownMarker: source
      }))
    : Fragment.fromArray([
        ...(source ? [schema.text(source)] : []),
        node.type.create({
          ...node.attrs,
          isInline: true,
          markdownMarker: null
        })
      ]);
}

function replaceHardbreakSource(view, parser, serializer, unit, source, afterCommit = null, sync = false) {
  const node = view.state.doc.nodeAt(unit.from);
  if (!node || node.type.name !== "hardbreak" || source.includes("\n")) {
    replaceInlineSource(view, parser, serializer, unit, source, afterCommit, sync);
    return;
  }

  const replacement = hardbreakSourceReplacement(view.state.schema, node, source);
  let transaction = view.state.tr.replaceWith(unit.from, unit.to, replacement);
  transaction = invalidateParagraphSource(transaction, unit.from);
  transaction = selectionAfter(transaction, unit.from + replacement.size);
  transaction.setMeta(markdownSyntaxKey, "close");
  dispatchSourceReplacement(view, transaction, afterCommit, sync);
}

function replaceBlockSource(view, parser, unit, source, afterCommit = null, sync = false) {
  const parsed = parser(source);
  const fallback = view.state.schema.nodes.paragraph.create();
  const replacement = parsed?.content?.size ? parsed.content : Fragment.from(fallback);
  let transaction = view.state.tr.replace(unit.from, unit.to, new Slice(replacement, 0, 0));
  transaction = selectionAfter(transaction, unit.from + replacement.size);
  transaction.setMeta(markdownSyntaxKey, "close");
  dispatchSourceReplacement(view, transaction, afterCommit, sync);
}

export function markdownSourceDraftMarkdown(state, parser, serializer, unit, source) {
  if (!state?.doc || typeof parser !== "function" || typeof serializer !== "function" || !unit) {
    return null;
  }
  let transaction;
  if (unit.kind === "inline") {
    const documentEdit = inlineSourceDocumentEdit(state, unit, source, serializer);
    if (documentEdit) return documentEdit.fullSource;
  }
  if (unit.name === "hardbreak") {
    const node = state.doc.nodeAt(unit.from);
    if (node?.type.name === "hardbreak" && !source.includes("\n")) {
      transaction = state.tr.replaceWith(
        unit.from,
        unit.to,
        hardbreakSourceReplacement(state.schema, node, source)
      );
    }
  }
  if (!transaction && unit.kind === "inline") {
    const parsed = parser(inlineSourceWithReferenceDefinitions(state, source));
    const firstBlock = parsed?.firstChild;
    const replacement = firstBlock?.isTextblock
      ? firstBlock.content
      : source
        ? Fragment.from(state.schema.text(source))
        : Fragment.empty;
    transaction = state.tr.replaceWith(unit.from, unit.to, replacement);
  }
  if (!transaction) {
    const parsed = parser(source);
    const fallback = state.schema.nodes.paragraph.create();
    const replacement = parsed?.content?.size ? parsed.content : Fragment.from(fallback);
    transaction = state.tr.replace(unit.from, unit.to, new Slice(replacement, 0, 0));
  }
  return serializeMarkdownDocument(transaction.doc, serializer);
}

export function activateMarkdownSourceDeletionAt(
  view,
  position,
  options,
  unit,
  source,
  parser,
  serializer
) {
  const deletion = sourceControlInitialDeletion(
    source,
    options.sourceOffset,
    options.initialDeleteDirection
  );
  const draft = deletion
    ? markdownSourceDraftMarkdown(
        view.state,
        parser,
        serializer,
        unit,
        deletion.afterValue
      )
    : null;
  activateMarkdownSourceAt(view, position, options);
  // Publish from the originating key event. A decoration widget can be
  // replaced several times before its focus frame, so making the temporary
  // control responsible for this first change can lose the deletion entirely.
  if (draft != null) publishMarkdownSourceDraft(view, draft);
}

export function inlineSourceBoundaryDirection(
  key,
  selectionStart,
  selectionEnd,
  sourceLength,
  hasModifier = false
) {
  if (hasModifier || selectionStart !== selectionEnd) return null;
  if (key === "ArrowLeft" && selectionStart === 0) return "backward";
  if (key === "ArrowRight" && selectionEnd === sourceLength) return "forward";
  return null;
}

export function inlineSourceBoundaryDeleteDirection(
  key,
  selectionStart,
  selectionEnd,
  sourceLength,
  hasModifier = false
) {
  if (hasModifier || selectionStart !== selectionEnd) return null;
  if (key === "Backspace" && selectionStart === 0) return "backward";
  if (key === "Delete" && selectionEnd === sourceLength) return "forward";
  return null;
}

export function inlineSourceVerticalDirection(
  key,
  selectionStart,
  selectionEnd,
  hasModifier = false
) {
  if (hasModifier || selectionStart !== selectionEnd) return null;
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  return null;
}

export function blockSourceVerticalDirection(
  key,
  selectionStart,
  selectionEnd,
  source,
  hasModifier = false
) {
  if (hasModifier || selectionStart !== selectionEnd) return null;
  if (key === "ArrowUp" && !source.slice(0, selectionStart).includes("\n")) return "up";
  if (key === "ArrowDown" && !source.slice(selectionEnd).includes("\n")) return "down";
  return null;
}

export function inlineSourceBoundarySelectionDirection(
  key,
  selectionStart,
  selectionEnd,
  sourceLength,
  shiftKey = false,
  hasOtherModifier = false,
  selectionDirection = "none"
) {
  if (!shiftKey || hasOtherModifier) return null;
  const collapsed = selectionStart === selectionEnd;
  if (!collapsed && !["backward", "forward"].includes(selectionDirection)) return null;
  const head = collapsed || selectionDirection !== "backward"
    ? selectionEnd
    : selectionStart;
  if (key === "ArrowLeft" && head === 0) return "backward";
  if (key === "ArrowRight" && head === sourceLength) return "forward";
  return null;
}

export function blockSourceBoundarySelectionDirection(
  key,
  selectionStart,
  selectionEnd,
  source,
  shiftKey = false,
  hasOtherModifier = false,
  selectionDirection = "none"
) {
  const horizontal = inlineSourceBoundarySelectionDirection(
    key,
    selectionStart,
    selectionEnd,
    source.length,
    shiftKey,
    hasOtherModifier,
    selectionDirection
  );
  if (horizontal) return horizontal;
  if (!shiftKey || hasOtherModifier || !["ArrowUp", "ArrowDown"].includes(key)) return null;
  const collapsed = selectionStart === selectionEnd;
  if (!collapsed && !["backward", "forward"].includes(selectionDirection)) return null;
  const head = collapsed || selectionDirection !== "backward"
    ? selectionEnd
    : selectionStart;
  if (key === "ArrowUp" && !source.slice(0, head).includes("\n")) return "up";
  if (key === "ArrowDown" && !source.slice(head).includes("\n")) return "down";
  return null;
}

export function sourceInputSelection(
  selectionStart,
  selectionEnd,
  selectionDirection = "none"
) {
  const backward = selectionDirection === "backward" && selectionStart !== selectionEnd;
  return {
    anchor: backward ? selectionEnd : selectionStart,
    head: backward ? selectionStart : selectionEnd
  };
}

export function sourceInputWordJumpDirection(
  key,
  selectionStart,
  selectionEnd,
  sourceLength,
  shiftKey = false,
  altKey = false,
  hasOtherModifier = false,
  selectionDirection = "none"
) {
  if (!altKey || hasOtherModifier || !["ArrowLeft", "ArrowRight"].includes(key)) return null;
  const localSelection = sourceInputSelection(
    selectionStart,
    selectionEnd,
    selectionDirection
  );
  if (!shiftKey && localSelection.anchor !== localSelection.head) return null;
  if (key === "ArrowLeft" && localSelection.head === 0) return "backward";
  if (key === "ArrowRight" && localSelection.head === sourceLength) return "forward";
  return null;
}

export function sourceWordDeleteDirection(event) {
  if (
    !event
    || event.metaKey
    || event.shiftKey
    || !["Backspace", "Delete"].includes(event.key)
  ) return null;
  const wordModifier = Boolean(event.altKey) !== Boolean(event.ctrlKey);
  if (!wordModifier) return null;
  return event.key === "Backspace" ? "backward" : "forward";
}

export function sourceLineDeleteDirection(event) {
  if (
    !event
    || !event.metaKey
    || event.altKey
    || event.ctrlKey
    || event.shiftKey
    || !["Backspace", "Delete"].includes(event.key)
  ) return null;
  return event.key === "Backspace" ? "backward" : "forward";
}

export function sourceWordSelectionAcrossUnitBoundary(
  fullSource,
  unitStart,
  localSelection,
  direction,
  extend = false
) {
  if (
    typeof fullSource !== "string"
    || !Number.isFinite(unitStart)
    || !localSelection
    || !["backward", "forward"].includes(direction)
  ) return null;
  const start = Math.max(0, Math.min(fullSource.length, unitStart));
  const anchor = Math.max(
    0,
    Math.min(fullSource.length, start + (Number(localSelection.anchor) || 0))
  );
  const head = Math.max(
    0,
    Math.min(fullSource.length, start + (Number(localSelection.head) || 0))
  );
  return sourceSelectionWordJump(
    { anchor, head, fullSource, verticalColumn: null },
    direction,
    extend
  );
}

export function exactSourceProtectionDecision(
  transaction,
  state,
  protectedSource,
  serializer,
  armProtection = false
) {
  if (!transaction?.docChanged) {
    return {
      reject: false,
      protectedSource: armProtection
        && protectedSource == null
        && typeof serializer === "function"
        ? serializeMarkdownDocument(state.doc, serializer)
        : protectedSource
    };
  }
  const candidateSource = serializeMarkdownDocument(transaction.doc, serializer);
  if (shouldRejectStaleExactSourceReplacement(
    transaction,
    state,
    protectedSource,
    serializer
  )) {
    // Chromium can retry the same reconciliation after ProseMirror rejects it.
    // Keep the authoritative source until an explicit pointer/destructive-key
    // interaction clears it or a legitimate edit advances it below.
    return { reject: true, protectedSource };
  }
  const meta = transaction.getMeta(markdownSyntaxKey);
  return {
    reject: false,
    protectedSource: protectedSource != null
      && meta?.action !== "exact-source-edit"
      && candidateSource !== protectedSource
      ? candidateSource
      : protectedSource
  };
}

export function sourcePointerDragSelection(
  fullSource,
  unitStart,
  localAnchor,
  documentHead
) {
  if (
    typeof fullSource !== "string"
    || !Number.isFinite(unitStart)
    || !Number.isFinite(localAnchor)
    || !Number.isFinite(documentHead)
  ) return null;
  return {
    anchor: Math.max(0, Math.min(fullSource.length, unitStart + localAnchor)),
    head: Math.max(0, Math.min(fullSource.length, documentHead)),
    fullSource,
    verticalColumn: null
  };
}

export function sourceSelectionAcrossUnitBoundary(
  fullSource,
  unitStart,
  localSelection,
  direction
) {
  if (
    typeof fullSource !== "string"
    || !Number.isFinite(unitStart)
    || !localSelection
    || !["backward", "forward", "up", "down"].includes(direction)
  ) return null;
  const start = Math.max(0, Math.min(fullSource.length, unitStart));
  const anchor = Math.max(
    0,
    Math.min(fullSource.length, start + (Number(localSelection.anchor) || 0))
  );
  const head = Math.max(
    0,
    Math.min(fullSource.length, start + (Number(localSelection.head) || 0))
  );
  const currentLine = sourceLineBounds(fullSource, head);
  const verticalColumn = ["up", "down"].includes(direction)
    ? Math.max(0, Math.min(currentLine.end, currentLine.bounded) - currentLine.start)
    : null;
  const nextHead = ["up", "down"].includes(direction)
    ? sourceVerticalOffset(fullSource, head, direction, verticalColumn)
    : sourceOffsetAfterCharacter(fullSource, head, direction);
  return {
    anchor,
    head: nextHead,
    fullSource,
    verticalColumn
  };
}

export function sourceBoundarySelectionRange(sourceOrLength, caret, direction) {
  const source = typeof sourceOrLength === "string" ? sourceOrLength : null;
  const sourceLength = source?.length ?? sourceOrLength;
  const boundedCaret = Math.max(0, Math.min(sourceLength, caret));
  if (direction === "backward" && boundedCaret > 0) {
    const start = source
      ? sourceOffsetAfterCharacter(source, boundedCaret, "backward")
      : boundedCaret - 1;
    return { start, end: boundedCaret, direction: "backward" };
  }
  if (direction === "forward" && boundedCaret < sourceLength) {
    const end = source
      ? sourceOffsetAfterCharacter(source, boundedCaret, "forward")
      : boundedCaret + 1;
    return { start: boundedCaret, end, direction: "forward" };
  }
  return { start: boundedCaret, end: boundedCaret, direction: "none" };
}

export function sourceInitialSelectionRange(source, caret, direction) {
  const boundedCaret = Math.max(0, Math.min(source.length, caret));
  if (["backward", "forward"].includes(direction)) {
    return sourceBoundarySelectionRange(source, boundedCaret, direction);
  }
  const line = sourceLineBounds(source, boundedCaret);
  const head = direction === "line-start"
    ? line.start
    : direction === "line-end"
      ? line.end
      : ["up", "down"].includes(direction)
        ? sourceVerticalOffset(source, boundedCaret, direction)
        : boundedCaret;

  return {
    start: Math.min(boundedCaret, head),
    end: Math.max(boundedCaret, head),
    direction: head < boundedCaret ? "backward" : head > boundedCaret ? "forward" : "none"
  };
}

function listItemTypeAtMarkerBoundary(state) {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || $from.parentOffset !== 0 || !$from.parent.isTextblock) return null;

  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    const type = $from.node(depth).type;
    if (type.name === "list_item") return type;
  }
  return null;
}

export function liftListMarkerAtCursor(state, dispatch = null, view = null) {
  const listItemType = listItemTypeAtMarkerBoundary(state);
  if (!listItemType) return false;
  return liftListItem(listItemType)(state, dispatch, view);
}

function replaceDocumentSourceAtCaret(state, source, caretOffset, parser) {
  if (typeof parser !== "function") return null;
  let marker = "\uE200";
  while (source.includes(marker)) marker += "\uE201";
  const parsed = parser(source);
  const marked = parser(`${source.slice(0, caretOffset)}${marker}${source.slice(caretOffset)}`);
  let markerPosition = null;
  marked?.descendants((node, position) => {
    if (markerPosition != null || !node.isText) return markerPosition == null;
    const index = node.text.indexOf(marker);
    if (index >= 0) markerPosition = position + index;
    return markerPosition == null;
  });
  if (markerPosition == null) return null;

  let transaction = state.tr.replace(
    0,
    state.doc.content.size,
    new Slice(parsed.content, 0, 0)
  );
  for (const [name, value] of Object.entries(parsed.attrs || {})) {
    transaction = transaction.setDocAttribute(name, value);
  }
  const selectionPosition = Math.max(0, Math.min(markerPosition, transaction.doc.content.size));
  return transaction.setSelection(TextSelection.create(transaction.doc, selectionPosition));
}

function listLinePrefix(line, requireCaretBoundary = false) {
  const pattern = requireCaretBoundary
    ? /^((?:\[\^[^\]\r\n]+\]:[\t ]*)?(?:[\t ]{0,3}>[\t ]?)*)([\t ]*)(?:[-+*]|\d+[.)])(?:[\t ]+)(?:\[[ xX]\][\t ]+)?$/
    : /^((?:\[\^[^\]\r\n]+\]:[\t ]*)?(?:[\t ]{0,3}>[\t ]?)*)([\t ]*)(?:[-+*]|\d+[.)])(?:[\t ]+|$)/;
  const match = line.match(pattern);
  if (!match) return null;
  return {
    container: match[1],
    indent: match[2],
    quoteDepth: (match[1].match(/>/g) || []).length
  };
}

function precedingListIndent(source, lineStart, current, searchStart = 0) {
  const before = source.slice(searchStart, lineStart).split(/\r?\n/);
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const candidate = listLinePrefix(before[index]);
    if (
      !candidate
      || candidate.quoteDepth !== current.quoteDepth
      || candidate.indent.length >= current.indent.length
    ) continue;
    return candidate.indent;
  }
  return "";
}

export function sourceFaithfulListMarkerBackspaceTransaction(state, parser, serializer) {
  if (!listItemTypeAtMarkerBoundary(state) || typeof serializer !== "function") return null;
  // At a formatted item start, the inline delimiter is physically between the
  // caret and the list marker. Avoid serializing a sentinel through the mark
  // group and let the inline source handler consume that delimiter first.
  if (activeMarkdownSyntax(state)) return null;
  const unit = activeMarkdownBlockSyntax(state);
  if (!unit || !["bullet_list", "ordered_list", "blockquote", "footnote_definition"].includes(unit.name)) {
    return null;
  }
  const documentSource = documentSourceSegments(state, serializer);
  const segment = documentSource?.segments.find(({ position }) => position === unit.from);
  if (!segment) return null;

  const unitSource = continuousMarkdownSource(state, unit, serializer);
  const unitOffset = sourceCaretOffset(
    state,
    unit,
    unitSource,
    state.selection.from,
    null,
    serializer
  );
  const caretOffset = segment.from + unitOffset;
  const lineStart = documentSource.fullSource.lastIndexOf("\n", Math.max(0, caretOffset - 1)) + 1;
  const prefix = documentSource.fullSource.slice(lineStart, caretOffset);
  const marker = listLinePrefix(prefix, true);
  if (!marker) return null;

  const listDepth = Array.from({ length: state.selection.$from.depth }, (_, index) =>
    state.selection.$from.node(index + 1).type.name
  ).filter((name) => name === "bullet_list" || name === "ordered_list").length;
  if (listDepth <= 1) {
    const retainedIndent = unit.name === "footnote_definition" && !marker.container
      ? marker.indent
      : "";
    const source = `${documentSource.fullSource.slice(0, lineStart)}${marker.container}${retainedIndent}${documentSource.fullSource.slice(caretOffset)}`;
    return replaceDocumentSourceAtCaret(
      state,
      source,
      lineStart + marker.container.length + retainedIndent.length,
      parser
    );
  }

  const targetIndent = precedingListIndent(
    documentSource.fullSource,
    lineStart,
    marker,
    segment.from
  );
  const source = `${documentSource.fullSource.slice(0, lineStart)}${marker.container}${targetIndent}${documentSource.fullSource.slice(lineStart + marker.container.length + marker.indent.length)}`;
  const nextCaret = caretOffset - marker.indent.length + targetIndent.length;
  return replaceDocumentSourceAtCaret(state, source, nextCaret, parser);
}

function structuralMarkerAtCursor(state) {
  const { selection } = state;
  const { $from } = selection;
  if (
    !selection.empty
    || $from.parentOffset !== 0
    || $from.parent.type.name !== "paragraph"
  ) return null;

  // Walk from the text toward the document so Backspace removes the source
  // marker nearest the caret. This matters for combinations such as
  // `- > quote`: the quote marker must lift before the outer list marker.
  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    const type = $from.node(depth).type;
    if (type.name === "blockquote") return { kind: "blockquote" };
    if (type.name === "list_item") return { kind: "list_item", type };
  }
  return null;
}

export function liftStructuralMarkerAtCursor(state, dispatch = null, view = null) {
  const marker = structuralMarkerAtCursor(state);
  if (!marker) return false;
  if (marker.kind === "list_item") {
    return liftListItem(marker.type)(state, dispatch, view);
  }
  return lift(state, dispatch, view);
}

export function sourceFaithfulListItemKeymapConfig(config) {
  return {
    ...config,
    LiftFirstListItem: {
      ...config.LiftFirstListItem,
      // Forward Delete operates on the first content character. Only Backspace
      // crosses the rendered marker boundary.
      shortcuts: "Backspace"
    }
  };
}

export function splitOrderedListItemWithSourceNumber(state, dispatch = null, view = null) {
  const { $from } = state.selection;
  let itemType = null;
  let inOrderedList = false;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (!itemType && node.type.name === "list_item") itemType = node.type;
    if (node.type.name === "ordered_list") {
      inOrderedList = true;
      break;
    }
  }
  if (!itemType || !inOrderedList) return false;

  return splitListItem(itemType)(state, dispatch
    ? (transaction) => {
        const selection = transaction.selection;
        const resolved = selection.$from;
        for (let depth = resolved.depth; depth > 0; depth -= 1) {
          const node = resolved.node(depth);
          if (node.type.name !== "list_item") continue;
          if (node.attrs.orderedNumber != null) {
            transaction.setNodeMarkup(resolved.before(depth), undefined, {
              ...node.attrs,
              orderedNumber: null
            });
          }
          break;
        }
        dispatch(transaction);
      }
    : null, view);
}

export function sourceFaithfulHeadingKeymapConfig(config) {
  return {
    ...config,
    DowngradeHeading: {
      ...config.DowngradeHeading,
      shortcuts: []
    }
  };
}

export function downgradeAtxHeadingAtCursor(state, dispatch = null) {
  const { selection } = state;
  const { $from } = selection;
  const heading = $from.parent;
  if (
    !selection.empty
    || $from.parentOffset !== 0
    || heading.type.name !== "heading"
    || heading.attrs.markdownStyle === "setext"
  ) return false;

  const position = $from.before();
  const level = Number(heading.attrs.level) - 1;
  const transaction = level > 0
    ? state.tr.setNodeMarkup(position, undefined, { ...heading.attrs, level })
    : state.tr.setNodeMarkup(position, state.schema.nodes.paragraph);
  dispatch?.(transaction.scrollIntoView());
  return true;
}

export function textSelectionAcrossBoundary(state, boundaryPosition, direction) {
  const assoc = direction === "backward" ? -1 : 1;
  let boundedBoundary = Math.max(0, Math.min(boundaryPosition, state.doc.content.size));
  const resolved = state.doc.resolve(boundedBoundary);

  // Inline source controls end at a textblock content position, while the
  // physical Markdown newline lives between the surrounding block nodes.
  // Promote that endpoint to the enclosing source block (list/quote/heading)
  // or, for ordinary prose, to the immediate textblock boundary.
  if (resolved.parent.isTextblock) {
    const atRequestedEdge = direction === "backward"
      ? resolved.parentOffset === 0
      : resolved.parentOffset === resolved.parent.content.size;
    if (atRequestedEdge) {
      const boundaryState = {
        doc: state.doc,
        schema: state.schema,
        selection: TextSelection.create(state.doc, boundedBoundary)
      };
      const sourceBlock = activeMarkdownBlockSyntax(boundaryState);
      boundedBoundary = sourceBlock
        ? direction === "backward" ? sourceBlock.from : sourceBlock.to
        : direction === "backward" ? resolved.before() : resolved.after();
    }
  }

  const boundary = state.doc.resolve(boundedBoundary);
  const before = Selection.findFrom(boundary, -1, true);
  const after = Selection.findFrom(boundary, 1, true);
  if (
    before
    && after
    && before.from < after.from
    && !rangeContainsLeafContent(state.doc, before.from, after.from)
    && state.doc.textBetween(before.from, after.from, "", "") === ""
  ) {
    return TextSelection.create(
      state.doc,
      direction === "backward" ? after.from : before.from,
      direction === "backward" ? before.from : after.from
    );
  }

  const anchor = Selection.near(boundary, assoc).from;
  const head = Math.max(0, Math.min(anchor + assoc, state.doc.content.size));
  return TextSelection.between(
    state.doc.resolve(anchor),
    state.doc.resolve(head),
    assoc
  );
}

function rangeContainsLeafContent(doc, from, to) {
  let containsLeafContent = false;
  doc.slice(from, to).content.descendants((node) => {
    if (node.isLeaf) containsLeafContent = true;
  });
  return containsLeafContent;
}

export function sourceNewlineSelectionInfo(state) {
  const { selection, doc } = state;
  if (
    selection.empty
    || rangeContainsLeafContent(doc, selection.from, selection.to)
    || doc.textBetween(selection.from, selection.to, "", "") !== ""
    || !doc.textBetween(selection.from, selection.to, "\n", "").includes("\n")
  ) return null;

  for (let position = selection.from + 1; position < selection.to; position += 1) {
    const resolved = doc.resolve(position);
    if (resolved.depth !== 0 || !resolved.nodeBefore || !resolved.nodeAfter) continue;
    return {
      boundary: position,
      beforeFrom: position - resolved.nodeBefore.nodeSize,
      beforeTo: position,
      afterFrom: position,
      afterTo: position + resolved.nodeAfter.nodeSize
    };
  }
  return null;
}

export function sourceNewlineClipboardText(state) {
  return sourceNewlineSelectionInfo(state) ? "\n" : null;
}

function sourceDocumentChildCount(doc) {
  const trailing = doc?.lastChild;
  return trailing?.type.name === "paragraph"
    && !trailing.content.size
    && trailing.attrs.tetherSyntheticTrailing
    ? Math.max(0, doc.childCount - 1)
    : doc?.childCount || 0;
}

export function serializedDocumentGaps(state, serializer) {
  if (typeof serializer !== "function") return null;
  const fullSource = serializeMarkdownDocument(state.doc, serializer);
  const gaps = [];
  let cursor = 0;
  const childCount = sourceDocumentChildCount(state.doc);

  for (let index = 0; index < childCount; index += 1) {
    const child = state.doc.child(index);
    const blockSource = serializedDocumentBlockSource(state, child, serializer);
    if (typeof blockSource !== "string") return null;
    const start = fullSource.indexOf(blockSource, cursor);
    if (start < cursor) return null;
    gaps.push(fullSource.slice(cursor, start));
    cursor = start + blockSource.length;
  }
  gaps.push(fullSource.slice(cursor));
  return gaps.length === childCount + 1 ? gaps : null;
}

function serializedDocumentBlockSource(state, child, serializer) {
  let serialized;
  try {
    const single = state.doc.type.create(
      { ...state.doc.attrs, markdownBlockGaps: null },
      child
    );
    serialized = serializer(single);
  } catch {
    return null;
  }
  const ownedTrailingLineEnding = child.type.name === "code_block"
    ? child.attrs.fenceTrailingLineEnding
    : "";
  if (ownedTrailingLineEnding && serialized.endsWith(ownedTrailingLineEnding)) {
    return serialized;
  }
  // A root serializer contributes one terminal line break. That line break is
  // document spacing, not part of the block's own physical source segment.
  return serialized.endsWith("\r\n")
    ? serialized.slice(0, -2)
    : serialized.endsWith("\n")
      ? serialized.slice(0, -1)
      : serialized;
}

function documentGapsForState(state, serializer) {
  return documentGaps(state.doc.attrs.markdownBlockGaps, sourceDocumentChildCount(state.doc))
    || serializedDocumentGaps(state, serializer);
}

export function sourceNewlineSourceRange(state, serializer) {
  if (typeof serializer !== "function") return null;
  const info = sourceNewlineSelectionInfo(state);
  const gaps = documentGapsForState(state, serializer);
  if (!info || !gaps) return null;
  const gapIndex = state.doc.resolve(info.boundary).index(0);
  const gap = gaps[gapIndex];
  if (!gap) return null;

  const prefix = state.doc.type.create(
    {
      ...state.doc.attrs,
      markdownBlockGaps: JSON.stringify(gaps.slice(0, gapIndex + 1))
    },
    state.doc.content.cut(0, info.boundary)
  );
  const prefixSource = serializeMarkdownDocument(prefix, serializer);
  const fullSource = serializeMarkdownDocument(state.doc, serializer);
  const gapStart = prefixSource.length - gap.length;
  if (gapStart < 0 || fullSource.slice(gapStart, gapStart + gap.length) !== gap) return null;

  const backward = state.selection.anchor > state.selection.head;
  const relativeFrom = backward
    ? gap.endsWith("\r\n") ? gap.length - 2 : gap.length - 1
    : 0;
  const length = backward
    ? gap.endsWith("\r\n") ? 2 : 1
    : gap.startsWith("\r\n") ? 2 : 1;
  const from = gapStart + relativeFrom;
  const to = from + length;
  const text = fullSource.slice(from, to);
  if (!(text === "\n" || text === "\r\n")) return null;
  return {
    ...info,
    from,
    to,
    text,
    fullSource,
    gapStart,
    gapEnd: gapStart + gap.length
  };
}

export function sourceSelectionFromNewlineRange(range, direction) {
  if (!range || !["backward", "forward"].includes(direction)) return null;
  return {
    anchor: direction === "backward" ? range.to : range.from,
    head: direction === "backward" ? range.from : range.to,
    fullSource: range.fullSource,
    boundary: range.boundary,
    beforeFrom: range.beforeFrom,
    beforeTo: range.beforeTo,
    afterFrom: range.afterFrom,
    afterTo: range.afterTo,
    gapStart: range.gapStart,
    gapEnd: range.gapEnd
  };
}

export function sourceSelectionText(sourceSelection) {
  if (!sourceSelection) return null;
  const from = Math.min(sourceSelection.anchor, sourceSelection.head);
  const to = Math.max(sourceSelection.anchor, sourceSelection.head);
  return sourceSelection.fullSource.slice(from, to);
}

export function exactSourceSelectionAfterUndo(history, beforeUndoSource, afterUndoSource) {
  if (!Array.isArray(history) || beforeUndoSource === afterUndoSource) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (
      entry?.afterSource !== beforeUndoSource
      || entry?.beforeSource !== afterUndoSource
      || !entry.sourceSelection
    ) continue;
    return {
      ...entry.sourceSelection,
      fullSource: afterUndoSource
    };
  }
  return null;
}

export function exactSourceSelectionAfterHistory(history, beforeHistorySource, afterHistorySource) {
  if (!Array.isArray(history) || beforeHistorySource === afterHistorySource) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (
      entry?.afterSource === beforeHistorySource
      && entry?.beforeSource === afterHistorySource
      && entry?.sourceSelection
    ) {
      return {
        ...entry.sourceSelection,
        fullSource: afterHistorySource
      };
    }
    if (
      entry?.beforeSource === beforeHistorySource
      && entry?.afterSource === afterHistorySource
      && entry?.afterSourceSelection
    ) {
      return {
        ...entry.afterSourceSelection,
        fullSource: afterHistorySource
      };
    }
  }
  return null;
}

export function exactSourceHistoryStep(history, command, currentSource) {
  if (!Array.isArray(history) || !["undo", "redo"].includes(command)) return null;
  if (command === "undo") {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (entry?.state !== "applied" || entry.afterSource !== currentSource) continue;
      return {
        entry,
        index,
        source: entry.beforeSource,
        sourceSelection: entry.sourceSelection
      };
    }
    return null;
  }
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (entry?.state !== "undone" || entry.beforeSource !== currentSource) continue;
    return {
      entry,
      index,
      source: entry.afterSource,
      sourceSelection: entry.afterSourceSelection
    };
  }
  return null;
}

export function sourceEditCaretOffset(sourceSelection, afterSource) {
  if (!sourceSelection || typeof afterSource !== "string") return null;
  const beforeSource = sourceSelection.fullSource;
  if (typeof beforeSource !== "string") return null;
  const to = Math.max(sourceSelection.anchor, sourceSelection.head);
  const maximumSuffix = Math.max(0, beforeSource.length - to);
  let suffixLength = 0;
  while (
    suffixLength < maximumSuffix
    && beforeSource[beforeSource.length - 1 - suffixLength]
      === afterSource[afterSource.length - 1 - suffixLength]
  ) suffixLength += 1;
  return Math.max(0, afterSource.length - suffixLength);
}

export function sourceLineEndingAt(source, offset) {
  const value = String(source ?? "");
  const bounded = Math.max(0, Math.min(value.length, Number(offset) || 0));
  const previous = value.lastIndexOf("\n", Math.max(0, bounded - 1));
  const next = value.indexOf("\n", bounded);
  const lineBreak = previous < 0
    ? next
    : next < 0
      ? previous
      : bounded - previous - 1 <= next - bounded ? previous : next;
  return lineBreak > 0 && value[lineBreak - 1] === "\r" ? "\r\n" : "\n";
}

export function sourceSelectionAfterEdit(transaction, editSelection, serializer) {
  if (!transaction?.doc || !editSelection || typeof serializer !== "function") return null;
  const fullSource = serializeMarkdownDocument(transaction.doc, serializer);
  const caret = sourceEditCaretOffset(editSelection, fullSource);
  if (!Number.isFinite(caret)) return null;
  return {
    anchor: caret,
    head: caret,
    fullSource,
    boundary: Math.max(0, Math.min(transaction.selection.head, transaction.doc.content.size))
  };
}

export function documentSourceSegments(state, serializer) {
  if (typeof serializer !== "function") return null;
  const gaps = documentGapsForState(state, serializer);
  if (!gaps) return null;
  const segments = [];
  let documentPosition = 0;
  let previousSourceEnd = 0;
  const childCount = sourceDocumentChildCount(state.doc);
  const fullSource = serializeMarkdownDocument(state.doc, serializer);
  for (let index = 0; index < childCount; index += 1) {
    const node = state.doc.child(index);
    const nodeTo = documentPosition + node.nodeSize;
    const sourceStart = previousSourceEnd + gaps[index].length;
    const blockSource = serializedDocumentBlockSource(state, node, serializer);
    let sourceEnd = typeof blockSource === "string"
      && fullSource.slice(sourceStart, sourceStart + blockSource.length) === blockSource
      ? sourceStart + blockSource.length
      : null;
    if (!Number.isFinite(sourceEnd)) {
      const prefix = state.doc.type.create(
        {
          ...state.doc.attrs,
          markdownBlockGaps: JSON.stringify(gaps.slice(0, index + 2))
        },
        state.doc.content.cut(0, nodeTo)
      );
      let prefixSource;
      try {
        prefixSource = serializeMarkdownDocument(prefix, serializer);
      } catch {
        return null;
      }
      sourceEnd = prefixSource.length - gaps[index + 1].length;
      if (sourceEnd < sourceStart || sourceEnd > fullSource.length) return null;
    }
    segments.push({
      index,
      node,
      position: documentPosition,
      from: sourceStart,
      to: sourceEnd,
      gapFrom: sourceEnd,
      gapTo: sourceEnd + gaps[index + 1].length
    });
    previousSourceEnd = sourceEnd;
    documentPosition = nodeTo;
  }
  if (previousSourceEnd + (gaps.at(-1)?.length || 0) !== fullSource.length) return null;
  return { fullSource, gaps, segments };
}

export function rootBoundarySourceSelection(state, direction, serializer, extend = false) {
  if (
    !state?.selection?.empty
    || !["backward", "forward"].includes(direction)
    || typeof serializer !== "function"
  ) return null;
  const { $head } = state.selection;
  const documentSource = documentSourceSegments(state, serializer);
  if (!documentSource) return null;
  let rootIndex;
  if ($head.depth === 1 && $head.parent.isTextblock) {
    const atEdge = direction === "backward"
      ? $head.parentOffset === 0
      : $head.parentOffset === $head.parent.content.size;
    if (!atEdge) return null;
    rootIndex = $head.index(0);
  } else if ($head.depth === 0) {
    // ProseMirror's virtual-cursor plugin represents a caret beside a
    // non-editable CodeMirror node as a root GapCursor. Visually this is the
    // beginning/end of the adjacent textblock, and physically it is the same
    // Markdown gap between those two root source segments.
    const nextIndex = $head.index(0);
    rootIndex = direction === "backward" ? nextIndex : nextIndex - 1;
  } else {
    return null;
  }
  const segment = documentSource.segments[rootIndex];
  const adjacent = documentSource.segments[rootIndex + (direction === "backward" ? -1 : 1)];
  if (!segment || !adjacent) return null;

  const currentOffset = direction === "backward" ? segment.from : segment.to;
  const gapFrom = direction === "backward" ? adjacent.to : segment.to;
  const gapTo = direction === "backward" ? segment.from : adjacent.from;
  if (gapFrom >= gapTo) return null;
  const nextOffset = sourceOffsetAfterCharacter(
    documentSource.fullSource,
    currentOffset,
    direction
  );
  if (nextOffset < gapFrom || nextOffset > gapTo || nextOffset === currentOffset) return null;

  const boundary = direction === "backward" ? segment.position : adjacent.position;
  return {
    anchor: extend ? currentOffset : nextOffset,
    head: nextOffset,
    fullSource: documentSource.fullSource,
    boundary,
    beforeFrom: boundary - (direction === "backward" ? adjacent.node.nodeSize : segment.node.nodeSize),
    beforeTo: boundary,
    afterFrom: boundary,
    afterTo: boundary + (direction === "backward" ? segment.node.nodeSize : adjacent.node.nodeSize)
  };
}

export function rootBoundarySourceDeletionEdit(state, direction, parser, serializer) {
  if (typeof parser !== "function" || typeof serializer !== "function") return null;
  const deletionSelection = rootBoundarySourceSelection(
    state,
    direction,
    serializer,
    true
  );
  if (!deletionSelection) return null;
  const beforeSelection = {
    ...deletionSelection,
    head: deletionSelection.anchor
  };
  const transaction = replaceSourceSelectionTransaction(
    state,
    deletionSelection,
    "",
    parser
  );
  return transaction ? { transaction, beforeSelection, deletionSelection } : null;
}

export function documentSourceTarget(state, sourceOffset, serializer, affinity = "forward") {
  const documentSource = documentSourceSegments(state, serializer);
  if (!documentSource) return null;
  const offset = Math.max(0, Math.min(documentSource.fullSource.length, sourceOffset));
  const first = documentSource.segments[0];
  if (
    first
    && first.from > 0
    && (offset < first.from || (offset === first.from && affinity === "backward"))
  ) {
    return {
      kind: "gap",
      position: 0,
      sourceOffset: offset,
      gapFrom: 0,
      gapTo: first.from,
      beforeSegment: null,
      afterSegment: first,
      segment: first,
      documentSource
    };
  }
  for (const segment of documentSource.segments) {
    const atStart = offset === segment.from;
    const atEnd = offset === segment.to;
    if (
      (offset > segment.from && offset < segment.to)
      || (atStart && affinity === "forward")
      || (atEnd && affinity === "backward")
    ) {
      return {
        kind: "block",
        position: segment.position,
        node: segment.node,
        sourceOffset: offset - segment.from,
        segment,
        documentSource
      };
    }
    if (
      (offset > segment.gapFrom && offset < segment.gapTo)
      || (offset === segment.gapFrom && affinity === "forward" && segment.gapTo > segment.gapFrom)
      || (offset === segment.gapTo && affinity === "backward" && segment.gapTo > segment.gapFrom)
    ) {
      return {
        kind: "gap",
        position: segment.position + segment.node.nodeSize,
        sourceOffset: offset,
        gapFrom: segment.gapFrom,
        gapTo: segment.gapTo,
        beforeSegment: segment,
        afterSegment: documentSource.segments[segment.index + 1] || null,
        segment,
        documentSource
      };
    }
  }
  return null;
}

export function sourceSelectionSpansDocumentUnits(state, sourceSelection, serializer) {
  if (
    !state?.doc
    || !sourceSelection
    || sourceSelection.anchor === sourceSelection.head
    || typeof serializer !== "function"
  ) return false;
  const from = Math.min(sourceSelection.anchor, sourceSelection.head);
  const to = Math.max(sourceSelection.anchor, sourceSelection.head);
  const start = documentSourceTarget(state, from, serializer, "forward");
  const end = documentSourceTarget(state, to, serializer, "backward");
  if (!start || !end) return false;
  if (start.kind !== end.kind) return true;
  if (start.kind === "gap") {
    return start.gapFrom !== end.gapFrom || start.gapTo !== end.gapTo;
  }
  return start.segment?.index !== end.segment?.index;
}

export function sourceDocumentJumpSelection(
  state,
  edge,
  serializer,
  { sourceOffset = null, extend = false, sourceSelection = null } = {}
) {
  if (!["start", "end"].includes(edge)) return null;
  const documentSource = documentSourceSegments(state, serializer);
  if (!documentSource) return null;
  const fallbackOffset = documentSourceOffsetAtPosition(
    state,
    state.selection.head,
    serializer,
    edge === "start" ? "forward" : "backward"
  );
  const current = Math.max(
    0,
    Math.min(
      documentSource.fullSource.length,
      Number.isFinite(sourceOffset)
        ? sourceOffset
        : Number.isFinite(sourceSelection?.head)
          ? sourceSelection.head
          : fallbackOffset ?? 0
    )
  );
  const head = edge === "start" ? 0 : documentSource.fullSource.length;
  const anchor = Math.max(
    0,
    Math.min(
      documentSource.fullSource.length,
      Number.isFinite(sourceSelection?.anchor) ? sourceSelection.anchor : current
    )
  );
  return {
    anchor: extend ? anchor : head,
    head,
    fullSource: documentSource.fullSource,
    boundary: edge === "start" ? 0 : state.doc.content.size
  };
}

export function applyDocumentSourceJump(
  view,
  event,
  serializer,
  sourceOffset = null,
  sourceAnchor = null
) {
  const edge = sourceDocumentJumpEdge(event);
  if (!edge) return false;
  const existing = markdownSyntaxKey.getState(view.state)?.sourceSelection
    || (Number.isFinite(sourceAnchor) && Number.isFinite(sourceOffset)
      ? { anchor: sourceAnchor, head: sourceOffset }
      : null);
  const next = sourceDocumentJumpSelection(view.state, edge, serializer, {
    sourceOffset,
    extend: Boolean(event.shiftKey),
    sourceSelection: existing
  });
  if (!next) return false;
  if (event.shiftKey) {
    view.dispatch(
      view.state.tr
        .setSelection(markdownSourceSelectionAt(view.state.doc, next.boundary))
        .setMeta(markdownSyntaxKey, {
          action: "source-selection",
          sourceSelection: next
        })
    );
    focusProseMirrorRoot(view);
    return true;
  }
  return activateDocumentSourceOffset(
    view,
    next,
    next.head,
    edge === "start" ? "forward" : "backward",
    serializer
  );
}

export function documentSourceOffsetAtPosition(state, position, serializer, affinity = "forward") {
  const documentSource = documentSourceSegments(state, serializer);
  if (!documentSource) return null;
  const bounded = Math.max(0, Math.min(position, state.doc.content.size));
  const literalOffset = literalTextblockDocumentSourceOffset(state, bounded, serializer);
  if (Number.isFinite(literalOffset)) return literalOffset;
  for (const segment of documentSource.segments) {
    const start = segment.position;
    const end = start + segment.node.nodeSize;
    if (bounded < start || bounded > end) continue;
    if (bounded === start && affinity === "backward" && segment.index > 0) {
      return documentSource.segments[segment.index - 1].to;
    }
    if (
      bounded === end
      && affinity === "forward"
      && segment.index + 1 < documentSource.segments.length
    ) {
      return documentSource.segments[segment.index + 1].from;
    }
    if (bounded <= start) return segment.from;
    if (bounded >= end) return segment.to;
    const unit = {
      from: start,
      to: end,
      kind: "block",
      name: segment.node.type.name
    };
    const source = documentSource.fullSource.slice(segment.from, segment.to);
    if (segment.node.type.name === "table") {
      const tableOffset = tableCellSourceOffsetAtPosition(
        state,
        bounded,
        source,
        affinity
      );
      return tableOffset == null ? null : segment.from + tableOffset;
    }
    const offset = sourceCaretOffset(state, unit, source, bounded, null, serializer);
    return segment.from + Math.max(0, Math.min(source.length, offset));
  }
  return null;
}

export function documentSourceUnitStartOffset(state, unit, serializer) {
  if (!unit || typeof serializer !== "function") return null;
  const source = continuousMarkdownSource(state, unit, serializer);
  const visibleStartOffset = sourceCaretOffset(
    state,
    unit,
    source,
    unit.from,
    null,
    serializer
  );
  const visibleStart = documentSourceOffsetAtPosition(
    state,
    unit.from,
    serializer,
    "forward"
  );
  return Number.isFinite(visibleStart)
    ? Math.max(0, visibleStart - visibleStartOffset)
    : null;
}

export function documentPositionAtSourceOffset(state, sourceOffset, serializer) {
  if (!state?.doc || !Number.isFinite(sourceOffset) || typeof serializer !== "function") {
    return null;
  }
  const forwardTarget = documentSourceTarget(state, sourceOffset, serializer, "forward");
  const backwardTarget = documentSourceTarget(state, sourceOffset, serializer, "backward");
  // At a block endpoint followed by a physical separator, forward affinity
  // correctly identifies the gap while backward affinity identifies the
  // visible block edge at that same source offset. Prefer either visible block
  // over a gap so a boundary handoff returns to rendered prose instead of
  // opening a raw paragraph control only in the backward direction.
  const target = [forwardTarget, backwardTarget].find((candidate) => candidate?.kind === "block");
  if (!target) return null;
  const unit = {
    from: target.position,
    to: target.position + target.node.nodeSize,
    kind: "block",
    name: target.node.type.name
  };
  const source = target.documentSource.fullSource.slice(target.segment.from, target.segment.to);
  for (let position = unit.from; position <= unit.to; position += 1) {
    let resolved;
    try {
      resolved = state.doc.resolve(position);
    } catch {
      continue;
    }
    if (!resolved.parent.isTextblock) continue;
    const literalOffset = literalTextblockDocumentSourceOffset(state, position, serializer);
    if (Number.isFinite(literalOffset)) {
      if (literalOffset === sourceOffset) return position;
      continue;
    }
    const localOffset = sourceCaretOffset(
      state,
      unit,
      source,
      position,
      null,
      serializer
    );
    if (target.segment.from + localOffset === sourceOffset) return position;
  }
  return null;
}

export function documentSourceOffsetFromPointerTarget(state, target, serializer) {
  if (!state?.doc || !target || typeof serializer !== "function") return null;
  if (Number.isFinite(target.atomPosition)) {
    const unit = markdownAtomSyntaxAt(state, target.atomPosition);
    const start = documentSourceUnitStartOffset(state, unit, serializer);
    if (!unit || !Number.isFinite(start)) return null;
    const source = continuousMarkdownSource(state, unit, serializer);
    const localOffset = sourceCaretOffset(
      state,
      unit,
      source,
      target.position,
      target.sourceOffset,
      serializer
    );
    return start + localOffset;
  }
  const preferredAffinity = target.assoc < 0 ? "backward" : "forward";
  return documentSourceOffsetAtPosition(
    state,
    target.position,
    serializer,
    preferredAffinity
  ) ?? documentSourceOffsetAtPosition(
    state,
    target.position,
    serializer,
    preferredAffinity === "forward" ? "backward" : "forward"
  );
}

export function documentSourceUnitBoundaryOffset(state, unit, direction, serializer) {
  if (!unit || !["backward", "forward"].includes(direction)) return null;
  if (Number.isFinite(unit.segmentSourceOffset)) {
    const documentSource = documentSourceSegments(state, serializer);
    const segment = documentSource?.segments.find(({ position, node }) => (
      unit.from >= position && unit.to <= position + node.nodeSize
    ));
    const source = continuousMarkdownSource(state, unit, serializer);
    const exactStart = segment
      ? segment.from + Math.max(0, unit.segmentSourceOffset)
      : null;
    if (
      Number.isFinite(exactStart)
      && documentSource.fullSource.slice(exactStart, exactStart + source.length) === source
    ) return direction === "backward" ? exactStart : exactStart + source.length;
  }
  const start = documentSourceUnitStartOffset(state, unit, serializer);
  if (!Number.isFinite(start)) return null;
  if (direction === "backward") return start;
  return start + continuousMarkdownSource(state, unit, serializer).length;
}

export function documentSourceUnitSegment(state, unit, serializer) {
  if (!unit) return null;
  const documentSource = documentSourceSegments(state, serializer);
  if (!documentSource) return null;
  const exact = documentSource.segments.find((candidate) => (
    candidate.position === unit.from
    && candidate.position + candidate.node.nodeSize === unit.to
  ));
  if (exact) return { segment: exact, documentSource };
  const sameType = documentSource.segments
    .filter((candidate) => candidate.node.type.name === unit.name)
    .sort((left, right) => (
      Math.abs(left.position - unit.from) - Math.abs(right.position - unit.from)
    ));
  return sameType[0] ? { segment: sameType[0], documentSource } : null;
}

export function documentSourceUnitBoundaryNavigationOffset(state, unit, direction, serializer) {
  const resolved = documentSourceUnitSegment(state, unit, serializer);
  const documentSource = resolved?.documentSource || documentSourceSegments(state, serializer);
  if (!documentSource) return null;
  // Complete block controls already correspond to one exact serialized
  // segment. Prefer that identity over reverse-mapping a rendered caret at the
  // block edge, where NodeViews can resolve to the following prose block.
  const segment = resolved?.segment;
  const boundary = segment
    ? direction === "backward" ? segment.from : segment.to
    : documentSourceUnitBoundaryOffset(state, unit, direction, serializer);
  if (!Number.isFinite(boundary)) return null;
  return sourceOffsetAfterCharacter(documentSource.fullSource, boundary, direction);
}

export function documentSourceUnitBoundaryGapTarget(
  state,
  unit,
  direction,
  serializer,
  visibleSourceLength = null
) {
  if (!unit || !["backward", "forward"].includes(direction)) return null;
  const resolved = documentSourceUnitSegment(state, unit, serializer);
  const segment = resolved?.segment;
  const documentSource = resolved?.documentSource;
  if (!segment || !documentSource) return null;
  const beforeSegment = direction === "forward"
    ? segment
    : documentSource.segments[segment.index - 1] || null;
  const afterSegment = direction === "forward"
    ? documentSource.segments[segment.index + 1] || null
    : segment;
  const visibleBoundary = direction === "forward" && Number.isFinite(visibleSourceLength)
    ? Math.max(segment.from, Math.min(segment.to, segment.from + visibleSourceLength))
    : null;
  const gapFrom = direction === "forward"
    ? Math.min(segment.gapFrom, visibleBoundary ?? segment.gapFrom)
    : beforeSegment?.gapFrom ?? 0;
  const gapTo = direction === "forward"
    ? segment.gapTo
    : beforeSegment?.gapTo ?? segment.from;
  if (gapFrom >= gapTo) return null;
  const boundary = direction === "forward"
    ? visibleBoundary ?? segment.to
    : segment.from;
  const sourceOffset = sourceOffsetAfterCharacter(
    documentSource.fullSource,
    boundary,
    direction
  );
  if (sourceOffset < gapFrom || sourceOffset > gapTo || sourceOffset === boundary) return null;
  return {
    kind: "gap",
    boundary,
    position: direction === "forward"
      ? segment.position + segment.node.nodeSize
      : segment.position,
    sourceOffset,
    gapFrom,
    gapTo,
    beforeSegment,
    afterSegment,
    segment,
    documentSource
  };
}

export function sourceSelectionFromDocumentSelection(
  state,
  serializer,
  selection = state.selection
) {
  if (!selection || selection.empty) return null;

  const sameTextblock = selection.$from.sameParent(selection.$to)
    && selection.$from.parent.isTextblock;
  if (sameTextblock) {
    let containsMarkdownSource = false;
    state.doc.nodesBetween(selection.from, selection.to, (node) => {
      if (sourceAtomNames.has(node.type.name)) containsMarkdownSource = true;
      if (node.isText && node.marks.some((mark) => supportedMarks.includes(mark.type.name))) {
        containsMarkdownSource = true;
      }
      return !containsMarkdownSource;
    });
    // A selection that touches a rendered Markdown token needs physical source
    // endpoints. Serializing the selected fragment would invent balanced
    // delimiters that the user never traversed or selected.
    if (!containsMarkdownSource) return null;
  }

  const documentSource = documentSourceSegments(state, serializer);
  if (!documentSource) return null;
  if (selection instanceof AllSelection) {
    return {
      anchor: 0,
      head: documentSource.fullSource.length,
      fullSource: documentSource.fullSource,
      boundary: 0
    };
  }
  const from = documentSourceOffsetAtPosition(state, selection.from, serializer, "forward");
  const to = documentSourceOffsetAtPosition(state, selection.to, serializer, "backward");
  if (from == null || to == null || from > to) return null;
  const forward = selection.anchor <= selection.head;
  const crossedBoundary = documentSource.segments
    .map((segment) => segment.position + segment.node.nodeSize)
    .find((boundary) => boundary >= selection.from && boundary <= selection.to);
  return {
    anchor: forward ? from : to,
    head: forward ? to : from,
    fullSource: documentSource.fullSource,
    boundary: crossedBoundary ?? selection.from
  };
}

function literalTextblockSourceMapping(
  state,
  selection = state?.selection,
  serializer = null
) {
  if (
    !selection
    || !selection.$from.sameParent(selection.$to)
    || !["paragraph", "heading"].includes(selection.$from.parent.type.name)
  ) return null;
  const textblock = selection.$from.parent;
  const text = textblock.textContent;
  if (!text) return null;

  const documentSource = typeof serializer === "function"
    ? documentSourceSegments(state, serializer)
    : null;
  const segment = documentSource?.segments.find(({ position, node }) => (
    selection.from > position
    && selection.to < position + node.nodeSize
  )) || null;
  let source = textblock.attrs.paragraphSource;
  let segmentSourceOffset = 0;
  if (textblock.type.name === "heading" && typeof textblock.attrs.headingSource === "string") {
    if (!segment || segment.node !== textblock) return null;
    const segmentSource = documentSource.fullSource.slice(segment.from, segment.to);
    const rawSource = textblock.attrs.headingSource;
    const sourceStart = textblock.attrs.headingSourceStart;
    const contentStart = textblock.attrs.headingContentStart;
    const contentEnd = textblock.attrs.headingContentEnd;
    if (
      rawSource !== segmentSource
      || !Number.isFinite(sourceStart)
      || !Number.isFinite(contentStart)
      || !Number.isFinite(contentEnd)
    ) return null;
    const from = contentStart - sourceStart;
    const to = contentEnd - sourceStart;
    if (from < 0 || to < from || to > rawSource.length) return null;
    source = rawSource.slice(from, to);
    segmentSourceOffset = from;
  }
  if (typeof source !== "string") {
    if (!segment || segment.node === textblock) return null;
    const unit = {
      from: segment.position,
      to: segment.position + segment.node.nodeSize,
      kind: "block",
      name: segment.node.type.name
    };
    const metadata = structuralSourceMetadata(state, unit);
    const segmentSource = documentSource.fullSource.slice(segment.from, segment.to);
    const contentStart = textblock.type.name === "heading"
      ? textblock.attrs.headingContentStart
      : textblock.attrs.markdownSourceStart;
    const contentEnd = textblock.type.name === "heading"
      ? textblock.attrs.headingContentEnd
      : textblock.attrs.markdownSourceEnd;
    if (
      metadata?.rawSource !== segmentSource
      || !Number.isFinite(metadata.sourceStart)
      || !Number.isFinite(contentStart)
      || !Number.isFinite(contentEnd)
    ) return null;
    const from = contentStart - metadata.sourceStart;
    const to = contentEnd - metadata.sourceStart;
    if (from < 0 || to < from || to > segmentSource.length) return null;
    source = segmentSource.slice(from, to);
    segmentSourceOffset = from;
  }
  if (source === text) return null;
  if (decodedMarkdownSourceOffset(
    source,
    text,
    text.length,
    literalTextblockDecodeOptions
  ) !== source.length) return null;
  return { textblock, source, text, segmentSourceOffset, segment, documentSource };
}

function literalTextblockDocumentSourceOffset(state, position, serializer) {
  if (!state?.doc || !Number.isFinite(position) || typeof serializer !== "function") return null;
  let selection;
  try {
    const resolved = state.doc.resolve(position);
    if (!resolved.parent.isTextblock) return null;
    if ([resolved.nodeBefore, resolved.nodeAfter].some((node) => (
      node?.isText && node.marks.length
    ))) return null;
    selection = TextSelection.create(state.doc, position);
  } catch {
    return null;
  }
  const mapping = literalTextblockSourceMapping(state, selection, serializer);
  if (!mapping?.segment) return null;
  const visibleOffset = selection.$from.parentOffset;
  const sourceOffset = decodedMarkdownSourceOffset(
    mapping.source,
    mapping.text,
    visibleOffset,
    literalTextblockDecodeOptions
  );
  return Number.isFinite(sourceOffset)
    ? mapping.segment.from + mapping.segmentSourceOffset + sourceOffset
    : null;
}

export function plainTextMarkdownSourceSelection(
  state,
  serializer,
  selection = state?.selection
) {
  if ([
    selection?.$from?.nodeBefore,
    selection?.$from?.nodeAfter,
    selection?.$to?.nodeBefore,
    selection?.$to?.nodeAfter
  ].some((node) => node?.isText && node.marks.length)) return null;
  const mapping = literalTextblockSourceMapping(state, selection, serializer);
  if (!mapping || typeof serializer !== "function") return null;
  const { source, text, segmentSourceOffset } = mapping;
  const start = selection.$from.start();
  const visibleFrom = selection.from - start;
  const visibleTo = selection.to - start;
  const sourceFrom = decodedMarkdownSourceOffset(
    source,
    text,
    visibleFrom,
    literalTextblockDecodeOptions
  );
  const sourceTo = decodedMarkdownSourceOffset(
    source,
    text,
    visibleTo,
    literalTextblockDecodeOptions
  );
  if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)) return null;
  const documentSource = mapping.documentSource || documentSourceSegments(state, serializer);
  const segment = mapping.segment || documentSource?.segments.find(({ position, node }) => (
    selection.from > position
    && selection.to < position + node.nodeSize
  ));
  if (!segment) return null;
  const forward = selection.anchor <= selection.head;
  return {
    anchor: segment.from + segmentSourceOffset + (forward ? sourceFrom : sourceTo),
    head: segment.from + segmentSourceOffset + (forward ? sourceTo : sourceFrom),
    fullSource: documentSource.fullSource,
    boundary: selection.head
  };
}

export function collapsedDocumentSourceSelection(
  state,
  serializer,
  selection = state?.selection
) {
  if (
    !state?.doc
    || !selection?.empty
    || !selection.$from?.parent?.isTextblock
    || typeof serializer !== "function"
  ) return null;
  const documentSource = documentSourceSegments(state, serializer);
  if (
    documentSource?.fullSource === ""
    && documentSource.segments.length === 0
    && !selection.$from.parent.content.size
  ) {
    return {
      anchor: 0,
      head: 0,
      fullSource: "",
      boundary: selection.head
    };
  }
  const directSegment = documentSource?.segments.find(({ position, node }) => (
    node === selection.$from.parent
    && selection.head > position
    && selection.head < position + node.nodeSize
  ));
  const directParagraphSource = selection.$from.parent.attrs?.paragraphSource;
  const sourceOffset = directSegment
    && directParagraphSource === selection.$from.parent.textContent
    ? directSegment.from + selection.$from.parentOffset
    : documentSourceOffsetAtPosition(
        { doc: state.doc, selection },
        selection.head,
        serializer,
        "forward"
      );
  if (!documentSource || !Number.isFinite(sourceOffset)) return null;
  return {
    anchor: sourceOffset,
    head: sourceOffset,
    fullSource: documentSource.fullSource,
    boundary: selection.head
  };
}

export function plainTextMarkdownSourceToken(state, direction, serializer = null) {
  const { selection } = state || {};
  if (!selection?.empty || !["backward", "forward"].includes(direction)) return null;
  const adjacent = markdownBoundarySourceTarget(state, direction);
  const adjacentNode = adjacent?.atomPosition == null
    ? null
    : state.doc.nodeAt(adjacent.atomPosition);
  if (
    adjacentNode?.type.name === "hardbreak"
    && adjacentNode.attrs.isInline
    && String(adjacentNode.attrs.markdownMarker || "").length
  ) return null;
  const mapping = literalTextblockSourceMapping(state, selection, serializer);
  if (!mapping) return null;
  const { source, text, segmentSourceOffset } = mapping;

  const caret = selection.$from.parentOffset;
  const boundaries = sourceCaretBoundaries(text);
  const visibleFrom = direction === "forward"
    ? caret
    : boundaries.findLast((boundary) => boundary < caret);
  const visibleTo = direction === "forward"
    ? boundaries.find((boundary) => boundary > caret)
    : caret;
  if (!Number.isFinite(visibleFrom) || !Number.isFinite(visibleTo)) return null;
  const sourceFrom = decodedMarkdownSourceOffset(
    source,
    text,
    visibleFrom,
    literalTextblockDecodeOptions
  );
  const sourceTo = decodedMarkdownSourceOffset(
    source,
    text,
    visibleTo,
    literalTextblockDecodeOptions
  );
  if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo) || sourceFrom >= sourceTo) {
    return null;
  }
  const tokenSource = source.slice(sourceFrom, sourceTo);
  const visibleToken = text.slice(visibleFrom, visibleTo);
  if (tokenSource === visibleToken) return null;
  if (decodedMarkdownSourceOffset(tokenSource, visibleToken, visibleToken.length) !== tokenSource.length) {
    return null;
  }

  const boundaryOffset = direction === "forward" ? 0 : tokenSource.length;
  return {
    unit: {
      from: selection.$from.start() + visibleFrom,
      to: selection.$from.start() + visibleTo,
      kind: "inline",
      name: "literal_source",
      source: tokenSource,
      segmentSourceOffset: segmentSourceOffset + sourceFrom
    },
    boundaryOffset,
    sourceOffset: sourceOffsetAfterCharacter(tokenSource, boundaryOffset, direction),
    direction
  };
}

export function activateDocumentSourceSelection(view, selection, serializer) {
  const sourceSelection = sourceSelectionFromDocumentSelection(view.state, serializer, selection);
  if (!sourceSelection) return false;
  dispatchFocusedSourceSelection(
    view,
    view.state.tr
      .setSelection(selection)
      .setMeta(markdownSyntaxKey, { action: "source-selection", sourceSelection })
      .scrollIntoView()
  );
  return true;
}

let sourceGraphemeSegmenter = null;

export function sourceCaretBoundaries(source) {
  const value = String(source ?? "");
  if (typeof Intl?.Segmenter === "function") {
    sourceGraphemeSegmenter ||= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [
      ...new Set([
        0,
        ...Array.from(sourceGraphemeSegmenter.segment(value), ({ index, segment }) =>
          index + segment.length
        )
      ])
    ];
  }

  const boundaries = [0];
  let offset = 0;
  for (const point of value) {
    offset += point.length;
    // Keep a Windows line ending indivisible even in the compatibility path.
    if (point === "\r" && value[offset] === "\n") continue;
    boundaries.push(offset);
  }
  if (boundaries.at(-1) !== value.length) boundaries.push(value.length);
  return boundaries;
}

export function sourceOffsetAfterCharacter(source, offset, direction) {
  const bounded = Math.max(0, Math.min(source.length, offset));
  const boundaries = sourceCaretBoundaries(source);
  if (direction === "forward") {
    return boundaries.find((boundary) => boundary > bounded) ?? bounded;
  }
  return boundaries.findLast((boundary) => boundary < bounded) ?? bounded;
}

export function sourceCharacterDeletionRange(source, caret, direction) {
  const bounded = Math.max(0, Math.min(source.length, caret));
  if (direction === "backward") {
    return {
      from: sourceOffsetAfterCharacter(source, bounded, "backward"),
      to: bounded
    };
  }
  if (direction === "forward") {
    return {
      from: bounded,
      to: sourceOffsetAfterCharacter(source, bounded, "forward")
    };
  }
  return { from: bounded, to: bounded };
}

export function sourceControlInitialDeletion(source, caret, direction) {
  if (!["backward", "forward"].includes(direction)) return null;
  const value = String(source ?? "");
  const boundedCaret = Math.max(0, Math.min(value.length, Number(caret) || 0));
  if (
    (direction === "backward" && boundedCaret === 0)
    || (direction === "forward" && boundedCaret === value.length)
  ) return null;
  const deletion = sourceCharacterDeletionRange(value, boundedCaret, direction);
  if (deletion.from === deletion.to) return null;
  return {
    beforeValue: value,
    afterValue: `${value.slice(0, deletion.from)}${value.slice(deletion.to)}`,
    beforeCaret: boundedCaret,
    afterCaret: deletion.from,
    state: "applied",
    nativeHistoryActive: false
  };
}

export function sourceControlInitialHistoryChange(history, command, currentValue) {
  if (!history || history.nativeHistoryActive || !["undo", "redo"].includes(command)) return null;
  const nativeRedoSnapshots = history.nativeRedoSnapshots || [];
  const nativeRedoIndex = Math.max(0, Math.min(
    nativeRedoSnapshots.length,
    history.nativeRedoIndex || 0
  ));
  const replayValue = nativeRedoIndex > 0
    ? nativeRedoSnapshots[nativeRedoIndex - 1].value
    : history.afterValue;
  if (
    command === "undo"
    && history.state === "applied"
    && nativeRedoIndex > 0
    && currentValue === replayValue
  ) {
    const nextIndex = nativeRedoIndex - 1;
    const target = nextIndex > 0
      ? nativeRedoSnapshots[nextIndex - 1]
      : { value: history.afterValue, start: history.afterCaret, end: history.afterCaret };
    return {
      value: target.value,
      start: target.start,
      end: target.end,
      direction: target.direction || "none",
      state: "applied",
      nativeRedoIndex: nextIndex
    };
  }
  if (
    command === "undo"
    && history.state === "applied"
    && nativeRedoIndex === 0
    && currentValue === history.afterValue
  ) {
    return { value: history.beforeValue, caret: history.beforeCaret, state: "undone" };
  }
  if (
    command === "redo"
    && history.state === "undone"
    && currentValue === history.beforeValue
  ) {
    return { value: history.afterValue, caret: history.afterCaret, state: "applied" };
  }
  if (
    command === "redo"
    && history.state === "applied"
    && nativeRedoIndex < nativeRedoSnapshots.length
    && currentValue === replayValue
  ) {
    const target = nativeRedoSnapshots[nativeRedoIndex];
    return {
      value: target.value,
      start: target.start,
      end: target.end,
      direction: target.direction || "none",
      state: "applied",
      nativeRedoIndex: nativeRedoIndex + 1
    };
  }
  return null;
}

export function sourceControlInputHistoryStep(history, command, currentSnapshot) {
  if (!history || !currentSnapshot || !["undo", "redo"].includes(command)) return null;
  const undo = Array.isArray(history.undo) ? history.undo : [];
  const redo = Array.isArray(history.redo) ? history.redo : [];
  const source = command === "undo" ? undo : redo;
  if (!source.length) return null;
  const snapshot = source[source.length - 1];
  return {
    snapshot,
    history: command === "undo"
      ? { undo: source.slice(0, -1), redo: [...redo, currentSnapshot] }
      : { undo: [...undo, currentSnapshot], redo: source.slice(0, -1) }
  };
}

export function sourceControlClipboardEdit(
  value,
  selectionStart,
  selectionEnd,
  replacement = ""
) {
  const source = String(value ?? "");
  const start = Math.max(0, Math.min(source.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(source.length, Number(selectionEnd) || 0));
  const inserted = String(replacement ?? "");
  return {
    value: `${source.slice(0, start)}${inserted}${source.slice(end)}`,
    selectedText: source.slice(start, end),
    caret: start + inserted.length
  };
}

export function extendSourceSelection(sourceSelection, direction) {
  if (!sourceSelection || !["backward", "forward"].includes(direction)) return null;
  const nextHead = sourceOffsetAfterCharacter(
    sourceSelection.fullSource,
    sourceSelection.head,
    direction
  );
  return {
    ...sourceSelection,
    head: Math.max(0, Math.min(sourceSelection.fullSource.length, nextHead))
  };
}

function sourceLineBounds(source, offset) {
  const bounded = Math.max(0, Math.min(source.length, offset));
  const start = source.lastIndexOf("\n", bounded - 1) + 1;
  const lineBreak = source.indexOf("\n", bounded);
  let end = lineBreak < 0 ? source.length : lineBreak;
  if (end > start && source[end - 1] === "\r") end -= 1;
  return { bounded, start, end, lineBreak };
}

export function sourceVerticalOffset(source, offset, direction, preferredColumn = null) {
  if (!source || !["up", "down"].includes(direction)) return offset;
  const current = sourceLineBounds(source, offset);
  const currentColumn = Math.max(0, Math.min(current.end, current.bounded) - current.start);
  const column = Number.isFinite(preferredColumn) ? Math.max(0, preferredColumn) : currentColumn;
  if (direction === "up") {
    if (current.start === 0) return current.bounded;
    const previousBreak = current.start - 1;
    const previousStart = source.lastIndexOf("\n", previousBreak - 1) + 1;
    let previousEnd = previousBreak;
    if (previousEnd > previousStart && source[previousEnd - 1] === "\r") previousEnd -= 1;
    return Math.min(previousStart + column, previousEnd);
  }
  if (current.lineBreak < 0) return current.bounded;
  const nextStart = current.lineBreak + 1;
  const nextBreak = source.indexOf("\n", nextStart);
  let nextEnd = nextBreak < 0 ? source.length : nextBreak;
  if (nextEnd > nextStart && source[nextEnd - 1] === "\r") nextEnd -= 1;
  return Math.min(nextStart + column, nextEnd);
}

export function moveSourceSelectionHead(sourceSelection, motion) {
  if (!sourceSelection) return null;
  if (["backward", "forward"].includes(motion)) {
    return { ...extendSourceSelection(sourceSelection, motion), verticalColumn: null };
  }
  if (!["up", "down"].includes(motion)) return sourceSelection;
  const current = sourceLineBounds(sourceSelection.fullSource, sourceSelection.head);
  const verticalColumn = Number.isFinite(sourceSelection.verticalColumn)
    ? sourceSelection.verticalColumn
    : Math.max(0, Math.min(current.end, current.bounded) - current.start);
  return {
    ...sourceSelection,
    head: sourceVerticalOffset(
      sourceSelection.fullSource,
      sourceSelection.head,
      motion,
      verticalColumn
    ),
    verticalColumn
  };
}

export function sourceSelectionLineJump(sourceSelection, edge, extend = false) {
  if (!sourceSelection || !["start", "end"].includes(edge)) return null;
  const bounds = sourceLineBounds(sourceSelection.fullSource, sourceSelection.head);
  const head = edge === "start" ? bounds.start : bounds.end;
  return {
    ...sourceSelection,
    anchor: extend ? sourceSelection.anchor : head,
    head,
    verticalColumn: null
  };
}

export function sourceLineSelectionAcrossUnitBoundary(
  fullSource,
  unitStart,
  localSelection,
  edge,
  extend = false
) {
  if (
    typeof fullSource !== "string"
    || !Number.isFinite(unitStart)
    || !localSelection
    || !["start", "end"].includes(edge)
  ) return null;
  const start = Math.max(0, Math.min(fullSource.length, unitStart));
  const anchor = Math.max(
    0,
    Math.min(fullSource.length, start + (Number(localSelection.anchor) || 0))
  );
  const head = Math.max(
    0,
    Math.min(fullSource.length, start + (Number(localSelection.head) || 0))
  );
  return sourceSelectionLineJump(
    { anchor, head, fullSource, verticalColumn: null },
    edge,
    extend
  );
}

export function sourceSelectionWordJump(sourceSelection, direction, extend = false) {
  if (!sourceSelection || !["backward", "forward"].includes(direction)) return null;
  const collapsed = sourceSelection.anchor === sourceSelection.head;
  const head = !extend && !collapsed
    ? direction === "backward"
      ? Math.min(sourceSelection.anchor, sourceSelection.head)
      : Math.max(sourceSelection.anchor, sourceSelection.head)
    : sourceWordOffset(sourceSelection.fullSource, sourceSelection.head, direction);
  return {
    ...sourceSelection,
    anchor: extend ? sourceSelection.anchor : head,
    head,
    verticalColumn: null
  };
}

function sourceSelectionModifierDelete(sourceSelection, direction, offsetAtCaret) {
  if (
    !sourceSelection
    || typeof sourceSelection.fullSource !== "string"
    || !["backward", "forward"].includes(direction)
    || typeof offsetAtCaret !== "function"
  ) return null;
  const collapsed = sourceSelection.anchor === sourceSelection.head;
  const target = collapsed
    ? offsetAtCaret(sourceSelection.fullSource, sourceSelection.head, direction)
    : null;
  const deletionSelection = collapsed
    ? {
        ...sourceSelection,
        anchor: sourceSelection.head,
        head: target,
        verticalColumn: null
      }
    : { ...sourceSelection, verticalColumn: null };
  const from = Math.min(deletionSelection.anchor, deletionSelection.head);
  const to = Math.max(deletionSelection.anchor, deletionSelection.head);
  if (from === to) {
    return {
      changed: false,
      deletionSelection,
      afterSelection: {
        ...sourceSelection,
        anchor: from,
        head: from,
        verticalColumn: null
      }
    };
  }
  const fullSource = `${sourceSelection.fullSource.slice(0, from)}${
    sourceSelection.fullSource.slice(to)
  }`;
  return {
    changed: true,
    deletionSelection,
    afterSelection: {
      ...sourceSelection,
      anchor: from,
      head: from,
      fullSource,
      verticalColumn: null
    }
  };
}

export function sourceSelectionWordDelete(sourceSelection, direction) {
  return sourceSelectionModifierDelete(
    sourceSelection,
    direction,
    sourceWordDeleteOffset
  );
}

export function sourceSelectionLineDelete(sourceSelection, direction) {
  return sourceSelectionModifierDelete(
    sourceSelection,
    direction,
    sourceLineDeleteOffset
  );
}

export function sourceSelectionTabEdit(sourceSelection, outdent = false) {
  if (!sourceSelection || typeof sourceSelection.fullSource !== "string") return null;
  const backward = sourceSelection.anchor > sourceSelection.head;
  const start = Math.min(sourceSelection.anchor, sourceSelection.head);
  const end = Math.max(sourceSelection.anchor, sourceSelection.head);
  const edit = sourceTabEdit(sourceSelection.fullSource, start, end, outdent);
  return {
    ...sourceSelection,
    anchor: backward ? edit.selectionEnd : edit.selectionStart,
    head: backward ? edit.selectionStart : edit.selectionEnd,
    fullSource: edit.value,
    verticalColumn: null
  };
}

export function replaceSourceSelectionTransaction(
  state,
  sourceSelection,
  replacement,
  parser,
  requestedCaretSourceOffset = null
) {
  if (!sourceSelection || typeof parser !== "function") return null;
  const from = Math.min(sourceSelection.anchor, sourceSelection.head);
  const to = Math.max(sourceSelection.anchor, sourceSelection.head);
  const nextSource = `${sourceSelection.fullSource.slice(0, from)}${replacement}${sourceSelection.fullSource.slice(to)}`;
  const parsed = normalizeEmptyMarkdownDocument(parser(nextSource), nextSource);
  let transaction = state.tr.replace(
    0,
    state.doc.content.size,
    new Slice(parsed.content, 0, 0)
  );
  for (const [name, value] of Object.entries(parsed.attrs || {})) {
    transaction = transaction.setDocAttribute(name, value);
  }
  let caret = null;
  let marker = "\uE000";
  while (nextSource.includes(marker)) marker += "\uE001";
  const caretSourceOffset = Number.isFinite(requestedCaretSourceOffset)
    ? Math.max(0, Math.min(nextSource.length, requestedCaretSourceOffset))
    : from + replacement.length;
  const marked = parser(
    `${nextSource.slice(0, caretSourceOffset)}${marker}${nextSource.slice(caretSourceOffset)}`
  );
  marked.descendants((node, position) => {
    if (caret != null || !node.isText) return caret == null;
    const markerOffset = node.text.indexOf(marker);
    if (markerOffset < 0) return true;
    caret = position + markerOffset;
    return false;
  });
  caret = Math.max(
    0,
    Math.min(caret ?? sourceSelection.boundary, transaction.doc.content.size)
  );
  return transaction.setSelection(Selection.near(transaction.doc.resolve(caret), 1));
}

function inlineSourceValueEditFromDocument(
  state,
  unit,
  originalSource,
  value,
  localCaret,
  parser,
  documentSource,
  unitStart
) {
  const caret = unitStart + Math.max(0, Math.min(value.length, Number(localCaret) || 0));
  const historySelection = {
    anchor: unitStart,
    head: unitStart + originalSource.length,
    fullSource: documentSource.fullSource,
    boundary: unit.from
  };
  const afterSource = `${documentSource.fullSource.slice(0, unitStart)}${value}${
    documentSource.fullSource.slice(unitStart + originalSource.length)
  }`;
  const transaction = replaceSourceSelectionTransaction(
    state,
    historySelection,
    value,
    parser,
    caret
  );
  if (!transaction) return null;
  return {
    transaction,
    historySelection,
    editSelection: historySelection,
    afterSelection: {
      anchor: caret,
      head: caret,
      fullSource: afterSource,
      boundary: transaction.selection.head
    }
  };
}

export function inlineSourceValueEdit(
  state,
  unit,
  originalSource,
  value,
  localCaret,
  parser,
  serializer
) {
  if (
    !state?.doc
    || !unit
    || typeof originalSource !== "string"
    || typeof value !== "string"
    || typeof parser !== "function"
    || typeof serializer !== "function"
  ) return null;
  const documentSource = documentSourceSegments(state, serializer);
  const unitStart = documentSourceUnitStartOffset(state, unit, serializer);
  if (!documentSource || !Number.isFinite(unitStart)) return null;
  return inlineSourceValueEditFromDocument(
    state,
    unit,
    originalSource,
    value,
    localCaret,
    parser,
    documentSource,
    unitStart
  );
}

export function inlineSourceEnterEdit(
  state,
  unit,
  originalSource,
  value,
  localOffset,
  parser,
  serializer
) {
  if (
    !state?.doc
    || !unit
    || typeof originalSource !== "string"
    || typeof value !== "string"
    || typeof parser !== "function"
    || typeof serializer !== "function"
  ) return null;
  const documentSource = documentSourceSegments(state, serializer);
  const unitStart = documentSourceUnitStartOffset(state, unit, serializer);
  if (!documentSource || !Number.isFinite(unitStart)) return null;
  const offset = Math.max(0, Math.min(value.length, Number(localOffset) || 0));
  const lineEnding = sourceLineEndingAt(
    documentSource.fullSource,
    unitStart + Math.min(offset, originalSource.length)
  );
  const replacement = `${value.slice(0, offset)}${lineEnding}${value.slice(offset)}`;
  return inlineSourceValueEditFromDocument(
    state,
    unit,
    originalSource,
    replacement,
    offset + lineEnding.length,
    parser,
    documentSource,
    unitStart
  );
}

export function inlineSourceTabEdit(
  state,
  unit,
  originalSource,
  value,
  localSelection,
  outdent,
  parser,
  serializer
) {
  if (
    !state?.doc
    || !unit
    || typeof originalSource !== "string"
    || typeof value !== "string"
    || !localSelection
    || typeof parser !== "function"
    || typeof serializer !== "function"
  ) return null;
  const documentSource = documentSourceSegments(state, serializer);
  const unitStart = documentSourceUnitStartOffset(state, unit, serializer);
  if (!documentSource || !Number.isFinite(unitStart)) return null;
  const localAnchor = Math.max(
    0,
    Math.min(value.length, Number(localSelection.anchor) || 0)
  );
  const localHead = Math.max(
    0,
    Math.min(value.length, Number(localSelection.head) || 0)
  );
  const currentSource = `${documentSource.fullSource.slice(0, unitStart)}${value}${
    documentSource.fullSource.slice(unitStart + originalSource.length)
  }`;
  const start = unitStart + Math.min(localAnchor, localHead);
  const end = unitStart + Math.max(localAnchor, localHead);
  const edit = sourceTabEdit(currentSource, start, end, Boolean(outdent));
  const backward = localAnchor > localHead;
  const anchor = backward ? edit.selectionEnd : edit.selectionStart;
  const head = backward ? edit.selectionStart : edit.selectionEnd;
  const afterSelection = {
    anchor,
    head,
    fullSource: edit.value,
    boundary: unit.from,
    verticalColumn: null
  };
  if (edit.value === documentSource.fullSource) {
    return { changed: false, transaction: null, afterSelection };
  }
  const historySelection = {
    anchor: 0,
    head: documentSource.fullSource.length,
    fullSource: documentSource.fullSource,
    boundary: unit.from
  };
  const transaction = replaceSourceSelectionTransaction(
    state,
    historySelection,
    edit.value,
    parser,
    head
  );
  if (!transaction) return null;
  return {
    changed: true,
    transaction,
    historySelection,
    editSelection: historySelection,
    afterSelection
  };
}

function sourceControlModifierDeletionEdit(
  state,
  unit,
  originalSource,
  value,
  localSelection,
  direction,
  parser,
  serializer,
  mode
) {
  if (
    !state?.doc
    || !unit
    || typeof originalSource !== "string"
    || typeof value !== "string"
    || !localSelection
    || !["backward", "forward"].includes(direction)
    || !["word", "line"].includes(mode)
    || typeof parser !== "function"
    || typeof serializer !== "function"
  ) return null;
  const documentSource = documentSourceSegments(state, serializer);
  const unitStart = documentSourceUnitStartOffset(state, unit, serializer);
  if (!documentSource || !Number.isFinite(unitStart)) return null;
  const localAnchor = Math.max(
    0,
    Math.min(value.length, Number(localSelection.anchor) || 0)
  );
  const localHead = Math.max(
    0,
    Math.min(value.length, Number(localSelection.head) || 0)
  );
  const currentSource = `${documentSource.fullSource.slice(0, unitStart)}${value}${
    documentSource.fullSource.slice(unitStart + originalSource.length)
  }`;
  const currentSelection = {
    anchor: unitStart + localAnchor,
    head: unitStart + localHead,
    fullSource: currentSource,
    boundary: unit.from,
    verticalColumn: null
  };
  const modifierEdit = mode === "line"
    ? sourceSelectionLineDelete(currentSelection, direction)
    : sourceSelectionWordDelete(currentSelection, direction);
  if (!modifierEdit) return null;
  const afterSelection = {
    ...modifierEdit.afterSelection,
    boundary: unit.from
  };
  if (afterSelection.fullSource === documentSource.fullSource) {
    return { changed: false, transaction: null, afterSelection };
  }
  const historySelection = {
    anchor: 0,
    head: documentSource.fullSource.length,
    fullSource: documentSource.fullSource,
    boundary: unit.from
  };
  const transaction = replaceSourceSelectionTransaction(
    state,
    historySelection,
    afterSelection.fullSource,
    parser,
    afterSelection.head
  );
  if (!transaction) return null;
  return {
    changed: true,
    transaction,
    historySelection,
    editSelection: historySelection,
    afterSelection
  };
}

export function sourceControlWordDeletionEdit(...args) {
  return sourceControlModifierDeletionEdit(...args, "word");
}

export function sourceControlLineDeletionEdit(...args) {
  return sourceControlModifierDeletionEdit(...args, "line");
}

export function sourceClipboardEdit(
  state,
  replacement,
  parser,
  serializer,
  sourceSelection = null
) {
  const exactSelection = sourceSelection
    || sourceSelectionFromDocumentSelection(state, serializer);
  const selectedText = exactSelection
    ? sourceSelectionText(exactSelection)
    : sourceNewlineClipboardText(state);
  if (selectedText == null || (selectedText === "" && replacement === "")) return null;
  const transaction = exactSelection
    ? replaceSourceSelectionTransaction(state, exactSelection, replacement, parser)
    : replaceSourceNewlineSelectionTransaction(state, replacement, parser, serializer);
  return transaction ? { selectedText, transaction, sourceSelection: exactSelection } : null;
}

export function replaceSourceNewlineSelectionTransaction(
  state,
  replacement,
  parser,
  serializer,
  selection = state.selection
) {
  if (typeof parser !== "function" || typeof serializer !== "function") return null;
  const range = sourceNewlineSourceRange({ doc: state.doc, selection }, serializer);
  if (!range) return null;
  return replaceSourceSelectionTransaction(
    state,
    sourceSelectionFromNewlineRange(
      range,
      selection.anchor > selection.head ? "backward" : "forward"
    ),
    replacement,
    parser
  );
}

export function sourceNewlineDeletionTransaction(
  state,
  boundaryPosition,
  direction,
  parser = null,
  serializer = null
) {
  const selection = textSelectionAcrossBoundary(state, boundaryPosition, direction);
  if (
    selection.empty
    || state.doc.textBetween(selection.from, selection.to, "", "") !== ""
    || !state.doc.textBetween(selection.from, selection.to, "\n", "").includes("\n")
  ) return null;

  const exact = replaceSourceNewlineSelectionTransaction(
    state,
    "",
    parser,
    serializer,
    selection
  );
  if (exact) return exact;
  return state.tr.delete(selection.from, selection.to);
}

export function documentSelectionFromCodeBoundary(
  state,
  boundaryPosition,
  direction,
  geometryPosition = null
) {
  const assoc = direction === "backward" ? -1 : 1;
  const destination = Number.isFinite(geometryPosition) ? geometryPosition : boundaryPosition;
  const bounded = Math.max(0, Math.min(destination, state.doc.content.size));
  const selection = Selection.near(state.doc.resolve(bounded), assoc);
  // At the beginning or end of a document containing only this code block,
  // the nearest selectable position is back inside CodeMirror. Returning null
  // lets its native key handling run instead of pretending the caret moved.
  return selection.$from.parent.type.name === "code_block" ? null : selection;
}

export const structuralMarkerBackspaceKeymap = $shortcut((ctx) => ({
  Backspace: {
    key: "Backspace",
    priority: 100,
    onRun: () => (state, dispatch, view) => {
      const listBoundary = Boolean(listItemTypeAtMarkerBoundary(state));
      const blockUnit = listBoundary ? activeMarkdownBlockSyntax(state) : null;
      const sourceFaithfulRootList = Boolean(
        blockUnit && ["bullet_list", "ordered_list", "blockquote", "footnote_definition"].includes(blockUnit.name)
      );
      const transaction = sourceFaithfulListMarkerBackspaceTransaction(
        state,
        ctx.get(parserCtx),
        ctx.get(serializerCtx)
      );
      if (transaction) {
        if (dispatch) dispatch(transaction.scrollIntoView());
        return true;
      }
      // A formatted token at the visible item start (for example `+ **bold**`)
      // is physically closer than the list marker. Yield so the inline source
      // handler removes that delimiter before a later Backspace reaches `+ `.
      if (sourceFaithfulRootList) return false;
      return liftStructuralMarkerAtCursor(state, dispatch, view);
    }
  }
}));

export const sourceFaithfulHeadingBackspaceKeymap = $shortcut(() => ({
  Backspace: {
    key: "Backspace",
    priority: 100,
    onRun: () => downgradeAtxHeadingAtCursor
  }
}));

export const sourceFaithfulOrderedListSplitKeymap = $shortcut(() => ({
  Enter: {
    key: "Enter",
    priority: 110,
    onRun: () => splitOrderedListItemWithSourceNumber
  }
}));

export function usesContinuousSourceEditor(unit, explicitUnit = null) {
  if (!unit) return false;
  return unit.kind === "inline"
    || sourceAtomNames.has(unit.name)
    || unit === explicitUnit;
}

export function isSourceInputComposing(event) {
  return Boolean(event?.isComposing) || event?.keyCode === 229;
}

export function finishUnchangedSourceHandoff(
  editor,
  onCancel,
  afterFinish,
  sync = false,
  scheduleFrame = globalThis.requestAnimationFrame
) {
  if (!afterFinish) {
    onCancel();
    return;
  }
  const handoff = () => {
    afterFinish(null);
    // A successful destination transaction removes this source widget. If a
    // guarded callback could not move anywhere, close it normally instead of
    // leaving a finished but still-mounted control behind.
    if (editor?.isConnected) onCancel();
  };
  if (sync) handoff();
  else if (typeof scheduleFrame === "function") scheduleFrame(handoff);
  else handoff();
}

function continuousSourceEditor(
  source,
  kind,
  name,
  label,
  initialCaret,
  initialDeleteDirection,
  initialSelectionDirection,
  initialSourceSelection,
  initialPointerSelection,
  onCommit,
  onCancel,
  onBoundaryNavigate,
  onBoundaryDelete,
  onVerticalNavigate,
  onBoundarySelect,
  onPointerDrag,
  onWordJump,
  onLineJump,
  onDocumentJump,
  onDocumentSelectAll,
  onSourceModifierDelete,
  onInlineEnter,
  onInlineMultilinePaste,
  onInlineTab,
  onDraftChange,
  shouldFocus,
  setActiveControl
) {
  const isBlock = kind === "block";
  const editor = document.createElement(isBlock ? "textarea" : "input");
  editor.className = `tether-continuous-source is-${kind} is-${name}`;
  if (!isBlock) editor.type = "text";
  editor.value = source;
  editor.setAttribute("aria-label", label);
  editor.setAttribute("autocomplete", "off");
  editor.setAttribute("autocapitalize", "off");
  editor.setAttribute("spellcheck", "false");
  let startingCaret = Math.max(0, Math.min(editor.value.length, initialCaret));
  let startingSelection = null;
  const initialDeletionHistory = sourceControlInitialDeletion(
    editor.value,
    startingCaret,
    initialDeleteDirection
  );
  if (initialDeletionHistory) {
    editor.value = initialDeletionHistory.afterValue;
    startingCaret = initialDeletionHistory.afterCaret;
  } else if (initialSourceSelection) {
    startingSelection = {
      start: Math.max(0, Math.min(editor.value.length, initialSourceSelection.start)),
      end: Math.max(0, Math.min(editor.value.length, initialSourceSelection.end)),
      direction: initialSourceSelection.direction || "none"
    };
  } else if (initialPointerSelection >= 2) {
    startingSelection = sourcePointerSelectionRange(
      editor.value,
      startingCaret,
      initialPointerSelection
    );
  } else if (initialSelectionDirection) {
    startingSelection = sourceInitialSelectionRange(
      editor.value,
      startingCaret,
      initialSelectionDirection
    );
  }

  const resize = () => {
    if (isBlock) {
      editor.style.height = "0";
      editor.style.height = `${Math.max(28, editor.scrollHeight)}px`;
    } else {
      editor.style.width = `${Math.max(3, Math.min(72, editor.value.length + 1))}ch`;
    }
  };
  const sourceInputSnapshot = () => ({
    value: editor.value,
    start: editor.selectionStart ?? 0,
    end: editor.selectionEnd ?? editor.selectionStart ?? 0,
    direction: editor.selectionDirection || "none"
  });
  let sourceInputHistory = { undo: [], redo: [] };
  let pendingSourceInputSnapshot = null;
  let compositionSourceInputSnapshot = null;
  let lastSourceInputSnapshot = sourceInputSnapshot();
  let lastSourceInputType = null;
  let lastSourceInputAt = 0;
  const sameSourceInputValue = (left, right) => left?.value === right?.value;
  const sameSourceInputSelection = (left, right) => Boolean(left && right)
    && left.start === right.start
    && left.end === right.end
    && left.direction === right.direction;
  const resetSourceInputGroup = () => {
    lastSourceInputType = null;
    lastSourceInputAt = 0;
  };
  const rememberSourceInputChange = (
    before,
    after = sourceInputSnapshot(),
    groupWithPrevious = false
  ) => {
    if (!before || sameSourceInputValue(before, after)) {
      lastSourceInputSnapshot = after;
      return;
    }
    const previous = sourceInputHistory.undo.at(-1);
    const reusePreviousSnapshot = (
      groupWithPrevious && sourceInputHistory.undo.length > 0
    ) || sameSourceInputValue(previous, before);
    sourceInputHistory = {
      undo: reusePreviousSnapshot
        ? sourceInputHistory.undo
        : [...sourceInputHistory.undo, before].slice(-100),
      redo: []
    };
    lastSourceInputSnapshot = after;
  };
  const caretAtClientX = (clientX) => {
    if (isBlock) return null;
    const style = getComputedStyle(editor);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const rect = editor.getBoundingClientRect();
    const textX = clientX - rect.left
      - Number.parseFloat(style.borderLeftWidth || "0")
      - Number.parseFloat(style.paddingLeft || "0")
      + editor.scrollLeft;
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const index of sourceCaretBoundaries(editor.value)) {
      const distance = Math.abs(context.measureText(editor.value.slice(0, index)).width - textX);
      if (distance >= nearestDistance) continue;
      nearest = index;
      nearestDistance = distance;
    }
    return nearest;
  };
  const caretTargetPoint = (direction) => {
    const style = getComputedStyle(editor);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const rect = editor.getBoundingClientRect();
    const caret = editor.selectionStart ?? 0;
    const beforeCaret = editor.value.slice(0, caret);
    const lineStart = beforeCaret.lastIndexOf("\n") + 1;
    const lineText = editor.value.slice(lineStart, caret);
    const lineIndex = beforeCaret.slice(0, lineStart).split("\n").length - 1;
    const textWidth = context.measureText(lineText).width;
    const borderLeft = Number.parseFloat(style.borderLeftWidth || "0");
    const paddingLeft = Number.parseFloat(style.paddingLeft || "0");
    const borderTop = Number.parseFloat(style.borderTopWidth || "0");
    const paddingTop = Number.parseFloat(style.paddingTop || "0");
    const lineHeight = Number.parseFloat(style.lineHeight || "")
      || Number.parseFloat(style.fontSize || "16") * 1.5;
    const lineTop = rect.top + borderTop + paddingTop + lineIndex * lineHeight - editor.scrollTop;
    return {
      left: rect.left + borderLeft + paddingLeft + textWidth - editor.scrollLeft,
      top: direction === "up" ? lineTop : lineTop + lineHeight
    };
  };
  let finished = false;
  let blurTimer = 0;
  let pointerDragAnchor = null;
  let pointerDragWindow = null;
  let handlePointerDragEnd = null;
  let pointerClickCount = initialPointerSelection >= 1 ? initialPointerSelection : 0;
  let lastPointerDownAt = pointerClickCount ? performance.now() : 0;
  const finish = (commit, afterFinish = null, sync = false) => {
    if (finished) return;
    finished = true;
    if (blurTimer) clearTimeout(blurTimer);
    if (pointerDragWindow && handlePointerDragEnd) {
      pointerDragWindow.removeEventListener("mouseup", handlePointerDragEnd, true);
    }
    pointerDragWindow = null;
    delete editor.tetherHandleHistoryCommand;
    const value = editor.value;
    const run = () => {
      setActiveControl(null);
      // Committing an untouched value would still rewrite the block through the
      // parser (dirtying the document and polluting undo); treat it as a cancel.
      if (commit && value !== source) onCommit(value, afterFinish, sync);
      else finishUnchangedSourceHandoff(
        editor,
        onCancel,
        afterFinish,
        sync
      );
    };
    if (sync) run();
    else requestAnimationFrame(run);
  };
  // Keyboard input can arrive again before the next animation frame. Finish
  // keyboard-driven handoffs in the same event turn so the destination owns
  // the very next character; pointer and blur exits can remain deferred.
  const finishKeyboardHandoff = (commit, afterFinish = null) => {
    finish(commit, afterFinish, true);
  };
  setActiveControl({ element: editor, finish });

  const applyInitialHistoryCommand = (command) => {
    const change = sourceControlInitialHistoryChange(
      initialDeletionHistory,
      command,
      editor.value
    );
    if (!change) {
      if (
        initialDeletionHistory?.nativeHistoryActive
        && command === "undo"
      ) {
        initialDeletionHistory.pendingNativeUndoSnapshot = {
          value: editor.value,
          start: editor.selectionStart ?? 0,
          end: editor.selectionEnd ?? editor.selectionStart ?? 0,
          direction: editor.selectionDirection || "none"
        };
      }
      return false;
    }
    editor.value = change.value;
    initialDeletionHistory.state = change.state;
    initialDeletionHistory.nativeHistoryActive = false;
    if (Number.isInteger(change.nativeRedoIndex)) {
      initialDeletionHistory.nativeRedoIndex = change.nativeRedoIndex;
    }
    const start = change.start ?? change.caret;
    const end = change.end ?? change.caret;
    editor.setSelectionRange(start, end, change.direction || "none");
    pendingSourceInputSnapshot = null;
    resetSourceInputGroup();
    lastSourceInputSnapshot = sourceInputSnapshot();
    resize();
    onDraftChange?.(editor.value);
    return true;
  };
  const applySourceInputHistoryCommand = (command) => {
    const change = sourceControlInputHistoryStep(
      sourceInputHistory,
      command,
      sourceInputSnapshot()
    );
    if (!change) return false;
    sourceInputHistory = change.history;
    pendingSourceInputSnapshot = null;
    resetSourceInputGroup();
    editor.value = change.snapshot.value;
    editor.setSelectionRange(
      change.snapshot.start,
      change.snapshot.end,
      change.snapshot.direction || "none"
    );
    if (initialDeletionHistory) {
      initialDeletionHistory.nativeHistoryActive = (
        initialDeletionHistory.state === "applied"
        && editor.value !== initialDeletionHistory.afterValue
      );
    }
    lastSourceInputSnapshot = sourceInputSnapshot();
    resize();
    onDraftChange?.(editor.value);
    return true;
  };
  const applySourceHistoryCommand = (command) => command === "undo"
    ? applySourceInputHistoryCommand(command) || applyInitialHistoryCommand(command)
    : applyInitialHistoryCommand(command) || applySourceInputHistoryCommand(command);
  editor.tetherHandleHistoryCommand = applySourceHistoryCommand;

  handlePointerDragEnd = (event) => {
    if (finished || pointerDragAnchor == null) return;
    const rect = editor.getBoundingClientRect();
    const endedInside = event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom;
    const localAnchor = pointerDragAnchor;
    pointerDragAnchor = null;
    if (pointerDragWindow) {
      pointerDragWindow.removeEventListener("mouseup", handlePointerDragEnd, true);
      pointerDragWindow = null;
    }
    if (endedInside) return;
    const target = editor.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const pointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      detail: 1,
      target
    };
    finish(true, (mapping) => onPointerDrag(localAnchor, pointer, mapping));
  };

  editor.addEventListener("beforeinput", (event) => {
    if (["historyUndo", "historyRedo"].includes(event.inputType)) return;
    if (event.isComposing) {
      compositionSourceInputSnapshot ||= sourceInputSnapshot();
      return;
    }
    pendingSourceInputSnapshot = sourceInputSnapshot();
  });
  editor.addEventListener("compositionstart", () => {
    compositionSourceInputSnapshot = sourceInputSnapshot();
  });
  editor.addEventListener("compositionend", () => {
    if (!compositionSourceInputSnapshot) return;
    rememberSourceInputChange(compositionSourceInputSnapshot);
    resetSourceInputGroup();
    compositionSourceInputSnapshot = null;
    pendingSourceInputSnapshot = null;
  });
  editor.addEventListener("input", (event) => {
    const currentSnapshot = sourceInputSnapshot();
    if (event.isComposing) {
      compositionSourceInputSnapshot ||= pendingSourceInputSnapshot || lastSourceInputSnapshot;
      pendingSourceInputSnapshot = null;
      lastSourceInputSnapshot = currentSnapshot;
    } else if (!["historyUndo", "historyRedo"].includes(event.inputType)) {
      const before = compositionSourceInputSnapshot
        || pendingSourceInputSnapshot
        || lastSourceInputSnapshot;
      const now = performance.now();
      const groupableInput = [
        "insertText",
        "deleteContentBackward",
        "deleteContentForward"
      ].includes(event.inputType);
      const groupWithPrevious = groupableInput
        && event.inputType === lastSourceInputType
        && now - lastSourceInputAt <= 1000
        && before?.start === before?.end
        && sameSourceInputSelection(lastSourceInputSnapshot, before);
      rememberSourceInputChange(
        before,
        currentSnapshot,
        groupWithPrevious
      );
      lastSourceInputType = groupableInput ? event.inputType : null;
      lastSourceInputAt = groupableInput ? now : 0;
      compositionSourceInputSnapshot = null;
      pendingSourceInputSnapshot = null;
    } else {
      pendingSourceInputSnapshot = null;
      lastSourceInputSnapshot = currentSnapshot;
      resetSourceInputGroup();
    }
    resize();
    onDraftChange?.(editor.value);
    if (!initialDeletionHistory) return;
    if (event.inputType === "historyUndo") {
      const snapshot = initialDeletionHistory.pendingNativeUndoSnapshot;
      if (snapshot && snapshot.value !== editor.value) {
        initialDeletionHistory.nativeUndoSnapshots ||= [];
        initialDeletionHistory.nativeUndoSnapshots.push(snapshot);
      }
    } else {
      initialDeletionHistory.nativeUndoSnapshots = [];
      initialDeletionHistory.nativeRedoSnapshots = [];
      initialDeletionHistory.nativeRedoIndex = 0;
    }
    initialDeletionHistory.pendingNativeUndoSnapshot = null;
    const returnedToInitialDeletion = (
      event.inputType === "historyUndo"
      && initialDeletionHistory.state === "applied"
      && editor.value === initialDeletionHistory.afterValue
    );
    initialDeletionHistory.nativeHistoryActive = !returnedToInitialDeletion;
    if (returnedToInitialDeletion) {
      initialDeletionHistory.nativeRedoSnapshots = [
        ...(initialDeletionHistory.nativeUndoSnapshots || [])
      ].reverse();
      initialDeletionHistory.nativeUndoSnapshots = [];
      initialDeletionHistory.nativeRedoIndex = 0;
    }
  });
  const applyClipboardEdit = (replacement, inputType) => {
    const before = sourceInputSnapshot();
    const edit = sourceControlClipboardEdit(
      editor.value,
      before.start,
      before.end,
      replacement
    );
    if (edit.value === editor.value) return edit;
    pendingSourceInputSnapshot = before;
    editor.value = edit.value;
    editor.setSelectionRange(edit.caret, edit.caret, "none");
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType,
      data: inputType === "insertFromPaste" ? String(replacement ?? "") : null
    }));
    return edit;
  };
  editor.addEventListener("copy", (event) => {
    if (!event.clipboardData) return;
    const { selectedText } = sourceControlClipboardEdit(
      editor.value,
      editor.selectionStart,
      editor.selectionEnd
    );
    if (!selectedText) return;
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData.setData("text/plain", selectedText);
  });
  editor.addEventListener("cut", (event) => {
    if (!event.clipboardData || editor.selectionStart === editor.selectionEnd) return;
    const selectedText = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData.setData("text/plain", selectedText);
    applyClipboardEdit("", "deleteByCut");
  });
  editor.addEventListener("paste", (event) => {
    if (!event.clipboardData) return;
    const text = event.clipboardData.getData("text/plain");
    event.preventDefault();
    event.stopPropagation();
    if (!isBlock && /[\r\n]/.test(text)) {
      const edit = sourceControlClipboardEdit(
        editor.value,
        editor.selectionStart,
        editor.selectionEnd,
        text
      );
      finishKeyboardHandoff(
        false,
        () => onInlineMultilinePaste(edit.value, edit.caret)
      );
      return;
    }
    applyClipboardEdit(text, "insertFromPaste");
  });
  editor.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const caret = caretAtClientX(event.clientX);
    const now = performance.now();
    // The first press replaces rendered text with this input, so the browser
    // sees the next press as a new target and may restart event.detail at 1.
    // Carry the sequence across that DOM swap to retain native double/triple
    // click word and line selection semantics.
    const continuedClickCount = pointerClickCount > 0 && now - lastPointerDownAt <= 500
      ? Math.min(3, pointerClickCount + 1)
      : Math.max(1, event.detail);
    pointerClickCount = Math.max(continuedClickCount, event.detail);
    lastPointerDownAt = now;
    const pointerSelection = caret == null
      ? null
      : sourcePointerSelectionRange(editor.value, caret, pointerClickCount);
    pointerDragAnchor = caret ?? sourceInputSelection(
      editor.selectionStart ?? 0,
      editor.selectionEnd ?? editor.selectionStart ?? 0,
      editor.selectionDirection
    ).anchor;
    pointerDragWindow = editor.ownerDocument.defaultView;
    pointerDragWindow?.addEventListener("mouseup", handlePointerDragEnd, true);
    requestAnimationFrame(() => {
      if (finished || !editor.isConnected) return;
      if (pointerSelection) {
        editor.setSelectionRange(
          pointerSelection.start,
          pointerSelection.end,
          pointerSelection.direction || "none"
        );
      } else {
        if (caret != null) editor.setSelectionRange(caret, caret);
      }
      pointerDragAnchor = sourceInputSelection(
        editor.selectionStart ?? 0,
        editor.selectionEnd ?? editor.selectionStart ?? 0,
        editor.selectionDirection
      ).anchor;
    });
  });
  editor.addEventListener("blur", () => {
    blurTimer = setTimeout(() => {
      blurTimer = 0;
      finish(true);
    }, 120);
  });
  editor.addEventListener("keydown", (event) => {
    if (isSourceInputComposing(event)) return;
    if (isEditorHistoryShortcut(event)) {
      const key = String(event.key || "").toLowerCase();
      const command = key === "y" || (key === "z" && event.shiftKey) ? "redo" : "undo";
      if (applySourceHistoryCommand(command)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (editor.closest(".ProseMirror")?.tetherRunBoundaryHistory?.(command)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (editor.closest(".ProseMirror")?.tetherRunSourceControlHistory?.(command)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    if (isEditorSelectAllShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      finishKeyboardHandoff(true, () => onDocumentSelectAll());
      return;
    }
    const lineDeleteDirection = sourceLineDeleteDirection(event);
    const wordDeleteDirection = lineDeleteDirection ? null : sourceWordDeleteDirection(event);
    const modifierDeleteDirection = lineDeleteDirection || wordDeleteDirection;
    if (modifierDeleteDirection) {
      const localSelection = sourceInputSelection(
        editor.selectionStart ?? 0,
        editor.selectionEnd ?? editor.selectionStart ?? 0,
        editor.selectionDirection
      );
      const value = editor.value;
      event.preventDefault();
      event.stopPropagation();
      finishKeyboardHandoff(
        false,
        () => onSourceModifierDelete(
          value,
          localSelection,
          modifierDeleteDirection,
          lineDeleteDirection ? "line" : "word"
        )
      );
      return;
    }
    const documentJumpEdge = sourceDocumentJumpEdge(event);
    if (documentJumpEdge) {
      const start = editor.selectionStart ?? 0;
      const end = editor.selectionEnd ?? start;
      const backward = editor.selectionDirection === "backward";
      const sourceSelection = {
        anchor: backward ? end : start,
        head: backward ? start : end
      };
      const shortcut = {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      };
      event.preventDefault();
      event.stopPropagation();
      finishKeyboardHandoff(
        true,
        (mapping) => onDocumentJump(shortcut, sourceSelection, mapping)
      );
      return;
    }
    const lineJumpEdge = sourceLineJumpEdge(event);
    const wordJumpDirection = lineJumpEdge ? null : sourceInputWordJumpDirection(
      event.key,
      editor.selectionStart,
      editor.selectionEnd,
      editor.value.length,
      event.shiftKey,
      event.altKey,
      event.ctrlKey || event.metaKey,
      editor.selectionDirection
    );
    const boundaryDirection = inlineSourceBoundaryDirection(
      event.key,
      editor.selectionStart,
      editor.selectionEnd,
      editor.value.length,
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    );
    // The source-aware boundary transaction now represents the newline between
    // ProseMirror blocks, so inline inputs and block textareas can share the
    // same Backspace/Delete handoff at their outer edges.
    const boundaryDeleteDirection = inlineSourceBoundaryDeleteDirection(
      event.key,
      editor.selectionStart,
      editor.selectionEnd,
      editor.value.length,
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    );
    const verticalDirection = isBlock
      ? blockSourceVerticalDirection(
          event.key,
          editor.selectionStart,
          editor.selectionEnd,
          editor.value,
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        )
      : inlineSourceVerticalDirection(
          event.key,
          editor.selectionStart,
          editor.selectionEnd,
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        );
    const boundarySelectionDirection = isBlock
      ? blockSourceBoundarySelectionDirection(
          event.key,
          editor.selectionStart,
          editor.selectionEnd,
          editor.value,
          event.shiftKey,
          event.altKey || event.ctrlKey || event.metaKey,
          editor.selectionDirection
        )
      : inlineSourceBoundarySelectionDirection(
          event.key,
          editor.selectionStart,
          editor.selectionEnd,
          editor.value.length,
          event.shiftKey,
          event.altKey || event.ctrlKey || event.metaKey,
          editor.selectionDirection
        );
    const localSelection = lineJumpEdge || wordJumpDirection || boundarySelectionDirection
      ? sourceInputSelection(
          editor.selectionStart ?? 0,
          editor.selectionEnd ?? editor.selectionStart ?? 0,
          editor.selectionDirection
        )
      : null;
    if (
      lineJumpEdge
      || wordJumpDirection
      || boundaryDirection
      || boundaryDeleteDirection
      || verticalDirection
      || boundarySelectionDirection
    ) {
      event.preventDefault();
      event.stopPropagation();
      const targetPoint = verticalDirection ? caretTargetPoint(verticalDirection) : null;
      finishKeyboardHandoff(true, (mapping) => {
        if (lineJumpEdge) {
          onLineJump(
            lineJumpEdge,
            localSelection,
            event.shiftKey,
            mapping
          );
        } else if (wordJumpDirection) {
          onWordJump(
            wordJumpDirection,
            localSelection,
            event.shiftKey,
            mapping
          );
        } else if (boundaryDirection) onBoundaryNavigate(boundaryDirection, mapping);
        else if (boundaryDeleteDirection) onBoundaryDelete(boundaryDeleteDirection, mapping);
        else if (verticalDirection) onVerticalNavigate(verticalDirection, targetPoint, mapping);
        else {
          onBoundarySelect(
            boundarySelectionDirection,
            localSelection,
            mapping
          );
        }
      });
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishKeyboardHandoff(false);
    } else if (
      event.key === "Tab"
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
    ) {
      event.preventDefault();
      if (!isBlock) {
        const localSelection = sourceInputSelection(
          editor.selectionStart ?? 0,
          editor.selectionEnd ?? editor.selectionStart ?? 0,
          editor.selectionDirection
        );
        const value = editor.value;
        finishKeyboardHandoff(
          false,
          () => onInlineTab(value, localSelection, event.shiftKey)
        );
        return;
      }
      const edit = sourceTabEdit(
        editor.value,
        editor.selectionStart,
        editor.selectionEnd,
        event.shiftKey
      );
      const direction = editor.selectionDirection || "none";
      const before = sourceInputSnapshot();
      editor.value = edit.value;
      editor.setSelectionRange(edit.selectionStart, edit.selectionEnd, direction);
      rememberSourceInputChange(before);
      resetSourceInputGroup();
      resize();
      onDraftChange?.(editor.value);
    } else if (!isBlock && event.key === "Enter") {
      event.preventDefault();
      const sourceOffset = editor.selectionStart ?? 0;
      if (editor.selectionEnd !== sourceOffset) {
        editor.value = `${editor.value.slice(0, sourceOffset)}${editor.value.slice(editor.selectionEnd)}`;
        resize();
      }
      const value = editor.value;
      finishKeyboardHandoff(
        false,
        () => onInlineEnter(value, sourceOffset)
      );
    } else if (isBlock && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finishKeyboardHandoff(true);
    }
  });
  resize();
  requestAnimationFrame(() => {
    if (finished || !editor.isConnected) return;
    resize();
    // The originating key event publishes this draft immediately, but a
    // decoration replacement can race the host's draft reconciliation. Once
    // the surviving control is mounted, publish its current value over a short
    // bounded settling window so the visible source and saved document cannot
    // diverge even when reconciliation spans several animation frames.
    if (initialDeletionHistory) {
      let remainingDraftFrames = 4;
      const republishInitialDraft = () => {
        if (finished || !editor.isConnected || remainingDraftFrames <= 0) return;
        remainingDraftFrames -= 1;
        onDraftChange?.(editor.value);
        if (remainingDraftFrames > 0) requestAnimationFrame(republishInitialDraft);
      };
      republishInitialDraft();
    }
    if (!shouldFocus()) return;
    editor.focus();
    const caret = Math.max(0, Math.min(editor.value.length, startingCaret));
    if (startingSelection) {
      editor.setSelectionRange(
        startingSelection.start,
        startingSelection.end,
        startingSelection.direction
      );
    } else {
      editor.setSelectionRange(caret, caret);
    }
  });
  return editor;
}

function pointerDocumentPosition(view, event) {
  const ownerDocument = view.dom.ownerDocument || document;
  const targetElement = event.target instanceof Element ? event.target : null;
  const textblock = targetElement?.closest("p, h1, h2, h3, h4, h5, h6");
  if (textblock && view.dom.contains(textblock)) {
    const exactPosition = textblockPositionFromGeometry(view, textblock, event);
    if (Number.isFinite(exactPosition)) return exactPosition;
  }
  let node = null;
  let offset = null;

  if (typeof ownerDocument.caretPositionFromPoint === "function") {
    const caret = ownerDocument.caretPositionFromPoint(event.clientX, event.clientY);
    node = caret?.offsetNode || null;
    offset = caret?.offset ?? null;
  } else if (typeof ownerDocument.caretRangeFromPoint === "function") {
    const range = ownerDocument.caretRangeFromPoint(event.clientX, event.clientY);
    node = range?.startContainer || null;
    offset = range?.startOffset ?? null;
  }

  const nodeElement = node?.nodeType === 1 ? node : node?.parentElement;
  if (node && Number.isFinite(offset) && nodeElement && view.dom.contains(nodeElement)) {
    try {
      return Math.max(0, Math.min(view.state.doc.content.size, view.posAtDOM(node, offset, -1)));
    } catch {
      // Some rendered widgets (notably KaTeX and CodeMirror) are outside the
      // ProseMirror content DOM. Fall back to its coordinate mapper below.
    }
  }

  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  return hit ? hit.pos : null;
}

function geometryDistance(rect, event, edgeX) {
  const verticalDistance = event.clientY < rect.top
    ? rect.top - event.clientY
    : event.clientY > rect.bottom
      ? event.clientY - rect.bottom
      : 0;
  // Vertical distance dominates so a click in the empty space beside a short
  // wrapped line lands on that line, never on a longer neighboring line whose
  // right edge happens to be horizontally closer.
  return Math.abs(event.clientX - edgeX) + verticalDistance * 1000;
}

function textblockPositionFromGeometry(view, root, event) {
  const ownerDocument = root.ownerDocument || document;
  const candidates = [];
  const walker = ownerDocument.createTreeWalker(root, 4);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent?.closest("button, input, textarea, .katex, [data-type='math_inline']")) continue;
    const text = node.nodeValue || "";
    for (let index = 0; index < text.length; index += 1) {
      const range = ownerDocument.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.height) continue;
      try {
        candidates.push({
          position: view.posAtDOM(node, index, -1),
          distance: geometryDistance(rect, event, rect.left)
        });
        candidates.push({
          position: view.posAtDOM(node, index + 1, 1),
          distance: geometryDistance(rect, event, rect.right)
        });
      } catch {
        // Ignore visual-only text that is outside ProseMirror's content DOM.
      }
    }
  }

  root.querySelectorAll("span[data-type='math_inline']").forEach((math) => {
    const rect = math.getBoundingClientRect();
    if (!rect.height) return;
    try {
      const atomPosition = view.posAtDOM(math, 0, -1);
      candidates.push({
        position: atomPosition,
        distance: geometryDistance(rect, event, rect.left)
      });
      candidates.push({
        position: atomPosition + 1,
        distance: geometryDistance(rect, event, rect.right)
      });
    } catch {
      // Ignore an atom while its node view is being replaced.
    }
  });

  if (!candidates.length) return null;
  const nearest = candidates.reduce((best, candidate) =>
    candidate.distance < best.distance ? candidate : best
  );
  return Math.max(0, Math.min(view.state.doc.content.size, nearest.position));
}

function textOffsetFromGeometry(root, event) {
  const ownerDocument = root.ownerDocument || document;
  const walker = ownerDocument.createTreeWalker(root, 4);
  let cumulativeOffset = 0;
  let bestOffset = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || "";
    for (let index = 0; index < text.length; index += 1) {
      const range = ownerDocument.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.height) continue;

      const verticalDistance = event.clientY < rect.top
        ? rect.top - event.clientY
        : event.clientY > rect.bottom
          ? event.clientY - rect.bottom
          : 0;
      const leftDistance = Math.abs(event.clientX - rect.left) + verticalDistance * 4;
      const rightDistance = Math.abs(event.clientX - rect.right) + verticalDistance * 4;
      if (leftDistance < bestDistance) {
        bestDistance = leftDistance;
        bestOffset = cumulativeOffset + index;
      }
      if (rightDistance < bestDistance) {
        bestDistance = rightDistance;
        bestOffset = cumulativeOffset + index + 1;
      }
    }
    cumulativeOffset += text.length;
  }

  return bestOffset;
}

function textOffsetAtPoint(root, event) {
  const ownerDocument = root.ownerDocument || document;
  const caret = typeof ownerDocument.caretPositionFromPoint === "function"
    ? ownerDocument.caretPositionFromPoint(event.clientX, event.clientY)
    : null;
  const fallbackRange = !caret && typeof ownerDocument.caretRangeFromPoint === "function"
    ? ownerDocument.caretRangeFromPoint(event.clientX, event.clientY)
    : null;
  const node = caret?.offsetNode || fallbackRange?.startContainer || null;
  const offset = caret?.offset ?? fallbackRange?.startOffset ?? null;
  const nodeElement = node?.nodeType === 1 ? node : node?.parentElement;
  if (!node || !Number.isFinite(offset) || !nodeElement || !root.contains(nodeElement)) return null;

  try {
    const range = ownerDocument.createRange();
    range.setStart(root, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

export function verticalDocumentPositionFromGeometry(view, point, direction) {
  if (!point) return null;
  const ownerDocument = view.dom.ownerDocument || document;
  const walker = ownerDocument.createTreeWalker(view.dom, 4);
  let best = null;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent?.closest("button, input, textarea, .katex, .cm-editor, [contenteditable='false']")) continue;
    const text = node.nodeValue || "";
    for (let index = 0; index < text.length; index += 1) {
      const range = ownerDocument.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.height) continue;
      const verticalDistance = direction === "up"
        ? point.top - rect.bottom
        : rect.top - point.top;
      if (verticalDistance < 1) continue;

      const edges = [
        { offset: index, x: rect.left, assoc: -1 },
        { offset: index + 1, x: rect.right, assoc: 1 }
      ];
      for (const edge of edges) {
        let position;
        try {
          position = view.posAtDOM(node, edge.offset, edge.assoc);
        } catch {
          continue;
        }
        const score = verticalDistance * 1000 + Math.abs(point.left - edge.x);
        if (!best || score < best.score) best = { position, score };
      }
    }
  }

  return best?.position ?? null;
}

export function enclosingCodeBlock(doc, position) {
  let blockPosition = Math.max(0, Math.min(position, doc.content.size));
  let node = doc.nodeAt(blockPosition);
  if (node?.type.name === "code_block") return { position: blockPosition, node };

  const resolved = doc.resolve(blockPosition);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (resolved.node(depth).type.name !== "code_block") continue;
    return { position: resolved.before(depth), node: resolved.node(depth) };
  }
  return null;
}

export function adjacentCodeBlockFromSelection(state, direction) {
  if (!state?.selection?.empty || !["up", "down"].includes(direction)) return null;
  const $head = state.selection.$head;
  const forward = direction === "down";

  // Walk outward only when the current textblock is already at the edge of an
  // enclosing container. The first real sibling is the visual neighbor; never
  // skip an intervening paragraph/list merely to find a later code block.
  for (let parentDepth = $head.depth - 1; parentDepth >= 0; parentDepth -= 1) {
    const parent = $head.node(parentDepth);
    const index = forward ? $head.indexAfter(parentDepth) : $head.index(parentDepth) - 1;
    if (index < 0 || index >= parent.childCount) continue;
    const node = parent.child(index);
    if (node.type.name !== "code_block") return null;
    const boundary = forward
      ? $head.after(parentDepth + 1)
      : $head.before(parentDepth + 1);
    return {
      position: forward ? boundary : boundary - node.nodeSize,
      node
    };
  }
  return null;
}

function atVerticalTextblockEdge(view, direction) {
  if (view.endOfTextblock(direction)) return true;
  const { $head } = view.state.selection;
  if (!$head.parent.isTextblock) return false;
  if (direction === "down" && $head.parentOffset === $head.parent.content.size) return true;
  if (direction === "up" && $head.parentOffset === 0) return true;

  let blockDOM = null;
  try {
    blockDOM = view.nodeDOM($head.before($head.depth));
  } catch {
    return false;
  }
  if (!(blockDOM instanceof Element)) return false;
  const caret = view.coordsAtPos($head.pos);
  const rect = blockDOM.getBoundingClientRect();
  const style = getComputedStyle(blockDOM);
  const lineHeight = Number.parseFloat(style.lineHeight || "")
    || Math.max(1, caret.bottom - caret.top);
  return direction === "up"
    ? caret.top <= rect.top + lineHeight * 0.5
    : caret.bottom >= rect.bottom - lineHeight * 0.5;
}

function documentSourceColumn(state, position, serializer) {
  const documentSource = documentSourceSegments(state, serializer);
  const offset = documentSourceOffsetAtPosition(state, position, serializer, "forward");
  if (!documentSource || !Number.isFinite(offset)) return 0;
  return offset - (documentSource.fullSource.lastIndexOf("\n", Math.max(0, offset - 1)) + 1);
}

export function adjacentCodeSourceTarget(state, target, direction, serializer) {
  const unit = {
    from: target.position,
    to: target.position + target.node.nodeSize,
    kind: "block",
    name: "code_block"
  };
  const source = continuousMarkdownSource(state, unit, serializer);
  const column = documentSourceColumn(state, state.selection.head, serializer);
  return {
    unit,
    sourceOffset: adjacentCodeSourceOffset(source, direction, column)
  };
}

export function adjacentCodeSourceSelection(state, target, direction, serializer) {
  const documentSource = documentSourceSegments(state, serializer);
  const anchor = documentSourceOffsetAtPosition(
    state,
    state.selection.anchor,
    serializer,
    "forward"
  );
  const { unit, sourceOffset } = adjacentCodeSourceTarget(
    state,
    target,
    direction,
    serializer
  );
  const unitStart = documentSourceUnitStartOffset(state, unit, serializer);
  if (!documentSource || !Number.isFinite(anchor) || !Number.isFinite(unitStart)) return null;

  const codeHead = target.position + 1 + (direction === "up" ? target.node.content.size : 0);
  return {
    selection: TextSelection.create(state.doc, state.selection.anchor, codeHead),
    sourceSelection: {
      anchor,
      head: unitStart + sourceOffset,
      fullSource: documentSource.fullSource,
      boundary: target.position
    }
  };
}

function focusAdjacentCodeBlock(view, target, direction, serializer) {
  const { sourceOffset } = adjacentCodeSourceTarget(view.state, target, direction, serializer);
  activateMarkdownSourceAt(view, target.position, {
    explicitUnitPosition: target.position,
    sourceOffset
  });
  return true;
}

function selectIntoAdjacentCodeBlock(view, target, direction, serializer) {
  const state = view.state;
  const exact = adjacentCodeSourceSelection(state, target, direction, serializer);
  if (!exact) return false;
  view.dispatch(
    state.tr
      .setSelection(exact.selection)
      .setMeta(markdownSyntaxKey, {
        action: "source-selection",
        sourceSelection: exact.sourceSelection
      })
      .scrollIntoView()
  );
  view.focus();
  return true;
}

function capturedCodeBlockTarget(view, block, event) {
  let domPosition;
  try {
    domPosition = view.posAtDOM(block, 0, -1);
  } catch {
    return null;
  }
  const codeBlock = enclosingCodeBlock(view.state.doc, domPosition);
  if (!codeBlock) return null;
  const { position: blockPosition, node } = codeBlock;

  const line = event.target instanceof Element ? event.target.closest(".cm-line") : null;
  if (line && block.contains(line)) {
    const lines = [...block.querySelectorAll(".cm-line")];
    const lineIndex = lines.indexOf(line);
    if (lineIndex >= 0) {
      // CodeMirror's content DOM is outside ProseMirror and WebKit does not
      // consistently expose it through caretPositionFromPoint. Character
      // rectangles give us the same exact boundary mapping used by ordinary
      // rendered text, including syntax-highlighted spans.
      const lineOffset = textOffsetFromGeometry(line, event) ?? textOffsetAtPoint(line, event);
      const priorLength = lines
        .slice(0, lineIndex)
        .reduce((length, item) => length + (item.textContent || "").length + 1, 0);
      const contentOffset = Math.max(0, Math.min(node.textContent.length, priorLength + (lineOffset ?? 0)));
      return { position: blockPosition + 1 + contentOffset, assoc: 1 };
    }
  }

  const preview = event.target instanceof Element ? event.target.closest(".preview-panel") : null;
  if (preview && block.contains(preview)) {
    const rect = preview.getBoundingClientRect();
    const ratio = rect.width > 0
      ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      : 0;
    return {
      position: blockPosition + 1 + Math.round(ratio * node.textContent.length),
      assoc: 1
    };
  }

  return { position: blockPosition + 1, assoc: 1 };
}

function capturedTargetAtPointer(view, event) {
  let math = event.target instanceof Element
    ? event.target.closest('span[data-type="math_inline"]')
    : null;
  let adjacentMathEdge = null;
  if (!math && event.target instanceof Element) {
    const textblock = event.target.closest("p, h1, h2, h3, h4, h5, h6");
    const nearby = [...(textblock?.querySelectorAll('span[data-type="math_inline"]') || [])]
      .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
      .filter(({ rect }) => event.clientY >= rect.top - 3 && event.clientY <= rect.bottom + 3)
      .map(({ candidate, rect }) => ({
        candidate,
        rect,
        distance: event.clientX < rect.left
          ? rect.left - event.clientX
          : event.clientX > rect.right
            ? event.clientX - rect.right
            : 0
      }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearby?.distance <= 10) {
      math = nearby.candidate;
      adjacentMathEdge = event.clientX >= nearby.rect.right ? "after" : "before";
    }
  }
  if (!math) {
    const targetElement = event.target instanceof Element ? event.target : null;
    const atomElement = targetElement?.closest("img:not(.ProseMirror-separator), hr, sup");
    if (atomElement) {
      try {
        const domPosition = view.posAtDOM(atomElement, 0, -1);
        const atom = sourceAtomNearPosition(view.state, domPosition);
        if (atom) {
          return {
            position: atom.from,
            atomPosition: atom.from,
            assoc: 1
          };
        }
      } catch {
        // Fall through to the general coordinate mapper for detached node views.
      }
    }
    const codeBlock = event.target instanceof Element
      ? event.target.closest(".milkdown-code-block")
      : null;
    if (codeBlock) return capturedCodeBlockTarget(view, codeBlock, event);
    const position = pointerDocumentPosition(view, event);
    return Number.isFinite(position) ? { position, assoc: 1 } : null;
  }

  const value = math.getAttribute("data-value") || "";
  const rect = math.getBoundingClientRect();
  const ratio = rect.width > 0
    ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    : 1;
  const clickedText = event.target instanceof Element
    ? (event.target.textContent || "").trim()
    : "";
  let valueOffset = Math.round(ratio * value.length);
  if (clickedText && clickedText.length <= 3) {
    const candidates = [];
    let candidate = value.indexOf(clickedText);
    while (candidate >= 0) {
      candidates.push(candidate);
      candidate = value.indexOf(clickedText, candidate + 1);
    }
    if (candidates.length) {
      const targetOffset = ratio * value.length;
      valueOffset = candidates.reduce((nearest, current) =>
        Math.abs(current - targetOffset) < Math.abs(nearest - targetOffset) ? current : nearest
      );
      const targetRect = event.target instanceof Element
        ? event.target.getBoundingClientRect()
        : rect;
      if (event.clientX > targetRect.left + targetRect.width / 2) valueOffset += clickedText.length;
    }
  }

  try {
    const atomPosition = view.posAtDOM(math, 0, -1);
    if (adjacentMathEdge) {
      const value = math.getAttribute("data-value") || "";
      return {
        position: atomPosition,
        atomPosition,
        sourceOffset: adjacentMathEdge === "after" ? value.length + 1 : 1,
        assoc: adjacentMathEdge === "after" ? 1 : -1
      };
    }
    return {
      position: atomPosition,
      atomPosition,
      sourceOffset: 1 + valueOffset,
      assoc: 1
    };
  } catch {
    return null;
  }
}

export function markdownSourceTargetFromPointer(view, event) {
  const target = capturedTargetAtPointer(view, event);
  return target
    ? { ...target, pointerClickCount: Math.max(1, Number(event?.detail) || 1) }
    : null;
}

export function mappedPosition(mapping, position, assoc = 1) {
  return mapping ? mapping.map(position, assoc) : position;
}

const inlineWordChar = /[\p{L}\p{N}_]/u;
const completedInlinePatterns = [
  { pattern: /\*\*[^*\n]+\*\*$/, closingLength: 2 },
  { pattern: /__[^_\n]+__$/, closingLength: 2, wordBoundary: true },
  { pattern: /~~[^~\n]+~~$/, closingLength: 2 },
  { pattern: /\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)$/, closingLength: 1, wordBoundary: true },
  { pattern: /\$(?!\s)[^$\n]*[^$\s]\$$/, closingLength: 1, noDigitAfter: true },
  { pattern: /(?<!\*)\*[^*\n]+\*$/, closingLength: 1 },
  { pattern: /(?<!_)_[^_\n]+_$/, closingLength: 1, wordBoundary: true }
];

function isEscapedDelimiter(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function completedInlineCodeMatch(text) {
  const closing = text.match(/`+$/);
  if (!closing) return null;
  const fence = closing[0];
  const closingStart = closing.index;
  for (let index = closingStart - fence.length; index >= 0; index -= 1) {
    if (text.slice(index, index + fence.length) !== fence) continue;
    // A matching fence is an exact run. A shorter slice inside a longer run
    // must not trigger conversion while the user is still typing the closer.
    if (text[index - 1] === "`" || text[index + fence.length] === "`") continue;
    if (isEscapedDelimiter(text, index)) continue;
    const content = text.slice(index + fence.length, closingStart);
    if (!content || content.includes("\n")) continue;
    return { 0: text.slice(index), index };
  }
  return null;
}

export function completedInlineMarkdownSource(text, nextChar = "") {
  const matches = [];
  for (const { pattern, closingLength, wordBoundary, noDigitAfter } of completedInlinePatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    // Delimiters glued to surrounding word characters stay literal text, so
    // snake_case identifiers and index-call shapes like arr[i](x) never
    // auto-format; a "$" closing right before a digit is a price, not math.
    const charBefore = match.index > 0 ? text[match.index - 1] : "";
    const closingIndex = match.index + match[0].length - closingLength;
    if (isEscapedDelimiter(text, match.index) || isEscapedDelimiter(text, closingIndex)) continue;
    if (wordBoundary && (inlineWordChar.test(charBefore) || (nextChar && inlineWordChar.test(nextChar)))) continue;
    if (noDigitAfter && nextChar && /\d/.test(nextChar)) continue;
    matches.push(match);
  }
  const inlineCode = completedInlineCodeMatch(text);
  if (inlineCode) matches.push(inlineCode);
  if (!matches.length) return null;
  return matches.reduce((best, match) => match.index < best.index ? match : best);
}

// The Crepe latex feature's input rule converts any "$...$" pair, which
// hijacks prose like "costs $5 and $10". Real inline math never carries
// whitespace at its edges, so such conversions are reverted to literal text.
export function invalidInlineMathValue(value) {
  return !value || value !== value.trim();
}

function revertInvalidInlineMath(state) {
  const fixes = [];
  state.doc.descendants((node, position) => {
    if (node.type.name === "math_inline" && invalidInlineMathValue(node.attrs.value ?? "")) {
      fixes.push({ position, size: node.nodeSize, value: node.attrs.value ?? "" });
    }
  });
  if (!fixes.length) return null;

  let transaction = state.tr;
  for (const fix of fixes.reverse()) {
    transaction = transaction.replaceWith(
      fix.position,
      fix.position + fix.size,
      state.schema.text(`$${fix.value}$`)
    );
  }
  transaction.setMeta(markdownSyntaxKey, { action: "smart-input" });
  return transaction;
}

function smartInlineInputTransaction(state, parser) {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.name === "code_block") return null;

  const cursorOffset = $from.parentOffset;
  let activeText = null;
  let activeOffset = 0;
  $from.parent.forEach((node, offset) => {
    if (activeText || !node.isText || node.marks.length) return;
    const end = offset + node.nodeSize;
    if (cursorOffset > offset && cursorOffset <= end) {
      activeText = node;
      activeOffset = offset;
    }
  });
  if (!activeText) return null;

  const localCaret = cursorOffset - activeOffset;
  const prefix = activeText.text.slice(0, localCaret);
  const nextChar = activeText.text.slice(localCaret, localCaret + 1);
  const match = completedInlineMarkdownSource(prefix, nextChar);
  if (!match) return null;

  const source = match[0];
  const parsed = parser(source);
  const block = parsed?.firstChild;
  if (!block?.isTextblock || block.type.name !== "paragraph" || !block.content.size) return null;
  const unchangedPlainText = block.childCount === 1
    && block.firstChild?.isText
    && block.firstChild.text === source
    && block.firstChild.marks.length === 0;
  if (unchangedPlainText) return null;

  const from = $from.start() + activeOffset + match.index;
  const to = $from.start() + activeOffset + localCaret;
  let transaction = state.tr.replaceWith(from, to, block.content);
  transaction = selectionAfter(transaction, from + block.content.size);
  transaction.setMeta(markdownSyntaxKey, { action: "smart-input" });
  return transaction;
}

function activateCapturedTarget(view, target, mapping = null) {
  const position = mappedPosition(mapping, target.position, target.assoc ?? 1);
  const atomPosition = target.atomPosition == null
    ? null
    : mappedPosition(mapping, target.atomPosition, target.assoc ?? 1);
  const activate = () => {
    if (!view.dom.isConnected) return;
    activateMarkdownSourceAt(view, position, {
      atomPosition,
      sourceOffset: target.sourceOffset ?? null,
      initialPointerSelection: target.pointerClickCount ?? 1,
      focusLock: Boolean(mapping)
    });
  };
  requestAnimationFrame(activate);
}

export function markdownDeletionTarget(state, direction) {
  const { selection } = state;
  if (selection.node) {
    const atom = markdownAtomSyntaxAt(state, selection.from);
    const unit = atom;
    if (!unit) return null;
    return {
      position: unit.from,
      atomPosition: unit.from,
      explicitUnitPosition: null,
      edge: direction === "backward" ? "end" : "start"
    };
  }
  return markdownBoundarySourceTarget(state, direction);
}

export function hardbreakBoundaryBackspaceTransaction(state) {
  const { selection } = state;
  if (!selection.empty) return null;
  const node = selection.$from.nodeBefore;
  if (!node || node.type.name !== "hardbreak") return null;
  const marker = String(node.attrs.markdownMarker || "");
  if (!node.attrs.isInline && !(marker === "\\" || /^ {2,}$/.test(marker))) return null;

  const from = selection.from - node.nodeSize;
  let transaction = marker
    ? state.tr.replaceWith(from, selection.from, state.schema.text(marker))
    : state.tr.delete(from, selection.from);
  transaction = transaction.setSelection(TextSelection.create(transaction.doc, from + marker.length));
  transaction.setMeta(markdownSyntaxKey, "close");
  return transaction;
}

function invalidateParagraphSource(transaction, position) {
  const bounded = Math.max(0, Math.min(position, transaction.doc.content.size));
  const resolved = transaction.doc.resolve(bounded);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type.name !== "paragraph") continue;
    const paragraphPosition = resolved.before(depth);
    return transaction.setNodeMarkup(paragraphPosition, undefined, {
      ...node.attrs,
      paragraphSource: null,
      paragraphSourceSignature: null
    });
  }
  return transaction;
}

export function softbreakMarkerBoundaryDeleteTransaction(state) {
  const { selection } = state;
  if (!selection.empty) return null;
  const node = selection.$from.nodeAfter;
  if (!node || node.type.name !== "hardbreak" || !node.attrs.isInline) return null;
  const marker = String(node.attrs.markdownMarker || "");
  if (!marker) return null;
  const range = sourceCharacterDeletionRange(marker, 0, "forward");
  const nextMarker = `${marker.slice(0, range.from)}${marker.slice(range.to)}`;
  const from = selection.from;
  let transaction = state.tr.replaceWith(
    from,
    from + node.nodeSize,
    hardbreakSourceReplacement(state.schema, node, nextMarker)
  );
  transaction = invalidateParagraphSource(transaction, from);
  transaction = transaction.setSelection(TextSelection.create(transaction.doc, from));
  transaction.setMeta(markdownSyntaxKey, "close");
  return transaction;
}

export function markdownBoundarySourceTarget(state, direction) {
  const { selection } = state;
  if (selection.node) {
    const atom = markdownAtomSyntaxAt(state, selection.from);
    if (!atom) return null;
    return {
      position: atom.from,
      atomPosition: atom.from,
      explicitUnitPosition: null,
      edge: direction === "backward" ? "end" : "start"
    };
  }
  if (!selection.empty) return null;

  const adjacentNode = direction === "backward" ? selection.$from.nodeBefore : selection.$from.nodeAfter;
  if (!adjacentNode) return null;
  const position = direction === "backward"
    ? selection.from - adjacentNode.nodeSize
    : selection.from;
  const atom = markdownAtomSyntaxAt(state, position);
  if (atom) {
    return {
      position: atom.from,
      atomPosition: atom.from,
      explicitUnitPosition: null,
      edge: direction === "backward" ? "end" : "start"
    };
  }

  if (!adjacentNode.isText || !adjacentNode.marks.length) return null;
  const inlinePosition = direction === "backward"
    ? Math.max(0, selection.from - 1)
    : Math.min(state.doc.content.size, selection.from + 1);
  const inline = inlineMarkdownSyntaxAtPosition(state, inlinePosition);
  if (!inline) return null;
  const touchesBoundary = direction === "backward"
    ? inline.to === selection.from
    : inline.from === selection.from;
  if (!touchesBoundary) return null;
  return {
    position: inlinePosition,
    inlinePosition,
    atomPosition: null,
    explicitUnitPosition: null,
    edge: direction === "backward" ? "end" : "start"
  };
}

export function landedOnRenderedSourceBoundary(state, key) {
  const direction = key === "ArrowLeft"
    ? "backward"
    : key === "ArrowRight"
      ? "forward"
      : null;
  return Boolean(direction && markdownBoundarySourceTarget(state, direction));
}

export function markdownDeletionSourceUnit(state, target) {
  if (target.atomPosition != null) return markdownAtomSyntaxAt(state, target.atomPosition);
  if (target.inlinePosition != null) return inlineMarkdownSyntaxAtPosition(state, target.inlinePosition);
  if (target.explicitUnitPosition != null) {
    return blockSyntaxAtPosition(state, target.explicitUnitPosition, sourceDeletionBlockNames);
  }
  return null;
}

// Live source controls per editor root, so the host component can commit an
// in-progress raw-Markdown edit synchronously before a save, mode change, or
// tab switch tears the surface down.
const liveSourceControls = new WeakMap();

function sourceNewlineDecorations(state, sourceSelection = null) {
  const info = sourceSelection || sourceNewlineSelectionInfo(state);
  if (!info) return [];
  const marker = Decoration.widget(info.boundary, () => {
    const element = document.createElement("span");
    element.className = "tether-source-newline-selection";
    const selected = sourceSelectionText(sourceSelection);
    if (selected === "") {
      element.classList.add("is-caret");
    } else if (selected != null && !["\n", "\r\n"].includes(selected)) {
      element.classList.add("is-extended");
      const visible = selected
        .replace(/\r\n|\n|\r/g, "↵")
        .replace(/\t/g, "⇥")
        .replace(/ /g, "·");
      element.textContent = visible.length > 28 ? `${visible.slice(0, 27)}…` : visible;
    }
    element.setAttribute("aria-hidden", "true");
    return element;
  }, { side: -1 });
  if (!sourceSelectionHasAdjacentBlocks(info)) return [marker];
  return [
    Decoration.node(info.beforeFrom, info.beforeTo, {
      class: "tether-source-newline-adjacent"
    }),
    Decoration.node(info.afterFrom, info.afterTo, {
      class: "tether-source-newline-adjacent"
    }),
    marker
  ];
}

export function sourceSelectionHasAdjacentBlocks(info) {
  return Boolean(info) && [info.beforeFrom, info.beforeTo, info.afterFrom, info.afterTo]
    .every(Number.isFinite);
}

export function flushActiveMarkdownSource(viewDom) {
  const control = viewDom ? liveSourceControls.get(viewDom) : null;
  if (control?.element?.isConnected) control.finish(true, null, true);
}

export function sourceControlSaveFocus(control, position) {
  if (!control || !Number.isFinite(position)) return null;
  const name = Array.from(control.classList || [])
    .find((className) => className.startsWith("is-") && !["is-block", "is-inline"].includes(className))
    ?.slice(3) || null;
  return {
    position,
    name,
    selection: {
      start: control.selectionStart ?? 0,
      end: control.selectionEnd ?? control.selectionStart ?? 0,
      direction: control.selectionDirection || "none"
    }
  };
}

export const markdownSyntaxPlugin = $prose((ctx) => {
  let editorView = null;
  let pendingActivation = false;
  let activeSourceControl = null;
  const exactEditHistory = [];
  const boundaryEditHistory = [];
  let exactHistoryFrame = 0;
  let exactSourceDispatchDepth = 0;
  let protectedExactSource = null;
  const capturedExactClipboardEvents = new WeakSet();

  const rememberExactEdit = (sourceSelection, transaction, afterSourceSelection = null) => {
    if (!sourceSelection || !transaction?.docChanged) return;
    const beforeSource = sourceSelection.fullSource;
    const serializer = ctx.get(serializerCtx);
    const afterSource = serializeMarkdownDocument(transaction.doc, serializer);
    if (beforeSource === afterSource) return;
    const afterState = EditorState.create({
      doc: transaction.doc,
      selection: transaction.selection
    });
    const mappedCaret = documentSourceOffsetAtPosition(
      afterState,
      transaction.selection.head,
      serializer,
      "forward"
    );
    const afterCaret = Number.isFinite(mappedCaret)
      ? mappedCaret
      : sourceEditCaretOffset(sourceSelection, afterSource);
    exactEditHistory.push({
      beforeSource,
      afterSource,
      sourceSelection: { ...sourceSelection },
      afterSourceSelection: afterSourceSelection || (Number.isFinite(afterCaret)
        ? {
            anchor: afterCaret,
            head: afterCaret,
            fullSource: afterSource,
            boundary: transaction.selection.head
          }
        : null)
    });
    if (exactEditHistory.length > 20) exactEditHistory.shift();
  };

  const dispatchExactEdit = (
    view,
    transaction,
    historySelection,
    editSelection,
    requestedAfterSelection = null,
    { isolatedHistory = false } = {}
  ) => {
    const serializer = ctx.get(serializerCtx);
    const afterSource = serializeMarkdownDocument(transaction.doc, serializer);
    const afterSelection = requestedAfterSelection?.fullSource === afterSource
      ? {
          ...requestedAfterSelection,
          fullSource: afterSource,
          boundary: Math.max(
            0,
            Math.min(transaction.selection.head, transaction.doc.content.size)
          )
        }
      : sourceSelectionAfterEdit(transaction, editSelection, serializer);
    const afterState = { doc: transaction.doc, selection: transaction.selection };
    const afterTarget = afterSelection
      ? documentSourceTarget(afterState, afterSelection.head, serializer, "forward")
      : null;
    const preserveSourcePosition = afterTarget?.kind === "gap"
      || (afterTarget?.kind === "block" && (
        afterTarget.node.type.name === "code_block"
        || structuralSourceBlockNames.has(afterTarget.node.type.name)
        || sourceAtomNames.has(afterTarget.node.type.name)
      ));
    rememberExactEdit(
      historySelection,
      transaction,
      preserveSourcePosition ? afterSelection : null
    );
    const useIsolatedHistory = isolatedHistory || sourceSelectionSpansDocumentUnits(
      view.state,
      historySelection,
      serializer
    );
    if (useIsolatedHistory && historySelection && afterSelection) {
      const firstUndone = boundaryEditHistory.findIndex((entry) => entry.state === "undone");
      if (firstUndone >= 0) boundaryEditHistory.splice(firstUndone);
      boundaryEditHistory.push({
        beforeSource: historySelection.fullSource,
        afterSource,
        sourceSelection: { ...historySelection },
        afterSourceSelection: { ...afterSelection },
        state: "applied"
      });
      if (boundaryEditHistory.length > 20) boundaryEditHistory.shift();
      transaction.setMeta("addToHistory", false);
    }
    transaction.setMeta(markdownSyntaxKey, { action: "exact-source-edit" });
    // The browser can report a stale DOM reconciliation after a virtual gap
    // edit moves focus out of an embedded CodeMirror. Remember the source
    // installed by this exact transaction so that reconciliation cannot delete
    // the adjacent fenced node or replace the document from stale rendered DOM.
    protectedExactSource = afterSource;
    exactSourceDispatchDepth += 1;
    try {
      view.dispatch(transaction.scrollIntoView());
    } finally {
      exactSourceDispatchDepth -= 1;
    }
    // Exact selections can include source-only bytes that Milkdown's normal
    // rendered change listener does not report. Publish the authoritative
    // serialization immediately so dirty state and Save track the transaction.
    publishMarkdownSourceDraft(view, afterSource);
    if (afterSelection && afterSelection.anchor !== afterSelection.head) {
      // Tab/Shift-Tab and similar source-native transforms retain a range.
      // Mapping only its moving head back into the rendered document would
      // collapse the selection (and can hand focus to a rebuilt CodeMirror),
      // unlike a normal source editor. Reinstall the complete physical range.
      dispatchFocusedSourceSelection(
        view,
        view.state.tr
          .setSelection(documentSourceSelectionCarrier(
            view.state,
            afterSelection,
            serializer
          ))
          .setMeta(markdownSyntaxKey, {
            action: "source-selection",
            sourceSelection: afterSelection
          })
          .scrollIntoView()
      );
      return;
    }
    if (
      preserveSourcePosition
      && afterSelection
      && activateDocumentSourceOffset(
        view,
        afterSelection,
        afterSelection.head,
        "forward",
        serializer
      )
    ) return;
    focusExactEditSelection(view);
  };

  const deleteExactSource = (view, direction, mode = "character") => {
    if (
      !view?.editable
      || !["backward", "forward"].includes(direction)
      || activeSourceControl?.element?.isConnected
    ) return false;
    const serializer = ctx.get(serializerCtx);
    const sourceSelection = markdownSyntaxKey.getState(view.state)?.sourceSelection;
    const documentSelection = sourceSelection || view.state.selection.empty
      ? null
      : sourceSelectionFromDocumentSelection(view.state, serializer);
    const plainSelection = sourceSelection || documentSelection
      ? null
      : plainTextMarkdownSourceSelection(view.state, serializer);
    const exactSelection = sourceSelection || documentSelection || plainSelection;
    if (exactSelection || sourceNewlineSelectionInfo(view.state)) {
      const modifierEdit = exactSelection && mode === "word"
        ? sourceSelectionWordDelete(exactSelection, direction)
        : exactSelection && mode === "line"
          ? sourceSelectionLineDelete(exactSelection, direction)
          : null;
      if (mode !== "character" && exactSelection && !modifierEdit?.changed) return false;
      const deletionSelection = modifierEdit?.deletionSelection || (exactSelection
        && exactSelection.anchor === exactSelection.head
        ? extendSourceSelection(exactSelection, direction)
        : exactSelection);
      const transaction = deletionSelection
        ? replaceSourceSelectionTransaction(
            view.state,
            deletionSelection,
            "",
            ctx.get(parserCtx)
          )
        : replaceSourceNewlineSelectionTransaction(
            view.state,
            "",
            ctx.get(parserCtx),
            serializer
          );
      if (!transaction) return false;
      dispatchExactEdit(
        view,
        transaction,
        exactSelection,
        deletionSelection || exactSelection,
        modifierEdit?.afterSelection || null,
        { isolatedHistory: true }
      );
      return true;
    }

    if (mode === "word" || mode === "line") {
      const edit = mode === "line"
        ? sourceLineDeletionTargetEdit(
            view.state,
            direction,
            ctx.get(parserCtx),
            serializer
          )
        : sourceWordDeletionTargetEdit(
            view.state,
            direction,
            ctx.get(parserCtx),
            serializer
          );
      if (!edit) return false;
      dispatchExactEdit(
        view,
        edit.transaction,
        edit.historySelection,
        edit.editSelection,
        edit.afterSelection,
        { isolatedHistory: true }
      );
      return true;
    }

    const edit = rootBoundarySourceDeletionEdit(
      view.state,
      direction,
      ctx.get(parserCtx),
      serializer
    );
    if (!edit) return false;
    dispatchExactEdit(
      view,
      edit.transaction,
      edit.beforeSelection,
      edit.deletionSelection,
      null,
      { isolatedHistory: true }
    );
    return true;
  };

  const runBoundaryHistory = (command) => {
    const view = editorView;
    if (!view) return false;
    const serializer = ctx.get(serializerCtx);
    const currentSource = serializeMarkdownDocument(view.state.doc, serializer);
    const step = exactSourceHistoryStep(boundaryEditHistory, command, currentSource);
    if (!step?.sourceSelection || typeof step.source !== "string") return false;
    const parsed = normalizeEmptyMarkdownDocument(
      ctx.get(parserCtx)(step.source),
      step.source
    );
    if (!parsed) return false;
    let transaction = view.state.tr.replace(
      0,
      view.state.doc.content.size,
      new Slice(parsed.content, 0, 0)
    );
    for (const [name, value] of Object.entries(parsed.attrs || {})) {
      transaction = transaction.setDocAttribute(name, value);
    }
    const sourceSelection = {
      ...step.sourceSelection,
      fullSource: step.source
    };
    transaction = transaction
      .setSelection(documentSourceSelectionCarrier(
        { doc: transaction.doc, selection: transaction.selection },
        sourceSelection,
        serializer
      ))
      .setMeta("addToHistory", false)
      .setMeta(markdownSyntaxKey, { action: "source-selection", sourceSelection });
    protectedExactSource = step.source;
    exactSourceDispatchDepth += 1;
    try {
      dispatchFocusedSourceSelection(view, transaction.scrollIntoView());
    } finally {
      exactSourceDispatchDepth -= 1;
    }
    step.entry.state = command === "undo" ? "undone" : "applied";
    publishMarkdownSourceDraft(view, step.source);
    return true;
  };

  const runSourceControlHistory = (command) => {
    const view = editorView;
    const historyCommand = command === "undo"
      ? undoProseMirror
      : command === "redo" ? redoProseMirror : null;
    if (!view || !historyCommand?.(view.state, view.dispatch)) return false;
    protectedExactSource = serializeMarkdownDocument(view.state.doc, ctx.get(serializerCtx));
    return true;
  };

  const restoreExactSelectionAfterHistory = (view) => {
    if (!exactEditHistory.length) return;
    const serializer = ctx.get(serializerCtx);
    const beforeHistorySource = serializeMarkdownDocument(view.state.doc, serializer);
    if (exactHistoryFrame) cancelAnimationFrame(exactHistoryFrame);
    exactHistoryFrame = requestAnimationFrame(() => {
      exactHistoryFrame = 0;
      if (!view.dom.isConnected) return;
      const afterHistorySource = serializeMarkdownDocument(view.state.doc, serializer);
      const sourceSelection = exactSourceSelectionAfterHistory(
        exactEditHistory,
        beforeHistorySource,
        afterHistorySource
      );
      if (!sourceSelection) return;
      view.dispatch(
        view.state.tr.setMeta(markdownSyntaxKey, {
          action: "source-selection",
          sourceSelection
        })
      );
      view.focus();
    });
  };

  const replaceExactTextInput = (view, event) => {
    if (isSourceInputComposing(event)) return false;
    if (!["insertText", "insertReplacementText"].includes(event.inputType)) return false;
    if (typeof event.data !== "string") return false;
    const sourceSelection = markdownSyntaxKey.getState(view.state)?.sourceSelection;
    const documentSelection = sourceSelection
      ? null
      : sourceSelectionFromDocumentSelection(view.state, ctx.get(serializerCtx));
    const plainSelection = sourceSelection || documentSelection
      ? null
      : plainTextMarkdownSourceSelection(view.state, ctx.get(serializerCtx));
    const exactSelection = sourceSelection || documentSelection || plainSelection;
    if (!exactSelection) return false;
    const transaction = replaceSourceSelectionTransaction(
      view.state,
      exactSelection,
      event.data,
      ctx.get(parserCtx)
    );
    if (!transaction) return false;
    event.preventDefault();
    dispatchExactEdit(view, transaction, exactSelection, exactSelection);
    return true;
  };

  return new Plugin({
    key: markdownSyntaxKey,
    filterTransaction(transaction, state) {
      const serializer = ctx.get(serializerCtx);
      const meta = transaction.getMeta(markdownSyntaxKey);
      const decision = exactSourceProtectionDecision(
        transaction,
        state,
        protectedExactSource,
        serializer,
        meta?.action === "activate" || meta?.action === "source-selection"
      );
      protectedExactSource = decision.protectedSource;
      return !decision.reject;
    },
    state: {
      // Milkdown starts with a selection in the first block. Source mode only
      // becomes active after an actual pointer/keyboard interaction.
      init: inactivePluginState,
      apply(transaction, pluginState) {
        const meta = transaction.getMeta(markdownSyntaxKey);
        if (meta === "close") {
          pendingActivation = false;
          return inactivePluginState();
        }
        if (meta?.action === "smart-input") {
          pendingActivation = false;
          return inactivePluginState();
        }
        if (meta?.action === "exact-source-edit") {
          pendingActivation = false;
          return inactivePluginState();
        }
        if (meta?.action === "source-selection") {
          // This transaction already specifies the exact physical source
          // selection. A pending activation from the arrow that entered the
          // temporary control must not replace it with the browser's stale DOM
          // caret when focus returns to ProseMirror.
          pendingActivation = false;
          return {
            ...inactivePluginState(),
            sourceSelection: meta.sourceSelection
          };
        }
        if (meta?.action === "activate") {
          pendingActivation = false;
          return {
            active: true,
            atomPosition: meta.atomPosition ?? null,
            literalSourceUnit: meta.literalSourceUnit ?? null,
            explicitUnitPosition: meta.explicitUnitPosition ?? null,
            clickPosition: meta.clickPosition ?? transaction.selection.from,
            sourceOffset: meta.sourceOffset ?? null,
            initialDeleteDirection: meta.initialDeleteDirection ?? null,
            initialSelectionDirection: meta.initialSelectionDirection ?? null,
            initialSourceSelection: meta.initialSourceSelection ?? null,
            initialPointerSelection: meta.initialPointerSelection ?? 0,
            focusLock: Boolean(meta.focusLock),
            sourceSelection: null
          };
        }
        if (transaction.selectionSet && pendingActivation) {
          const activationKey = pendingActivation;
          pendingActivation = false;
          // This native arrow moved onto a rendered caret boundary beside
          // hidden Markdown. The boundary itself is a physical source offset;
          // keep it rendered and let the next arrow consume the delimiter.
          // Activating here skips that offset (and, for links, their full URL).
          if (landedOnRenderedSourceBoundary({
            doc: transaction.doc,
            selection: transaction.selection
          }, activationKey)) return inactivePluginState();
          return {
            active: true,
            atomPosition: null,
            literalSourceUnit: null,
            explicitUnitPosition: null,
            clickPosition: transaction.selection.from,
            sourceOffset: null,
            initialDeleteDirection: null,
            initialSelectionDirection: null,
            initialSourceSelection: null,
            initialPointerSelection: 0,
            focusLock: false,
            sourceSelection: null
          };
        }
        if (transaction.selectionSet && pluginState.active && pluginState.focusLock) {
          return { ...pluginState, focusLock: false };
        }
        if (transaction.selectionSet && pluginState.active) {
          return {
            active: true,
            atomPosition: null,
            literalSourceUnit: null,
            explicitUnitPosition: null,
            clickPosition: transaction.selection.from,
            sourceOffset: null,
            initialDeleteDirection: null,
            initialSelectionDirection: null,
            initialSourceSelection: null,
            initialPointerSelection: 0,
            focusLock: false,
            sourceSelection: null
          };
        }
        // Exact Markdown offsets remain authoritative while focus and DOM
        // selection reconcile. Real pointer interaction clears them explicitly
        // below; treating every ProseMirror selection update as user intent can
        // turn a gap caret into a code-block NodeSelection.
        if (transaction.selectionSet && pluginState.sourceSelection) return pluginState;
        return pluginState;
      }
    },
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      if (exactSourceDispatchDepth > 0) return null;
      if (transactions.some((transaction) => ["smart-input", "exact-source-edit"].includes(
        transaction.getMeta(markdownSyntaxKey)?.action
      ))) return null;
      const mathRevert = revertInvalidInlineMath(newState);
      if (mathRevert) return mathRevert;
      return smartInlineInputTransaction(newState, ctx.get(parserCtx));
    },
    view(view) {
      editorView = view;
      const protectCurrentSource = () => {
        const currentView = editorView || view;
        const serializer = ctx.get(serializerCtx);
        protectedExactSource = serializeMarkdownDocument(currentView.state.doc, serializer);
      };
      const replaceExactSourceSelection = (sourceSelection, replacement) => {
        const currentView = editorView || view;
        if (
          !currentView.editable
          || !sourceSelection
          || typeof replacement !== "string"
        ) return false;
        const transaction = replaceSourceSelectionTransaction(
          currentView.state,
          sourceSelection,
          replacement,
          ctx.get(parserCtx)
        );
        if (!transaction) return false;
        dispatchExactEdit(
          currentView,
          transaction,
          sourceSelection,
          sourceSelection,
          null,
          { isolatedHistory: true }
        );
        return true;
      };
      view.dom.tetherProtectCurrentSource = protectCurrentSource;
      view.dom.tetherRunBoundaryHistory = runBoundaryHistory;
      view.dom.tetherRunSourceControlHistory = runSourceControlHistory;
      view.dom.tetherReplaceExactSourceSelection = replaceExactSourceSelection;
      const getActiveSourceSelection = () => activeDocumentSourceSelection(
        (editorView || view).state
      );
      view.dom.tetherGetActiveSourceSelection = getActiveSourceSelection;
      const captureExactClipboard = (event) => {
        if (!event.clipboardData || !["copy", "cut"].includes(event.type)) return;
        const currentView = editorView || view;
        const sourceSelection = markdownSyntaxKey.getState(currentView.state)?.sourceSelection;
        const selectedText = sourceSelectionText(sourceSelection);
        if (!sourceSelection || selectedText == null || selectedText === "") return;
        const edit = event.type === "cut" && currentView.editable
          ? sourceClipboardEdit(
              currentView.state,
              "",
              ctx.get(parserCtx),
              ctx.get(serializerCtx),
              sourceSelection
            )
          : null;
        if (event.type === "cut" && !edit) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", selectedText);
        if (["\n", "\r\n"].includes(selectedText)) {
          event.clipboardData.setData("text/html", "<br>");
        }
        capturedExactClipboardEvents.add(event);
        if (edit) {
          queueMicrotask(() => {
            dispatchExactEdit(
              currentView,
              edit.transaction,
              edit.sourceSelection,
              edit.sourceSelection
            );
          });
        }
      };
      const captureExactDeletion = (event) => {
        const lineDirection = sourceLineDeleteDirection(event);
        const wordDirection = lineDirection ? null : sourceWordDeleteDirection(event);
        const plainDeletion = !event.altKey
          && !event.ctrlKey
          && !event.metaKey
          && !event.shiftKey
          && ["Backspace", "Delete"].includes(event.key);
        if (!lineDirection && !wordDirection && !plainDeletion) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button, input, select, textarea, .cm-content, .tether-continuous-source")) {
          return;
        }
        const direction = lineDirection || wordDirection
          || (event.key === "Backspace" ? "backward" : "forward");
        const mode = lineDirection ? "line" : wordDirection ? "word" : "character";
        if (!deleteExactSource(view, direction, mode)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const captureSourceHandoff = (event) => {
        if (!view.editable) return;
        protectedExactSource = null;
        const targetElement = event.target instanceof Element ? event.target : null;
        if (targetElement?.closest(".tether-continuous-source")) return;
        const sourceToFinish = activeSourceControl?.element?.isConnected ? activeSourceControl : null;
        if (!sourceToFinish) return;

        const target = markdownSourceTargetFromPointer(view, event);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        pendingActivation = false;
        sourceToFinish.finish(true, (mapping) => {
          if (editorView) activateCapturedTarget(editorView, target, mapping);
        });
      };
      view.dom.addEventListener("keydown", captureExactDeletion, true);
      view.dom.addEventListener("copy", captureExactClipboard, true);
      view.dom.addEventListener("cut", captureExactClipboard, true);
      view.dom.addEventListener("mousedown", captureSourceHandoff, true);
      return {
        update(nextView) {
          editorView = nextView;
        },
        destroy() {
          view.dom.removeEventListener("keydown", captureExactDeletion, true);
          view.dom.removeEventListener("copy", captureExactClipboard, true);
          view.dom.removeEventListener("cut", captureExactClipboard, true);
          view.dom.removeEventListener("mousedown", captureSourceHandoff, true);
          if (view.dom.tetherProtectCurrentSource === protectCurrentSource) {
            delete view.dom.tetherProtectCurrentSource;
          }
          if (view.dom.tetherRunBoundaryHistory === runBoundaryHistory) {
            delete view.dom.tetherRunBoundaryHistory;
          }
          if (view.dom.tetherRunSourceControlHistory === runSourceControlHistory) {
            delete view.dom.tetherRunSourceControlHistory;
          }
          if (view.dom.tetherReplaceExactSourceSelection === replaceExactSourceSelection) {
            delete view.dom.tetherReplaceExactSourceSelection;
          }
          if (view.dom.tetherGetActiveSourceSelection === getActiveSourceSelection) {
            delete view.dom.tetherGetActiveSourceSelection;
          }
          editorView = null;
        }
      };
    },
    props: {
      handleTextInput(view, _from, _to, text) {
        const sourceSelection = markdownSyntaxKey.getState(view.state)?.sourceSelection;
        const documentSelection = sourceSelection
          ? null
          : sourceSelectionFromDocumentSelection(view.state, ctx.get(serializerCtx));
        const plainSelection = sourceSelection || documentSelection
          ? null
          : plainTextMarkdownSourceSelection(
              view.state,
              ctx.get(serializerCtx),
              TextSelection.create(view.state.doc, _from, _to)
            );
        const exactSelection = sourceSelection || documentSelection || plainSelection;
        const transaction = exactSelection
          ? replaceSourceSelectionTransaction(
              view.state,
              exactSelection,
              text,
              ctx.get(parserCtx)
            )
          : replaceSourceNewlineSelectionTransaction(
              view.state,
              text,
              ctx.get(parserCtx),
              ctx.get(serializerCtx)
            );
        if (!transaction) return false;
        dispatchExactEdit(view, transaction, exactSelection, exactSelection);
        return true;
      },
      handleDOMEvents: {
        paste(view, event) {
          const sourceSelection = markdownSyntaxKey.getState(view.state)?.sourceSelection
            || collapsedDocumentSourceSelection(view.state, ctx.get(serializerCtx))
            || plainTextMarkdownSourceSelection(view.state, ctx.get(serializerCtx));
          const text = event.clipboardData?.getData("text/plain");
          if (text == null) return false;
          const edit = sourceClipboardEdit(
            view.state,
            text,
            ctx.get(parserCtx),
            ctx.get(serializerCtx),
            sourceSelection
          );
          if (!edit) return false;
          event.preventDefault();
          dispatchExactEdit(
            view,
            edit.transaction,
            edit.sourceSelection,
            edit.sourceSelection,
            null,
            { isolatedHistory: true }
          );
          return true;
        },
        beforeinput(view, event) {
          if (["historyUndo", "historyRedo"].includes(event.inputType)) {
            restoreExactSelectionAfterHistory(view);
            return false;
          }
          return replaceExactTextInput(view, event);
        },
        copy(view, event) {
          if (capturedExactClipboardEvents.has(event)) return true;
          const sourceSelection = markdownSyntaxKey.getState(view.state)?.sourceSelection;
          const plainSelection = sourceSelection
            ? null
            : plainTextMarkdownSourceSelection(view.state, ctx.get(serializerCtx));
          const text = sourceSelectionText(sourceSelection || plainSelection)
            ?? sourceNewlineClipboardText(view.state)
            ?? sourceAwareClipboardText(view.state, ctx.get(serializerCtx));
          if (text == null || text === "" || !event.clipboardData) return false;
          event.preventDefault();
          event.clipboardData.setData("text/plain", text);
          if (["\n", "\r\n"].includes(text)) event.clipboardData.setData("text/html", "<br>");
          return true;
        },
        cut(view, event) {
          if (capturedExactClipboardEvents.has(event)) return true;
          if (!view.editable || !event.clipboardData) return false;
          const sourceSelection = markdownSyntaxKey.getState(view.state)?.sourceSelection
            || plainTextMarkdownSourceSelection(view.state, ctx.get(serializerCtx));
          const edit = sourceClipboardEdit(
            view.state,
            "",
            ctx.get(parserCtx),
            ctx.get(serializerCtx),
            sourceSelection
          );
          if (!edit) return false;
          event.preventDefault();
          event.clipboardData.setData("text/plain", edit.selectedText);
          if (["\n", "\r\n"].includes(edit.selectedText)) {
            event.clipboardData.setData("text/html", "<br>");
          }
          dispatchExactEdit(
            view,
            edit.transaction,
            edit.sourceSelection,
            edit.sourceSelection
          );
          return true;
        },
        mousedown(view, event) {
          if (!view.editable) return false;
          protectedExactSource = null;
          if (event.target instanceof Element && event.target.closest(".tether-continuous-source")) return false;
          if (markdownSyntaxKey.getState(view.state)?.sourceSelection) {
            pendingActivation = false;
            view.dispatch(view.state.tr.setMeta(markdownSyntaxKey, "close"));
          }
          const sourceToFinish = activeSourceControl?.element?.isConnected ? activeSourceControl : null;
          const target = markdownSourceTargetFromPointer(view, event);
          if (!target) return false;
          const activateCapturedPosition = (mapping = null) => {
            if (!editorView) return;
            pendingActivation = false;
            activateCapturedTarget(editorView, target, mapping);
          };
          if (sourceToFinish) {
            event.preventDefault();
            sourceToFinish.finish(true, activateCapturedPosition);
            return true;
          }
          activateCapturedPosition();
          if (target.atomPosition != null) event.preventDefault();
          return target.atomPosition != null;
        },
        keydown(_view, event) {
          if (!_view.editable) return false;
          if (isSourceInputComposing(event)) return false;
          if (["Backspace", "Delete"].includes(event.key)) protectedExactSource = null;
          if (isEditorHistoryShortcut(event)) {
            protectedExactSource = null;
            const command = codeOuterHistoryDirection(event);
            if (runBoundaryHistory(command)) {
              event.preventDefault();
              return true;
            }
            restoreExactSelectionAfterHistory(_view);
            return false;
          }
          const pluginState = markdownSyntaxKey.getState(_view.state);
          const sourceSelection = pluginState?.sourceSelection;
          if (
            !activeSourceControl?.element?.isConnected
            && sourceDocumentJumpEdge(event)
            && applyDocumentSourceJump(_view, event, ctx.get(serializerCtx))
          ) {
            event.preventDefault();
            return true;
          }
          const serializer = ctx.get(serializerCtx);
          const sourceTabShortcut = event.key === "Tab"
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey;
          // CodeMirror Select All already installs an exact source selection.
          // Rendered Cmd+A leaves ProseMirror's AllSelection instead, so map it
          // to the same physical range before applying source-native Tab.
          const tabSourceSelection = sourceTabShortcut
            ? sourceSelection || (
                _view.state.selection instanceof AllSelection
                  ? sourceSelectionFromDocumentSelection(_view.state, serializer)
                  : null
              )
            : null;
          if (tabSourceSelection) {
            const next = sourceSelectionTabEdit(tabSourceSelection, Boolean(event.shiftKey));
            event.preventDefault();
            if (next.fullSource === tabSourceSelection.fullSource) return true;
            const fullSelection = {
              ...tabSourceSelection,
              anchor: 0,
              head: tabSourceSelection.fullSource.length
            };
            const transaction = replaceSourceSelectionTransaction(
              _view.state,
              fullSelection,
              next.fullSource,
              ctx.get(parserCtx)
            );
            if (!transaction) return true;
            dispatchExactEdit(
              _view,
              transaction,
              tabSourceSelection,
              fullSelection,
              next
            );
            return true;
          }
          const exactWordDirection = sourceSelection
            && event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowLeft", "ArrowRight"].includes(event.key)
            ? event.key === "ArrowLeft" ? "backward" : "forward"
            : null;
          if (exactWordDirection) {
            const next = sourceSelectionWordJump(
              sourceSelection,
              exactWordDirection,
              Boolean(event.shiftKey)
            );
            event.preventDefault();
            if (
              next.anchor === next.head
              && activateDocumentSourceOffset(
                _view,
                next,
                next.head,
                exactWordDirection,
                serializer
              )
            ) return true;
            _view.dispatch(
              _view.state.tr.setMeta(markdownSyntaxKey, {
                action: "source-selection",
                sourceSelection: next
              })
            );
            focusProseMirrorRoot(_view);
            return true;
          }
          const wordJump = sourceWordJumpTarget(_view.state, event, serializer);
          if (wordJump && !activeSourceControl?.element?.isConnected) {
            event.preventDefault();
            activateMarkdownSourceAt(_view, wordJump.position, {
              atomPosition: wordJump.atomPosition,
              explicitUnitPosition: wordJump.explicitUnitPosition,
              sourceOffset: wordJump.targetOffset,
              initialSourceSelection: event.shiftKey
                ? sourceWordSelectionRange(wordJump.currentOffset, wordJump.targetOffset)
                : null
            });
            return true;
          }
          const lineJumpEdge = sourceLineJumpEdge(event);
          if (sourceSelection && lineJumpEdge) {
            const next = sourceSelectionLineJump(
              sourceSelection,
              lineJumpEdge,
              Boolean(event.shiftKey)
            );
            const direction = lineJumpEdge === "start" ? "backward" : "forward";
            event.preventDefault();
            if (
              next.anchor === next.head
              && activateDocumentSourceOffset(
                _view,
                next,
                next.head,
                direction,
                serializer
              )
            ) return true;
            _view.dispatch(
              _view.state.tr.setMeta(markdownSyntaxKey, {
                action: "source-selection",
                sourceSelection: next
              })
            );
            focusProseMirrorRoot(_view);
            return true;
          }
          if (
            lineJumpEdge
            && _view.state.selection.empty
            && !activeSourceControl?.element?.isConnected
            && _view.endOfTextblock(lineJumpEdge === "start" ? "up" : "down")
          ) {
            const target = sourceLineJumpTarget(
              _view.state,
              lineJumpEdge,
              ctx.get(serializerCtx)
            );
            if (target) {
              event.preventDefault();
              activateMarkdownSourceAt(_view, _view.state.selection.from, {
                explicitUnitPosition: target.unit.from,
                sourceOffset: event.shiftKey ? target.caretOffset : target.boundaryOffset,
                initialSelectionDirection: event.shiftKey
                  ? lineJumpEdge === "start" ? "line-start" : "line-end"
                  : null
              });
              return true;
            }
          }
          if (
            sourceSelection
            && !event.shiftKey
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
          ) {
            const motion = event.key === "ArrowLeft"
              ? "backward"
              : event.key === "ArrowRight"
                ? "forward"
                : event.key === "ArrowUp"
                  ? "up"
                  : "down";
            const direction = ["backward", "up"].includes(motion) ? "backward" : "forward";
            const offset = sourceSelection.anchor === sourceSelection.head
              ? moveSourceSelectionHead(sourceSelection, motion).head
              : direction === "backward"
                ? Math.min(sourceSelection.anchor, sourceSelection.head)
                : Math.max(sourceSelection.anchor, sourceSelection.head);
            event.preventDefault();
            activateDocumentSourceOffset(
              _view,
              sourceSelection,
              offset,
              direction,
              ctx.get(serializerCtx)
            );
            return true;
          }
          if (
            sourceSelection
            && event.shiftKey
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
          ) {
            const motion = event.key === "ArrowLeft"
              ? "backward"
              : event.key === "ArrowRight"
                ? "forward"
                : event.key === "ArrowUp"
                  ? "up"
                  : "down";
            const direction = ["backward", "up"].includes(motion) ? "backward" : "forward";
            const next = moveSourceSelectionHead(sourceSelection, motion);
            event.preventDefault();
            if (next.head === next.anchor) {
              activateDocumentSourceOffset(
                _view,
                next,
                next.head,
                direction,
                ctx.get(serializerCtx)
              );
              return true;
            }
            _view.dispatch(
              _view.state.tr.setMeta(markdownSyntaxKey, {
                action: "source-selection",
                sourceSelection: next
              })
            );
            return true;
          }
          const documentSelection = sourceSelection || _view.state.selection.empty
            ? null
            : sourceSelectionFromDocumentSelection(
                _view.state,
                ctx.get(serializerCtx)
              );
          const plainSelection = sourceSelection || documentSelection
            ? null
            : plainTextMarkdownSourceSelection(_view.state, ctx.get(serializerCtx));
          const exactSelection = sourceSelection || documentSelection || plainSelection;
          if (
            (exactSelection || sourceNewlineSelectionInfo(_view.state))
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && !event.shiftKey
            && event.key === "Enter"
          ) {
            const replacement = sourceLineEndingAt(
              exactSelection?.fullSource || serializeMarkdownDocument(_view.state.doc, serializer),
              exactSelection
                ? Math.min(exactSelection.anchor, exactSelection.head)
                : 0
            );
            const transaction = exactSelection
              ? replaceSourceSelectionTransaction(
                  _view.state,
                  exactSelection,
                  replacement,
                  ctx.get(parserCtx)
                )
              : replaceSourceNewlineSelectionTransaction(
                  _view.state,
                  replacement,
                  ctx.get(parserCtx),
                  ctx.get(serializerCtx)
                );
            if (transaction) {
              event.preventDefault();
              dispatchExactEdit(
                _view,
                transaction,
                exactSelection,
                exactSelection
              );
              return true;
            }
          }
          if (
            !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowLeft", "ArrowRight"].includes(event.key)
            && !activeSourceControl?.element?.isConnected
          ) {
            const direction = event.key === "ArrowLeft" ? "backward" : "forward";
            const literalTarget = plainTextMarkdownSourceToken(
              _view.state,
              direction,
              ctx.get(serializerCtx)
            );
            if (literalTarget) {
              event.preventDefault();
              activateMarkdownSourceAt(_view, _view.state.selection.from, {
                literalSourceUnit: literalTarget.unit,
                sourceOffset: event.shiftKey
                  ? literalTarget.boundaryOffset
                  : literalTarget.sourceOffset,
                initialSelectionDirection: event.shiftKey ? direction : null
              });
              return true;
            }
            const target = structuralBoundarySourceTarget(_view.state, event.key);
            if (target) {
              const serializer = ctx.get(serializerCtx);
              const source = continuousMarkdownSource(_view.state, target.unit, serializer);
              const caret = sourceCaretOffset(
                _view.state,
                target.unit,
                source,
                target.position,
                null,
                serializer
              );
              const sourceOffset = event.shiftKey
                ? caret
                : Math.max(
                    0,
                    Math.min(source.length, caret + (target.direction === "backward" ? -1 : 1))
                  );
              event.preventDefault();
              activateMarkdownSourceAt(_view, target.position, {
                explicitUnitPosition: target.unit.kind === "block" ? target.unit.from : null,
                sourceOffset,
                initialSelectionDirection: event.shiftKey ? target.direction : null
              });
              return true;
            }
          }
          if (
            !event.shiftKey
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowLeft", "ArrowRight"].includes(event.key)
            && !activeSourceControl?.element?.isConnected
          ) {
            // Moving from rendered prose into a formatted/atomic unit must
            // consume one hidden source character, exactly like Source mode.
            const direction = event.key === "ArrowLeft" ? "backward" : "forward";
            const target = markdownBoundarySourceTarget(_view.state, direction);
            const unit = target ? markdownDeletionSourceUnit(_view.state, target) : null;
            if (target && unit) {
              const source = continuousMarkdownSource(_view.state, unit, ctx.get(serializerCtx));
              const boundary = target.edge === "end" ? source.length : 0;
              const sourceOffset = sourceOffsetAfterCharacter(source, boundary, direction);
              if (sourceOffset !== boundary) {
                event.preventDefault();
                activateMarkdownSourceAt(_view, target.position, {
                  atomPosition: target.atomPosition,
                  explicitUnitPosition: target.explicitUnitPosition,
                  sourceOffset
                });
                return true;
              }
            }
          }
          if (
            event.shiftKey
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowLeft", "ArrowRight"].includes(event.key)
            && !activeSourceControl?.element?.isConnected
          ) {
            const direction = event.key === "ArrowLeft" ? "backward" : "forward";
            const target = markdownBoundarySourceTarget(_view.state, direction);
            if (target) {
              const unit = markdownDeletionSourceUnit(_view.state, target);
              if (!unit) return false;
              const serializer = ctx.get(serializerCtx);
              const source = continuousMarkdownSource(_view.state, unit, serializer);
              event.preventDefault();
              activateMarkdownSourceAt(_view, target.position, {
                atomPosition: target.atomPosition,
                explicitUnitPosition: target.explicitUnitPosition,
                sourceOffset: target.edge === "end" ? source.length : 0,
                initialSelectionDirection: direction
              });
              return true;
            }
          }
          if (
            !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowLeft", "ArrowRight"].includes(event.key)
            && !activeSourceControl?.element?.isConnected
          ) {
            const direction = event.key === "ArrowLeft" ? "backward" : "forward";
            const sourceSelection = rootBoundarySourceSelection(
              _view.state,
              direction,
              ctx.get(serializerCtx),
              event.shiftKey
            );
            if (sourceSelection) {
              event.preventDefault();
              _view.dispatch(
                _view.state.tr.setMeta(markdownSyntaxKey, {
                  action: "source-selection",
                  sourceSelection
                })
              );
              _view.focus();
              return true;
            }
          }
          if (
            event.key === "Backspace"
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && !event.shiftKey
            && !activeSourceControl?.element?.isConnected
          ) {
            const transaction = hardbreakBoundaryBackspaceTransaction(_view.state);
            if (transaction) {
              event.preventDefault();
              _view.dispatch(transaction.scrollIntoView());
              return true;
            }
          }
          if (
            !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && !event.shiftKey
            && ["Backspace", "Delete"].includes(event.key)
            && !activeSourceControl?.element?.isConnected
          ) {
            const direction = event.key === "Backspace" ? "backward" : "forward";
            if (direction === "forward") {
              const transaction = softbreakMarkerBoundaryDeleteTransaction(_view.state);
              if (transaction) {
                event.preventDefault();
                _view.dispatch(transaction.scrollIntoView());
                return true;
              }
            }
            const literalTarget = plainTextMarkdownSourceToken(
              _view.state,
              direction,
              ctx.get(serializerCtx)
            );
            if (literalTarget) {
              const serializer = ctx.get(serializerCtx);
              event.preventDefault();
              activateMarkdownSourceDeletionAt(
                _view,
                _view.state.selection.from,
                {
                  literalSourceUnit: literalTarget.unit,
                  sourceOffset: literalTarget.boundaryOffset,
                  initialDeleteDirection: direction
                },
                literalTarget.unit,
                literalTarget.unit.source,
                ctx.get(parserCtx),
                serializer
              );
              return true;
            }
            const target = markdownDeletionTarget(_view.state, direction);
            if (target) {
              const unit = markdownDeletionSourceUnit(_view.state, target);
              if (!unit) return false;
              const serializer = ctx.get(serializerCtx);
              const source = continuousMarkdownSource(_view.state, unit, serializer);
              event.preventDefault();
              activateMarkdownSourceDeletionAt(
                _view,
                target.position,
                {
                  atomPosition: target.atomPosition,
                  explicitUnitPosition: target.explicitUnitPosition,
                  sourceOffset: target.edge === "end" ? source.length : 0,
                  initialDeleteDirection: direction
                },
                unit,
                source,
                ctx.get(parserCtx),
                serializer
              );
              return true;
            }
          }
          if (
            event.shiftKey
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowUp", "ArrowDown"].includes(event.key)
            && _view.state.selection.empty
            && !activeSourceControl?.element?.isConnected
          ) {
            const direction = event.key === "ArrowUp" ? "up" : "down";
            const target = atVerticalTextblockEdge(_view, direction)
              ? adjacentCodeBlockFromSelection(_view.state, direction)
              : null;
            if (target) {
              event.preventDefault();
              selectIntoAdjacentCodeBlock(
                _view,
                target,
                direction,
                ctx.get(serializerCtx)
              );
              return true;
            }
          }
          if (
            !event.shiftKey
            && !event.altKey
            && !event.ctrlKey
            && !event.metaKey
            && ["ArrowUp", "ArrowDown"].includes(event.key)
            && _view.state.selection.empty
            && !activeSourceControl?.element?.isConnected
          ) {
            const direction = event.key === "ArrowUp" ? "up" : "down";
            const target = atVerticalTextblockEdge(_view, direction)
              ? adjacentCodeBlockFromSelection(_view.state, direction)
              : null;
            if (target && focusAdjacentCodeBlock(
              _view,
              target,
              direction,
              ctx.get(serializerCtx)
            )) {
              event.preventDefault();
              return true;
            }
          }
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            pendingActivation = event.key;
          }
          return false;
        }
      },
      decorations(state) {
        const pluginState = markdownSyntaxKey.getState(state);
        const newlineDecorations = sourceNewlineDecorations(
          state,
          pluginState?.sourceSelection
        );
        if (!pluginState?.active) {
          return newlineDecorations.length
            ? DecorationSet.create(state.doc, newlineDecorations)
            : DecorationSet.empty;
        }

        // The smallest active unit wins: inline formatting, then a selected atom,
        // then a complete structural block such as a heading, list, or quote.
        const explicitUnit = pluginState.explicitUnitPosition == null
          ? null
          : markdownTableSyntaxAt(state, pluginState.explicitUnitPosition)
            || blockSyntaxAtPosition(state, pluginState.explicitUnitPosition, explicitSourceBlockNames);
        const unit = pluginState.literalSourceUnit
          || (pluginState.atomPosition == null
          ? null
          : markdownAtomSyntaxAt(state, pluginState.atomPosition))
          || explicitUnit
          || activeMarkdownSyntax(state)
          || activeMarkdownAtomSyntax(state)
          || activeMarkdownBlockSyntax(state);
        if (!unit) {
          return newlineDecorations.length
            ? DecorationSet.create(state.doc, newlineDecorations)
            : DecorationSet.empty;
        }

        // Keep headings, lists, quotes, and fenced code in their native rendered
        // editors. A node decoration gives CSS a stable active-block hook without
        // replacing the content DOM or creating a second caret/undo context.
        if (!usesContinuousSourceEditor(unit, explicitUnit)) {
          return DecorationSet.create(state.doc, [
            ...newlineDecorations,
            Decoration.node(unit.from, unit.to, {
              class: `tether-active-markdown-block is-${unit.name}`
            })
          ]);
        }

        const serializer = ctx.get(serializerCtx);
        const source = continuousMarkdownSource(state, unit, serializer);
        const sourceName = unit.name || unit.names?.[0] || "markdown";
        const initialCaret = sourceCaretOffset(
          state,
          unit,
          source,
          pluginState.clickPosition,
          pluginState.sourceOffset,
          serializer
        );
        const commit = (value, afterCommit = null, sync = false) => {
          if (!editorView) return;
          const parser = ctx.get(parserCtx);
          if (unit.name === "hardbreak") {
            replaceHardbreakSource(editorView, parser, serializer, unit, value, afterCommit, sync);
          } else if (unit.kind === "inline") replaceInlineSource(editorView, parser, serializer, unit, value, afterCommit, sync);
          else replaceBlockSource(editorView, parser, unit, value, afterCommit, sync);
        };
        const navigateFromBoundary = (direction, mapping = null) => {
          if (!editorView?.dom.isConnected) return;
          const assoc = direction === "backward" ? -1 : 1;
          const originalPosition = direction === "backward" ? unit.from : unit.to;
          const position = Math.max(
            0,
            Math.min(mappedPosition(mapping, originalPosition, assoc), editorView.state.doc.content.size)
          );
          if (unit.kind === "inline" && unit.name !== "literal_source") {
            const handoff = structuralSourceHandoffTarget(
              editorView.state,
              position,
              direction,
              serializer,
              true
            );
            if (handoff) {
              activateMarkdownSourceAt(editorView, position, {
                explicitUnitPosition: handoff.unit.from,
                sourceOffset: handoff.sourceOffset,
                focusLock: true
              });
              return;
            }
          }
          const mappedFrom = Math.max(
            0,
            Math.min(mappedPosition(mapping, unit.from, -1), editorView.state.doc.content.size)
          );
          const mappedNode = editorView.state.doc.nodeAt(mappedFrom);
          const mappedUnit = {
            ...unit,
            from: mappedFrom,
            to: mappedNode?.type.name === unit.name
              ? mappedFrom + mappedNode.nodeSize
              : Math.max(
                  0,
                  Math.min(mappedPosition(mapping, unit.to, 1), editorView.state.doc.content.size)
                )
          };
          const boundaryGap = unit.kind === "block"
            ? documentSourceUnitBoundaryGapTarget(
                editorView.state,
                mappedUnit,
                direction,
                serializer,
                source.length
              )
            : null;
          if (boundaryGap) {
            const gapSelection = documentGapSourceSelection(
              boundaryGap,
              boundaryGap.sourceOffset
            );
            dispatchFocusedSourceSelection(
              editorView,
              editorView.state.tr
                .setSelection(markdownGapSelectionAt(
                  editorView.state.doc,
                  boundaryGap.position,
                  direction
                ))
                .setMeta(markdownSyntaxKey, {
                  action: "source-selection",
                  sourceSelection: gapSelection
                })
                .scrollIntoView()
            );
            return;
          }
          const sourceOffset = documentSourceUnitBoundaryNavigationOffset(
            editorView.state,
            mappedUnit,
            direction,
            serializer
          );
          if (
            Number.isFinite(sourceOffset)
            && activateDocumentSourceOffset(
              editorView,
              null,
              sourceOffset,
              direction === "backward" ? "backward" : "forward",
              serializer
            )
          ) return;
          editorView.dispatch(
            editorView.state.tr
              .setSelection(Selection.near(editorView.state.doc.resolve(position), assoc))
              .setMeta(markdownSyntaxKey, "close")
              .scrollIntoView()
          );
          editorView.focus();
        };
        const deleteFromBoundary = (direction, mapping = null) => {
          if (!editorView?.dom.isConnected) return;
          const assoc = direction === "backward" ? -1 : 1;
          const originalPosition = direction === "backward" ? unit.from : unit.to;
          const position = Math.max(
            0,
            Math.min(mappedPosition(mapping, originalPosition, assoc), editorView.state.doc.content.size)
          );
          if (unit.kind === "inline") {
            const handoff = structuralSourceHandoffTarget(
              editorView.state,
              position,
              direction,
              serializer
            );
            if (handoff) {
              const handoffSource = continuousMarkdownSource(
                editorView.state,
                handoff.unit,
                serializer
              );
              activateMarkdownSourceDeletionAt(
                editorView,
                position,
                {
                  explicitUnitPosition: handoff.unit.from,
                  sourceOffset: handoff.sourceOffset,
                  initialDeleteDirection: direction,
                  focusLock: true
                },
                handoff.unit,
                handoffSource,
                ctx.get(parserCtx),
                serializer
              );
              return;
            }
          }
          const newlineDeletion = sourceNewlineDeletionTransaction(
            editorView.state,
            position,
            direction,
            ctx.get(parserCtx),
            serializer
          );
          if (newlineDeletion) {
            newlineDeletion.setMeta(markdownSyntaxKey, "close");
            editorView.dispatch(newlineDeletion.scrollIntoView());
            editorView.focus();
            return;
          }
          const resolved = editorView.state.doc.resolve(position);
          const boundaryState = {
            doc: editorView.state.doc,
            selection: TextSelection.create(editorView.state.doc, position)
          };
          const adjacentTarget = markdownDeletionTarget(boundaryState, direction);
          const adjacentUnit = adjacentTarget
            ? markdownDeletionSourceUnit(editorView.state, adjacentTarget)
            : null;
          if (adjacentTarget && adjacentUnit) {
            const adjacentSource = continuousMarkdownSource(editorView.state, adjacentUnit, serializer);
            activateMarkdownSourceDeletionAt(
              editorView,
              adjacentTarget.position,
              {
                atomPosition: adjacentTarget.atomPosition,
                explicitUnitPosition: adjacentTarget.explicitUnitPosition,
                sourceOffset: adjacentTarget.edge === "end" ? adjacentSource.length : 0,
                initialDeleteDirection: direction,
                focusLock: true
              },
              adjacentUnit,
              adjacentSource,
              ctx.get(parserCtx),
              serializer
            );
            return;
          }
          let transaction = editorView.state.tr.setMeta(markdownSyntaxKey, "close");

          if (resolved.parent.isTextblock && direction === "backward" && resolved.parentOffset > 0) {
            transaction = transaction
              .delete(position - 1, position)
              .setSelection(Selection.near(transaction.doc.resolve(position - 1), -1));
            editorView.dispatch(transaction.scrollIntoView());
          } else if (
            resolved.parent.isTextblock
            && direction === "forward"
            && resolved.parentOffset < resolved.parent.content.size
          ) {
            transaction = transaction
              .delete(position, position + 1)
              .setSelection(Selection.near(transaction.doc.resolve(position), 1));
            editorView.dispatch(transaction.scrollIntoView());
          } else {
            transaction = transaction.setSelection(Selection.near(resolved, assoc));
            editorView.dispatch(transaction.scrollIntoView());
            const join = direction === "backward" ? joinBackward : joinForward;
            join(editorView.state, editorView.dispatch, editorView);
          }
          editorView.focus();
        };
        const navigateVertically = (direction, point, mapping = null) => {
          if (!editorView?.dom.isConnected) return;
          const assoc = direction === "up" ? -1 : 1;
          const fallbackPosition = mappedPosition(
            mapping,
            direction === "up" ? unit.from : unit.to,
            assoc
          );
          const geometryPosition = verticalDocumentPositionFromGeometry(editorView, point, direction);
          const hit = geometryPosition == null && point ? editorView.posAtCoords(point) : null;
          const position = Math.max(
            0,
            Math.min(geometryPosition ?? hit?.pos ?? fallbackPosition, editorView.state.doc.content.size)
          );
          editorView.dispatch(
            editorView.state.tr
              .setSelection(Selection.near(editorView.state.doc.resolve(position), assoc))
              .setMeta(markdownSyntaxKey, "close")
              .scrollIntoView()
          );
          editorView.focus();
        };
        const selectFromBoundary = (direction, localSelection, mapping = null) => {
          if (!editorView?.dom.isConnected) return;
          const sourceDirection = ["backward", "up"].includes(direction)
            ? "backward"
            : "forward";
          const assoc = sourceDirection === "backward" ? -1 : 1;
          const originalPosition = sourceDirection === "backward" ? unit.from : unit.to;
          const anchor = Math.max(
            0,
            Math.min(mappedPosition(mapping, originalPosition, assoc), editorView.state.doc.content.size)
          );
          const localSelectionIsCollapsed = localSelection?.anchor === localSelection?.head;
          if (unit.kind === "inline" && localSelectionIsCollapsed) {
            const handoff = structuralSourceHandoffTarget(
              editorView.state,
              anchor,
              direction,
              serializer
            );
            if (handoff) {
              activateMarkdownSourceAt(editorView, anchor, {
                explicitUnitPosition: handoff.unit.from,
                sourceOffset: handoff.sourceOffset,
                initialSelectionDirection: direction,
                focusLock: true
              });
              return;
            }
          }
          if (!localSelectionIsCollapsed || ["up", "down"].includes(direction)) {
            const mappedUnit = {
              ...unit,
              from: Math.max(
                0,
                Math.min(mappedPosition(mapping, unit.from, -1), editorView.state.doc.content.size)
              ),
              to: Math.max(
                0,
                Math.min(mappedPosition(mapping, unit.to, 1), editorView.state.doc.content.size)
              )
            };
            const documentSource = documentSourceSegments(editorView.state, serializer);
            const unitStart = documentSourceUnitStartOffset(
              editorView.state,
              mappedUnit,
              serializer
            );
            const exactSelection = documentSource && sourceSelectionAcrossUnitBoundary(
              documentSource.fullSource,
              unitStart,
              localSelection,
              direction
            );
            if (exactSelection) {
              // The physical source range may begin inside a custom node view
              // and end in the adjacent document block. ProseMirror cannot
              // represent that hidden half safely as a DOM TextSelection: on a
              // fenced block the browser promotes it to a selection of the
              // entire node view, including language and Copy controls. Keep a
              // direction-biased, collapsed document caret beside the unit;
              // the plugin metadata remains the authoritative source range.
              const selection = markdownGapSelectionAt(
                editorView.state.doc,
                anchor,
                sourceDirection
              );
              dispatchFocusedSourceSelection(
                editorView,
                editorView.state.tr
                  .setSelection(selection)
                  .setMeta(markdownSyntaxKey, {
                    action: "source-selection",
                    sourceSelection: {
                      ...exactSelection,
                      boundary: anchor
                    }
                  })
                  .scrollIntoView()
              );
              return;
            }
          }
          const selection = textSelectionAcrossBoundary(editorView.state, anchor, sourceDirection);
          const range = sourceNewlineSourceRange(
            { doc: editorView.state.doc, selection },
            serializer
          );
          const sourceSelection = sourceSelectionFromNewlineRange(range, sourceDirection);
          editorView.dispatch(
            editorView.state.tr
              .setSelection(selection)
              .setMeta(
                markdownSyntaxKey,
                sourceSelection
                  ? { action: "source-selection", sourceSelection }
                  : "close"
              )
              .scrollIntoView()
          );
          editorView.focus();
        };
        const jumpFromSource = (event, localSelection, mapping = null) => {
          if (!editorView?.dom.isConnected) return;
          const mappedFrom = Math.max(
            0,
            Math.min(
              mappedPosition(mapping, unit.from, -1),
              editorView.state.doc.content.size
            )
          );
          const mappedTo = Math.max(
            mappedFrom,
            Math.min(
              mappedPosition(mapping, unit.to, 1),
              editorView.state.doc.content.size
            )
          );
          const mappedUnit = { ...unit, from: mappedFrom, to: mappedTo };
          const baseOffset = documentSourceUnitStartOffset(
            editorView.state,
            mappedUnit,
            serializer
          );
          if (!Number.isFinite(baseOffset)) return;
          applyDocumentSourceJump(
            editorView,
            event,
            serializer,
            baseOffset + localSelection.head,
            baseOffset + localSelection.anchor
          );
        };
        const selectAllFromSource = () => {
          if (!editorView?.dom.isConnected) return;
          activateDocumentSourceSelection(
            editorView,
            new AllSelection(editorView.state.doc),
            serializer
          );
        };
        const lineJumpFromSource = (
          edge,
          localSelection,
          extend,
          mapping = null
        ) => {
          if (!editorView?.dom.isConnected) return;
          const mappedUnit = {
            ...unit,
            from: Math.max(
              0,
              Math.min(mappedPosition(mapping, unit.from, -1), editorView.state.doc.content.size)
            ),
            to: Math.max(
              0,
              Math.min(mappedPosition(mapping, unit.to, 1), editorView.state.doc.content.size)
            )
          };
          const documentSource = documentSourceSegments(editorView.state, serializer);
          const unitStart = documentSourceUnitStartOffset(
            editorView.state,
            mappedUnit,
            serializer
          );
          const next = documentSource && sourceLineSelectionAcrossUnitBoundary(
            documentSource.fullSource,
            unitStart,
            localSelection,
            edge,
            extend
          );
          if (!next) return;
          const direction = edge === "start" ? "backward" : "forward";

          if (!extend || next.anchor === next.head) {
            const renderedPosition = documentPositionAtSourceOffset(
              editorView.state,
              next.head,
              serializer
            );
            if (renderedPosition != null) {
              editorView.dispatch(
                editorView.state.tr
                  .setSelection(TextSelection.create(editorView.state.doc, renderedPosition))
                  .setMeta(markdownSyntaxKey, "close")
                  .scrollIntoView()
              );
              focusExactEditSelection(editorView);
              return;
            }
            activateDocumentSourceOffset(
              editorView,
              next,
              next.head,
              direction,
              serializer
            );
            return;
          }

          const boundary = direction === "backward" ? mappedUnit.from : mappedUnit.to;
          editorView.dispatch(
            editorView.state.tr
              .setSelection(textSelectionAcrossBoundary(editorView.state, boundary, direction))
              .setMeta(markdownSyntaxKey, {
                action: "source-selection",
                sourceSelection: {
                  ...next,
                  boundary
                }
              })
              .scrollIntoView()
          );
          focusProseMirrorRoot(editorView);
        };
        const wordJumpFromSource = (
          direction,
          localSelection,
          extend,
          mapping = null
        ) => {
          if (!editorView?.dom.isConnected) return;
          const mappedUnit = {
            ...unit,
            from: Math.max(
              0,
              Math.min(mappedPosition(mapping, unit.from, -1), editorView.state.doc.content.size)
            ),
            to: Math.max(
              0,
              Math.min(mappedPosition(mapping, unit.to, 1), editorView.state.doc.content.size)
            )
          };
          const documentSource = documentSourceSegments(editorView.state, serializer);
          const unitStart = documentSourceUnitStartOffset(
            editorView.state,
            mappedUnit,
            serializer
          );
          const next = documentSource && sourceWordSelectionAcrossUnitBoundary(
            documentSource.fullSource,
            unitStart,
            localSelection,
            direction,
            extend
          );
          if (!next) return;

          if (!extend || next.anchor === next.head) {
            const renderedPosition = documentPositionAtSourceOffset(
              editorView.state,
              next.head,
              serializer
            );
            if (renderedPosition != null) {
              editorView.dispatch(
                editorView.state.tr
                  .setSelection(TextSelection.create(editorView.state.doc, renderedPosition))
                  .setMeta(markdownSyntaxKey, "close")
                  .scrollIntoView()
              );
              focusExactEditSelection(editorView);
              return;
            }
            activateDocumentSourceOffset(
              editorView,
              next,
              next.head,
              direction,
              serializer
            );
            return;
          }

          const boundary = direction === "backward" ? mappedUnit.from : mappedUnit.to;
          editorView.dispatch(
            editorView.state.tr
              .setSelection(textSelectionAcrossBoundary(editorView.state, boundary, direction))
              .setMeta(markdownSyntaxKey, {
                action: "source-selection",
                sourceSelection: {
                  ...next,
                  boundary
                }
              })
              .scrollIntoView()
          );
          focusProseMirrorRoot(editorView);
        };
        const dragFromSource = (localAnchor, event, mapping = null) => {
          if (!editorView?.dom.isConnected) return;
          const target = markdownSourceTargetFromPointer(editorView, event);
          if (!target) return;
          const mappedUnit = {
            ...unit,
            from: Math.max(
              0,
              Math.min(mappedPosition(mapping, unit.from, -1), editorView.state.doc.content.size)
            ),
            to: Math.max(
              0,
              Math.min(mappedPosition(mapping, unit.to, 1), editorView.state.doc.content.size)
            )
          };
          const documentSource = documentSourceSegments(editorView.state, serializer);
          const unitStart = documentSourceUnitStartOffset(
            editorView.state,
            mappedUnit,
            serializer
          );
          const documentHead = documentSourceOffsetFromPointerTarget(
            editorView.state,
            target,
            serializer
          );
          const exactSelection = documentSource && sourcePointerDragSelection(
            documentSource.fullSource,
            unitStart,
            localAnchor,
            documentHead
          );
          if (!exactSelection || exactSelection.anchor === exactSelection.head) {
            activateCapturedTarget(editorView, target, null);
            return;
          }
          const forward = exactSelection.anchor < exactSelection.head;
          const anchorPosition = documentPositionAtSourceOffset(
            editorView.state,
            exactSelection.anchor,
            serializer
          ) ?? (forward ? mappedUnit.from : mappedUnit.to);
          const headPosition = Math.max(
            0,
            Math.min(target.position, editorView.state.doc.content.size)
          );
          editorView.dispatch(
            editorView.state.tr
              .setSelection(TextSelection.create(editorView.state.doc, anchorPosition, headPosition))
              .setMeta(markdownSyntaxKey, {
                action: "source-selection",
                sourceSelection: {
                  ...exactSelection,
                  boundary: forward ? mappedUnit.to : mappedUnit.from
                }
              })
              .scrollIntoView()
          );
          focusProseMirrorRoot(editorView);
        };
        const insertLineBreakFromInlineSource = (value, sourceOffset) => {
          if (!editorView?.dom.isConnected) return;
          const edit = inlineSourceEnterEdit(
            editorView.state,
            unit,
            source,
            value,
            sourceOffset,
            ctx.get(parserCtx),
            serializer
          );
          if (!edit) return;
          dispatchExactEdit(
            editorView,
            edit.transaction,
            edit.historySelection,
            edit.editSelection,
            edit.afterSelection,
            { isolatedHistory: true }
          );
        };
        const pasteMultilineFromInlineSource = (value, sourceOffset) => {
          if (!editorView?.dom.isConnected) return;
          const edit = inlineSourceValueEdit(
            editorView.state,
            unit,
            source,
            value,
            sourceOffset,
            ctx.get(parserCtx),
            serializer
          );
          if (!edit) return;
          dispatchExactEdit(
            editorView,
            edit.transaction,
            edit.historySelection,
            edit.editSelection,
            edit.afterSelection,
            { isolatedHistory: true }
          );
        };
        const deleteModifierFromSource = (value, localSelection, direction, mode) => {
          if (!editorView?.dom.isConnected) return;
          const edit = sourceControlModifierDeletionEdit(
            editorView.state,
            unit,
            source,
            value,
            localSelection,
            direction,
            ctx.get(parserCtx),
            serializer,
            mode
          );
          if (!edit) return;
          if (!edit.changed) {
            activateDocumentSourceOffset(
              editorView,
              edit.afterSelection,
              edit.afterSelection.head,
              direction,
              serializer
            );
            return;
          }
          dispatchExactEdit(
            editorView,
            edit.transaction,
            edit.historySelection,
            edit.editSelection,
            edit.afterSelection,
            { isolatedHistory: true }
          );
        };
        const tabFromInlineSource = (value, localSelection, outdent) => {
          if (!editorView?.dom.isConnected) return;
          const edit = inlineSourceTabEdit(
            editorView.state,
            unit,
            source,
            value,
            localSelection,
            outdent,
            ctx.get(parserCtx),
            serializer
          );
          if (!edit) return;
          if (!edit.changed) {
            activateDocumentSourceOffset(
              editorView,
              edit.afterSelection,
              edit.afterSelection.head,
              "forward",
              serializer
            );
            return;
          }
          dispatchExactEdit(
            editorView,
            edit.transaction,
            edit.historySelection,
            edit.editSelection,
            edit.afterSelection,
            { isolatedHistory: true }
          );
        };
        const publishDraft = (value) => {
          if (!editorView?.dom.isConnected) return;
          const markdown = markdownSourceDraftMarkdown(
            editorView.state,
            ctx.get(parserCtx),
            serializer,
            unit,
            value
          );
          if (markdown == null) return;
          publishMarkdownSourceDraft(editorView, markdown);
        };
        const editorDecoration = Decoration.widget(unit.from, () => continuousSourceEditor(
          source,
          unit.kind,
          sourceName,
          `${unit.name || unit.names?.join(" ") || "Markdown"} source`,
          initialCaret,
          pluginState.initialDeleteDirection,
          pluginState.initialSelectionDirection,
          pluginState.initialSourceSelection,
          pluginState.initialPointerSelection,
          commit,
          () => editorView && closeSourceEditor(editorView),
          navigateFromBoundary,
          deleteFromBoundary,
          navigateVertically,
          selectFromBoundary,
          dragFromSource,
          wordJumpFromSource,
          lineJumpFromSource,
          jumpFromSource,
          selectAllFromSource,
          deleteModifierFromSource,
          insertLineBreakFromInlineSource,
          pasteMultilineFromInlineSource,
          tabFromInlineSource,
          publishDraft,
          () => true,
          (control) => {
            activeSourceControl = control;
            if (editorView) {
              if (control) liveSourceControls.set(editorView.dom, control);
              else liveSourceControls.delete(editorView.dom);
            }
          }
        ), {
          key: `tether-source:${unit.kind}:${unit.from}:${unit.to}:${sourceName}:${source}`,
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true
        });
        const hiddenDecoration = unit.kind === "inline"
          ? Decoration.inline(unit.from, unit.to, { class: "tether-source-hidden" })
          : Decoration.node(unit.from, unit.to, { class: "tether-source-hidden is-block" });

        return DecorationSet.create(state.doc, [
          ...newlineDecorations,
          editorDecoration,
          hiddenDecoration
        ]);
      }
    }
  });
});
