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
  annotateFrontmatterBlock,
  annotateFencedCodeMarkers,
  codeSemanticSignature,
  sourceFaithfulCodeBlockSchema,
  sourceFaithfulCodeHandler,
  sourceFaithfulFenceRemark
} from "../src/renderer/lib/markdownFence.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  documentGapSourceSelection,
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
    sourceFaithfulFenceRemark,
    sourceFaithfulDocumentRemark,
    sourceFaithfulDocumentSchema,
    paragraphSchema,
    textSchema,
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

test("YAML front matter becomes one exact rendered code unit", () => {
  const source = [
    "---",
    'title: "Demo"',
    "tags:",
    "  - alpha",
    "  - beta",
    "---",
    "",
    "# Body",
    ""
  ].join("\n");
  const tree = unified().use(remarkParse).parse(source);
  annotateFrontmatterBlock(tree, { value: source });
  assert.deepEqual({
    type: tree.children[0].type,
    lang: tree.children[0].lang,
    value: tree.children[0].value,
    opening: tree.children[0].frontmatterOpening,
    closing: tree.children[0].frontmatterClosing,
    body: tree.children[1].type
  }, {
    type: "code",
    lang: "yaml",
    value: 'title: "Demo"\ntags:\n  - alpha\n  - beta',
    opening: "---",
    closing: "---",
    body: "heading"
  });
  assert.equal(roundTrip(source), source);
});

test("edited front matter retains its YAML delimiters and line endings", () => {
  const source = "---\r\ntitle: Demo\r\n...\r\n\r\nBody\r\n";
  assert.equal(roundTrip(source, (tree) => {
    tree.children[0].value = "title: Changed";
  }), "---\r\ntitle: Changed\r\n...\n\nBody\n");
});

test("a fence grows only when edited content would collide with it", () => {
  const source = "~~~~js\nconst answer = 42;\n~~~~~\n";
  const result = roundTrip(source, (tree) => {
    tree.children[0].value += "\n~~~~";
  });
  assert.equal(result, "~~~~~js\nconst answer = 42;\n~~~~\n~~~~~\n");

  const notAClosingLine = roundTrip(source, (tree) => {
    tree.children[0].value += "\n~~~~not-a-close";
  });
  assert.equal(
    notAClosingLine,
    "~~~~js\nconst answer = 42;\n~~~~not-a-close\n~~~~~\n"
  );
});

test("untouched indented code keeps its exact physical source", () => {
  assert.equal(roundTrip("    alpha\n\n      beta\n"), "    alpha\n\n      beta\n");
  assert.equal(roundTrip("\talpha\r\n\tbeta\r\n"), "\talpha\r\n\tbeta\n");
});

test("editing an indented code block preserves its source style", () => {
  const source = "Before\n\n    alpha\n    beta\n\nAfter\n";
  assert.equal(roundTrip(source, (tree) => {
    tree.children[1].value = "alpha\nchanged";
  }), "Before\n\n    alpha\n    changed\n\nAfter\n");

  assert.equal(roundTrip(source, (tree) => {
    tree.children[0].children[0].value = "Before!";
  }), "Before!\n\n    alpha\n    beta\n\nAfter\n");
});

test("an unchanged unclosed fence remains exact source instead of being repaired", () => {
  const source = "```js\ncode\n```After\n";
  assert.equal(roundTrip(source), source);
  assert.equal(roundTrip("```js", (tree) => {
    tree.children[0].lang = "ts";
  }), "```ts\n");
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

  const crlf = "> ~~~~js\r\n> const quoted = true;\r\n> ~~~~~\r\n";
  assert.equal(roundTrip(crlf, (nestedTree) => {
    nestedTree.children[0].children[0].value = "const quoted = false;";
  }), "> ~~~~js\r\n> const quoted = false;\r\n> ~~~~~\n");
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
    fenceClosed: true,
    fenceLineEnding: "\n",
    fenceTrailingLineEnding: "",
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
    mathSourceValue: null,
    frontmatterBlock: false,
    frontmatterOpening: "---",
    frontmatterClosing: "---"
  });

  const editedCode = doc.firstChild.type.create(
    doc.firstChild.attrs,
    doc.type.schema.text("const answer = 43;")
  );
  const editedDoc = doc.type.create(null, [editedCode]);
  assert.equal(serialize(editedDoc), "~~~~js title=demo\nconst answer = 43;\n~~~~~\n");
});

