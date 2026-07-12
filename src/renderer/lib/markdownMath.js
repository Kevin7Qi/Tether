import { nodesCtx } from "@milkdown/kit/core";
import { $remark } from "@milkdown/kit/utils";
import { mathToMarkdown } from "mdast-util-math";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function structuralPrefix(prefix) {
  let rest = prefix;
  while (rest) {
    const whitespace = rest.match(/^[\t ]+/)?.[0];
    if (whitespace) {
      rest = rest.slice(whitespace.length);
      continue;
    }
    const quote = rest.match(/^>[\t ]?/)?.[0];
    if (quote) {
      rest = rest.slice(quote.length);
      continue;
    }
    const list = rest.match(/^(?:[-+*]|\d{1,9}[.)])[\t ]+/)?.[0];
    if (list) {
      rest = rest.slice(list.length);
      continue;
    }
    return false;
  }
  return true;
}

function mathFenceOnLine(line, closing = false) {
  for (const match of line.matchAll(/\${2,}/g)) {
    const prefix = line.slice(0, match.index);
    const suffix = line.slice(match.index + match[0].length);
    if (!structuralPrefix(prefix)) continue;
    if (closing && !/^[\t ]*$/.test(suffix)) continue;
    if (!closing && suffix.includes("$")) continue;
    return { prefix, sequence: match[0], suffix };
  }
  return null;
}

function sourceLines(source) {
  const lines = [];
  let offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const value = line.replace(/\r?\n$/, "");
    lines.push({ value, start: offset, end: offset + value.length });
    offset += line.length;
  }
  return lines;
}

export function scanMathBlocks(source) {
  const lines = sourceLines(source);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = mathFenceOnLine(lines[index].value);
    if (!opening) continue;
    let closing = null;
    let closingIndex = index + 1;
    for (; closingIndex < lines.length; closingIndex += 1) {
      closing = mathFenceOnLine(lines[closingIndex].value, true);
      if (closing) break;
    }
    if (!closing) continue;
    blocks.push({
      start: lines[index].start,
      end: lines[closingIndex].end,
      openingLength: opening.sequence.length,
      closingLength: closing.sequence.length,
      openingSuffix: opening.suffix,
      openingPrefix: opening.prefix,
      closingPrefix: closing.prefix
    });
    index = closingIndex;
  }
  return blocks;
}

export function annotateMathSources(tree, file) {
  const source = sourceText(file);
  const blocks = scanMathBlocks(source);
  let blockIndex = 0;
  const visit = (node, ancestors = []) => {
    if (node?.type === "inlineMath") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const delimiterLength = raw.match(/^\$+/)?.[0].length || 1;
        node.mathSource = raw;
        node.mathSourceValue = node.value || "";
        node.mathDelimiterLength = delimiterLength;
        node.mathRawContent = raw.slice(delimiterLength, -delimiterLength);
      }
    }
    if (node?.type === "math") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const lines = raw.split(/\r?\n/);
        const opening = lines[0]?.match(/^(\${2,})(.*)$/);
        const closing = lines.at(-1)?.match(/(\${2,})[\t ]*$/);
        if (opening && closing) {
          node.mathBlock = true;
          node.mathOpeningLength = opening[1].length;
          node.mathClosingLength = closing[1].length;
          node.mathOpeningSuffix = opening[2];
          node.mathSourceValue = node.value || "";
          if (ancestors.at(-1)?.type === "root") node.mathSource = raw;
        }
      }
    }
    if (
      node?.type === "code"
      && !node.position
      && String(node.lang || "").toLowerCase() === "latex"
    ) {
      const block = blocks[blockIndex++];
      if (block) {
        node.mathBlock = true;
        node.mathOpeningLength = block.openingLength;
        node.mathClosingLength = block.closingLength;
        node.mathOpeningSuffix = block.openingSuffix;
        node.mathSourceValue = node.value || "";
        if (ancestors.at(-1)?.type === "root") {
          node.mathSource = source.slice(block.start, block.end);
        }
      }
    }
    (node?.children || []).forEach((child) => visit(child, [...ancestors, node]));
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulMathRemark = $remark(
  "tetherSourceFaithfulMath",
  () => () => annotateMathSources
);

function mathDomSourceAttrs(attrs) {
  return {
    ...(attrs.mathSource == null ? {} : { "data-md-math-source": attrs.mathSource }),
    ...(attrs.mathSourceValue == null
      ? {}
      : { "data-md-math-source-value": attrs.mathSourceValue }),
    "data-md-math-delimiter": attrs.mathDelimiterLength,
    ...(attrs.mathRawContent == null ? {} : { "data-md-math-raw": attrs.mathRawContent })
  };
}

