import { blockquoteSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function semanticValue(value) {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] == null) continue;
    if (
      key === "position"
      || key === "blockquoteLinePrefixes"
      || key === "blockquotePreferredPrefix"
      || key === "blockquoteSource"
      || key === "blockquoteSourceSignature"
      || key === "blockquoteSourceStart"
      || key === "markdownSourceStart"
      || key === "markdownSourceEnd"
      || key === "paragraphSource"
      || key === "paragraphSourceSignature"
      || key === "headingSource"
      || key === "headingSourceSignature"
      || key === "headingSourceStart"
      || key === "headingContentStart"
      || key === "headingContentEnd"
      || key === "markdownStyle"
      || key === "setextMarker"
      || key === "setextLength"
      || key === "atxClosingLength"
      || key === "listSource"
      || key === "listSourceSignature"
      || key === "listSourceStart"
      || key === "listItemSource"
      || key === "listItemSourceSignature"
      || key === "label"
      || key === "listType"
      || key === "tetherSyntheticTrailing"
    ) continue;
    result[key] = key === "spread" && typeof value[key] === "string"
      ? value[key] === "true"
      : semanticValue(value[key]);
  }
  return result;
}

export function blockquoteSemanticSignature(node) {
  return JSON.stringify(semanticValue(node));
}

function structuralQuoteMarkers(line) {
  const markers = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && /[\t ]/.test(line[index])) index += 1;
    if (line[index] === ">") {
      const start = index;
      index += 1;
      while (index < line.length && /[\t ]/.test(line[index])) index += 1;
      markers.push({ start, end: index });
      continue;
    }
    const listMarker = line.slice(index).match(/^(?:[-+*]|\d{1,9}[.)])[\t ]+/)?.[0];
    if (listMarker) {
      index += listMarker.length;
      continue;
    }
    break;
  }
  return markers;
}

function linePrefixAtDepth(line, quoteDepth, fallbackColumn = null) {
  const markers = structuralQuoteMarkers(line);
  let marker = markers[quoteDepth - 1];
  if (!marker && Number.isFinite(fallbackColumn) && line[fallbackColumn - 1] === ">") {
    const start = fallbackColumn - 1;
    let end = start + 1;
    while (end < line.length && /[\t ]/.test(line[end])) end += 1;
    marker = { start, end };
  }
  return marker ? line.slice(marker.start, marker.end) : "";
}

