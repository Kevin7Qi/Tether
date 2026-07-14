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
import { EditorState } from "@milkdown/kit/prose/state";
import { paragraphSchema, textSchema } from "@milkdown/kit/preset/commonmark";
import {
  annotateDocumentGaps,
  documentGaps,
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "../src/renderer/lib/markdownDocument.js";
import {
  sourceFaithfulCodeBlockSchema,
  sourceFaithfulFenceRemark
} from "../src/renderer/lib/markdownFence.js";
import {
  normalizeSerializedMarkdown,
  tetherStringifyOptions
} from "../src/renderer/lib/markdownStyle.js";
import {
  documentGapSourceSelection,
  documentSourceSegments,
  documentSourceTarget,
  documentSourceUnitBoundaryOffset,
  documentSourceUnitBoundaryNavigationOffset,
  extendSourceSelection,
  replaceSourceSelectionTransaction,
  replaceSourceNewlineSelectionTransaction,
  sourceSelectionFromNewlineRange,
  sourceSelectionText,
  sourceNewlineDeletionTransaction,
  sourceNewlineSourceRange,
  textSelectionAcrossBoundary
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown, mutateTree = null) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => {
      annotateDocumentGaps(tree, file);
      mutateTree?.(tree);
    })
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
    sourceFaithfulFenceRemark,
    sourceFaithfulCodeBlockSchema
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

test("root gap annotation captures exact prefix, separators, and suffix", () => {
  const source = "```js\ncode\n```\nAfter\n";
  const tree = unified().use(remarkParse).parse(source);
  annotateDocumentGaps(tree, { value: source });
  assert.deepEqual(documentGaps(tree.markdownBlockGaps, 2), ["", "\n", "\n"]);
});

test("serialized edits preserve the source file's exact terminal newline convention", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const source of ["After", "After\n", "After\n\n", "After\r\n"]) {
    const doc = parse(source);
    assert.equal(normalizeSerializedMarkdown(serialize(doc), doc, source), source);
  }

  const source = "~~~js\ncode\n~~~\nAfter";
  const doc = parse(source);
  const code = doc.firstChild.type.create(doc.firstChild.attrs, doc.type.schema.text("changed"));
  const edited = doc.type.create(doc.attrs, [code, doc.lastChild]);
  assert.equal(
    normalizeSerializedMarkdown(serialize(edited), edited, source),
    "~~~js\nchanged\n~~~\nAfter"
  );
});

test("root serialization preserves a single source newline through a block edit", () => {
  const source = "```js\ncode\n```\nAfter\n";
  assert.equal(roundTrip(source), source);
  assert.equal(roundTrip(source, (tree) => {
    tree.children[0].value = "changed";
  }), "```js\nchanged\n```\nAfter\n");

  const loose = "```js\ncode\n```\n\nAfter\n";
  assert.equal(roundTrip(loose), loose);
});

test("a marked editor-only trailing paragraph never leaks into Markdown source", () => {
  const source = "After\n";
  assert.equal(roundTrip(source, (tree) => {
    tree.children.push({
      type: "paragraph",
      children: [],
      tetherSyntheticTrailing: true
    });
  }), source);
});

test("Milkdown carries exact root gaps in document attrs", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "```js\ncode\n```\nAfter\n";
  const doc = parse(source);
  assert.deepEqual(documentGaps(doc.attrs.markdownBlockGaps, 2), ["", "\n", "\n"]);
  assert.equal(serialize(doc), source);

  const code = doc.firstChild.type.create(doc.firstChild.attrs, doc.type.schema.text("changed"));
  const edited = doc.type.create(doc.attrs, [code, doc.lastChild]);
  assert.equal(serialize(edited), "```js\nchanged\n```\nAfter\n");
});

test("deleting one of two root newlines preserves both rendered blocks", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "```js\ncode\n```\n\nAfter\n";
  const doc = parse(source);
  const state = EditorState.create({ doc });
  const transaction = sourceNewlineDeletionTransaction(
    state,
    doc.firstChild.nodeSize,
    "forward",
    parse,
    serialize
  );
  assert.equal(transaction?.doc.childCount, 2);
  assert.equal(transaction?.doc.firstChild.type.name, "code_block");
  assert.equal(transaction?.doc.lastChild.type.name, "paragraph");
  assert.equal(serialize(transaction.doc), "```js\ncode\n```\nAfter\n");
  assert.deepEqual(documentGaps(transaction.doc.attrs.markdownBlockGaps, 2), ["", "\n", "\n"]);

  const nextState = EditorState.create({ doc: transaction.doc });
  const joined = sourceNewlineDeletionTransaction(
    nextState,
    transaction.doc.firstChild.nodeSize,
    "forward",
    parse,
    serialize
  );
  assert.equal(joined?.doc.childCount, 1);
  assert.equal(joined?.doc.firstChild.type.name, "code_block");
  assert.equal(joined?.doc.firstChild.textContent, "code\n```After");
  assert.equal(serialize(joined.doc), "```js\ncode\n```After\n");
});

