import { emphasisSchema, strongSchema } from "@milkdown/kit/preset/commonmark";
import { Fragment } from "@milkdown/kit/prose/model";
import { SerializerReady, schemaCtx, serializerCtx } from "@milkdown/kit/core";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

const attentionTypes = new Set(["emphasis", "strong"]);
const metadataKeys = new Set([
  "attentionGroupPattern",
  "attentionGroupOuter",
  "attentionGroupSignature",
  "attentionGroupSource",
  "isMark",
  "marker",
  "position"
]);

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function semanticValue(value) {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (!value || typeof value !== "object") return value;

  if (attentionTypes.has(value.type)) {
    const marks = [];
    let current = value;
    while (
      attentionTypes.has(current?.type)
      && current.children?.length === 1
      && attentionTypes.has(current.children[0]?.type)
    ) {
      marks.push(current.type);
      current = current.children[0];
    }
    if (attentionTypes.has(current?.type)) marks.push(current.type);
    return {
      type: "attention",
      marks: marks.sort(),
      children: semanticValue(current.children || [])
    };
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (metadataKeys.has(key)) continue;
    result[key] = semanticValue(value[key]);
  }
  return result;
}

export function attentionSemanticSignature(node) {
  return JSON.stringify(semanticValue(node));
}

function markerAtSource(node, source) {
  const start = node.position?.start?.offset;
  const marker = Number.isFinite(start) ? source[start] : null;
  return marker === "_" ? "_" : "*";
}

function coextensivePattern(node) {
  const pattern = [];
  let current = node;
  while (attentionTypes.has(current?.type)) {
    pattern.push({ type: current.type, marker: current.marker === "_" ? "_" : "*" });
    if (current.children?.length !== 1 || !attentionTypes.has(current.children[0]?.type)) break;
    current = current.children[0];
  }
  return pattern.length > 1 ? pattern : null;
}

function attentionDescendants(node, callback) {
  if (attentionTypes.has(node?.type)) callback(node);
  (node?.children || []).forEach((child) => attentionDescendants(child, callback));
}

export function annotateAttentionSources(tree, file) {
  const source = sourceText(file);
  const annotateMarkers = (node) => {
    if (attentionTypes.has(node?.type)) node.marker = markerAtSource(node, source);
    (node?.children || []).forEach(annotateMarkers);
  };
  annotateMarkers(tree);

  const visit = (node, parent = null) => {
    if (attentionTypes.has(node?.type) && !attentionTypes.has(parent?.type)) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const groupSource = source.slice(start, end);
        const groupSignature = attentionSemanticSignature(node);
        const groupPattern = coextensivePattern(node);
        attentionDescendants(node, (descendant) => {
          descendant.attentionGroupSource = groupSource;
          descendant.attentionGroupSignature = groupSignature;
          descendant.attentionGroupPattern = groupPattern ? JSON.stringify(groupPattern) : null;
          descendant.attentionGroupOuter = node.type;
        });
      }
    }

    (node?.children || []).forEach((child) => visit(child, node));
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulAttentionRemark = $remark(
  "tetherSourceFaithfulAttention",
  () => () => annotateAttentionSources
);

