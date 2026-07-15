import { Fragment } from "@milkdown/kit/prose/model";
import { headingSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";
import { paragraphSemanticSignature } from "./markdownParagraph.js";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

export function annotateHeadingMarkers(tree, file) {
  const source = sourceText(file);
  const lines = source.split(/\r?\n/);
  const visit = (node, parent = null) => {
    if (node?.type === "heading") {
      const sourceStart = node.position?.start?.offset;
      const sourceEnd = node.position?.end?.offset;
      const contentStart = node.children?.[0]?.position?.start?.offset;
      const contentEnd = node.children?.at(-1)?.position?.end?.offset;
      if (Number.isFinite(contentStart) && Number.isFinite(contentEnd)) {
        node.headingContentStart = contentStart;
        node.headingContentEnd = contentEnd;
      }
      if (
        parent?.type === "root"
        && Number.isFinite(sourceStart)
        && Number.isFinite(sourceEnd)
      ) {
        node.headingSource = source.slice(sourceStart, sourceEnd);
        node.headingSourceSignature = headingSemanticSignature(node);
        node.headingSourceStart = sourceStart;
      }
      const startLine = node.position?.start?.line;
      const startColumn = node.position?.start?.column;
      const endLine = node.position?.end?.line;
      if (Number.isFinite(startLine) && Number.isFinite(startColumn) && Number.isFinite(endLine)) {
        const openingLine = lines[startLine - 1]?.slice(startColumn - 1) || "";
        const atx = openingLine.match(/^(#{1,6})(?:[\t ]+|$)/);
        if (atx) {
          const closing = openingLine.match(/[\t ]+(#+)[\t ]*$/)?.[1] || "";
          node.markdownStyle = "atx";
          node.atxClosingLength = closing.length;
        } else if (node.depth <= 2) {
          const underline = lines[endLine - 1]?.match(/([=-]+)[\t ]*$/)?.[1] || "";
          const marker = underline[0];
          if ((node.depth === 1 && marker === "=") || (node.depth === 2 && marker === "-")) {
            node.markdownStyle = "setext";
            node.setextMarker = marker;
            node.setextLength = underline.length;
          }
        }
      }
    }
    (node?.children || []).forEach((child) => visit(child, node));
  };
  visit(tree);
  return tree;
}

export function headingSemanticSignature(node) {
  return JSON.stringify({
    depth: Number(node?.depth) || 1,
    content: paragraphSemanticSignature(node)
  });
}

export const sourceFaithfulHeadingRemark = $remark(
  "tetherSourceFaithfulHeading",
  () => () => annotateHeadingMarkers
);

function serializeHeadingChildren(state, node) {
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

export const sourceFaithfulHeadingSchema = headingSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      markdownStyle: { default: "atx", validate: "string" },
      setextMarker: { default: "=", validate: "string" },
      setextLength: { default: 3, validate: "number" },
      atxClosingLength: { default: 0, validate: "number" },
      headingSource: { default: null, validate: "string|null" },
      headingSourceSignature: { default: null, validate: "string|null" },
      headingSourceStart: { default: null, validate: "number|null" },
      headingContentStart: { default: null, validate: "number|null" },
      headingContentEnd: { default: null, validate: "number|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          headingSource: dom.getAttribute?.("data-md-heading-source") ?? null,
          headingSourceSignature: dom.getAttribute?.("data-md-heading-signature") ?? null,
          headingSourceStart: dom.hasAttribute?.("data-md-heading-source-start")
            ? Number(dom.getAttribute("data-md-heading-source-start"))
            : null,
          headingContentStart: dom.hasAttribute?.("data-md-heading-content-start")
            ? Number(dom.getAttribute("data-md-heading-content-start"))
            : null,
          headingContentEnd: dom.hasAttribute?.("data-md-heading-content-end")
            ? Number(dom.getAttribute("data-md-heading-content-end"))
            : null
        };
      }
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      const marker = node.attrs.markdownStyle === "setext"
        ? String(node.attrs.setextMarker || (node.attrs.level === 1 ? "=" : "-")).repeat(
            Math.max(1, Number(node.attrs.setextLength) || 1)
          )
        : "";
      return [
        dom[0],
        {
          ...dom[1],
          "data-md-heading-style": node.attrs.markdownStyle,
          ...(marker ? { "data-md-heading-marker": marker } : {}),
          ...(node.attrs.headingSource == null
            ? {}
            : { "data-md-heading-source": node.attrs.headingSource }),
          ...(node.attrs.headingSourceSignature == null
            ? {}
            : { "data-md-heading-signature": node.attrs.headingSourceSignature }),
          ...(node.attrs.headingSourceStart == null
            ? {}
            : { "data-md-heading-source-start": node.attrs.headingSourceStart }),
          ...(node.attrs.headingContentStart == null
            ? {}
            : { "data-md-heading-content-start": node.attrs.headingContentStart }),
          ...(node.attrs.headingContentEnd == null
            ? {}
            : { "data-md-heading-content-end": node.attrs.headingContentEnd })
        },
        dom[2]
      ];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        state.openNode(type, {
          level: node.depth,
          markdownStyle: node.markdownStyle || "atx",
          setextMarker: node.setextMarker || (node.depth === 1 ? "=" : "-"),
          setextLength: node.setextLength || 3,
          atxClosingLength: node.atxClosingLength || 0,
          headingSource: node.headingSource ?? null,
          headingSourceSignature: node.headingSourceSignature ?? null,
          headingSourceStart: node.headingSourceStart ?? null,
          headingContentStart: node.headingContentStart ?? null,
          headingContentEnd: node.headingContentEnd ?? null
        });
        state.next(node.children);
        state.closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        state.openNode("heading", undefined, {
          depth: node.attrs.level,
          markdownStyle: node.attrs.markdownStyle,
          setextMarker: node.attrs.setextMarker,
          setextLength: node.attrs.setextLength,
          atxClosingLength: node.attrs.atxClosingLength,
          headingSource: node.attrs.headingSource,
          headingSourceSignature: node.attrs.headingSourceSignature,
          headingSourceStart: node.attrs.headingSourceStart,
          headingContentStart: node.attrs.headingContentStart,
          headingContentEnd: node.attrs.headingContentEnd
        });
        serializeHeadingChildren(state, node);
        state.closeNode();
      }
    }
  };
});

