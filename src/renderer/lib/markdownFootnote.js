import {
  footnoteDefinitionSchema,
  footnoteReferenceSchema
} from "@milkdown/kit/preset/gfm";
import { $remark } from "@milkdown/kit/utils";
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmFootnote } from "micromark-extension-gfm-footnote";

const footnoteHandlers = gfmFootnoteToMarkdown().handlers;
const semanticKeys = [
  "alt",
  "bulletMarker",
  "checked",
  "identifier",
  "label",
  "ordered",
  "orderedDelimiter",
  "orderedNumber",
  "referenceType",
  "spread",
  "start",
  "taskMarker",
  "title",
  "url",
  "value"
];

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function semanticChildren(children = []) {
  const output = [];
  for (const child of children) {
    if (
      child?.type === "paragraph"
      && child.tetherSyntheticTrailing
      && !child.children?.length
    ) continue;
    const value = semanticValue(child);
    const previous = output.at(-1);
    if (previous?.type === "text" && value?.type === "text") previous.value += value.value;
    else output.push(value);
  }
  return output;
}

function semanticValue(node) {
  if (!node || typeof node !== "object") return node;
  if (node.type === "break" && node.data?.isInline) return { type: "text", value: "\n" };
  const output = { type: node.type };
  for (const key of semanticKeys) {
    if (!(key in node) || node[key] == null) continue;
    if (node.type === "listItem" && key === "label") continue;
    output[key] = key === "identifier" && typeof node[key] === "string"
        ? node[key].trim().replace(/\s+/g, " ").toLowerCase()
        : key === "spread" && typeof node[key] === "string"
          ? node[key] === "true"
          : node[key];
  }
  if (node.children) output.children = semanticChildren(node.children);
  return output;
}

export function footnoteSemanticSignature(node) {
  return JSON.stringify(semanticValue(node));
}

export function annotateFootnoteSources(tree, file) {
  const source = sourceText(file);
  const visit = (node, parent = null) => {
    if (node?.type === "footnoteReference") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        node.footnoteSource = source.slice(start, end);
        node.footnoteSourceLabel = node.label || node.identifier;
      }
    }
    if (node?.type === "footnoteDefinition" && parent?.type === "root") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        node.footnoteDefinitionSource = source.slice(start, end);
        node.footnoteDefinitionSignature = footnoteSemanticSignature(node);
        node.footnoteDefinitionSourceStart = start;
      }
    }
    (node?.children || []).forEach((child) => visit(child, node));
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulFootnoteRemark = $remark(
  "tetherSourceFaithfulFootnote",
  () => function tetherFootnotePlugin() {
    const data = this.data();
    (data.micromarkExtensions ||= []).push(gfmFootnote());
    (data.fromMarkdownExtensions ||= []).push(gfmFootnoteFromMarkdown());
    (data.toMarkdownExtensions ||= []).push(gfmFootnoteToMarkdown());
    return annotateFootnoteSources;
  }
);

