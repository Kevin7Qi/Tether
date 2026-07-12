import { tableSchema } from "@milkdown/kit/preset/gfm";
import { $remark } from "@milkdown/kit/utils";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";

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
    if (key === "position" || key === "isHeader") continue;
    if (!isRoot && key === "align") continue;
    if (key === "markdownTableSource" || key === "markdownTableSignature") continue;
    result[key] = semanticValue(value[key], false);
  }
  return result;
}

export function tableSemanticSignature(node) {
  return JSON.stringify(semanticValue(node, true));
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
      markdownTableSignature: { default: null, validate: "string|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          markdownTableSource: dom.getAttribute("data-md-table-source"),
          markdownTableSignature: dom.getAttribute("data-md-table-signature")
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
          : { "data-md-table-signature": node.attrs.markdownTableSignature })
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
          markdownTableSignature: node.markdownTableSignature ?? null
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
          markdownTableSignature: node.attrs.markdownTableSignature
        }).next(node.content).closeNode();
      }
    }
  };
});

export function sourceFaithfulTableHandler(node, parent, state, info) {
  if (
    node.markdownTableSource != null
    && node.markdownTableSignature != null
    && tableSemanticSignature(node) === node.markdownTableSignature
  ) return node.markdownTableSource;
  return gfmTableToMarkdown(state.options).handlers.table(node, parent, state, info);
}