function containsLineBreak(node) {
  if (node.type === "break") return true;
  if (typeof node.value === "string" && /\r?\n|\r/.test(node.value)) return true;
  return (node.children || []).some(containsLineBreak);
}

function encodeLeadingWhitespace(value) {
  if (!/^[\t ]/.test(value)) return value;
  return `&#x${value.charCodeAt(0).toString(16).toUpperCase()};${value.slice(1)}`;
}

export function sourceFaithfulHeadingHandler(node, _parent, state, info) {
  if (
    node.headingSource != null
    && node.headingSourceSignature != null
    && headingSemanticSignature(node) === node.headingSourceSignature
  ) return node.headingSource;
  const rank = Math.max(Math.min(6, node.depth || 1), 1);
  const tracker = state.createTracker(info);
  const useSetext = node.markdownStyle === "setext"
    && rank <= 2
    && !containsLineBreak(node);

  if (useSetext) {
    const exit = state.enter("headingSetext");
    const phrasingExit = state.enter("phrasing");
    const value = state.containerPhrasing(node, {
      ...tracker.current(),
      before: "\n",
      after: "\n"
    });
    phrasingExit();
    exit();
    if (value) {
      const marker = node.setextMarker === "-" ? "-" : "=";
      const length = Math.max(1, Number(node.setextLength) || 1);
      return `${value}\n${marker.repeat(length)}`;
    }
  }

  const sequence = "#".repeat(rank);
  const exit = state.enter("headingAtx");
  const phrasingExit = state.enter("phrasing");
  tracker.move(`${sequence} `);
  let value = state.containerPhrasing(node, {
    before: "# ",
    after: "\n",
    ...tracker.current()
  });
  value = encodeLeadingWhitespace(value);
  value = value ? `${sequence} ${value}` : sequence;
  const closingLength = Number(node.atxClosingLength) || 0;
  if (closingLength > 0) value += ` ${"#".repeat(closingLength)}`;
  else if (state.options.closeAtx) value += ` ${sequence}`;
  phrasingExit();
  exit();
  return value;
}