export const sourceFaithfulFootnoteDefinitionSchema = footnoteDefinitionSchema.extendSchema(
  (previous) => (ctx) => {
    const spec = previous(ctx);
    return {
      ...spec,
      attrs: {
        ...spec.attrs,
        footnoteDefinitionSource: { default: null, validate: "string|null" },
        footnoteDefinitionSignature: { default: null, validate: "string|null" },
        footnoteDefinitionSourceStart: { default: null, validate: "number|null" }
      },
      parseDOM: (spec.parseDOM || []).map((rule) => ({
        ...rule,
        getAttrs: (dom) => {
          const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
          if (attrs === false) return false;
          return {
            ...(attrs || {}),
            footnoteDefinitionSource: dom.getAttribute?.("data-md-footnote-source") ?? null,
            footnoteDefinitionSignature: dom.getAttribute?.("data-md-footnote-signature") ?? null,
            footnoteDefinitionSourceStart: dom.hasAttribute?.("data-md-footnote-source-start")
              ? Number(dom.getAttribute("data-md-footnote-source-start"))
              : null
          };
        }
      })),
      toDOM: (node) => {
        const dom = spec.toDOM(node);
        return [dom[0], {
          ...(dom[1] || {}),
          ...(node.attrs.footnoteDefinitionSource == null
            ? {}
            : { "data-md-footnote-source": node.attrs.footnoteDefinitionSource }),
          ...(node.attrs.footnoteDefinitionSignature == null
            ? {}
            : { "data-md-footnote-signature": node.attrs.footnoteDefinitionSignature }),
          ...(node.attrs.footnoteDefinitionSourceStart == null
            ? {}
            : { "data-md-footnote-source-start": node.attrs.footnoteDefinitionSourceStart })
        }, ...dom.slice(2)];
      },
      parseMarkdown: {
        ...spec.parseMarkdown,
        runner: (state, node, type) => {
          state.openNode(type, {
            label: node.label,
            footnoteDefinitionSource: node.footnoteDefinitionSource ?? null,
            footnoteDefinitionSignature: node.footnoteDefinitionSignature ?? null,
            footnoteDefinitionSourceStart: node.footnoteDefinitionSourceStart ?? null
          }).next(node.children).closeNode();
        }
      },
      toMarkdown: {
        ...spec.toMarkdown,
        runner: (state, node) => {
          state.openNode("footnoteDefinition", undefined, {
            label: node.attrs.label,
            identifier: node.attrs.label,
            footnoteDefinitionSource: node.attrs.footnoteDefinitionSource,
            footnoteDefinitionSignature: node.attrs.footnoteDefinitionSignature,
            footnoteDefinitionSourceStart: node.attrs.footnoteDefinitionSourceStart
          }).next(node.content).closeNode();
        }
      }
    };
  }
);

export const sourceFaithfulFootnoteReferenceSchema = footnoteReferenceSchema.extendSchema(
  (previous) => (ctx) => {
    const spec = previous(ctx);
    return {
      ...spec,
      attrs: {
        ...spec.attrs,
        footnoteSource: { default: null, validate: "string|null" },
        footnoteSourceLabel: { default: null, validate: "string|null" }
      },
      parseDOM: (spec.parseDOM || []).map((rule) => ({
        ...rule,
        getAttrs: (dom) => {
          const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
          if (attrs === false) return false;
          return {
            ...(attrs || {}),
            footnoteSource: dom.getAttribute?.("data-md-footnote-reference-source") ?? null,
            footnoteSourceLabel: dom.getAttribute?.("data-md-footnote-reference-label") ?? null
          };
        }
      })),
      toDOM: (node) => {
        const dom = spec.toDOM(node);
        return [dom[0], {
          ...(dom[1] || {}),
          ...(node.attrs.footnoteSource == null
            ? {}
            : { "data-md-footnote-reference-source": node.attrs.footnoteSource }),
          ...(node.attrs.footnoteSourceLabel == null
            ? {}
            : { "data-md-footnote-reference-label": node.attrs.footnoteSourceLabel })
        }, ...dom.slice(2)];
      },
      parseMarkdown: {
        ...spec.parseMarkdown,
        runner: (state, node, type) => {
          state.addNode(type, {
            label: node.label,
            footnoteSource: node.footnoteSource ?? null,
            footnoteSourceLabel: node.footnoteSourceLabel ?? null
          });
        }
      },
      toMarkdown: {
        ...spec.toMarkdown,
        runner: (state, node) => {
          state.addNode("footnoteReference", undefined, undefined, {
            label: node.attrs.label,
            identifier: node.attrs.label,
            footnoteSource: node.attrs.footnoteSource,
            footnoteSourceLabel: node.attrs.footnoteSourceLabel
          });
        }
      }
    };
  }
);

export function sourceFaithfulFootnoteDefinitionHandler(node, parent, state, info) {
  if (
    node.footnoteDefinitionSource != null
    && node.footnoteDefinitionSignature != null
    && footnoteSemanticSignature(node) === node.footnoteDefinitionSignature
  ) return node.footnoteDefinitionSource;
  return footnoteHandlers.footnoteDefinition(node, parent, state, info);
}

export function sourceFaithfulFootnoteReferenceHandler(node, parent, state, info) {
  if (
    node.footnoteSource != null
    && node.footnoteSourceLabel != null
    && (node.label || node.identifier) === node.footnoteSourceLabel
  ) return node.footnoteSource;
  return footnoteHandlers.footnoteReference(node, parent, state, info);
}
