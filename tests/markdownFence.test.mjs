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
import { AllSelection, EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { paragraphSchema, textSchema } from "@milkdown/kit/preset/commonmark";
import {
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "../src/renderer/lib/markdownDocument.js";
import {
  annotateFencedCodeMarkers,
  codeSemanticSignature,
  sourceFaithfulCodeBlockSchema,
  sourceFaithfulCodeHandler,
  sourceFaithfulFenceRemark
} from "../src/renderer/lib/markdownFence.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  documentSourceTarget,
  replaceSourceSelectionTransaction,
  sourceAwareClipboardText,
  sourceClipboardEdit,
  sourceDocumentJumpSelection,
  sourceSelectionFromDocumentSelection
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown, mutateTree = null) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => {
      annotateFencedCodeMarkers(tree, file);
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
  const userPromises = userHandlers.map((handler) => handler());
  const schemaPromise = schemaHandler();
  const parserPromise = parserHandler();
  const serializerPromise = serializerHandler();
  const initPromise = initHandler();
  ctx.done(ConfigReady);
  try {
    await Promise.all([
      initPromise,
      schemaPromise,
      parserPromise,
      serializerPromise,
      ...userPromises
    ]);
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

test("fenced code preserves mixed marker styles, lengths, and metadata", () => {
  const source = [
    "~~~~js title=demo",
    "const answer = 42;",
    "~~~~~",
    "",
    "`````ts",
    "const ticks = `value`;",
    "`````",
    ""
  ].join("\n");
  assert.equal(roundTrip(source), source);
});

test("a fence grows only when edited content would collide with it", () => {
  const source = "~~~~js\nconst answer = 42;\n~~~~~\n";
  const result = roundTrip(source, (tree) => {
    tree.children[0].value += "\n~~~~";
  });
  assert.equal(result, "~~~~~js\nconst answer = 42;\n~~~~\n~~~~~\n");
});

test("indented code keeps the existing canonical fenced output", () => {
  assert.equal(roundTrip("    alpha\n    beta\n"), "```\nalpha\nbeta\n```\n");
});

test("an unchanged unclosed fence remains exact source instead of being repaired", () => {
  const source = "```js\ncode\n```After\n";
  assert.equal(roundTrip(source), source);
});

test("fence annotation reads source coordinates without touching ordinary code nodes", () => {
  const source = "~~~python key=value\nprint(1)\n~~~~\n";
  const processor = unified().use(remarkParse);
  const tree = processor.parse(source);
  annotateFencedCodeMarkers(tree, { value: source });
  assert.deepEqual(
    {
      marker: tree.children[0].fenceMarker,
      length: tree.children[0].fenceLength,
      closingLength: tree.children[0].closingFenceLength,
      meta: tree.children[0].meta
    },
    { marker: "~", length: 3, closingLength: 4, meta: "key=value" }
  );
});

test("nested fences preserve a longer physical closing run past container prefixes", () => {
  const source = "> ~~~~js\n> const quoted = true;\n> ~~~~~\n";
  const processor = unified().use(remarkParse);
  const tree = processor.parse(source);
  annotateFencedCodeMarkers(tree, { value: source });
  const code = tree.children[0].children[0];
  assert.equal(code.fenceMarker, "~");
  assert.equal(code.fenceLength, 4);
  assert.equal(code.closingFenceLength, 5);
});

test("Markdown stringify options compose the source-faithful code handler", () => {
  const existingHandler = () => "html";
  const options = tetherStringifyOptions({ handlers: { html: existingHandler } });
  assert.equal(options.handlers.html, existingHandler);
  assert.equal(options.handlers.code, sourceFaithfulCodeHandler);
});

test("Milkdown keeps fence attributes through a ProseMirror content edit", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "~~~~js title=demo\nconst answer = 42;\n~~~~~\n";
  const doc = parse(source);
  assert.deepEqual({ ...doc.firstChild.attrs }, {
    language: "js",
    meta: "title=demo",
    fenceMarker: "~",
    fenceLength: 4,
    closingFenceLength: 5,
    fenceSource: source.trimEnd(),
    fenceSourceSignature: codeSemanticSignature({
      value: "const answer = 42;",
      lang: "js",
      meta: "title=demo"
    }),
    mathBlock: false,
    mathOpeningLength: 2,
    mathClosingLength: 2,
    mathOpeningSuffix: "",
    mathSource: null,
    mathSourceValue: null
  });

  const editedCode = doc.firstChild.type.create(
    doc.firstChild.attrs,
    doc.type.schema.text("const answer = 43;")
  );
  const editedDoc = doc.type.create(null, [editedCode]);
  assert.equal(serialize(editedDoc), "~~~~js title=demo\nconst answer = 43;\n~~~~~\n");
});

test("a partial code-to-prose selection includes the physical closing fence", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "````js meta\nalpha\nbeta\n`````\n\nAfter\n";
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(
      doc,
      textPosition(doc, "alpha\nbeta") + 2,
      textPosition(doc, "After") + 2
    )
  });
  assert.equal(sourceAwareClipboardText(state, serialize), "pha\nbeta\n`````\n\nAf");

  const sourceSelection = sourceSelectionFromDocumentSelection(state, serialize);
  assert.equal(sourceSelection.boundary, doc.firstChild.nodeSize);
  const replacement = replaceSourceSelectionTransaction(state, sourceSelection, "X", parse);
  assert.ok(replacement);
  assert.equal(serialize(replacement.doc), "````js meta\nalXter\n");
  assert.equal(replacement.selection.$from.parentOffset, 3);

  const cut = sourceClipboardEdit(state, "", parse, serialize);
  assert.ok(cut);
  assert.equal(cut.selectedText, "pha\nbeta\n`````\n\nAf");
  assert.equal(serialize(cut.transaction.doc), "````js meta\nalter\n");

  const paste = sourceClipboardEdit(state, "P\nQ", parse, serialize);
  assert.ok(paste);
  assert.equal(paste.selectedText, cut.selectedText);
  assert.equal(serialize(paste.transaction.doc), "````js meta\nalP\nQter\n");
});