test("Milkdown keeps front matter rendered as one editable YAML block", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "---\ntitle: Demo\ntags:\n  - alpha\n---\n\nBody\n";
  const doc = parse(source);
  const frontmatter = doc.firstChild;
  assert.deepEqual({
    language: frontmatter.attrs.language,
    frontmatterBlock: frontmatter.attrs.frontmatterBlock,
    opening: frontmatter.attrs.frontmatterOpening,
    closing: frontmatter.attrs.frontmatterClosing,
    value: frontmatter.textContent
  }, {
    language: "yaml",
    frontmatterBlock: true,
    opening: "---",
    closing: "---",
    value: "title: Demo\ntags:\n  - alpha"
  });
  assert.equal(serialize(doc), source);

  const edited = frontmatter.type.create(
    frontmatter.attrs,
    doc.type.schema.text("title: Changed\ntags:\n  - alpha")
  );
  assert.equal(
    serialize(doc.type.create(doc.attrs, [edited, doc.lastChild])),
    "---\ntitle: Changed\ntags:\n  - alpha\n---\n\nBody\n"
  );

  const crlfSource = "---\r\ntitle: Demo\r\n...\r\n\r\nBody\r\n";
  const crlfDoc = parse(crlfSource);
  assert.equal(serialize(crlfDoc), crlfSource);
  const editedCrlf = crlfDoc.firstChild.type.create(
    crlfDoc.firstChild.attrs,
    crlfDoc.type.schema.text("title: Changed")
  );
  assert.equal(
    serialize(crlfDoc.type.create(crlfDoc.attrs, [editedCrlf, crlfDoc.lastChild])),
    "---\r\ntitle: Changed\r\n...\r\n\r\nBody\r\n"
  );
});

test("Milkdown preserves indented code through unrelated and content edits", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before\n\n    alpha\n    beta\n\nAfter\n";
  const doc = parse(source);
  const code = doc.child(1);
  assert.equal(code.attrs.fenceMarker, null);
  assert.equal(code.attrs.fenceSource, "    alpha\n    beta");
  assert.equal(serialize(doc), source);

  const editedCode = code.type.create(code.attrs, doc.type.schema.text("alpha\nchanged"));
  const editedDoc = doc.type.create(doc.attrs, [doc.firstChild, editedCode, doc.lastChild]);
  assert.equal(serialize(editedDoc), "Before\n\n    alpha\n    changed\n\nAfter\n");
});

test("edited fenced code preserves CRLF wrappers and unclosed source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const crlf = "~~~~js title=demo\r\nconst answer = 42;\r\n~~~~~\r\n";
  const crlfDoc = parse(crlf);
  assert.equal(crlfDoc.firstChild.attrs.fenceLineEnding, "\r\n");
  assert.equal(crlfDoc.firstChild.attrs.fenceClosed, true);
  const editedCrlf = crlfDoc.firstChild.type.create(
    crlfDoc.firstChild.attrs,
    crlfDoc.type.schema.text("const answer = 43;")
  );
  assert.equal(
    serialize(crlfDoc.type.create(crlfDoc.attrs, [editedCrlf])),
    "~~~~js title=demo\r\nconst answer = 43;\r\n~~~~~\r\n"
  );

  const unclosed = "```js\r\ncode\r\n```After\r\n";
  const unclosedDoc = parse(unclosed);
  assert.equal(unclosedDoc.firstChild.attrs.fenceClosed, false);
  assert.equal(unclosedDoc.firstChild.attrs.fenceLineEnding, "\r\n");
  const editedUnclosed = unclosedDoc.firstChild.type.create(
    unclosedDoc.firstChild.attrs,
    unclosedDoc.type.schema.text(unclosedDoc.firstChild.textContent.replace("code", "changed"))
  );
  assert.equal(
    serialize(unclosedDoc.type.create(unclosedDoc.attrs, [editedUnclosed])),
    "```js\r\nchanged\r\n```After\r\n"
  );
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

  const cut = sourceClipboardEdit(state, "", parse, serialize);
  assert.ok(cut);
  assert.equal(serialize(cut.transaction.doc), "");
  assert.equal(cut.transaction.doc.firstChild.type.name, "paragraph");
  assert.equal(cut.transaction.selection.$from.parent.type.name, "paragraph");
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
  assert.deepEqual(documentGapSourceSelection(start, 0), {
    anchor: 0,
    head: 0,
    fullSource: source,
    boundary: 0,
    gapStart: 0,
    gapEnd: 1,
    beforeFrom: null,
    beforeTo: null,
    afterFrom: 0,
    afterTo: doc.firstChild.nodeSize
  });

  const end = documentSourceTarget(state, source.length, serialize, "backward");
  assert.equal(end.kind, "gap");
  assert.equal(end.position, doc.content.size);
  assert.equal(end.gapFrom, source.length - 2);
  assert.equal(end.gapTo, source.length);
  assert.equal(end.beforeSegment, end.documentSource.segments.at(-1));
  assert.equal(end.afterSegment, null);
  assert.deepEqual(documentGapSourceSelection(end, source.length), {
    anchor: source.length,
    head: source.length,
    fullSource: source,
    boundary: doc.content.size,
    gapStart: source.length - 2,
    gapEnd: source.length,
    beforeFrom: doc.content.size - doc.lastChild.nodeSize,
    beforeTo: doc.content.size,
    afterFrom: null,
    afterTo: null
  });

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
