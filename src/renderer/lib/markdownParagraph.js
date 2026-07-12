import { paragraphSchema } from "@milkdown/kit/preset/commonmark";
import { Fragment } from "@milkdown/kit/prose/model";
import { $remark } from "@milkdown/kit/utils";
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
    const normalized = semanticValue(child);
    const previous = result.at(-1);
    if (previous?.type === "text" && normalized?.type === "text") {
      previous.value += normalized.value;
    } else {
      result.push(normalized);
    }
  }
  return result;
}

function semanticValue(node) {
  if (!node || typeof node !== "object") return node;
  // Milkdown's remarkLineBreak plugin expands a soft newline into an inline
  // `break` before our source annotation runs, while its serializer writes the
  // same node back as a text newline. Treat those two model representations as
  // the same semantic value so an unrelated edit cannot invalidate raw source.
  if (node.type === "break" && node.data?.isInline) return { type: "text", value: "\n" };
  const result = { type: node.type };
  for (const key of semanticKeys) {
    if (key in node) result[key] = node[key];
  }
  if (node.children) result.children = semanticChildren(node.children);
  return result;
}

export function paragraphSemanticSignature(node) {
  return JSON.stringify(semanticValue(node));
}

export function annotateParagraphSources(tree, file) {
  const source = sourceText(file);
  const visit = (node, parent = null) => {
    if (node?.type === "paragraph") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        node.markdownSourceStart = start;
        node.markdownSourceEnd = end;
        if (parent?.type === "root") {
          node.paragraphSource = source.slice(start, end);
          node.paragraphSourceSignature = paragraphSemanticSignature(node);
        }
      }
    }
    (node?.children || []).forEach((child) => visit(child, node));
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulParagraphRemark = $remark(
  "tetherSourceFaithfulParagraph",
  () => () => annotateParagraphSources
);

function serializeParagraphChildren(state, node) {
  if (!(node.childCount >= 1 && node.lastChild?.type.name === "hardbreak")) {
    state.next(node.content);
    return;
  }
  const children = [];
  node.content.forEach((child, _offset, index) => {
    if (index !== node.childCount - 1) children.push(child);
  });
  state.next(Fragment.fromArray(children));
}

export const sourceFaithfulParagraphSchema = paragraphSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      paragraphSource: { default: null, validate: "string|null" },
      paragraphSourceSignature: { default: null, validate: "string|null" },
      markdownSourceStart: { default: null, validate: "number|null" },
      markdownSourceEnd: { default: null, validate: "number|null" },
      tetherSyntheticTrailing: { default: false, validate: "boolean" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          paragraphSource: dom.getAttribute?.("data-md-paragraph-source") ?? null,
          paragraphSourceSignature: dom.getAttribute?.("data-md-paragraph-signature") ?? null,
          markdownSourceStart: dom.hasAttribute?.("data-md-source-start")
            ? Number(dom.getAttribute("data-md-source-start"))
            : null,
          markdownSourceEnd: dom.hasAttribute?.("data-md-source-end")
            ? Number(dom.getAttribute("data-md-source-end"))
            : null,
          tetherSyntheticTrailing: dom.getAttribute?.("data-tether-synthetic-trailing") === "true"
        };
      }
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [dom[0], {
        ...(dom[1] || {}),
        ...(node.attrs.paragraphSource == null
          ? {}
          : { "data-md-paragraph-source": node.attrs.paragraphSource }),
        ...(node.attrs.paragraphSourceSignature == null
          ? {}
          : { "data-md-paragraph-signature": node.attrs.paragraphSourceSignature }),
        ...(node.attrs.markdownSourceStart == null
          ? {}
          : { "data-md-source-start": node.attrs.markdownSourceStart }),
        ...(node.attrs.markdownSourceEnd == null
          ? {}
          : { "data-md-source-end": node.attrs.markdownSourceEnd }),
        ...(node.attrs.tetherSyntheticTrailing
          ? { "data-tether-synthetic-trailing": "true" }
          : {})
      }, ...dom.slice(2)];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        state.openNode(type, {
          paragraphSource: node.paragraphSource ?? null,
          paragraphSourceSignature: node.paragraphSourceSignature ?? null,
          markdownSourceStart: node.markdownSourceStart ?? null,
          markdownSourceEnd: node.markdownSourceEnd ?? null,
          tetherSyntheticTrailing: false
        });
        if (node.children) state.next(node.children);
        else state.addText(node.value || "");
        state.closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        state.openNode("paragraph", undefined, {
          paragraphSource: node.attrs.paragraphSource,
          paragraphSourceSignature: node.attrs.paragraphSourceSignature,
          markdownSourceStart: node.attrs.markdownSourceStart,
          markdownSourceEnd: node.attrs.markdownSourceEnd,
          tetherSyntheticTrailing: node.attrs.tetherSyntheticTrailing
        });
        if (node.content?.size) serializeParagraphChildren(state, node);
        state.closeNode();
      }
    }
  };
});

export function sourceFaithfulParagraphHandler(node, parent, state, info) {
  if (
    node.paragraphSource != null
    && node.paragraphSourceSignature != null
    && paragraphSemanticSignature(node) === node.paragraphSourceSignature
  ) return node.paragraphSource;
  return defaultHandlers.paragraph(node, parent, state, info);
}
