import { bulletListSchema, orderedListSchema } from "@milkdown/kit/preset/commonmark";
import { extendListItemSchemaForTask } from "@milkdown/kit/preset/gfm";
import { listItemBlockConfig } from "@milkdown/kit/component/list-item-block";
import { InputRule, wrappingInputRule } from "@milkdown/kit/prose/inputrules";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { $inputRule, $prose, $remark, $view } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

const semanticKeys = [
  "alt",
  "identifier",
  "label",
  "referenceType",
  "title",
  "url",
  "value"
];

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function semanticChildren(children = []) {
  const result = [];
  for (const child of children) {
    const normalized = listSemanticValue(child);
    const previous = result.at(-1);
    if (previous?.type === "text" && normalized?.type === "text") {
      previous.value += normalized.value;
    } else {
      result.push(normalized);
    }
  }
  return result;
}

function listSemanticValue(node) {
  if (!node || typeof node !== "object") return node;
  if (node.type === "break" && node.data?.isInline) return { type: "text", value: "\n" };
  const result = { type: node.type };
  for (const key of semanticKeys) {
    if (node.type === "listItem" && key === "label") continue;
    if (key in node) result[key] = node[key];
  }
  if (node.type === "list") {
    result.ordered = Boolean(node.ordered);
    result.start = node.ordered ? node.start ?? 1 : null;
    result.spread = node.spread === true || node.spread === "true";
  } else if (node.type === "listItem") {
    result.checked = node.checked == null ? null : Boolean(node.checked);
    result.spread = node.spread === true || node.spread === "true";
  }
  if (node.children) result.children = semanticChildren(node.children);
  return result;
}

export function listSemanticSignature(node) {
  return JSON.stringify(listSemanticValue(node));
}

export function annotateBulletListMarkers(tree, file) {
  const sourceValue = sourceText(file);
  const lines = sourceValue.split(/\r?\n/);
  const visit = (node, parent = null, grandparent = null) => {
    if (node?.type === "list") {
      if (parent?.type === "root") {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (Number.isFinite(start) && Number.isFinite(end)) {
          node.listSource = sourceValue.slice(start, end);
          node.listSourceSignature = listSemanticSignature(node);
          node.listSourceStart = start;
        }
      }
      const line = node.position?.start?.line;
      const column = node.position?.start?.column;
      if (Number.isFinite(line) && Number.isFinite(column)) {
        const source = lines[line - 1]?.slice(column - 1) || "";
        if (node.ordered) {
          const delimiter = source.match(/^\d{1,9}([.)])(?:[\t ]+|$)/)?.[1];
          if (delimiter) node.orderedDelimiter = delimiter;
        } else {
          const marker = source.match(/^([-+*])(?:[\t ]+|$)/)?.[1];
          if (marker) node.bulletMarker = marker;
        }
      }
      if (node.ordered) {
        for (const item of node.children || []) {
          const itemLine = item.position?.start?.line;
          const itemColumn = item.position?.start?.column;
          if (!Number.isFinite(itemLine) || !Number.isFinite(itemColumn)) continue;
          const marker = (lines[itemLine - 1]?.slice(itemColumn - 1) || "")
            .match(/^(\d{1,9})[.)](?:[\t ]+|$)/);
          if (marker) item.orderedNumber = Number(marker[1]);
        }
      }
    }
    if (node?.type === "listItem" && parent?.type === "list" && grandparent?.type === "root") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        node.listItemSource = sourceValue.slice(start, end);
        node.listItemSourceSignature = listSemanticSignature(node);
      }
    }
    if (node?.type === "listItem" && node.checked != null) {
      const line = node.position?.start?.line;
      const column = node.position?.start?.column;
      if (Number.isFinite(line) && Number.isFinite(column)) {
        const source = lines[line - 1]?.slice(column - 1) || "";
        const taskMarker = source.match(/^(?:[-+*]|\d{1,9}[.)])[\t ]+\[([ xX])\](?:[\t ]+|$)/)?.[1];
        if (taskMarker != null) node.taskMarker = taskMarker;
      }
    }
    (node?.children || []).forEach((child) => visit(child, node, parent));
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulBulletRemark = $remark(
  "tetherSourceFaithfulBullet",
  () => () => annotateBulletListMarkers
);