function sourceFaithfulInlineMathSpec(spec) {
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      value: { default: "", validate: "string" },
      mathSource: { default: null, validate: "string|null" },
      mathSourceValue: { default: null, validate: "string|null" },
      mathDelimiterLength: { default: 1, validate: "number" },
      mathRawContent: { default: null, validate: "string|null" }
    },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs: (dom) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom) : {};
        if (attrs === false) return false;
        return {
          ...(attrs || {}),
          mathSource: dom.getAttribute("data-md-math-source"),
          mathSourceValue: dom.getAttribute("data-md-math-source-value"),
          mathDelimiterLength: Number(dom.getAttribute("data-md-math-delimiter")) || 1,
          mathRawContent: dom.getAttribute("data-md-math-raw")
        };
      }
    })),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      const attrs = mathDomSourceAttrs(node.attrs);
      if (typeof dom?.setAttribute === "function") {
        Object.entries(attrs).forEach(([name, value]) => dom.setAttribute(name, String(value)));
        return dom;
      }
      if (Array.isArray(dom)) {
        return [dom[0], { ...(dom[1] || {}), ...attrs }, ...dom.slice(2)];
      }
      return dom;
    },
    parseMarkdown: {
      match: (node) => node.type === "inlineMath",
      runner: (state, node, type) => state.addNode(type, {
        value: node.value || "",
        mathSource: node.mathSource ?? null,
        mathSourceValue: node.mathSourceValue ?? node.value ?? "",
        mathDelimiterLength: node.mathDelimiterLength || 1,
        mathRawContent: node.mathRawContent ?? null
      })
    },
    toMarkdown: {
      match: (node) => node.type.name === "math_inline",
      runner: (state, node) => state.addNode("inlineMath", undefined, node.attrs.value, {
        mathSource: node.attrs.mathSource,
        mathSourceValue: node.attrs.mathSourceValue,
        mathDelimiterLength: node.attrs.mathDelimiterLength,
        mathRawContent: node.attrs.mathRawContent
      })
    }
  };
}

export const sourceFaithfulInlineMathSchema = (ctx) => {
  let previous = null;
  let replacement = null;
  return async () => {
    const entry = ctx.get(nodesCtx).find(([name]) => name === "math_inline");
    if (!entry) throw new Error("Crepe math_inline schema must be registered before Tether's extension");
    previous = entry[1];
    replacement = sourceFaithfulInlineMathSpec(previous);
    ctx.update(nodesCtx, (nodes) => nodes.map(([name, spec]) =>
      name === "math_inline" ? [name, replacement] : [name, spec]));
    return () => {
      ctx.update(nodesCtx, (nodes) => nodes.map(([name, spec]) =>
        name === "math_inline" && spec === replacement ? [name, previous] : [name, spec]));
    };
  };
};

function longestDollarRun(value) {
  return [...value.matchAll(/\$+/g)].reduce((longest, match) => Math.max(longest, match[0].length), 0);
}

export function sourceFaithfulInlineMathHandler(node, parent, state, info) {
  if (
    node.mathSource != null
    && node.mathSourceValue != null
    && node.value === node.mathSourceValue
  ) return node.mathSource;

  if (node.mathDelimiterLength == null) {
    return mathToMarkdown().handlers.inlineMath(node, parent, state, info);
  }
  const preferredLength = Math.max(1, Number(node.mathDelimiterLength) || 1);
  const delimiterLength = Math.max(preferredLength, longestDollarRun(node.value || "") + 1);
  const delimiter = "$".repeat(delimiterLength);
  let value = node.value || "";
  const preservePadding = typeof node.mathRawContent === "string"
    && node.mathRawContent.startsWith(" ")
    && node.mathRawContent.endsWith(" ")
    && /[^ ]/.test(node.mathRawContent);
  const requiredPadding = /[^ \r\n]/.test(value)
    && ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^\$|\$$/.test(value));
  if (preservePadding || requiredPadding) value = ` ${value} `;
  return `${delimiter}${value}${delimiter}`;
}

export function sourceFaithfulMathBlockHandler(node, parent, state, info) {
  if (
    node.mathSource != null
    && node.mathSourceValue != null
    && node.value === node.mathSourceValue
  ) return node.mathSource;

  if (!node.mathBlock) return mathToMarkdown().handlers.math(node, parent, state, info);
  const raw = node.value || "";
  const openingLength = Math.max(2, Number(node.mathOpeningLength) || 2, longestDollarRun(raw) + 1);
  const closingLength = Math.max(openingLength, Number(node.mathClosingLength) || openingLength);
  const opening = "$".repeat(openingLength);
  const closing = "$".repeat(closingLength);
  const suffix = typeof node.mathOpeningSuffix === "string" ? node.mathOpeningSuffix : "";
  return `${opening}${suffix}\n${raw ? `${raw}\n` : ""}${closing}`;
}

sourceFaithfulInlineMathHandler.peek = () => "$";
