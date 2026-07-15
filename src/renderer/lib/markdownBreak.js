import { hardbreakSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function lineEnding(value) {
  if (value === "\r\n" || value === "\r") return value;
  return "\n";
}

function splitSoftLines(node, source) {
  if (node?.type !== "text" || typeof node.value !== "string") return null;
  const find = /[\t ]*(?:\r\n|\r|\n)/g;
  const startOffset = node.position?.start?.offset;
  const endOffset = node.position?.end?.offset;
  const rawBreaks = Number.isFinite(startOffset) && Number.isFinite(endOffset)
    ? [...source.slice(startOffset, endOffset).matchAll(/([\t ]*)(\r\n|\r|\n)/g)]
    : [];
  const result = [];
  let start = 0;
  let breakIndex = 0;
  let match = find.exec(node.value);
  while (match) {
    if (start !== match.index) {
      result.push({ type: "text", value: node.value.slice(start, match.index) });
    }
    const sourceBreak = rawBreaks[breakIndex];
    const rawLineEnding = sourceBreak?.[2]
      || match[0].match(/(?:\r\n|\r|\n)$/)?.[0]
      || "\n";
    result.push({
      type: "break",
      data: { isInline: true },
      hardbreakMarker: sourceBreak?.[1] || "",
      hardbreakLineEnding: rawLineEnding
    });
    breakIndex += 1;
    start = match.index + match[0].length;
    match = find.exec(node.value);
  }
  if (result.length === 0) return null;
  if (start < node.value.length) result.push({ type: "text", value: node.value.slice(start) });
  return result;
}

export function annotateHardBreakMarkers(tree, file) {
  const source = sourceText(file);
  const visit = (node) => {
    if (node?.type === "break") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const match = raw.match(/^(\\| {2,})(\r\n|\r|\n)$/);
        if (match) {
          node.hardbreakMarker = match[1];
          node.hardbreakLineEnding = match[2];
        }
      }
    }
    const children = node?.children;
    if (!Array.isArray(children)) return;
    for (let index = 0; index < children.length; index += 1) {
      const replacement = splitSoftLines(children[index], source);
      if (replacement) {
        children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      } else {
        visit(children[index]);
      }
    }
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
      markdownMarker: { default: "\\", validate: "string|null" },
      markdownLineEnding: { default: "\n", validate: "string" }
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
          ? typeof node.hardbreakMarker === "string" ? node.hardbreakMarker : null
          : node.hardbreakMarker === "\\" || /^ {2,}$/.test(node.hardbreakMarker || "")
            ? node.hardbreakMarker
            : "\\";
        state.addNode(type, {
          isInline,
          markdownMarker: marker,
          markdownLineEnding: lineEnding(node.hardbreakLineEnding)
        });
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        if (node.attrs.isInline) {
          state.addNode(
            "text",
            undefined,
            `${node.attrs.markdownMarker || ""}${lineEnding(node.attrs.markdownLineEnding)}`
          );
          return;
        }
        state.addNode("break", undefined, undefined, {
          hardbreakMarker: node.attrs.markdownMarker,
          hardbreakLineEnding: node.attrs.markdownLineEnding
        });
      }
    }
  };
});

export function sourceFaithfulHardBreakHandler(node, parent, state, info) {
  if (node.data?.isInline) {
    return `${node.hardbreakMarker || ""}${lineEnding(node.hardbreakLineEnding)}`;
  }
  const canonical = defaultHandlers.break(node, parent, state, info);
  if (canonical !== "\\\n") return canonical;
  const marker = node.hardbreakMarker;
  const ending = lineEnding(node.hardbreakLineEnding);
  return marker === "\\" || /^ {2,}$/.test(marker || "")
    ? `${marker}${ending}`
    : canonical;
}