export const sourceFaithfulBulletListSchema = bulletListSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      bulletMarker: { default: "-", validate: "string" },
      listSource: { default: null, validate: "string|null" },
      listSourceSignature: { default: null, validate: "string|null" },
      listSourceStart: { default: null, validate: "number|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          listSource: dom.getAttribute?.("data-md-list-source") ?? null,
          listSourceSignature: dom.getAttribute?.("data-md-list-signature") ?? null,
          listSourceStart: dom.hasAttribute?.("data-md-list-source-start")
            ? Number(dom.getAttribute("data-md-list-source-start"))
            : null
        };
      }
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [dom[0], {
        ...dom[1],
        "data-md-bullet-marker": node.attrs.bulletMarker,
        ...(node.attrs.listSource == null ? {} : { "data-md-list-source": node.attrs.listSource }),
        ...(node.attrs.listSourceSignature == null
          ? {}
          : { "data-md-list-signature": node.attrs.listSourceSignature }),
        ...(node.attrs.listSourceStart == null
          ? {}
          : { "data-md-list-source-start": node.attrs.listSourceStart })
      }, dom[2]];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        const spread = node.spread != null ? `${node.spread}` : "false";
        state.openNode(type, {
          spread,
          bulletMarker: ["-", "+", "*"].includes(node.bulletMarker) ? node.bulletMarker : "-",
          listSource: node.listSource ?? null,
          listSourceSignature: node.listSourceSignature ?? null,
          listSourceStart: node.listSourceStart ?? null
        }).next(node.children).closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        state.openNode("list", undefined, {
          ordered: false,
          spread: node.attrs.spread,
          bulletMarker: node.attrs.bulletMarker,
          listSource: node.attrs.listSource,
          listSourceSignature: node.attrs.listSourceSignature,
          listSourceStart: node.attrs.listSourceStart
        }).next(node.content).closeNode();
      }
    }
  };
});

export const sourceFaithfulOrderedListSchema = orderedListSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      orderedDelimiter: { default: ".", validate: "string" },
      listSource: { default: null, validate: "string|null" },
      listSourceSignature: { default: null, validate: "string|null" },
      listSourceStart: { default: null, validate: "number|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          listSource: dom.getAttribute?.("data-md-list-source") ?? null,
          listSourceSignature: dom.getAttribute?.("data-md-list-signature") ?? null,
          listSourceStart: dom.hasAttribute?.("data-md-list-source-start")
            ? Number(dom.getAttribute("data-md-list-source-start"))
            : null
        };
      }
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [dom[0], {
        ...dom[1],
        "data-md-ordered-delimiter": node.attrs.orderedDelimiter,
        ...(node.attrs.listSource == null ? {} : { "data-md-list-source": node.attrs.listSource }),
        ...(node.attrs.listSourceSignature == null
          ? {}
          : { "data-md-list-signature": node.attrs.listSourceSignature }),
        ...(node.attrs.listSourceStart == null
          ? {}
          : { "data-md-list-source-start": node.attrs.listSourceStart })
      }, dom[2]];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        const spread = node.spread != null ? `${node.spread}` : "true";
        state.openNode(type, {
          spread,
          order: node.start ?? 1,
          orderedDelimiter: [".", ")"].includes(node.orderedDelimiter) ? node.orderedDelimiter : ".",
          listSource: node.listSource ?? null,
          listSourceSignature: node.listSourceSignature ?? null,
          listSourceStart: node.listSourceStart ?? null
        }).next(node.children).closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        state.openNode("list", undefined, {
          ordered: true,
          start: node.attrs.order ?? 1,
          spread: node.attrs.spread === "true",
          orderedDelimiter: node.attrs.orderedDelimiter,
          listSource: node.attrs.listSource,
          listSourceSignature: node.attrs.listSourceSignature,
          listSourceStart: node.attrs.listSourceStart
        }).next(node.content).closeNode();
      }
    }
  };
});