export function annotateBlockquoteSources(tree, file) {
  const source = sourceText(file);
  const lines = source.split(/\r?\n/);
  const visit = (node, ancestors = []) => {
    if (node?.type === "blockquote") {
      const startLine = node.position?.start?.line;
      const startColumn = node.position?.start?.column;
      const endLine = node.position?.end?.line;
      if (Number.isFinite(startLine) && Number.isFinite(startColumn) && Number.isFinite(endLine)) {
        const quoteDepth = ancestors.filter((ancestor) => ancestor.type === "blockquote").length + 1;
        const prefixes = [];
        for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
          prefixes.push(linePrefixAtDepth(
            lines[lineNumber - 1] || "",
            quoteDepth,
            lineNumber === startLine ? startColumn : null
          ));
        }
        node.blockquoteLinePrefixes = JSON.stringify(prefixes);
        node.blockquotePreferredPrefix = prefixes.find(Boolean) || "> ";

        // A root quote's source slice is already local to the node. Nested and
        // list-contained slices include physical parent prefixes on later lines,
        // so those nodes use the per-line template instead of storing unsafe raw.
        if (ancestors.at(-1)?.type === "root") {
          const start = node.position?.start?.offset;
          const end = node.position?.end?.offset;
          if (Number.isFinite(start) && Number.isFinite(end)) {
            node.blockquoteSource = source.slice(start, end);
            node.blockquoteSourceSignature = blockquoteSemanticSignature(node);
            node.blockquoteSourceStart = start;
          }
        }
      }
    }
    (node?.children || []).forEach((child) => visit(child, [...ancestors, node]));
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulBlockquoteRemark = $remark(
  "tetherSourceFaithfulBlockquote",
  () => () => annotateBlockquoteSources
);

export const sourceFaithfulBlockquoteSchema = blockquoteSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      blockquoteLinePrefixes: { default: null, validate: "string|null" },
      blockquotePreferredPrefix: { default: "> ", validate: "string" },
      blockquoteSource: { default: null, validate: "string|null" },
      blockquoteSourceSignature: { default: null, validate: "string|null" },
      blockquoteSourceStart: { default: null, validate: "number|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          blockquoteLinePrefixes: dom.getAttribute?.("data-md-blockquote-prefixes") ?? null,
          blockquotePreferredPrefix: dom.getAttribute?.("data-md-blockquote-prefix") || "> ",
          blockquoteSource: dom.getAttribute?.("data-md-blockquote-source") ?? null,
          blockquoteSourceSignature: dom.getAttribute?.("data-md-blockquote-signature") ?? null,
          blockquoteSourceStart: dom.hasAttribute?.("data-md-blockquote-source-start")
            ? Number(dom.getAttribute("data-md-blockquote-source-start"))
            : null
        };
      }
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [dom[0], {
        ...(dom[1] || {}),
        "data-md-blockquote-prefix": node.attrs.blockquotePreferredPrefix,
        ...(node.attrs.blockquoteLinePrefixes == null
          ? {}
          : { "data-md-blockquote-prefixes": node.attrs.blockquoteLinePrefixes }),
        ...(node.attrs.blockquoteSource == null
          ? {}
          : { "data-md-blockquote-source": node.attrs.blockquoteSource }),
        ...(node.attrs.blockquoteSourceSignature == null
          ? {}
          : { "data-md-blockquote-signature": node.attrs.blockquoteSourceSignature }),
        ...(node.attrs.blockquoteSourceStart == null
          ? {}
          : { "data-md-blockquote-source-start": node.attrs.blockquoteSourceStart })
      }, ...dom.slice(2)];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        state.openNode(type, {
          blockquoteLinePrefixes: node.blockquoteLinePrefixes ?? null,
          blockquotePreferredPrefix: node.blockquotePreferredPrefix || "> ",
          blockquoteSource: node.blockquoteSource ?? null,
          blockquoteSourceSignature: node.blockquoteSourceSignature ?? null,
          blockquoteSourceStart: node.blockquoteSourceStart ?? null
        }).next(node.children).closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        state.openNode("blockquote", undefined, {
          blockquoteLinePrefixes: node.attrs.blockquoteLinePrefixes,
          blockquotePreferredPrefix: node.attrs.blockquotePreferredPrefix,
          blockquoteSource: node.attrs.blockquoteSource,
          blockquoteSourceSignature: node.attrs.blockquoteSourceSignature,
          blockquoteSourceStart: node.attrs.blockquoteSourceStart
        }).next(node.content).closeNode();
      }
    }
  };
});

function storedPrefixes(node) {
  if (typeof node.blockquoteLinePrefixes !== "string") return null;
  try {
    const prefixes = JSON.parse(node.blockquoteLinePrefixes);
    return Array.isArray(prefixes) && prefixes.every((prefix) => typeof prefix === "string")
      ? prefixes
      : null;
  } catch {
    return null;
  }
}

function replaceCanonicalPrefix(line, prefix) {
  if (!line.startsWith(">")) return line;
  return `${prefix}${line.replace(/^>[ ]?/, "")}`;
}

export function sourceFaithfulBlockquoteHandler(node, parent, state, info) {
  if (
    node.blockquoteSource != null
    && node.blockquoteSourceSignature != null
    && blockquoteSemanticSignature(node) === node.blockquoteSourceSignature
  ) return node.blockquoteSource;

  const canonical = defaultHandlers.blockquote(node, parent, state, info);
  const lines = canonical.split("\n");
  const prefixes = storedPrefixes(node);
  if (prefixes?.length === lines.length) {
    return lines.map((line, index) => replaceCanonicalPrefix(line, prefixes[index])).join("\n");
  }

  const preferred = typeof node.blockquotePreferredPrefix === "string"
    ? node.blockquotePreferredPrefix
    : "> ";
  return lines.map((line) => replaceCanonicalPrefix(line, preferred)).join("\n");
}

sourceFaithfulBlockquoteHandler.peek = defaultHandlers.blockquote.peek;
