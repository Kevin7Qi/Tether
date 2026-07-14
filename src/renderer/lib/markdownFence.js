import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { textblockTypeInputRule } from "@milkdown/kit/prose/inputrules";
import { TextSelection } from "@milkdown/kit/prose/state";
import { $inputRule, $remark, $shortcut } from "@milkdown/kit/utils";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function fenceRun(line) {
  return line.match(/^[\t ]{0,3}(`{3,}|~{3,})/)?.[1] || null;
}

function closingFenceRun(line) {
  return line.match(/(`{3,}|~{3,})[\t ]*$/)?.[1] || null;
}

function openingFenceLayout(line, fence, language = "", meta = "") {
  const remainder = line.slice(line.indexOf(fence) + fence.length);
  if (!language) {
    return {
      fenceLanguagePrefix: "",
      fenceMetaPrefix: " ",
      fenceOpeningTrailing: remainder
    };
  }
  const languageIndex = remainder.indexOf(language);
  if (languageIndex < 0) {
    return {
      fenceLanguagePrefix: "",
      fenceMetaPrefix: " ",
      fenceOpeningTrailing: ""
    };
  }
  const afterLanguage = languageIndex + language.length;
  if (!meta) {
    return {
      fenceLanguagePrefix: remainder.slice(0, languageIndex),
      fenceMetaPrefix: " ",
      fenceOpeningTrailing: remainder.slice(afterLanguage)
    };
  }
  const metaIndex = remainder.indexOf(meta, afterLanguage);
  if (metaIndex < 0) {
    return {
      fenceLanguagePrefix: remainder.slice(0, languageIndex),
      fenceMetaPrefix: " ",
      fenceOpeningTrailing: ""
    };
  }
  return {
    fenceLanguagePrefix: remainder.slice(0, languageIndex),
    fenceMetaPrefix: remainder.slice(afterLanguage, metaIndex),
    fenceOpeningTrailing: remainder.slice(metaIndex + meta.length)
  };
}

export function typedCodeFenceAttributes(openingLine, options = {}) {
  const match = String(openingLine || "").match(/^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/);
  if (!match) return null;
  const openingIndent = match[1];
  const fence = match[2];
  const rawInfo = match[3];
  if (fence[0] === "`" && rawInfo.includes("`")) return null;

  const leading = rawInfo.match(/^[\t ]*/)?.[0] || "";
  const trailingMatch = rawInfo.match(/[\t ]*$/)?.[0] || "";
  const infoEnd = Math.max(leading.length, rawInfo.length - trailingMatch.length);
  const info = rawInfo.slice(leading.length, infoEnd);
  const trailing = info ? rawInfo.slice(infoEnd) : rawInfo;
  const infoPrefix = info ? leading : "";
  const languageMatch = info.match(/^(\S+)([\t ]+(.+))?$/);
  const language = languageMatch?.[1] || "";
  const meta = languageMatch?.[3] || null;
  const metaPrefix = meta ? languageMatch[2].slice(0, -meta.length) : " ";
  const lineEnding = options.lineEnding === "\r\n" ? "\r\n" : "\n";
  const closed = options.closed !== false;
  const closingIndent = options.closingIndent ?? openingIndent;
  const closingLength = Math.max(fence.length, Number(options.closingFenceLength) || fence.length);
  const opening = `${openingIndent}${fence}${infoPrefix}${language}${meta ? `${metaPrefix}${meta}` : ""}${trailing}`;
  const closing = `${closingIndent}${fence[0].repeat(closingLength)}`;
  const fenceSource = `${opening}${lineEnding}${closed ? closing : ""}`;

  return {
    language,
    meta,
    fenceMarker: fence[0],
    fenceLength: fence.length,
    closingFenceLength: closingLength,
    fenceClosed: closed,
    fenceLineEnding: lineEnding,
    fenceTrailingLineEnding: "",
    fenceSource,
    fenceSourceSignature: codeSemanticSignature({ value: "", lang: language, meta }),
    fenceOpeningIndent: openingIndent,
    fenceClosingIndent: closingIndent,
    fenceLanguagePrefix: infoPrefix,
    fenceMetaPrefix: metaPrefix,
    fenceOpeningTrailing: trailing
  };
}

export function typedCodeFenceTransaction(state) {
  const { selection } = state;
  if (!selection.empty || selection.$from.depth !== 1) return null;
  const paragraph = selection.$from.parent;
  if (paragraph.type.name !== "paragraph" || selection.$from.parentOffset !== paragraph.content.size) return null;
  const attrs = typedCodeFenceAttributes(paragraph.textContent);
  const codeType = state.schema.nodes.code_block;
  if (!attrs || !codeType) return null;
  const from = selection.$from.before();
  const to = selection.$from.after();
  const transaction = state.tr.replaceWith(from, to, codeType.create(attrs));
  return transaction.setSelection(TextSelection.create(transaction.doc, from + 1));
}

