import { tableSchema } from "@milkdown/kit/preset/gfm";
import { $remark } from "@milkdown/kit/utils";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { decodeString } from "micromark-util-decode-string";

const tableSemanticKeys = new Set([
  "alt",
  "children",
  "identifier",
  "label",
  "referenceType",
  "title",
  "type",
  "url",
  "value"
]);

const markdownEscapeOrReference = /^(?:\\[!-/:-@[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});)/i;

function decodedSourceOffset(raw, text, targetOffset) {
  if (targetOffset === 0) return 0;
  let rawOffset = 0;
  let visibleOffset = 0;
  while (rawOffset < raw.length && visibleOffset < targetOffset) {
    const token = raw.slice(rawOffset).match(markdownEscapeOrReference)?.[0] || raw[rawOffset];
    const decoded = decodeString(token);
    const sourceToken = decoded === token && token.length > 1 ? token[0] : token;
    const visibleToken = sourceToken === token ? decoded : sourceToken;
    if (text.slice(visibleOffset, visibleOffset + visibleToken.length) !== visibleToken) return null;
    if (targetOffset < visibleOffset + visibleToken.length) return null;
    rawOffset += sourceToken.length;
    visibleOffset += visibleToken.length;
  }
  return visibleOffset === targetOffset ? rawOffset : null;
}

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function semanticValue(value, isRoot = false) {
  if (Array.isArray(value)) return value.map((item) => semanticValue(item, false));
  if (!value || typeof value !== "object") return value;
  if (
    value.type === "tableCell"
    && value.children?.length === 1
    && value.children[0]?.type === "paragraph"
  ) {
    value = { ...value, children: value.children[0].children || [] };
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!tableSemanticKeys.has(key) && !(isRoot && key === "align")) continue;
    result[key] = semanticValue(value[key], false);
  }
  return result;
}

export function tableSemanticSignature(node) {
  return JSON.stringify(semanticValue(node, true));
}

function cellSourceSegments(cell, source, tableStart) {
  const segments = [];
  let visibleOffset = 0;
  const add = (node, text, atom = false, wrapperStart = null, wrapperEnd = null) => {
    const start = node?.position?.start?.offset;
    const end = node?.position?.end?.offset;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const raw = source.slice(start, end);
    let contentStart = start;
    let contentEnd = end;
    if (node.type === "inlineCode") {
      const fenceLength = Math.max(1, Number(node.inlineCodeFenceLength) || 1);
      contentStart = start + fenceLength;
      contentEnd = end - fenceLength;
    } else if (!atom && node.type !== "text") {
      const index = raw.indexOf(text);
      if (index >= 0) {
        contentStart = start + index;
        contentEnd = contentStart + text.length;
      }
    }
    const size = atom ? 1 : text.length;
    segments.push({
      visibleFrom: visibleOffset,
      visibleTo: visibleOffset + size,
      sourceStart: (Number.isFinite(wrapperStart) ? wrapperStart : start) - tableStart,
      sourceEnd: (Number.isFinite(wrapperEnd) ? wrapperEnd : end) - tableStart,
      contentStart: contentStart - tableStart,
      contentEnd: contentEnd - tableStart,
      text,
      atom
    });
    visibleOffset += size;
  };
  const visit = (node, wrapperStart = null, wrapperEnd = null) => {
    if (!node) return;
    if (node.type === "text" || node.type === "inlineCode") {
      add(node, String(node.value || ""), false, wrapperStart, wrapperEnd);
      return;
    }
    if (["inlineMath", "image", "imageReference", "break", "html"].includes(node.type)) {
      add(node, String(node.value || ""), true, wrapperStart, wrapperEnd);
      return;
    }
    if (node.children?.length) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      node.children.forEach((child, index) => visit(
        child,
        index === 0 ? (Number.isFinite(wrapperStart) ? wrapperStart : start) : null,
        index === node.children.length - 1 ? (Number.isFinite(wrapperEnd) ? wrapperEnd : end) : null
      ));
    }
  };
  (cell.children || []).forEach((child) => visit(child));
  return { segments, visibleSize: visibleOffset };
}

export function annotateTableSources(tree, file) {
  const source = sourceText(file);
  const visit = (node) => {
    if (node?.type === "table") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        node.markdownTableSource = source.slice(start, end);
        node.markdownTableSignature = tableSemanticSignature(node);
        node.markdownTableCells = JSON.stringify((node.children || []).map((row) =>
          (row.children || []).map((cell) => {
            const children = cell.children || [];
            const first = children[0]?.position?.start?.offset;
            const last = children[children.length - 1]?.position?.end?.offset;
            const mapped = cellSourceSegments(cell, source, start);
            return {
              start: Number.isFinite(first) ? first - start : null,
              end: Number.isFinite(last) ? last - start : null,
              ...mapped
            };
          })
        ));
      }
    }
    (node?.children || []).forEach(visit);
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulTableRemark = $remark(
  "tetherSourceFaithfulTable",
  () => () => annotateTableSources
);