export const sourceFaithfulOrderedParenInputRule = $inputRule((ctx) => wrappingInputRule(
  /^\s*(\d+)\)\s$/,
  sourceFaithfulOrderedListSchema.type(ctx),
  (match) => ({ order: Number(match[1]), orderedDelimiter: ")" }),
  (match, node) => node.childCount + node.attrs.order === Number(match[1])
));

export const sourceFaithfulTaskListItemSchema = extendListItemSchemaForTask.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      taskMarker: { default: null, validate: "string|null" },
      orderedNumber: { default: null, validate: "number|null" },
      listItemSource: { default: null, validate: "string|null" },
      listItemSourceSignature: { default: null, validate: "string|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: rule.getAttrs
        ? (dom) => {
            const attrs = rule.getAttrs(dom);
            if (attrs === false) return false;
            const taskMarker = typeof HTMLElement !== "undefined" && dom instanceof HTMLElement
              ? dom.dataset.mdTaskMarker || null
              : null;
            const orderedNumber = typeof HTMLElement !== "undefined"
              && dom instanceof HTMLElement
              && dom.hasAttribute("data-md-ordered-number")
              ? Number(dom.dataset.mdOrderedNumber)
              : null;
            return {
              ...(attrs || {}),
              taskMarker,
              orderedNumber: Number.isInteger(orderedNumber) ? orderedNumber : null,
              listItemSource: dom.getAttribute?.("data-md-list-item-source") ?? null,
              listItemSourceSignature: dom.getAttribute?.("data-md-list-item-signature") ?? null
            };
          }
        : rule.getAttrs
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [dom[0], {
        ...dom[1],
        ...(node.attrs.taskMarker ? { "data-md-task-marker": node.attrs.taskMarker } : {}),
        ...(Number.isInteger(node.attrs.orderedNumber)
          ? { "data-md-ordered-number": node.attrs.orderedNumber }
          : {}),
        ...(node.attrs.listItemSource == null
          ? {}
          : { "data-md-list-item-source": node.attrs.listItemSource }),
        ...(node.attrs.listItemSourceSignature == null
          ? {}
          : { "data-md-list-item-signature": node.attrs.listItemSourceSignature })
      }, dom[2]];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        const label = node.label != null ? `${node.label}.` : "•";
        const listType = node.label != null ? "ordered" : "bullet";
        const spread = node.spread != null ? `${node.spread}` : "true";
        const checked = node.checked == null ? null : Boolean(node.checked);
        const taskMarker = checked == null
          ? null
          : ["x", "X", " "].includes(node.taskMarker)
            ? node.taskMarker
            : checked ? "x" : " ";
        state.openNode(type, {
          label,
          listType,
          spread,
          checked,
          taskMarker,
          orderedNumber: Number.isInteger(node.orderedNumber) ? node.orderedNumber : null,
          listItemSource: node.listItemSource ?? null,
          listItemSourceSignature: node.listItemSourceSignature ?? null
        }).next(node.children).closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        state.openNode("listItem", undefined, {
          label: node.attrs.label,
          listType: node.attrs.listType,
          spread: node.attrs.spread === "true",
          checked: node.attrs.checked,
          taskMarker: node.attrs.taskMarker,
          orderedNumber: node.attrs.orderedNumber,
          listItemSource: node.attrs.listItemSource,
          listItemSourceSignature: node.attrs.listItemSourceSignature
        }).next(node.content).closeNode();
      }
    }
  };
});

