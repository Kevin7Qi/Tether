import { hardbreakSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

export function annotateHardBreakMarkers(tree, file) {
  const source = sourceText(file);
  const visit = (node) => {
    if (node?.type === "break") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const marker = raw.match(/^(\\| {2,})(?:\r?\n)$/)?.[1];
        if (marker) node.hardbreakMarker = marker;
      }
    }
    (node?.children || []).forEach(visit);
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulHardBreakRemark = $remark(
  "tetherSourceFaithfulHardBreak",
  () => () => annotateHardBreakMarkers
);

export const sourceFaithfulHardBreakSchema = hardbreakSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      markdownMarker: { default: "\\", validate: "string|null" }
    },
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      const attributes = {
        ...(dom[1] || {}),
        ...(node.attrs.markdownMarker == null
          ? {}
          : { "data-md-hardbreak-marker": node.attrs.markdownMarker })
      };
      return [dom[0], attributes, ...dom.slice(2)];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        const isInline = Boolean(node.data?.isInline);
        const marker = isInline
          ? null
          : node.hardbreakMarker === "\\" || /^ {2,}$/.test(node.hardbreakMarker || "")
            ? node.hardbreakMarker
            : "\\";
        state.addNode(type, { isInline, markdownMarker: marker });
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        if (node.attrs.isInline) {
          state.addNode("text", undefined, "\n");
          return;
        }
        state.addNode("break", undefined, undefined, {
          hardbreakMarker: node.attrs.markdownMarker
        });
      }
    }
  };
});

export function sourceFaithfulHardBreakHandler(node, parent, state, info) {
  const canonical = defaultHandlers.break(node, parent, state, info);
  if (canonical !== "\\\n") return canonical;
  const marker = node.hardbreakMarker;
  return marker === "\\" || /^ {2,}$/.test(marker || "") ? `${marker}\n` : canonical;
}
