import DOMPurify from "dompurify";
import { $markSchema, $nodeSchema, $remark } from "@milkdown/kit/utils";

const blockHtmlContainers = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition"
]);

const blockHtmlTags = [
  "a",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul"
];

const blockHtmlAttributes = [
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "class",
  "colspan",
  "open",
  "reversed",
  "rowspan",
  "scope",
  "start",
  "title",
  "value"
];

const blockHtmlTagSet = new Set(blockHtmlTags);
const blockHtmlAttributeSet = new Set(blockHtmlAttributes);
const droppedBlockHtmlTags = new Set([
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "form",
  "iframe",
  "img",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "picture",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "video"
]);

function copySafeBlockHtmlNode(node, documentLike) {
  if (node.nodeType === 3) return documentLike.createTextNode(node.nodeValue || "");
  if (node.nodeType !== 1) return null;
  const tag = String(node.localName || node.tagName || "").toLowerCase();
  if (droppedBlockHtmlTags.has(tag)) return null;

  if (!blockHtmlTagSet.has(tag)) {
    const fragment = documentLike.createDocumentFragment();
    for (const child of node.childNodes || []) {
      const safeChild = copySafeBlockHtmlNode(child, documentLike);
      if (safeChild) fragment.append(safeChild);
    }
    return fragment;
  }

  const safe = documentLike.createElement(tag);
  for (const attribute of node.attributes || []) {
    const name = String(attribute.name || "").toLowerCase();
    if (!blockHtmlAttributeSet.has(name)) continue;
    safe.setAttribute(name, attribute.value || "");
  }
  for (const child of node.childNodes || []) {
    const safeChild = copySafeBlockHtmlNode(child, documentLike);
    if (safeChild) safe.append(safeChild);
  }
  return safe;
}

export function nativeSanitizeBlockHtml(value, documentLike) {
  if (!documentLike?.createElement || !documentLike?.createTextNode) return String(value || "");
  const template = documentLike.createElement("template");
  template.innerHTML = String(value || "");
  const output = documentLike.createElement("div");
  for (const node of template.content?.childNodes || []) {
    const safeNode = copySafeBlockHtmlNode(node, documentLike);
    if (safeNode) output.append(safeNode);
  }
  return output.innerHTML;
}

export function sanitizeBlockHtml(
  value,
  purifier = DOMPurify,
  windowLike = typeof window === "undefined" ? null : window,
  documentLike = windowLike?.document || null
) {
  const raw = String(value || "");
  let candidate = raw;
  try {
    const activePurifier = typeof purifier?.sanitize === "function"
      ? purifier
      : typeof purifier === "function" && windowLike
        ? purifier(windowLike)
        : null;
    if (typeof activePurifier?.sanitize === "function") {
      const sanitized = activePurifier.sanitize(raw, {
        ALLOWED_TAGS: blockHtmlTags,
        ALLOWED_ATTR: blockHtmlAttributes,
        ALLOW_ARIA_ATTR: true,
        ALLOW_DATA_ATTR: false,
        FORBID_ATTR: ["style"],
        RETURN_TRUSTED_TYPE: false
      });
      const clean = typeof sanitized === "string" ? sanitized : String(sanitized || "");
      // An unsupported DOMPurify instance returns an empty string for every
      // input. The native reconstruction below remains the mandatory final
      // barrier and can safely recover the allowed portion in that case.
      if (clean || !raw.trim()) candidate = clean;
    }
  } catch {}
  return nativeSanitizeBlockHtml(candidate, documentLike);
}

function renderBlockHtmlChildren(node) {
  if (!Array.isArray(node?.children)) return node;
  node.children = node.children.map((child) => {
    if (child?.type === "html" && blockHtmlContainers.has(node.type)) {
      return {
        type: "htmlBlockElement",
        value: child.value || "",
        position: child.position
      };
    }
    return renderBlockHtmlChildren(child);
  });
  return node;
}

export function renderSafeBlockHtml(tree) {
  return renderBlockHtmlChildren(tree);
}

export const renderedBlockHtmlRemark = $remark(
  "tetherRenderedBlockHtml",
  () => () => renderSafeBlockHtml
);

function htmlBlockDOM(node) {
  const value = node.attrs.value || "";
  const wrapper = document.createElement("div");
  wrapper.className = "tether-html-block";
  wrapper.setAttribute("data-md-html-block", "");
  wrapper.setAttribute("data-md-html-source", value);
  wrapper.setAttribute("contenteditable", "false");

  const preview = document.createElement("div");
  preview.className = "tether-html-block-preview";
  preview.innerHTML = sanitizeBlockHtml(value, DOMPurify, document.defaultView, document);
  const hasPreview = preview.children.length > 0 || Boolean(preview.textContent?.trim());
  if (hasPreview) {
    wrapper.classList.add("is-rendered");
    wrapper.setAttribute("aria-label", "Rendered HTML block. Select to edit Markdown source.");
    wrapper.append(preview);
  } else {
    wrapper.classList.add("is-literal");
    wrapper.setAttribute("aria-label", "HTML source block. Select to edit Markdown source.");
    const literal = document.createElement("pre");
    literal.className = "tether-html-block-literal";
    literal.textContent = value;
    wrapper.append(literal);
  }
  return wrapper;
}

export const renderedBlockHtmlSchema = $nodeSchema("html_block", () => ({
  atom: true,
  group: "block",
  selectable: true,
  isolating: true,
  attrs: {
    value: { default: "", validate: "string" }
  },
  toDOM: htmlBlockDOM,
  parseDOM: [{
    tag: "div[data-md-html-block]",
    getAttrs: (dom) => ({ value: dom.getAttribute?.("data-md-html-source") || "" })
  }],
  parseMarkdown: {
    match: (node) => node.type === "htmlBlockElement",
    runner: (state, node, type) => state.addNode(type, { value: node.value || "" })
  },
  toMarkdown: {
    match: (node) => node.type.name === "html_block",
    runner: (state, node) => state.addNode("htmlBlockElement", undefined, node.attrs.value || "")
  }
}));

export function renderedBlockHtmlHandler(node) {
  return node.value || "";
}

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
