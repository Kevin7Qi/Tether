import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function fenceRun(line) {
  return line.match(/^[\t ]{0,3}(`{3,}|~{3,})/)?.[1] || null;
}

function closingFenceRun(line) {
  return line.match(/(`{3,}|~{3,})[\t ]*$/)?.[1] || null;
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
        if (opening) {
          const start = node.position?.start?.offset;
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
          if (parent?.type === "root") {
            const end = node.position?.end?.offset;
            if (Number.isFinite(start) && Number.isFinite(end)) {
              node.fenceSource = source.slice(start, end);
              node.fenceTrailingLineEnding = node.fenceSource.endsWith("\r\n")
                ? "\r\n"
                : node.fenceSource.endsWith("\n") ? "\n" : "";
              node.fenceSourceSignature = codeSemanticSignature(node);
            }
          }
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
      mathBlock: { default: false, validate: "boolean" },
      mathOpeningLength: { default: 2, validate: "number" },
      mathClosingLength: { default: 2, validate: "number" },
      mathOpeningSuffix: { default: "", validate: "string" },
      mathSource: { default: null, validate: "string|null" },
      mathSourceValue: { default: null, validate: "string|null" }
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
          mathBlock: Boolean(node.mathBlock),
          mathOpeningLength: node.mathOpeningLength || 2,
          mathClosingLength: node.mathClosingLength || node.mathOpeningLength || 2,
          mathOpeningSuffix: node.mathOpeningSuffix || "",
          mathSource: node.mathSource ?? null,
          mathSourceValue: node.mathSourceValue ?? null
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
          fenceSourceSignature: node.attrs.fenceSourceSignature
        });
      }
    }
  };
});

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
    || state.options.fences !== false
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
  let value = tracker.move(opening);

  if (node.lang) {
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
    value += tracker.move(" ");
    value += tracker.move(state.safe(node.meta, {
      before: value,
      after: "\n",
      encode: ["`"],
      ...tracker.current()
    }));
    metaExit();
  }

  value += tracker.move(lineEnding);
  if (raw) {
    value += tracker.move(raw.replace(/\r?\n/g, lineEnding || "\n"));
    if (closed) value += tracker.move(lineEnding || "\n");
  }
  if (closed) value += tracker.move(closing);
  else if (node.fenceTrailingLineEnding && !raw.endsWith("\n")) {
    value += tracker.move(node.fenceTrailingLineEnding);
  }
  exit();
  return value;
}
