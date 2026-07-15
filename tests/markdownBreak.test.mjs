import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import {
  ConfigReady,
  editorViewCtx,
  init,
  parser,
  parserCtx,
  remarkStringifyOptionsCtx,
  schema,
  serializer,
  serializerCtx
} from "@milkdown/kit/core";
import { Clock, Container, Ctx } from "@milkdown/kit/ctx";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import {
  hardbreakAttr,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  annotateHardBreakMarkers,
  sourceFaithfulHardBreakRemark,
  sourceFaithfulHardBreakSchema
} from "../src/renderer/lib/markdownBreak.js";
import {
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "../src/renderer/lib/markdownDocument.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  documentSourceUnitStartOffset,
  plainTextMarkdownSourceToken,
  sourceAwareClipboardText,
  sourceClipboardEdit,
  sourceSelectionAcrossUnitBoundary,
  sourceSelectionFromDocumentSelection,
  sourceSelectionText
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => annotateHardBreakMarkers(tree, file))
    .use(remarkStringify, tetherStringifyOptions({}));
  return processor.processSync(markdown).toString();
}

async function milkdownTransformer() {
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args);
    timer.unref?.();
    return timer;
  };
  const ctx = new Ctx(new Container(), new Clock());
  const initHandler = init({})(ctx);
  const schemaHandler = schema(ctx);
  const parserHandler = parser(ctx);
  const serializerHandler = serializer(ctx);
  ctx.inject(editorViewCtx, { state: { doc: { lastChild: null } } });
  const userHandlers = [
    sourceFaithfulDocumentRemark,
    sourceFaithfulDocumentSchema,
    paragraphSchema,
    textSchema,
    hardbreakAttr,
    sourceFaithfulHardBreakRemark,
    sourceFaithfulHardBreakSchema
  ].flat().map((plugin) => plugin(ctx));
  ctx.record(ConfigReady);
  ctx.update(remarkStringifyOptionsCtx, (options) => tetherStringifyOptions(options));
  const promises = [
    ...userHandlers.map((handler) => handler()),
    schemaHandler(),
    parserHandler(),
    serializerHandler()
  ];
  const initPromise = initHandler();
  ctx.done(ConfigReady);
  try {
    await Promise.all([initPromise, ...promises]);
    return { parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) };
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
}

function textPosition(doc, text) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && node.isText && node.text === text) position = pos;
  });
  return position;
}

test("hard breaks retain backslash and exact trailing-space markers", () => {
  const source = "two  \nspaces\n\nthree   \nspaces\n\nslash\\\nbreak\n";
  assert.equal(roundTrip(source), source);
  const crlf = "alpha  \r\nbeta\r\n\r\ngamma\\\r\ndelta\r\n";
  assert.equal(roundTrip(crlf), "alpha  \r\nbeta\n\ngamma\\\r\ndelta\n");
});

test("Milkdown retains a trailing-space hard break through an unrelated text edit", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("alpha  \nbeta\n");
  const hardbreak = doc.firstChild.child(1);
  assert.equal(hardbreak.type.name, "hardbreak");
  assert.equal(hardbreak.attrs.markdownMarker, "  ");
  assert.equal(hardbreak.attrs.markdownLineEnding, "\n");
  assert.equal(hardbreak.type.spec.toDOM(hardbreak)[1]["data-md-hardbreak-marker"], "  ");

  const alpha = textPosition(doc, "alpha");
  const edited = EditorState.create({ doc }).tr.insertText("renamed", alpha, alpha + "alpha".length).doc;
  assert.equal(serialize(edited), "renamed  \nbeta\n");

  const crlfDoc = parse("alpha  \r\nbeta\r\n");
  const beta = textPosition(crlfDoc, "beta");
  const crlfEdited = EditorState.create({ doc: crlfDoc }).tr
    .insertText("renamed", beta, beta + "beta".length).doc;
  assert.equal(serialize(crlfEdited), "alpha  \r\nrenamed\r\n");
});

test("Milkdown retains each physical soft-line ending through a text edit", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "alpha \r\nbeta\t\ngamma\r\n";
  const doc = parse(source);
  const breaks = [];
  doc.descendants((node) => {
    if (node.type.name === "hardbreak") breaks.push(node);
  });
  assert.deepEqual(
    breaks.map((node) => [node.attrs.isInline, node.attrs.markdownMarker, node.attrs.markdownLineEnding]),
    [[true, " ", "\r\n"], [true, "\t", "\n"]]
  );

  const alpha = textPosition(doc, "alpha");
  const edited = EditorState.create({ doc }).tr.insertText("X", alpha + 2).doc;
  assert.equal(serialize(edited), "alXpha \r\nbeta\t\ngamma\r\n");
});

test("soft-line selections copy and delete their exact physical source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "alpha \r\nbeta\r\n";
  const doc = parse(source);
  const breakPosition = textPosition(doc, "alpha") + "alpha".length;
  const softBreak = doc.nodeAt(breakPosition);
  assert.equal(softBreak.type.name, "hardbreak");
  assert.equal(softBreak.attrs.isInline, true);
  assert.equal(plainTextMarkdownSourceToken(EditorState.create({
    doc,
    selection: TextSelection.create(doc, breakPosition)
  }), "forward", serialize), null);

  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, breakPosition, breakPosition + 1)
  });
  assert.equal(sourceSelectionText(sourceSelectionFromDocumentSelection(state, serialize)), " \r\n");
  assert.equal(sourceAwareClipboardText(state, serialize), " \r\n");
  const edit = sourceClipboardEdit(state, "", parse, serialize);
  assert.equal(edit?.selectedText, " \r\n");
  assert.equal(serialize(edit.transaction.doc), "alphabeta\r\n");
});

test("hard-break selections include the physical marker and newline", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const [source, token, joined] of [
    ["alpha  \nbeta\n", "  \n", "alpha beta\n"],
    ["alpha\\\nbeta\n", "\\\n", "alpha beta\n"],
    ["alpha  \r\nbeta\r\n", "  \r\n", "alpha beta\r\n"]
  ]) {
    const doc = parse(source);
    const breakPosition = textPosition(doc, "alpha") + "alpha".length;
    assert.equal(doc.nodeAt(breakPosition).attrs.markdownLineEnding, token.endsWith("\r\n") ? "\r\n" : "\n");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, breakPosition, breakPosition + 1)
    });
    assert.equal(sourceSelectionText(sourceSelectionFromDocumentSelection(state, serialize)), token);
    assert.equal(sourceAwareClipboardText(state, serialize), token);
    const edit = sourceClipboardEdit(state, " ", parse, serialize);
    assert.equal(edit?.selectedText, token);
    assert.equal(serialize(edit.transaction.doc), joined);
  }
});

test("hard-break source controls hand selections through the physical newline", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const [source, marker, token] of [
    ["alpha  \nbeta\n", "  ", "  \n"],
    ["alpha\\\r\nbeta\r\n", "\\", "\\\r\n"]
  ]) {
    const doc = parse(source);
    const breakPosition = textPosition(doc, "alpha") + "alpha".length;
    const unit = {
      from: breakPosition,
      to: breakPosition + doc.nodeAt(breakPosition).nodeSize,
      kind: "inline",
      name: "hardbreak"
    };
    const state = EditorState.create({ doc });
    const unitStart = documentSourceUnitStartOffset(state, unit, serialize);
    assert.equal(unitStart, source.indexOf(marker));
    const crossed = sourceSelectionAcrossUnitBoundary(
      source,
      unitStart,
      { anchor: 0, head: marker.length },
      "forward"
    );
    assert.equal(source.slice(crossed.anchor, crossed.head), token);
  }
});