test("Select All replacement includes leading and trailing root Markdown gaps", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "\nBefore\n\n```js\ncode\n```\n\n";
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: new AllSelection(doc)
  });
  const exact = sourceSelectionFromDocumentSelection(state, serialize);
  assert.equal(exact.anchor, 0);
  assert.equal(exact.head, source.length);
  assert.equal(exact.fullSource, source);

  const edit = sourceClipboardEdit(state, "Replacement\n", parse, serialize);
  assert.ok(edit);
  assert.equal(edit.selectedText, source);
  assert.equal(serialize(edit.transaction.doc), "Replacement\n");
});

test("document jumps address leading and trailing root Markdown gaps exactly", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "\nBefore\n\n```js\ncode\n```\n\n";
  const doc = parse(source);
  const state = EditorState.create({ doc });

  const start = documentSourceTarget(state, 0, serialize, "forward");
  assert.equal(start.kind, "gap");
  assert.equal(start.position, 0);
  assert.equal(start.gapFrom, 0);
  assert.equal(start.gapTo, 1);
  assert.equal(start.beforeSegment, null);
  assert.equal(start.afterSegment, start.documentSource.segments[0]);

  const end = documentSourceTarget(state, source.length, serialize, "backward");
  assert.equal(end.kind, "gap");
  assert.equal(end.position, doc.content.size);
  assert.equal(end.gapFrom, source.length - 2);
  assert.equal(end.gapTo, source.length);
  assert.equal(end.beforeSegment, end.documentSource.segments.at(-1));
  assert.equal(end.afterSegment, null);

  const current = source.indexOf("code") + 2;
  assert.deepEqual(sourceDocumentJumpSelection(state, "start", serialize, {
    sourceOffset: current,
    extend: true
  }), {
    anchor: current,
    head: 0,
    fullSource: source,
    boundary: 0
  });
  assert.deepEqual(sourceDocumentJumpSelection(state, "end", serialize, {
    sourceOffset: current,
    extend: true
  }), {
    anchor: current,
    head: source.length,
    fullSource: source,
    boundary: doc.content.size
  });
  assert.equal(sourceDocumentJumpSelection(state, "start", serialize, {
    sourceOffset: current,
    extend: true,
    sourceSelection: { anchor: source.length + 20, head: current }
  }).anchor, source.length);
});

test("a prose-to-code replacement preserves the unselected physical closing fence", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before code paragraph.\n\n```js\nalpha\nbeta\ngamma\n```\n\nAfter code paragraph.\n";
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(
      doc,
      textPosition(doc, "alpha\nbeta\ngamma") + "alpha\nbe".length,
      textPosition(doc, "Before code paragraph.") + "Before ".length
    )
  });
  assert.equal(sourceAwareClipboardText(state, serialize), "code paragraph.\n\n```js\nalpha\nbe");

  const sourceSelection = sourceSelectionFromDocumentSelection(state, serialize);
  const replacement = replaceSourceSelectionTransaction(state, sourceSelection, "Z", parse);
  assert.ok(replacement);
  assert.equal(serialize(replacement.doc), "Before Zta\ngamma\n```\n\nAfter code paragraph.\n");
});