function listItemLabelClass(node) {
  if (node.attrs.checked == null) return node.attrs.listType === "bullet" ? "bullet" : "ordered";
  return node.attrs.checked ? "checked" : "unchecked";
}

export function renderedListItemLabel(node, orderedDelimiter = ".") {
  const attrs = node?.attrs || {};
  if (attrs.checked != null) return attrs.label;
  const sourceNumber = Number.isInteger(attrs.orderedNumber) ? attrs.orderedNumber : null;
  if (sourceNumber == null && attrs.listType !== "ordered") return attrs.label;
  const delimiter = orderedDelimiter === ")" ? ")" : ".";
  if (sourceNumber != null) return `${sourceNumber}${delimiter}`;
  const label = String(attrs.label ?? "");
  return /^\d+[.)]$/.test(label) ? `${label.slice(0, -1)}${delimiter}` : label;
}

function orderedListDelimiterAtPosition(view, position) {
  if (!Number.isFinite(position)) return ".";
  try {
    const resolved = view.state.doc.resolve(position);
    for (let depth = resolved.depth; depth >= 0; depth -= 1) {
      const ancestor = resolved.node(depth);
      if (ancestor.type.name === "ordered_list") {
        return ancestor.attrs.orderedDelimiter === ")" ? ")" : ".";
      }
    }
  } catch {
    // A node view can briefly outlive its document position during replacement.
  }
  return ".";
}

export function isInteractiveTaskMarker(node) {
  return node?.attrs?.checked != null;
}

export function listItemTextStart(position, node) {
  if (!Number.isFinite(position) || !node) return null;
  let childPosition = position + 1;
  let textStart = null;
  node.forEach((child) => {
    if (textStart == null && child.isTextblock) textStart = childPosition + 1;
    childPosition += child.nodeSize;
  });
  return textStart;
}

// Milkdown's stock list-item view replays a captured TextSelection in a later
// animation frame. Its equality guard accepts a structurally equal replacement
// document, even though ProseMirror selections must belong to the exact current
// document object; mode switches can therefore throw repeatedly during remount.
// Build the same DOM synchronously so contentDOM is present before the view is
// returned and no stale selection needs to be restored.
export const sourceFaithfulListItemView = $view(
  sourceFaithfulTaskListItemSchema.node,
  (ctx) => {
    const config = ctx.get(listItemBlockConfig.key);
    return (initialNode, view, getPos) => {
      const dom = document.createElement("div");
      dom.className = "milkdown-list-item-block";
      dom.dataset.tetherStableListItem = "";
      const listItem = document.createElement("li");
      listItem.className = "list-item";
      const labelWrapper = document.createElement("div");
      labelWrapper.className = "label-wrapper";
      labelWrapper.contentEditable = "false";
      const label = document.createElement("span");
      label.className = "milkdown-icon label";
      const children = document.createElement("div");
      children.className = "children";
      const contentDOM = document.createElement("div");
      contentDOM.className = "content-dom";
      contentDOM.dataset.contentDom = "true";
      children.appendChild(contentDOM);
      labelWrapper.appendChild(label);
      listItem.append(labelWrapper, children);
      dom.appendChild(listItem);

      let node = initialNode;
      const render = () => {
        label.className = `milkdown-icon label ${listItemLabelClass(node)}`;
        label.classList.toggle("readonly", !view.editable);
        let position = null;
        try {
          position = getPos();
        } catch {
          // Fall back to the semantic label while this node view is being replaced.
        }
        const renderedLabel = renderedListItemLabel(
          node,
          orderedListDelimiterAtPosition(view, position)
        );
        const orderedMarker = typeof renderedLabel === "string"
          ? renderedLabel.match(/^(\d+)[.)]$/)
          : null;
        if (orderedMarker) label.dataset.markerDigits = `${orderedMarker[1].length}`;
        else delete label.dataset.markerDigits;
        const icon = config.renderLabel({
          label: renderedLabel,
          listType: node.attrs.listType,
          checked: node.attrs.checked,
          readonly: !view.editable
        });
        label.innerHTML = typeof icon === "string" ? icon.trim() : "";
      };
      const handleMarkerPointerDown = (event) => {
        if (!isInteractiveTaskMarker(node)) {
          if (!view.editable) return;
          const position = getPos();
          const currentNode = position == null ? null : view.state.doc.nodeAt(position);
          const caret = listItemTextStart(position, currentNode);
          if (caret == null) return;
          event.preventDefault();
          event.stopPropagation();
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, caret))
              .scrollIntoView()
          );
          view.focus();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!view.editable) return;
        if (!view.hasFocus()) view.focus();
        const position = getPos();
        if (position == null || view.state.doc.nodeAt(position)?.type !== node.type) return;
        view.dispatch(view.state.tr.setNodeAttribute(position, "checked", !node.attrs.checked));
      };
      labelWrapper.addEventListener("pointerdown", handleMarkerPointerDown);
      render();

      return {
        dom,
        contentDOM,
        update(updatedNode) {
          if (updatedNode.type !== initialNode.type) return false;
          node = updatedNode;
          render();
          return true;
        },
        ignoreMutation(mutation) {
          if (mutation.type === "selection") return false;
          if (contentDOM === mutation.target && mutation.type === "attributes") return true;
          return !contentDOM.contains(mutation.target);
        },
        stopEvent(event) {
          return event.target instanceof Node && labelWrapper.contains(event.target);
        },
        selectNode() {
          dom.classList.add("selected");
          listItem.classList.add("ProseMirror-selectednode");
        },
        deselectNode() {
          dom.classList.remove("selected");
          listItem.classList.remove("ProseMirror-selectednode");
        },
        destroy() {
          labelWrapper.removeEventListener("pointerdown", handleMarkerPointerDown);
          dom.remove();
        }
      };
    };
  }
);

