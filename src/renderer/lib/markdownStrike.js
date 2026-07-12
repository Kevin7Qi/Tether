import { strikethroughSchema } from "@milkdown/kit/preset/gfm";
import { markRule } from "@milkdown/kit/prose";
import { $inputRule, $remark } from "@milkdown/kit/utils";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function semanticValue(value) {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (
      key === "position"
      || key === "strikeMarkerLength"
      || key === "strikeSource"
      || key === "strikeSourceSignature"
    ) continue;
    result[key] = semanticValue(value[key]);
  }
  return result;
}

export function strikeSemanticSignature(node) {
  return JSON.stringify(semanticValue(node));
}

export function annotateStrikeSources(tree, file) {
  const source = sourceText(file);
  const visit = (node) => {
    if (node?.type === "delete") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const markerLength = raw.match(/^~{1,2}(?!~)/)?.[0].length;
        const marker = markerLength ? "~".repeat(markerLength) : "";
        if (marker && raw.endsWith(marker) && raw.length >= markerLength * 2) {
          node.strikeMarkerLength = markerLength;
          node.strikeSource = raw;
          node.strikeSourceSignature = strikeSemanticSignature(node);
        }
      }
    }
    (node?.children || []).forEach(visit);
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulStrikeRemark = $remark(
  "tetherSourceFaithfulStrike",
  () => () => annotateStrikeSources
);

export const sourceFaithfulStrikeSchema = strikethroughSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      strikeMarkerLength: { default: 2, validate: "number" },
      strikeSource: { default: null, validate: "string|null" },
      strikeSourceSignature: { default: null, validate: "string|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          strikeMarkerLength: Number(dom.getAttribute?.("data-md-strike-marker")) || 2,
          strikeSource: dom.getAttribute?.("data-md-strike-source") ?? null,
          strikeSourceSignature: dom.getAttribute?.("data-md-strike-signature") ?? null
        };
      }
    })),
    toDOM: (mark) => {
      const dom = spec.toDOM(mark);
      return [dom[0], {
        ...(dom[1] || {}),
        "data-md-strike-marker": mark.attrs.strikeMarkerLength,
        ...(mark.attrs.strikeSource == null
          ? {}
          : { "data-md-strike-source": mark.attrs.strikeSource }),
        ...(mark.attrs.strikeSourceSignature == null
          ? {}
          : { "data-md-strike-signature": mark.attrs.strikeSourceSignature })
      }, ...dom.slice(2)];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, markType) => {
        state.openMark(markType, {
          strikeMarkerLength: node.strikeMarkerLength || 2,
          strikeSource: node.strikeSource ?? null,
          strikeSourceSignature: node.strikeSourceSignature ?? null
        });
        state.next(node.children);
        state.closeMark(markType);
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, mark) => {
        state.withMark(mark, "delete", undefined, {
          strikeMarkerLength: mark.attrs.strikeMarkerLength,
          strikeSource: mark.attrs.strikeSource,
          strikeSourceSignature: mark.attrs.strikeSourceSignature
        });
      }
    }
  };
});

export function strikeInputAttributes(match) {
  return { strikeMarkerLength: match?.[1]?.length === 1 ? 1 : 2 };
}

export const sourceFaithfulStrikeInputRule = $inputRule((ctx) => markRule(
  /(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/,
  sourceFaithfulStrikeSchema.type(ctx),
  { getAttr: strikeInputAttributes }
));

export function sourceFaithfulStrikeHandler(node, _parent, state, info) {
  if (
    node.strikeSource != null
    && node.strikeSourceSignature != null
    && strikeSemanticSignature(node) === node.strikeSourceSignature
  ) return node.strikeSource;

  const markerLength = Number(node.strikeMarkerLength) === 1 ? 1 : 2;
  const marker = "~".repeat(markerLength);
  const tracker = state.createTracker(info);
  const exit = state.enter("strikethrough");
  let value = tracker.move(marker);
  value += state.containerPhrasing(node, {
    ...tracker.current(),
    before: value,
    after: "~"
  });
  value += tracker.move(marker);
  exit();
  return value;
}

sourceFaithfulStrikeHandler.peek = () => "~";