export const sourceFaithfulTableSchema = tableSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      markdownTableSource: { default: null, validate: "string|null" },
      markdownTableSignature: { default: null, validate: "string|null" },
      markdownTableCells: { default: null, validate: "string|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          markdownTableSource: dom.getAttribute("data-md-table-source"),
          markdownTableSignature: dom.getAttribute("data-md-table-signature"),
          markdownTableCells: dom.getAttribute("data-md-table-cells")
        };
      }
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [dom[0], {
        ...(dom[1] || {}),
        ...(node.attrs.markdownTableSource == null
          ? {}
          : { "data-md-table-source": node.attrs.markdownTableSource }),
        ...(node.attrs.markdownTableSignature == null
          ? {}
          : { "data-md-table-signature": node.attrs.markdownTableSignature }),
        ...(node.attrs.markdownTableCells == null
          ? {}
          : { "data-md-table-cells": node.attrs.markdownTableCells })
      }, ...dom.slice(2)];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        const align = node.align;
        const children = node.children.map((row, index) => ({
          ...row,
          align,
          isHeader: index === 0
        }));
        state.openNode(type, {
          markdownTableSource: node.markdownTableSource ?? null,
          markdownTableSignature: node.markdownTableSignature ?? null,
          markdownTableCells: node.markdownTableCells ?? null
        }).next(children).closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        const firstLine = node.content.firstChild?.content;
        if (!firstLine) return;
        const align = [];
        firstLine.forEach((cell) => align.push(cell.attrs.alignment));
        state.openNode("table", undefined, {
          align,
          markdownTableSource: node.attrs.markdownTableSource,
          markdownTableSignature: node.attrs.markdownTableSignature,
          markdownTableCells: node.attrs.markdownTableCells
        }).next(node.content).closeNode();
      }
    }
  };
});

export function tableCellSourceOffsetAtPosition(
  state,
  position,
  tableSource,
  affinity = "forward"
) {
  const $position = state.doc.resolve(position);
  let tableDepth = null;
  let rowDepth = null;
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const name = $position.node(depth).type.name;
    if (tableDepth == null && name === "table") tableDepth = depth;
    if (rowDepth == null && ["table_row", "table_header_row"].includes(name)) rowDepth = depth;
  }
  if (tableDepth == null || rowDepth == null || !$position.parent.isTextblock) return null;
  const table = $position.node(tableDepth);
  if (table.attrs.markdownTableSource !== tableSource) return null;
  let cells;
  try {
    cells = JSON.parse(table.attrs.markdownTableCells || "null");
  } catch {
    return null;
  }
  const row = cells?.[$position.index(tableDepth)];
  const cell = row?.[$position.index(rowDepth)];
  if (!cell || !Number.isFinite(cell.start) || !Number.isFinite(cell.end)) return null;
  if (cell.visibleSize !== $position.parent.content.size) return null;
  const offset = $position.parentOffset;
  const segments = cell.segments || [];
  const before = [...segments].reverse().find((segment) => segment.visibleTo <= offset);
  const after = segments.find((segment) => segment.visibleFrom >= offset);
  if (before && before.visibleTo === offset && after && after.visibleFrom === offset) {
    return affinity === "backward" ? before.sourceEnd : after.sourceStart;
  }
  const segment = segments.find(({ visibleFrom, visibleTo }) =>
    offset >= visibleFrom && offset <= visibleTo
  );
  if (!segment) return offset === 0 ? cell.start : offset === cell.visibleSize ? cell.end : null;
  if (segment.atom) {
    return offset <= segment.visibleFrom ? segment.sourceStart : segment.sourceEnd;
  }
  const relative = offset - segment.visibleFrom;
  if (relative === 0) {
    return affinity === "forward" ? segment.sourceStart : segment.contentStart;
  }
  if (relative === segment.visibleTo - segment.visibleFrom) {
    return affinity === "backward" ? segment.sourceEnd : segment.contentEnd;
  }
  const raw = tableSource.slice(segment.contentStart, segment.contentEnd);
  if (raw === segment.text) return segment.contentStart + relative;
  const rawOffset = decodedSourceOffset(raw, segment.text, relative);
  return rawOffset == null ? null : segment.contentStart + rawOffset;
}

export function sourceFaithfulTableHandler(node, parent, state, info) {
  if (
    node.markdownTableSource != null
    && node.markdownTableSignature != null
    && tableSemanticSignature(node) === node.markdownTableSignature
  ) return node.markdownTableSource;
  return gfmTableToMarkdown(state.options).handlers.table(node, parent, state, info);
}
