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

const inactivePluginState = () => ({
  active: false,
  atomPosition: null,
  clickPosition: null,
  sourceOffset: null
});

export function activateMarkdownSourceAt(view, position, options = {}) {
  const { atomPosition = null, sourceOffset = null } = options;
  const resolved = view.state.doc.resolve(Math.min(position, view.state.doc.content.size));
  view.dispatch(
    view.state.tr
      .setSelection(Selection.near(resolved))
      .setMeta(markdownSyntaxKey, {
        action: "activate",
        atomPosition,
        clickPosition: resolved.pos,
        sourceOffset
      })
  );
  view.focus();
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

function serializeBlockRange(state, from, serializer) {
  const node = state.doc.nodeAt(from);
  if (!node) return "";
  const doc = state.schema.nodes.doc.create(null, [node]);
  let source = serializer(doc).trimEnd();
  const isSimpleList = ["bullet_list", "ordered_list"].includes(node.type.name)
    && [...Array(node.childCount).keys()].every((index) => {
      const item = node.child(index);
      return item.childCount === 1 && item.firstChild?.type.name === "paragraph";
    });
  if (isSimpleList) {
    source = source.replace(/\n\n(?=\s*(?:[-+*]|\d+[.)])\s)/g, "\n");
    if (node.type.name === "bullet_list") source = source.replace(/^(\s*)\*\s/gm, "$1- ");
  }
  return source;
}

export function continuousMarkdownSource(state, unit, serializer) {
  if (!unit) return "";
  return unit.kind === "inline"
    ? serializeInlineRange(state, unit.from, unit.to, serializer)
    : serializeBlockRange(state, unit.from, serializer);
}

export function sourceCaretOffset(state, unit, source, clickPosition, explicitOffset = null) {
  if (Number.isFinite(explicitOffset)) {
    return Math.max(0, Math.min(source.length, explicitOffset));
  }
  if (!Number.isFinite(clickPosition)) return source.length;

  const position = Math.max(0, Math.min(clickPosition, state.doc.content.size));
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

function closeSourceEditor(view) {
  view.dispatch(view.state.tr.setMeta(markdownSyntaxKey, "close"));
  requestAnimationFrame(() => view.focus());
}

function selectionAfter(transaction, position) {
  const resolvedPosition = Math.max(0, Math.min(position, transaction.doc.content.size));
  return transaction.setSelection(Selection.near(transaction.doc.resolve(resolvedPosition), 1));
}

function replaceInlineSource(view, parser, unit, source) {
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
  view.dispatch(transaction.scrollIntoView());
  requestAnimationFrame(() => view.focus());
}

function replaceBlockSource(view, parser, unit, source) {
  const parsed = parser(source);
  const fallback = view.state.schema.nodes.paragraph.create();
  const replacement = parsed?.content?.size ? parsed.content : Fragment.from(fallback);
  let transaction = view.state.tr.replace(unit.from, unit.to, new Slice(replacement, 0, 0));
  transaction = selectionAfter(transaction, unit.from + replacement.size);
  transaction.setMeta(markdownSyntaxKey, "close");
  view.dispatch(transaction.scrollIntoView());
  requestAnimationFrame(() => view.focus());
}

function continuousSourceEditor(
  source,
  kind,
  name,
  label,
  initialCaret,
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
  const finish = (commit, afterFinish = null) => {
    if (finished) return;
    finished = true;
    const value = editor.value;
    requestAnimationFrame(() => {
      setActiveControl(null);
      if (commit) onCommit(value);
      else onCancel();
      if (afterFinish) requestAnimationFrame(afterFinish);
    });
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
  editor.addEventListener("blur", () => finish(true));
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
    const caret = Math.max(0, Math.min(editor.value.length, initialCaret));
    editor.setSelectionRange(caret, caret);
  });
  return editor;
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
        if (meta?.action === "activate") {
          return {
            active: true,
            atomPosition: meta.atomPosition ?? null,
            clickPosition: meta.clickPosition ?? transaction.selection.from,
            sourceOffset: meta.sourceOffset ?? null
          };
        }
        if (transaction.selectionSet && pendingActivation) {
          pendingActivation = false;
          return {
            active: true,
            atomPosition: null,
            clickPosition: transaction.selection.from,
            sourceOffset: null
          };
        }
        if (transaction.selectionSet && pluginState.active) {
          return {
            active: true,
            atomPosition: null,
            clickPosition: transaction.selection.from,
            sourceOffset: null
          };
        }
        return pluginState;
      }
    },
    view(view) {
      editorView = view;
      return {
        update(nextView) {
          editorView = nextView;
        },
        destroy() {
          editorView = null;
        }
      };
    },
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.target instanceof Element && event.target.closest(".tether-continuous-source")) return false;
          const sourceToFinish = activeSourceControl?.element?.isConnected ? activeSourceControl : null;
          const math = event.target instanceof Element
            ? event.target.closest('span[data-type="math_inline"]')
            : null;
          if (math) {
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
            const activateMath = () => {
              if (!editorView) return;
              const currentMath = math.isConnected
                ? math
                : document.elementFromPoint(event.clientX, event.clientY)?.closest?.('span[data-type="math_inline"]');
              if (!currentMath) return;
              let atomPosition;
              try {
                atomPosition = editorView.posAtDOM(currentMath, 0, -1);
              } catch {
                return;
              }
              activateMarkdownSourceAt(editorView, atomPosition, {
                atomPosition,
                sourceOffset: 1 + valueOffset
              });
            };
            event.preventDefault();
            if (sourceToFinish) sourceToFinish.finish(true, activateMath);
            else requestAnimationFrame(activateMath);
            return true;
          }
          const coordinates = { left: event.clientX, top: event.clientY };
          const activateAtCoordinates = () => {
            if (!editorView) return;
            const hit = editorView.posAtCoords(coordinates);
            if (!hit) return;
            pendingActivation = false;
            activateMarkdownSourceAt(editorView, hit.pos);
          };
          if (sourceToFinish) {
            event.preventDefault();
            sourceToFinish.finish(true, activateAtCoordinates);
            return true;
          }
          requestAnimationFrame(activateAtCoordinates);
          return false;
        },
        keydown(_view, event) {
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
          pluginState.sourceOffset
        );
        const commit = (value) => {
          if (!editorView) return;
          const parser = ctx.get(parserCtx);
          if (unit.kind === "inline") replaceInlineSource(editorView, parser, unit, value);
          else replaceBlockSource(editorView, parser, unit, value);
        };
        const editorDecoration = Decoration.widget(unit.from, () => continuousSourceEditor(
          source,
          unit.kind,
          sourceName,
          `${unit.name || unit.names?.join(" ") || "Markdown"} source`,
          initialCaret,
          commit,
          () => editorView && closeSourceEditor(editorView),
          () => true,
          (control) => {
            activeSourceControl = control;
          }
        ), {
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