function frontmatterBlock(source) {
  const opening = source.match(/^(---[\t ]*)(\r\n|\n)/);
  if (!opening) return null;
  const lineEnding = opening[2];
  const contentStart = opening[0].length;
  let lineStart = contentStart;
  let line = 2;

  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const rawLine = source.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (/^(?:---|\.\.\.)[\t ]*$/.test(rawLine)) {
      const closingEnd = lineStart + rawLine.length;
      let value = source.slice(contentStart, lineStart);
      if (value.endsWith("\r\n")) value = value.slice(0, -2);
      else if (value.endsWith("\n")) value = value.slice(0, -1);
      return {
        type: "code",
        lang: "yaml",
        meta: null,
        value: value.replace(/\r\n/g, "\n"),
        frontmatterBlock: true,
        frontmatterOpening: opening[1],
        frontmatterClosing: rawLine,
        fenceLineEnding: lineEnding,
        position: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line, column: rawLine.length + 1, offset: closingEnd }
        }
      };
    }
    if (newline < 0) break;
    lineStart = newline + 1;
    line += 1;
  }
  return null;
}

export function annotateFrontmatterBlock(tree, file) {
  const source = sourceText(file);
  const frontmatter = frontmatterBlock(source);
  if (!frontmatter || tree?.type !== "root") return tree;
  const end = frontmatter.position.end.offset;
  const remaining = (tree.children || []).filter((child) => {
    const start = child?.position?.start?.offset;
    return Number.isFinite(start) && start >= end;
  });
  tree.children = [frontmatter, ...remaining];
  return tree;
}

export function codeSemanticSignature(node) {
  return JSON.stringify({
    value: node?.value || "",
    lang: node?.lang || "",
    meta: node?.meta || ""
  });
}

