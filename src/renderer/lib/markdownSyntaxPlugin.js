import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, Selection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

const markdownSyntaxKey = new PluginKey("TETHER_MARKDOWN_SYNTAX");

const supportedMarks = ["inlineCode", "link", "strike_through", "strong", "emphasis"];
const sourceBlockNames = new Set(["bullet_list", "ordered_list", "blockquote", "footnote_definition"]);
const tableNames = new Set(["table", "table_row", "table_cell", "table_header"]);
const sourceAtomNames = new Set(["image", "hr", "footnote_reference", "html", "math_inline"]);
const sourceDeletionBlockNames = new Set(["code_block", "heading", ...sourceBlockNames]);

const inactivePluginState = () => ({
  active: false,
  atomPosition: null,
  clickPosition: null,
  sourceOffset: null,
  explicitUnitPosition: null,
  initialDeleteDirection: null,
  focusLock: false
});

export function activateMarkdownSourceAt(view, position, options = {}) {
  const {
    atomPosition = null,
    explicitUnitPosition = null,
    sourceOffset = null,
    initialDeleteDirection = null,
    focusLock = false
  } = options;
  const resolved = view.state.doc.resolve(Math.min(position, view.state.doc.content.size));
  view.dispatch(
    view.state.tr
      .setSelection(Selection.near(resolved))
      .setMeta(markdownSyntaxKey, {
        action: "activate",
        atomPosition,
        explicitUnitPosition,
        clickPosition: resolved.pos,
        sourceOffset,
        initialDeleteDirection,
        focusLock
      })
  );
  view.focus();
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
  return null;
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

export function activeMarkdownSyntax(state) {
  const { selection } = state;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;

  const marks = selection.$from.marks().filter((mark) => supportedMarks.includes(mark.type.name));
  if (!marks.length) return null;

  // Inline code owns its contents; Markdown inside it is literal text.
  const activeMarks = marks.some((mark) => mark.type.name === "inlineCode")
    ? marks.filter((mark) => mark.type.name === "inlineCode")
    : marks;
  const hasAllActiveMarks = (node) =>
    node.isText && activeMarks.every((mark) => node.marks.some((nodeMark) => nodeMark.eq(mark)));
  const cursorOffset = selection.$from.parentOffset;
  const runs = [];
  let current = null;

  selection.$from.parent.forEach((node, offset) => {
    if (!hasAllActiveMarks(node)) {
      if (current) runs.push(current);
      current = null;
      return;
    }

    const end = offset + node.nodeSize;
    if (!current) current = { from: offset, to: end };
    else current.to = end;
  });
  if (current) runs.push(current);

  const run = runs.find(({ from, to }) => cursorOffset >= from && cursorOffset <= to);
  if (!run) return null;

  const parentStart = selection.$from.start();
  return {
    from: parentStart + run.from,
    to: parentStart + run.to,
    kind: "inline",
    names: activeMarks.map((mark) => mark.type.name)
  };
}

export function activeMarkdownBlockSyntax(state) {
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock) return null;

  // A table remains a visual grid. Its pipe grammar is intentionally never exposed.
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

  // Pick the nearest complete Markdown block. For a list this deliberately means
  // the whole list, which allows marker, task state, numbering, and indentation to
  // be edited as one continuous multiline source value.
  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
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

export function markdownAtomSyntaxAt(state, position) {
  const node = state.doc.nodeAt(position);
  if (!node || !sourceAtomNames.has(node.type.name)) return null;

  return {
    from: position,
    to: position + node.nodeSize,
    kind: node.isInline ? "inline" : "block",
    name: node.type.name
  };
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

export function continuousMarkdownSource(state, unit, serializer) {
  if (!unit) return "";
  return unit.kind === "inline"
    ? serializeInlineRange(state, unit.from, unit.to, serializer)
    : serializeBlockNode(state.schema, state.doc.nodeAt(unit.from), serializer);
}

function serializedCaretOffset(state, unit, source, position, serializer) {
  if (unit.kind === "block" && position <= unit.from) return 0;
  let marker = "\uE000";
  while (source.includes(marker)) marker += "\uE001";

  const transaction = state.tr.insertText(marker, position, position);
  const markedState = { schema: state.schema, doc: transaction.doc };
  const markedUnit = {
    ...unit,
    to: unit.kind === "inline" ? unit.to + marker.length : unit.to
  };
  const markedSource = continuousMarkdownSource(markedState, markedUnit, serializer);
  const markerOffset = markedSource.indexOf(marker);
  return markerOffset >= 0 ? markerOffset : null;
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
  view.dispatch(transaction.scrollIntoView());
  if (sync) {
    if (afterCommit) afterCommit(mapping);
    return;
  }
  requestAnimationFrame(() => {
    if (afterCommit) afterCommit(mapping);
    else refocusView(view);
  });
}

function replaceInlineSource(view, parser, unit, source, afterCommit = null, sync = false) {
  const parsed = parser(source);
  const firstBlock = parsed?.firstChild;
  const replacement = firstBlock?.isTextblock
    ? firstBlock.content
    : source
      ? Fragment.from(view.state.schema.text(source))
      : Fragment.empty;
  let transaction = view.state.tr.replaceWith(unit.from, unit.to, replacement);
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

function continuousSourceEditor(
  source,
  kind,
  name,
  label,
  initialCaret,
  initialDeleteDirection,
  onCommit,
  onCancel,
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
  if (initialDeleteDirection === "backward" && startingCaret > 0) {
    editor.value = `${editor.value.slice(0, startingCaret - 1)}${editor.value.slice(startingCaret)}`;
    startingCaret -= 1;
  } else if (initialDeleteDirection === "forward" && startingCaret < editor.value.length) {
    editor.value = `${editor.value.slice(0, startingCaret)}${editor.value.slice(startingCaret + 1)}`;
  }

  const resize = () => {
    if (isBlock) {
      editor.style.height = "0";
      editor.style.height = `${Math.max(28, editor.scrollHeight)}px`;
    } else {
      editor.style.width = `${Math.max(3, Math.min(72, editor.value.length + 1))}ch`;
    }
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
    for (let index = 0; index <= editor.value.length; index += 1) {
      const distance = Math.abs(context.measureText(editor.value.slice(0, index)).width - textX);
      if (distance >= nearestDistance) continue;
      nearest = index;
      nearestDistance = distance;
    }
    return nearest;
  };
  let finished = false;
  let blurTimer = 0;
  const finish = (commit, afterFinish = null, sync = false) => {
    if (finished) return;
    finished = true;
    if (blurTimer) clearTimeout(blurTimer);
    const value = editor.value;
    const run = () => {
      setActiveControl(null);
      // Committing an untouched value would still rewrite the block through the
      // parser (dirtying the document and polluting undo); treat it as a cancel.
      if (commit && value !== source) onCommit(value, afterFinish, sync);
      else {
        onCancel();
        if (afterFinish) {
          if (sync) afterFinish(null);
          else requestAnimationFrame(() => afterFinish(null));
        }
      }
    };
    if (sync) run();
    else requestAnimationFrame(run);
  };
  setActiveControl({ element: editor, finish });

  editor.addEventListener("input", resize);
  editor.addEventListener("mousedown", (event) => {
    const caret = caretAtClientX(event.clientX);
    if (caret == null) return;
    requestAnimationFrame(() => {
      if (!finished && editor.isConnected) editor.setSelectionRange(caret, caret);
    });
  });
  editor.addEventListener("blur", () => {
    blurTimer = setTimeout(() => {
      blurTimer = 0;
      finish(true);
    }, 120);
  });
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    } else if (!isBlock && event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (isBlock && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish(true);
    }
  });
  resize();
  requestAnimationFrame(() => {
    if (finished || !editor.isConnected) return;
    resize();
    if (!shouldFocus()) return;
    editor.focus();
    const caret = Math.max(0, Math.min(editor.value.length, startingCaret));
    editor.setSelectionRange(caret, caret);
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

export function activateMarkdownSourceFromPointer(view, event) {
  const target = capturedTargetAtPointer(view, event);
  if (!target) return false;
  activateCapturedTarget(view, target);
  return true;
}

export function mappedPosition(mapping, position, assoc = 1) {
  return mapping ? mapping.map(position, assoc) : position;
}

const inlineWordChar = /[\p{L}\p{N}_]/u;
const completedInlinePatterns = [
  { pattern: /\*\*[^*\n]+\*\*$/ },
  { pattern: /__[^_\n]+__$/, wordBoundary: true },
  { pattern: /~~[^~\n]+~~$/ },
  { pattern: /`[^`\n]+`$/ },
  { pattern: /\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)$/, wordBoundary: true },
  { pattern: /\$(?!\s)[^$\n]*[^$\s]\$$/, noDigitAfter: true },
  { pattern: /(?<!\*)\*[^*\n]+\*$/ },
  { pattern: /(?<!_)_[^_\n]+_$/, wordBoundary: true }
];

export function completedInlineMarkdownSource(text, nextChar = "") {
  const matches = [];
  for (const { pattern, wordBoundary, noDigitAfter } of completedInlinePatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    // Delimiters glued to surrounding word characters stay literal text, so
    // snake_case identifiers and index-call shapes like arr[i](x) never
    // auto-format; a "$" closing right before a digit is a price, not math.
    const charBefore = match.index > 0 ? text[match.index - 1] : "";
    if (wordBoundary && (inlineWordChar.test(charBefore) || (nextChar && inlineWordChar.test(nextChar)))) continue;
    if (noDigitAfter && nextChar && /\d/.test(nextChar)) continue;
    matches.push(match);
  }
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
      focusLock: Boolean(mapping)
    });
  };
  requestAnimationFrame(activate);
}

export function markdownDeletionTarget(state, direction) {
  const { selection } = state;
  if (selection.node) {
    const atom = markdownAtomSyntaxAt(state, selection.from);
    const block = sourceDeletionBlockNames.has(selection.node.type.name)
      ? {
          from: selection.from,
          to: selection.to,
          kind: "block",
          name: selection.node.type.name
        }
      : null;
    const unit = atom || block;
    if (!unit) return null;
    return {
      position: unit.from,
      atomPosition: atom ? unit.from : null,
      explicitUnitPosition: block ? unit.from : null,
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
  const block = sourceDeletionBlockNames.has(adjacentNode.type.name)
    ? {
        from: position,
        to: position + adjacentNode.nodeSize,
        kind: "block",
        name: adjacentNode.type.name
      }
    : null;
  const unit = atom || block;
  if (!unit) return null;
  return {
    position: unit.from,
    atomPosition: atom ? unit.from : null,
    explicitUnitPosition: block ? unit.from : null,
    edge: direction === "backward" ? "end" : "start"
  };
}

// Live source controls per editor root, so the host component can commit an
// in-progress raw-Markdown edit synchronously before a save, mode change, or
// tab switch tears the surface down.
const liveSourceControls = new WeakMap();

export function flushActiveMarkdownSource(viewDom) {
  const control = viewDom ? liveSourceControls.get(viewDom) : null;
  if (control?.element?.isConnected) control.finish(true, null, true);
}

export const markdownSyntaxPlugin = $prose((ctx) => {
  let editorView = null;
  let pendingActivation = false;
  let activeSourceControl = null;

  return new Plugin({
    key: markdownSyntaxKey,
    state: {
      // Milkdown starts with a selection in the first block. Source mode only
      // becomes active after an actual pointer/keyboard interaction.
      init: inactivePluginState,
      apply(transaction, pluginState) {
        const meta = transaction.getMeta(markdownSyntaxKey);
        if (meta === "close") return inactivePluginState();
        if (meta?.action === "smart-input") return inactivePluginState();
        if (meta?.action === "activate") {
          return {
            active: true,
            atomPosition: meta.atomPosition ?? null,
            explicitUnitPosition: meta.explicitUnitPosition ?? null,
            clickPosition: meta.clickPosition ?? transaction.selection.from,
            sourceOffset: meta.sourceOffset ?? null,
            initialDeleteDirection: meta.initialDeleteDirection ?? null,
            focusLock: Boolean(meta.focusLock)
          };
        }
        if (transaction.selectionSet && pendingActivation) {
          pendingActivation = false;
          return {
            active: true,
            atomPosition: null,
            explicitUnitPosition: null,
            clickPosition: transaction.selection.from,
            sourceOffset: null,
            initialDeleteDirection: null,
            focusLock: false
          };
        }
        if (transaction.selectionSet && pluginState.active && pluginState.focusLock) {
          return { ...pluginState, focusLock: false };
        }
        if (transaction.selectionSet && pluginState.active) {
          return {
            active: true,
            atomPosition: null,
            explicitUnitPosition: null,
            clickPosition: transaction.selection.from,
            sourceOffset: null,
            initialDeleteDirection: null,
            focusLock: false
          };
        }
        return pluginState;
      }
    },
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      if (transactions.some((transaction) => transaction.getMeta(markdownSyntaxKey)?.action === "smart-input")) return null;
      const mathRevert = revertInvalidInlineMath(newState);
      if (mathRevert) return mathRevert;
      return smartInlineInputTransaction(newState, ctx.get(parserCtx));
    },
    view(view) {
      editorView = view;
      const captureSourceHandoff = (event) => {
        if (!view.editable) return;
        const targetElement = event.target instanceof Element ? event.target : null;
        if (targetElement?.closest(".tether-continuous-source")) return;
        const sourceToFinish = activeSourceControl?.element?.isConnected ? activeSourceControl : null;
        if (!sourceToFinish) return;

        const target = capturedTargetAtPointer(view, event);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        pendingActivation = false;
        sourceToFinish.finish(true, (mapping) => {
          if (editorView) activateCapturedTarget(editorView, target, mapping);
        });
      };
      view.dom.addEventListener("mousedown", captureSourceHandoff, true);
      return {
        update(nextView) {
          editorView = nextView;
        },
        destroy() {
          view.dom.removeEventListener("mousedown", captureSourceHandoff, true);
          editorView = null;
        }
      };
    },
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (!view.editable) return false;
          if (event.target instanceof Element && event.target.closest(".tether-continuous-source")) return false;
          const sourceToFinish = activeSourceControl?.element?.isConnected ? activeSourceControl : null;
          const target = capturedTargetAtPointer(view, event);
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
          if (["Backspace", "Delete"].includes(event.key) && !activeSourceControl?.element?.isConnected) {
            const direction = event.key === "Backspace" ? "backward" : "forward";
            const target = markdownDeletionTarget(_view.state, direction);
            if (target) {
              const unit = target.atomPosition == null
                ? blockSyntaxAtPosition(_view.state, target.explicitUnitPosition, sourceDeletionBlockNames)
                : markdownAtomSyntaxAt(_view.state, target.atomPosition);
              const serializer = ctx.get(serializerCtx);
              const source = continuousMarkdownSource(_view.state, unit, serializer);
              event.preventDefault();
              activateMarkdownSourceAt(_view, target.position, {
                atomPosition: target.atomPosition,
                explicitUnitPosition: target.explicitUnitPosition,
                sourceOffset: target.edge === "end" ? source.length : 0,
                initialDeleteDirection: direction
              });
              return true;
            }
          }
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            pendingActivation = true;
          }
          return false;
        }
      },
      decorations(state) {
        const pluginState = markdownSyntaxKey.getState(state);
        if (!pluginState?.active) return DecorationSet.empty;

        // The smallest active unit wins: inline formatting, then a selected atom,
        // then a complete structural block such as a heading, list, or quote.
        const unit = (pluginState.atomPosition == null
          ? null
          : markdownAtomSyntaxAt(state, pluginState.atomPosition))
          || (pluginState.explicitUnitPosition == null
            ? null
            : markdownTableSyntaxAt(state, pluginState.explicitUnitPosition)
              || blockSyntaxAtPosition(state, pluginState.explicitUnitPosition, sourceDeletionBlockNames))
          || activeMarkdownSyntax(state)
          || activeMarkdownAtomSyntax(state)
          || activeMarkdownBlockSyntax(state);
        if (!unit) return DecorationSet.empty;

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
          if (unit.kind === "inline") replaceInlineSource(editorView, parser, unit, value, afterCommit, sync);
          else replaceBlockSource(editorView, parser, unit, value, afterCommit, sync);
        };
        const editorDecoration = Decoration.widget(unit.from, () => continuousSourceEditor(
          source,
          unit.kind,
          sourceName,
          `${unit.name || unit.names?.join(" ") || "Markdown"} source`,
          initialCaret,
          pluginState.initialDeleteDirection,
          commit,
          () => editorView && closeSourceEditor(editorView),
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

        return DecorationSet.create(state.doc, [editorDecoration, hiddenDecoration]);
      }
    }
  });
});
