import { inlineCodeSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

export function annotateInlineCodeSources(tree, file) {
  const source = sourceText(file);
  const visit = (node) => {
    if (node?.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const fenceLength = raw.match(/^`+/)?.[0].length || 1;
        if (raw.endsWith("`".repeat(fenceLength)) && raw.length >= fenceLength * 2) {
          node.inlineCodeFenceLength = fenceLength;
          node.inlineCodeRawContent = raw.slice(fenceLength, -fenceLength);
          node.inlineCodeSourceText = node.value;
        }
      }
    }
    (node?.children || []).forEach(visit);
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulInlineCodeRemark = $remark(
  "tetherSourceFaithfulInlineCode",
  () => () => annotateInlineCodeSources
);

export const sourceFaithfulInlineCodeSchema = inlineCodeSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      inlineCodeFenceLength: { default: 1, validate: "number" },
      inlineCodeRawContent: { default: null, validate: "string|null" },
      inlineCodeSourceText: { default: null, validate: "string|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => ({
        inlineCodeFenceLength: Number(dom.getAttribute("data-md-inline-code-fence")) || 1,
        inlineCodeRawContent: dom.hasAttribute("data-md-inline-code-raw")
          ? dom.getAttribute("data-md-inline-code-raw")
          : null,
        inlineCodeSourceText: dom.hasAttribute("data-md-inline-code-text")
          ? dom.getAttribute("data-md-inline-code-text")
          : null
      })
    })),
    toDOM: (mark) => {
      const dom = spec.toDOM(mark);
      return [dom[0], {
        ...(dom[1] || {}),
        "data-md-inline-code-fence": mark.attrs.inlineCodeFenceLength,
        ...(mark.attrs.inlineCodeRawContent == null
          ? {}
          : { "data-md-inline-code-raw": mark.attrs.inlineCodeRawContent }),
        ...(mark.attrs.inlineCodeSourceText == null
          ? {}
          : { "data-md-inline-code-text": mark.attrs.inlineCodeSourceText })
      }, ...dom.slice(2)];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, markType) => {
        state.openMark(markType, {
          inlineCodeFenceLength: node.inlineCodeFenceLength || 1,
          inlineCodeRawContent: node.inlineCodeRawContent ?? null,
          inlineCodeSourceText: node.inlineCodeSourceText ?? node.value
        });
        state.addText(node.value);
        state.closeMark(markType);
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, mark, node) => {
        state.withMark(mark, "inlineCode", node.text || "", {
          inlineCodeFenceLength: mark.attrs.inlineCodeFenceLength,
          inlineCodeRawContent: mark.attrs.inlineCodeRawContent,
          inlineCodeSourceText: mark.attrs.inlineCodeSourceText
        });
        return true;
      }
    }
  };
});

function longestBacktickRun(value) {
  return [...value.matchAll(/`+/g)].reduce((longest, match) => Math.max(longest, match[0].length), 0);
}

export function sourceFaithfulInlineCodeHandler(node, parent, state, info) {
  const preferredLength = Math.max(1, Number(node.inlineCodeFenceLength) || 1);
  if (
    node.inlineCodeRawContent != null
    && node.inlineCodeSourceText != null
    && node.value === node.inlineCodeSourceText
  ) {
    const fence = "`".repeat(preferredLength);
    const exact = `${fence}${node.inlineCodeRawContent}${fence}`;
    return state.stack.includes("tableCell") ? exact.replace(/(?<!\\)\|/g, "\\|") : exact;
  }

  let value = node.value || "";
  const fenceLength = Math.max(preferredLength, longestBacktickRun(value) + 1);
  const fence = "`".repeat(fenceLength);
  const preservePadding = typeof node.inlineCodeRawContent === "string"
    && node.inlineCodeRawContent.startsWith(" ")
    && node.inlineCodeRawContent.endsWith(" ")
    && /[^ ]/.test(node.inlineCodeRawContent);
  const requiredPadding = /[^ \r\n]/.test(value)
    && ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^`|`$/.test(value));
  if (preservePadding || requiredPadding) value = ` ${value} `;
  const serialized = `${fence}${value}${fence}`;
  return state.stack.includes("tableCell") ? serialized.replace(/(?<!\\)\|/g, "\\|") : serialized;
}

sourceFaithfulInlineCodeHandler.peek = defaultHandlers.inlineCode.peek;