export function annotateFencedCodeMarkers(tree, file) {
  const source = sourceText(file);
  annotateFrontmatterBlock(tree, file);
  const sourceLines = source.split(/\r?\n/);
  const visit = (node, parent = null) => {
    if (node?.type === "code") {
      const startLine = node.position?.start?.line;
      const startColumn = node.position?.start?.column;
      const endLine = node.position?.end?.line;
      if (Number.isFinite(startLine) && Number.isFinite(startColumn) && Number.isFinite(endLine)) {
        const openingLine = sourceLines[startLine - 1]?.slice(startColumn - 1) || "";
        const closingLine = sourceLines[endLine - 1] || "";
        const opening = fenceRun(openingLine);
        const closing = closingFenceRun(closingLine);
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (opening) {
          const layout = openingFenceLayout(openingLine, opening, node.lang || "", node.meta || "");
          const openingLineEnd = Number.isFinite(start) ? source.indexOf("\n", start) : -1;
          const lineEnding = openingLineEnd < 0
            ? ""
            : source[openingLineEnd - 1] === "\r" ? "\r\n" : "\n";
          const validClosing = Boolean(
            closing
            && closing[0] === opening[0]
            && closing.length >= opening.length
          );
          node.fenceMarker = opening[0];
          node.fenceLength = opening.length;
          node.closingFenceLength = validClosing ? closing.length : opening.length;
          node.fenceClosed = validClosing;
          node.fenceLineEnding = lineEnding;
          node.fenceLanguagePrefix = layout.fenceLanguagePrefix;
          node.fenceMetaPrefix = layout.fenceMetaPrefix;
          node.fenceOpeningTrailing = layout.fenceOpeningTrailing;
          if (parent?.type === "root" && closing) {
            const closingPrefix = closingLine.slice(0, closingLine.lastIndexOf(closing));
            if (/^[\t ]{0,3}$/.test(closingPrefix)) node.fenceClosingIndent = closingPrefix;
          }
        }
        if (parent?.type === "root" && Number.isFinite(start) && Number.isFinite(end)) {
          // Root indented code needs the same source snapshot as a fence. Without
          // it, editing an unrelated paragraph silently rewrites four-space or
          // tab-indented code as a fenced block.
          node.fenceSource = source.slice(start, end);
          node.fenceTrailingLineEnding = node.fenceSource.endsWith("\r\n")
            ? "\r\n"
            : node.fenceSource.endsWith("\n") ? "\n" : "";
          node.fenceSourceSignature = codeSemanticSignature(node);
        }
      }
    }
    (node?.children || []).forEach((child) => visit(child, node));
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulFenceRemark = $remark(
  "tetherSourceFaithfulFence",
  () => () => annotateFencedCodeMarkers
);

export const sourceFaithfulCodeBlockSchema = codeBlockSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      meta: { default: null, validate: "string|null" },
      fenceMarker: { default: "`", validate: "string|null" },
      fenceLength: { default: 3, validate: "number" },
      closingFenceLength: { default: 3, validate: "number" },
      fenceClosed: { default: true, validate: "boolean" },
      fenceLineEnding: { default: "\n", validate: "string" },
      fenceTrailingLineEnding: { default: "", validate: "string" },
      fenceSource: { default: null, validate: "string|null" },
      fenceSourceSignature: { default: null, validate: "string|null" },
      fenceOpeningIndent: { default: "", validate: "string" },
      fenceClosingIndent: { default: "", validate: "string" },
      fenceLanguagePrefix: { default: "", validate: "string" },
      fenceMetaPrefix: { default: " ", validate: "string" },
      fenceOpeningTrailing: { default: "", validate: "string" },
      mathBlock: { default: false, validate: "boolean" },
      mathOpeningLength: { default: 2, validate: "number" },
      mathClosingLength: { default: 2, validate: "number" },
      mathOpeningSuffix: { default: "", validate: "string" },
      mathSource: { default: null, validate: "string|null" },
      mathSourceValue: { default: null, validate: "string|null" },
      frontmatterBlock: { default: false, validate: "boolean" },
      frontmatterOpening: { default: "---", validate: "string" },
      frontmatterClosing: { default: "---", validate: "string" }
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        state.openNode(type, {
          language: node.lang ?? "",
          meta: node.meta ?? null,
          fenceMarker: node.fenceMarker ?? null,
          fenceLength: node.fenceLength ?? 3,
          closingFenceLength: node.closingFenceLength ?? node.fenceLength ?? 3,
          fenceClosed: node.fenceClosed !== false,
          fenceLineEnding: node.fenceLineEnding === "\r\n"
            ? "\r\n"
            : node.fenceLineEnding === "" ? "" : "\n",
          fenceTrailingLineEnding: node.fenceTrailingLineEnding === "\r\n"
            ? "\r\n"
            : node.fenceTrailingLineEnding === "\n" ? "\n" : "",
          fenceSource: node.fenceSource ?? null,
          fenceSourceSignature: node.fenceSourceSignature ?? null,
          fenceOpeningIndent: node.fenceOpeningIndent || "",
          fenceClosingIndent: node.fenceClosingIndent || "",
          fenceLanguagePrefix: node.fenceLanguagePrefix || "",
          fenceMetaPrefix: node.fenceMetaPrefix ?? " ",
          fenceOpeningTrailing: node.fenceOpeningTrailing || "",
          mathBlock: Boolean(node.mathBlock),
          mathOpeningLength: node.mathOpeningLength || 2,
          mathClosingLength: node.mathClosingLength || node.mathOpeningLength || 2,
          mathOpeningSuffix: node.mathOpeningSuffix || "",
          mathSource: node.mathSource ?? null,
          mathSourceValue: node.mathSourceValue ?? null,
          frontmatterBlock: Boolean(node.frontmatterBlock),
          frontmatterOpening: node.frontmatterOpening || "---",
          frontmatterClosing: node.frontmatterClosing || "---"
        });
        if (node.value) state.addText(node.value);
        state.closeNode();
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        if (node.attrs.mathBlock && String(node.attrs.language || "").toLowerCase() === "latex") {
          state.addNode("math", undefined, node.content.firstChild?.text || "", {
            mathBlock: true,
            mathOpeningLength: node.attrs.mathOpeningLength,
            mathClosingLength: node.attrs.mathClosingLength,
            mathOpeningSuffix: node.attrs.mathOpeningSuffix,
            mathSource: node.attrs.mathSource,
            mathSourceValue: node.attrs.mathSourceValue
          });
          return;
        }
        state.addNode("code", undefined, node.content.firstChild?.text || "", {
          lang: node.attrs.language || null,
          meta: node.attrs.meta || null,
          fenceMarker: node.attrs.fenceMarker,
          fenceLength: node.attrs.fenceLength,
          closingFenceLength: node.attrs.closingFenceLength,
          fenceClosed: node.attrs.fenceClosed,
          fenceLineEnding: node.attrs.fenceLineEnding,
          fenceTrailingLineEnding: node.attrs.fenceTrailingLineEnding,
          fenceSource: node.attrs.fenceSource,
          fenceSourceSignature: node.attrs.fenceSourceSignature,
          fenceOpeningIndent: node.attrs.fenceOpeningIndent,
          fenceClosingIndent: node.attrs.fenceClosingIndent,
          fenceLanguagePrefix: node.attrs.fenceLanguagePrefix,
          fenceMetaPrefix: node.attrs.fenceMetaPrefix,
          fenceOpeningTrailing: node.attrs.fenceOpeningTrailing,
          frontmatterBlock: node.attrs.frontmatterBlock,
          frontmatterOpening: node.attrs.frontmatterOpening,
          frontmatterClosing: node.attrs.frontmatterClosing
        });
      }
    }
  };
});