function extendAttentionSchema(schema) {
  return schema.extendSchema((previous) => (ctx) => {
    const spec = previous(ctx);
    return {
      ...spec,
      attrs: {
        ...spec.attrs,
        attentionGroupSource: { default: null, validate: "string|null" },
        attentionGroupSignature: { default: null, validate: "string|null" },
        attentionGroupPattern: { default: null, validate: "string|null" },
        attentionGroupOuter: { default: null, validate: "string|null" }
      },
      parseDOM: (spec.parseDOM || []).map((rule) => ({
        ...rule,
        getAttrs: (dom) => {
          const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
          if (attrs === false) return false;
          return {
            ...(attrs || {}),
            marker: dom.getAttribute?.("data-md-attention-marker") === "_" ? "_" : "*",
            attentionGroupSource: dom.getAttribute?.("data-md-attention-source") ?? null,
            attentionGroupSignature: dom.getAttribute?.("data-md-attention-signature") ?? null,
            attentionGroupPattern: dom.getAttribute?.("data-md-attention-pattern") ?? null,
            attentionGroupOuter: dom.getAttribute?.("data-md-attention-outer") ?? null
          };
        }
      })),
      toDOM: (mark) => {
        const dom = spec.toDOM(mark);
        return [dom[0], {
          ...(dom[1] || {}),
          "data-md-attention-marker": mark.attrs.marker,
          ...(mark.attrs.attentionGroupSource == null
            ? {}
            : { "data-md-attention-source": mark.attrs.attentionGroupSource }),
          ...(mark.attrs.attentionGroupSignature == null
            ? {}
            : { "data-md-attention-signature": mark.attrs.attentionGroupSignature }),
          ...(mark.attrs.attentionGroupPattern == null
            ? {}
            : { "data-md-attention-pattern": mark.attrs.attentionGroupPattern }),
          ...(mark.attrs.attentionGroupOuter == null
            ? {}
            : { "data-md-attention-outer": mark.attrs.attentionGroupOuter })
        }, ...dom.slice(2)];
      },
      parseMarkdown: {
        ...spec.parseMarkdown,
        runner: (state, node, markType) => {
          state.openMark(markType, {
            marker: node.marker === "_" ? "_" : "*",
            attentionGroupSource: node.attentionGroupSource ?? null,
            attentionGroupSignature: node.attentionGroupSignature ?? null,
            attentionGroupPattern: node.attentionGroupPattern ?? null,
            attentionGroupOuter: node.attentionGroupOuter ?? null
          });
          state.next(node.children);
          state.closeMark(markType);
        }
      },
      toMarkdown: {
        ...spec.toMarkdown,
        runner: (state, mark) => {
          state.withMark(mark, mark.type.name, undefined, {
            marker: mark.attrs.marker,
            attentionGroupSource: mark.attrs.attentionGroupSource,
            attentionGroupSignature: mark.attrs.attentionGroupSignature,
            attentionGroupPattern: mark.attrs.attentionGroupPattern,
            attentionGroupOuter: mark.attrs.attentionGroupOuter
          });
        }
      }
    };
  });
}

export const sourceFaithfulEmphasisSchema = extendAttentionSchema(emphasisSchema);
export const sourceFaithfulStrongSchema = extendAttentionSchema(strongSchema);

export const serializationAttentionGroupSchema = $nodeSchema(
  "tether_attention_group",
  () => ({
    inline: true,
    group: "inline",
    content: "inline*",
    parseDOM: [],
    toDOM: () => ["span", 0],
    parseMarkdown: { match: () => false, runner: () => {} },
    toMarkdown: {
      match: (node) => node.type.name === "tether_attention_group",
      runner: (state, node) => state.next(node.content)
    }
  })
);

function childEntries(parent) {
  const entries = [];
  parent.forEach((child, offset) => entries.push({ child, from: offset, to: offset + child.nodeSize }));
  return entries;
}

function markRun(entries, index, mark) {
  let start = index;
  let end = index;
  while (start > 0 && entries[start - 1].child.marks.some((candidate) => candidate.eq(mark))) start -= 1;
  while (
    end + 1 < entries.length
    && entries[end + 1].child.marks.some((candidate) => candidate.eq(mark))
  ) end += 1;
  return { from: entries[start].from, to: entries[end].to };
}

function markRunIndexes(entries, index, mark) {
  let start = index;
  let end = index;
  while (start > 0 && entries[start - 1].child.marks.some((candidate) => candidate.eq(mark))) start -= 1;
  while (
    end + 1 < entries.length
    && entries[end + 1].child.marks.some((candidate) => candidate.eq(mark))
  ) end += 1;
  return { start, end };
}

function emphasisBelongsInsideStrong(entries, index, emphasis, strong) {
  if (emphasis.attrs.attentionGroupOuter === "strong" || strong.attrs.attentionGroupOuter === "strong") {
    return true;
  }
  const emphasisRun = markRun(entries, index, emphasis);
  const strongRun = markRun(entries, index, strong);
  return strongRun.from <= emphasisRun.from
    && strongRun.to >= emphasisRun.to
    && (strongRun.from < emphasisRun.from || strongRun.to > emphasisRun.to);
}

function strongBelongsInsideEmphasis(entries, index, emphasis, strong) {
  if (emphasis.attrs.attentionGroupOuter === "emphasis" || strong.attrs.attentionGroupOuter === "emphasis") {
    return true;
  }
  const emphasisRun = markRun(entries, index, emphasis);
  const strongRun = markRun(entries, index, strong);
  return emphasisRun.from <= strongRun.from
    && emphasisRun.to >= strongRun.to
    && (emphasisRun.from < strongRun.from || emphasisRun.to > strongRun.to);
}