export function uppercaseTaskTransaction(state, start, end) {
  const pos = state.doc.resolve(start);
  let depth = 0;
  let node = pos.node(depth);
  while (node && node.type.name !== "list_item") {
    depth -= 1;
    node = pos.node(depth);
  }
  if (!node || node.attrs.checked != null) return null;
  return state.tr.deleteRange(start, end).setNodeMarkup(pos.before(depth), undefined, {
    ...node.attrs,
    checked: true,
    taskMarker: "X"
  });
}

export const sourceFaithfulUpperTaskInputRule = $inputRule(() => new InputRule(
  /^\[X\]\s$/,
  (state, _match, start, end) => uppercaseTaskTransaction(state, start, end)
));

export function sourceFaithfulListItemHandler(node, parent, state, info) {
  if (
    node.listItemSource != null
    && node.listItemSourceSignature != null
    && listSemanticSignature(node) === node.listItemSourceSignature
  ) return node.listItemSource;

  const head = node.children?.[0];
  const checkable = typeof node.checked === "boolean" && head?.type === "paragraph";
  const sourceMarker = ["x", "X", " "].includes(node.taskMarker) ? node.taskMarker : null;
  const taskMarker = node.checked ? sourceMarker === "X" ? "X" : "x" : " ";
  const checkbox = `[${taskMarker}] `;
  const tracker = state.createTracker(info);
  if (checkable) tracker.move(checkbox);

  const itemIndex = parent?.children?.indexOf(node) ?? -1;
  const serializationParent = parent?.ordered
    && Number.isInteger(node.orderedNumber)
    && itemIndex >= 0
    ? { ...parent, start: node.orderedNumber, children: [node] }
    : parent;
  let value = defaultHandlers.listItem(node, serializationParent, state, {
    ...info,
    ...tracker.current()
  });
  if (!checkable) return value;

  const withCheckbox = value.replace(
    /^(?:[-+*]|\d+[.)])(?:[\r\n]| {1,3})/,
    (prefix) => prefix + checkbox
  );
  if (withCheckbox !== value) return withCheckbox;
  if (/^(?:[-+*]|\d+[.)])$/.test(value)) return `${value} [${taskMarker}]`;
  return value;
}

