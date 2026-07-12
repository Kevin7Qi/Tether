import { $markSchema, $remark } from "@milkdown/kit/utils";

const renderedTags = new Set([
  "b",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "s",
  "small",
  "strong",
  "sub",
  "sup",
  "u"
]);

function openingTag(value) {
  const match = typeof value === "string"
    ? value.match(/^<\s*([A-Za-z][\w-]*)\s*>$/)
    : null;
  const tag = match?.[1]?.toLowerCase();
  return tag && renderedTags.has(tag) ? tag : null;
}

function closingTag(value) {
  const match = typeof value === "string"
    ? value.match(/^<\s*\/\s*([A-Za-z][\w-]*)\s*>$/)
    : null;
  const tag = match?.[1]?.toLowerCase();
  return tag && renderedTags.has(tag) ? tag : null;
}

function matchingClose(children, start, tag) {
  let depth = 0;
  for (let index = start + 1; index < children.length; index += 1) {
    const child = children[index];
    if (child?.type !== "html") continue;
    if (openingTag(child.value) === tag) {
      depth += 1;
      continue;
    }
    if (closingTag(child.value) !== tag) continue;
    if (depth === 0) return index;
    depth -= 1;
  }
  return -1;
}

function renderInlineHtmlPairs(children = []) {
  const output = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const tag = child?.type === "html" ? openingTag(child.value) : null;
    const closeIndex = tag ? matchingClose(children, index, tag) : -1;
    if (!tag || closeIndex < 0) {
      if (child?.children) child.children = renderInlineHtmlPairs(child.children);
      output.push(child);
      continue;
    }

    const containsNestedHtml = children.slice(index + 1, closeIndex).some((nested) =>
      nested?.type === "html" && (openingTag(nested.value) || closingTag(nested.value))
    );
    if (containsNestedHtml) {
      output.push(...children.slice(index, closeIndex + 1));
      index = closeIndex;
      continue;
    }

    const closing = children[closeIndex];
    output.push({
      type: "htmlInlineElement",
      tag,
      openingSource: child.value,
      closingSource: closing.value,
      children: renderInlineHtmlPairs(children.slice(index + 1, closeIndex)),
      position: child.position && closing.position ? {
        start: child.position.start,
        end: closing.position.end
      } : undefined
    });
    index = closeIndex;
  }
  return output;
}

export function renderSafeInlineHtml(tree) {
  if (tree?.children) tree.children = renderInlineHtmlPairs(tree.children);
  return tree;
}

export const renderedInlineHtmlRemark = $remark(
  "tetherRenderedInlineHtml",
  () => () => renderSafeInlineHtml
);

function attrsFromDOM(dom, fallbackTag) {
  return {
    tag: dom.getAttribute?.("data-md-html-tag") || fallbackTag,
    openingSource: dom.getAttribute?.("data-md-html-opening") || `<${fallbackTag}>`,
    closingSource: dom.getAttribute?.("data-md-html-closing") || `</${fallbackTag}>`
  };
}

export const renderedInlineHtmlSchema = $markSchema("html_inline", () => ({
  attrs: {
    tag: { default: "span", validate: "string" },
    openingSource: { default: "", validate: "string" },
    closingSource: { default: "", validate: "string" }
  },
  parseDOM: [...renderedTags].map((tag) => ({
    tag: `${tag}[data-md-html-inline]`,
    getAttrs: (dom) => attrsFromDOM(dom, tag)
  })),
  toDOM: (mark) => {
    const tag = renderedTags.has(mark.attrs.tag) ? mark.attrs.tag : "span";
    return [tag, {
      "data-md-html-inline": "",
      "data-md-html-tag": tag,
      "data-md-html-opening": mark.attrs.openingSource,
      "data-md-html-closing": mark.attrs.closingSource
    }, 0];
  },
  parseMarkdown: {
    match: (node) => node.type === "htmlInlineElement",
    runner: (state, node, markType) => {
      state.openMark(markType, {
        tag: node.tag,
        openingSource: node.openingSource,
        closingSource: node.closingSource
      }).next(node.children).closeMark(markType);
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "html_inline",
    runner: (state, mark) => {
      state.withMark(mark, "htmlInlineElement", undefined, {
        tag: mark.attrs.tag,
        openingSource: mark.attrs.openingSource,
        closingSource: mark.attrs.closingSource
      });
    }
  }
}));

export function renderedInlineHtmlHandler(node, _parent, state, info) {
  const tag = renderedTags.has(node.tag) ? node.tag : "span";
  const opening = node.openingSource || `<${tag}>`;
  const closing = node.closingSource || `</${tag}>`;
  return `${opening}${state.containerPhrasing(node, info)}${closing}`;
}