export function attentionSerializationDocument(doc, proseSchema) {
  const groupType = proseSchema.nodes.tether_attention_group;
  if (!groupType) return doc;

  const transform = (node) => {
    if (node.isTextblock) {
      const entries = childEntries(node);
      const outerMarks = [];
      entries.forEach(({ child }, index) => {
        const emphasis = child.marks.find((mark) => mark.type.name === "emphasis");
        const strong = child.marks.find((mark) => mark.type.name === "strong");
        if (!emphasis || !strong) return;
        let outer = null;
        if (emphasisBelongsInsideStrong(entries, index, emphasis, strong)) {
          outer = strong;
        } else if (strongBelongsInsideEmphasis(entries, index, emphasis, strong)) {
          outer = emphasis;
        } else if (!emphasis.attrs.attentionGroupOuter && !strong.attrs.attentionGroupOuter) {
          // A newly-created coextensive pair has no source order to preserve;
          // use the conventional emphasis-outside-strong order.
          outer = emphasis;
        }
        if (outer && !outerMarks.some((candidate) => candidate.mark.eq(outer))) {
          outerMarks.push({ mark: outer, ...markRunIndexes(entries, index, outer) });
        }
      });

      const groupsByStart = new Map(outerMarks.map((group) => [group.start, group]));
      const children = [];
      for (let index = 0; index < entries.length; index += 1) {
        const group = groupsByStart.get(index);
        if (!group) {
          children.push(entries[index].child);
          continue;
        }
        const content = entries.slice(group.start, group.end + 1).map(({ child }) =>
          child.mark(child.marks.filter((mark) => !mark.eq(group.mark))));
        children.push(groupType.create(null, Fragment.fromArray(content), [group.mark]));
        index = group.end;
      }
      return node.copy(Fragment.fromArray(children));
    }
    if (node.isLeaf) return node;
    const children = [];
    node.content.forEach((child) => children.push(transform(child)));
    return node.copy(Fragment.fromArray(children));
  };

  return transform(doc);
}

export const sourceFaithfulAttentionSerializer = (ctx) => {
  let wrapped = null;
  let previous = null;
  return async () => {
    await ctx.wait(SerializerReady);
    previous = ctx.get(serializerCtx);
    const proseSchema = ctx.get(schemaCtx);
    wrapped = (doc) => previous(attentionSerializationDocument(doc, proseSchema));
    ctx.set(serializerCtx, wrapped);
    return () => {
      if (ctx.get(serializerCtx) === wrapped) ctx.set(serializerCtx, previous);
    };
  };
};

function parsePattern(value) {
  if (typeof value !== "string") return null;
  try {
    const pattern = JSON.parse(value);
    return Array.isArray(pattern)
      && pattern.length > 1
      && pattern.every(({ type, marker }) => attentionTypes.has(type) && ["*", "_"].includes(marker))
      ? pattern
      : null;
  } catch {
    return null;
  }
}

function currentCoextensiveChain(node) {
  const chain = [];
  let current = node;
  while (attentionTypes.has(current?.type)) {
    chain.push(current.type);
    if (current.children?.length !== 1 || !attentionTypes.has(current.children[0]?.type)) break;
    current = current.children[0];
  }
  return { chain, content: current.children || [] };
}

function sameMarkSet(pattern, chain) {
  return pattern.map(({ type }) => type).sort().join("|") === [...chain].sort().join("|");
}

function syntheticAttention(pattern, content) {
  let children = content;
  for (let index = pattern.length - 1; index >= 0; index -= 1) {
    const { type, marker } = pattern[index];
    children = [{ type, marker, children }];
  }
  return children[0];
}

function markerAwareDefault(node, parent, state, info) {
  const type = node.type === "strong" ? "strong" : "emphasis";
  const marker = node.marker === "_" ? "_" : "*";
  const previous = state.options[type];
  state.options[type] = marker;
  try {
    return defaultHandlers[type](node, parent, state, info);
  } finally {
    if (previous == null) delete state.options[type];
    else state.options[type] = previous;
  }
}

export function sourceFaithfulAttentionHandler(node, parent, state, info) {
  if (
    node.attentionGroupSource != null
    && node.attentionGroupSignature != null
    && attentionSemanticSignature(node) === node.attentionGroupSignature
  ) return node.attentionGroupSource;

  const pattern = parsePattern(node.attentionGroupPattern);
  if (pattern) {
    const { chain, content } = currentCoextensiveChain(node);
    if (chain.length === pattern.length && sameMarkSet(pattern, chain)) {
      return markerAwareDefault(syntheticAttention(pattern, content), parent, state, info);
    }
  }

  return markerAwareDefault(node, parent, state, info);
}

sourceFaithfulAttentionHandler.peek = defaultHandlers.emphasis.peek;