test("typing replaces the selected physical newline in full Markdown source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "```js\ncode\n```\n\nAfter\n";
  const doc = parse(source);
  const selection = textSelectionAcrossBoundary(
    EditorState.create({ doc }),
    doc.firstChild.nodeSize,
    "forward"
  );
  const state = EditorState.create({ doc, selection });
  const range = sourceNewlineSourceRange(state, serialize);
  assert.equal(range?.text, "\n");
  assert.equal(range?.fullSource, source);

  const initial = sourceSelectionFromNewlineRange(range, "forward");
  assert.equal(sourceSelectionText(initial), "\n");
  const secondNewline = extendSourceSelection(initial, "forward");
  assert.equal(sourceSelectionText(secondNewline), "\n\n");
  const firstVisibleCharacter = extendSourceSelection(secondNewline, "forward");
  assert.equal(sourceSelectionText(firstVisibleCharacter), "\n\nA");
  assert.equal(
    sourceSelectionText(extendSourceSelection(firstVisibleCharacter, "backward")),
    "\n\n"
  );

  const documentSource = documentSourceSegments(state, serialize);
  assert.deepEqual(
    documentSource?.segments.map(({ node, from, to, gapFrom, gapTo }) => ({
      name: node.type.name,
      from,
      to,
      gapFrom,
      gapTo
    })),
    [
      { name: "code_block", from: 0, to: 14, gapFrom: 14, gapTo: 16 },
      { name: "paragraph", from: 16, to: 21, gapFrom: 21, gapTo: 22 }
    ]
  );
  assert.equal(documentSourceTarget(state, 14, serialize, "backward")?.node.type.name, "code_block");
  const gapTarget = documentSourceTarget(state, 15, serialize, "forward");
  assert.equal(gapTarget?.kind, "gap");
  assert.deepEqual(documentGapSourceSelection(gapTarget, 15), {
    anchor: 15,
    head: 15,
    fullSource: source,
    boundary: doc.firstChild.nodeSize,
    gapStart: 14,
    gapEnd: 16,
    beforeFrom: 0,
    beforeTo: doc.firstChild.nodeSize,
    afterFrom: doc.firstChild.nodeSize,
    afterTo: doc.content.size
  });
  const codeUnit = {
    from: 0,
    to: doc.firstChild.nodeSize,
    kind: "block",
    name: "code_block"
  };
  assert.equal(documentSourceUnitBoundaryOffset(state, codeUnit, "backward", serialize), 0);
  assert.equal(documentSourceUnitBoundaryOffset(state, codeUnit, "forward", serialize), 14);
  assert.equal(
    documentSourceUnitBoundaryNavigationOffset(state, codeUnit, "backward", serialize),
    0
  );
  assert.equal(
    documentSourceUnitBoundaryNavigationOffset(state, codeUnit, "forward", serialize),
    15
  );
  assert.equal(
    documentSourceTarget(
      state,
      documentSourceUnitBoundaryOffset(state, codeUnit, "forward", serialize),
      serialize,
      "forward"
    )?.kind,
    "gap"
  );

  const crlfSource = "```js\r\ncode\r\n```\r\n\r\nAfter\r\n";
  const crlfDoc = parse(crlfSource);
  const crlfState = EditorState.create({ doc: crlfDoc });
  const crlfUnit = {
    from: 0,
    to: crlfDoc.firstChild.nodeSize,
    kind: "block",
    name: "code_block"
  };
  const crlfBoundary = documentSourceUnitBoundaryOffset(
    crlfState,
    crlfUnit,
    "forward",
    serialize
  );
  const crlfNext = documentSourceUnitBoundaryNavigationOffset(
    crlfState,
    crlfUnit,
    "forward",
    serialize
  );
  assert.equal(crlfSource.slice(crlfBoundary, crlfNext), "\r\n");
  assert.equal(documentSourceTarget(state, 16, serialize, "forward")?.node.type.name, "paragraph");
  assert.equal(documentSourceTarget(state, 17, serialize, "forward")?.sourceOffset, 1);

  const typed = replaceSourceNewlineSelectionTransaction(state, "X", parse, serialize);
  assert.equal(typed?.doc.childCount, 1);
  assert.equal(typed?.doc.firstChild.textContent, "code\n```X\nAfter");
  assert.equal(serialize(typed.doc), "```js\ncode\n```X\nAfter\n");

  const unchanged = replaceSourceNewlineSelectionTransaction(state, "\n", parse, serialize);
  assert.equal(serialize(unchanged.doc), source);

  const extendedReplacement = replaceSourceSelectionTransaction(
    state,
    firstVisibleCharacter,
    "\nR",
    parse
  );
  assert.equal(serialize(extendedReplacement.doc), "```js\ncode\n```\nRfter\n");

  const collapsed = { ...initial, anchor: initial.head };
  assert.equal(sourceSelectionText(collapsed), "");
  assert.equal(sourceSelectionText(extendSourceSelection(collapsed, "backward")), "\n");
  const inserted = replaceSourceSelectionTransaction(state, collapsed, "X", parse);
  assert.equal(serialize(inserted.doc), "```js\ncode\n```\nX\nAfter\n");
});

test("CRLF separators are one logical source-newline selection", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "```js\r\ncode\r\n```\r\n\r\nAfter\r\n";
  const doc = parse(source);
  const selection = textSelectionAcrossBoundary(
    EditorState.create({ doc }),
    doc.firstChild.nodeSize,
    "forward"
  );
  const state = EditorState.create({ doc, selection });
  const range = sourceNewlineSourceRange(state, serialize);
  assert.equal(range?.text, "\r\n");
  assert.equal(range?.to - range?.from, 2);
  const initial = sourceSelectionFromNewlineRange(range, "forward");
  const extended = extendSourceSelection(initial, "forward");
  assert.equal(sourceSelectionText(extended), "\r\n\r\n");
});