function unorderedBullet(node, state) {
  if (["-", "+", "*"].includes(node.bulletMarker)) return node.bulletMarker;
  return ["-", "+", "*"].includes(state.options.bullet) ? state.options.bullet : "*";
}

function otherBullet(current, state) {
  const configured = state.options.bulletOther;
  if (["-", "+", "*"].includes(configured) && configured !== current) return configured;
  return ["*", "-", "+"].find((marker) => marker !== current) || "*";
}

export function sourceFaithfulListHandler(node, parent, state, info) {
  if (
    node.listSource != null
    && node.listSourceSignature != null
    && listSemanticSignature(node) === node.listSourceSignature
  ) return node.listSource;

  const exit = state.enter("list");
  const previousCurrent = state.bulletCurrent;
  let bullet = node.ordered
    ? [".", ")"].includes(node.orderedDelimiter)
      ? node.orderedDelimiter
      : state.options.bulletOrdered === ")" ? ")" : "."
    : unorderedBullet(node, state);
  const alternate = node.ordered ? bullet === "." ? ")" : "." : otherBullet(bullet, state);
  let useAlternate = Boolean(parent && state.bulletLastUsed && bullet === state.bulletLastUsed);

  if (!node.ordered) {
    const firstItem = node.children?.[0];
    if (
      (bullet === "*" || bullet === "-")
      && firstItem
      && (!firstItem.children || !firstItem.children[0])
      && state.stack[state.stack.length - 1] === "list"
      && state.stack[state.stack.length - 2] === "listItem"
      && state.stack[state.stack.length - 3] === "list"
      && state.stack[state.stack.length - 4] === "listItem"
      && state.indexStack[state.indexStack.length - 1] === 0
      && state.indexStack[state.indexStack.length - 2] === 0
      && state.indexStack[state.indexStack.length - 3] === 0
    ) useAlternate = true;

    const ruleMarker = ["*", "-", "_"].includes(state.options.rule) ? state.options.rule : "*";
    if (ruleMarker === bullet && firstItem) {
      if (node.children.some((item) => item.children?.[0]?.type === "thematicBreak")) useAlternate = true;
    }
  }

  if (useAlternate) bullet = alternate;
  state.bulletCurrent = bullet;
  const value = state.containerFlow(node, info);
  state.bulletLastUsed = bullet;
  state.bulletCurrent = previousCurrent;
  exit();
  return value;
}

export function typedBulletMarkerTransaction(oldState, newState) {
  const oldSelection = oldState.selection;
  if (!oldSelection.empty || oldSelection.$from.parentOffset !== oldSelection.$from.parent.content.size) return null;
  for (let depth = oldSelection.$from.depth; depth > 0; depth -= 1) {
    if (oldSelection.$from.node(depth).type.name === "bullet_list") return null;
  }
  const marker = oldSelection.$from.parent.type.name === "paragraph"
    ? oldSelection.$from.parent.textContent.trim()
    : "";
  if (!["-", "+", "*"].includes(marker)) return null;

  const { $from } = newState.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "bullet_list") continue;
    if (!("bulletMarker" in node.attrs) || node.attrs.bulletMarker === marker) return null;
    return newState.tr.setNodeAttribute($from.before(depth), "bulletMarker", marker);
  }
  return null;
}

export const sourceFaithfulBulletInputPlugin = $prose(() => new Plugin({
  appendTransaction(transactions, oldState, newState) {
    if (!transactions.some((transaction) => transaction.docChanged)) return null;
    return typedBulletMarkerTransaction(oldState, newState);
  }
}));