export const sourceFaithfulCodeBlockInputRule = $inputRule((ctx) => textblockTypeInputRule(
  /^(?: {0,3})(?:`{3,}[^`\r\n]*|~{3,}[^\r\n]*)[\t ]$/,
  codeBlockSchema.type(ctx),
  (match) => typedCodeFenceAttributes(match[0])
));

export const sourceFaithfulCodeBlockEnterShortcut = $shortcut(() => ({
  Enter: {
    key: "Enter",
    priority: 120,
    onRun: (state, dispatch) => {
      const transaction = typedCodeFenceTransaction(state);
      if (!transaction) return false;
      dispatch?.(transaction.scrollIntoView());
      return true;
    }
  }
}));

function longestClosingRun(value, marker) {
  let longest = 0;
  for (const line of value.split(/\r?\n/)) {
    const run = line.match(/^[\t ]{0,3}(`{3,}|~{3,})[\t ]*$/)?.[1];
    if (run?.[0] === marker) longest = Math.max(longest, run.length);
  }
  return longest;
}

function indentedCode(node, state) {
  const raw = node.value || "";
  if (
    node.fenceMarker != null
    || !raw
    || node.lang
    || !/[^ \r\n]/.test(raw)
    || /^[\t ]*(?:[\r\n]|$)|(?:^|[\r\n])[\t ]*$/.test(raw)
  ) return null;
  return state.indentLines(raw, (line, _index, blank) => (blank ? "" : "    ") + line);
}

export function sourceFaithfulCodeHandler(node, _parent, state, info) {
  if (
    node.fenceSource != null
    && node.fenceSourceSignature != null
    && codeSemanticSignature(node) === node.fenceSourceSignature
  ) return node.fenceSource;

  if (node.frontmatterBlock) {
    const lineEnding = node.fenceLineEnding === "\r\n" ? "\r\n" : "\n";
    const opening = node.frontmatterOpening || "---";
    const closing = node.frontmatterClosing || "---";
    const raw = String(node.value || "").replace(/\r?\n/g, lineEnding);
    return `${opening}${lineEnding}${raw}${raw ? lineEnding : ""}${closing}`;
  }

  const indented = indentedCode(node, state);
  if (indented != null) return indented;

  const raw = node.value || "";
  const marker = node.fenceMarker === "~" ? "~" : "`";
  const openingLength = Math.max(
    3,
    Number(node.fenceLength) || 3,
    longestClosingRun(raw, marker) + 1
  );
  const closingLength = Math.max(openingLength, Number(node.closingFenceLength) || openingLength);
  const opening = marker.repeat(openingLength);
  const closing = marker.repeat(closingLength);
  const closed = node.fenceClosed !== false;
  const storedLineEnding = node.fenceLineEnding === "\r\n"
    ? "\r\n"
    : node.fenceLineEnding === "" ? "" : "\n";
  const lineEnding = storedLineEnding || (raw ? "\n" : "");
  const suffix = marker === "`" ? "GraveAccent" : "Tilde";
  const tracker = state.createTracker(info);
  const exit = state.enter("codeFenced");
  const openingIndent = node.fenceOpeningIndent || "";
  const closingIndent = node.fenceClosingIndent || "";
  const languagePrefix = node.fenceLanguagePrefix || "";
  const metaPrefix = node.fenceMetaPrefix ?? " ";
  const openingTrailing = node.fenceOpeningTrailing || "";
  let value = tracker.move(`${openingIndent}${opening}`);

  if (node.lang) {
    value += tracker.move(languagePrefix);
    const languageExit = state.enter(`codeFencedLang${suffix}`);
    value += tracker.move(state.safe(node.lang, {
      before: value,
      after: " ",
      encode: ["`"],
      ...tracker.current()
    }));
    languageExit();
  }
  if (node.lang && node.meta) {
    const metaExit = state.enter(`codeFencedMeta${suffix}`);
    value += tracker.move(metaPrefix);
    value += tracker.move(state.safe(node.meta, {
      before: value,
      after: "\n",
      encode: ["`"],
      ...tracker.current()
    }));
    metaExit();
  }

  value += tracker.move(openingTrailing);

  value += tracker.move(lineEnding);
  if (raw) {
    value += tracker.move(raw.replace(/\r?\n/g, lineEnding || "\n"));
    if (closed) value += tracker.move(lineEnding || "\n");
  }
  if (closed) value += tracker.move(`${closingIndent}${closing}`);
  else if (node.fenceTrailingLineEnding && !raw.endsWith("\n")) {
    value += tracker.move(node.fenceTrailingLineEnding);
  }
  exit();
  return value;
}
