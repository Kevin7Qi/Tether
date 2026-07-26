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
  blockquoteAttr,
  docSchema,
  headingAttr,
  headingIdGenerator,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  sourceFaithfulBlockquoteRemark,
  sourceFaithfulBlockquoteSchema
} from "../src/renderer/lib/markdownBlockquote.js";
import {
  annotateHeadingMarkers,
  headingSemanticSignature,
  sourceFaithfulHeadingRemark,
  sourceFaithfulHeadingSchema
} from "../src/renderer/lib/markdownHeading.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  documentPositionAtSourceOffset,
  documentSourceSegments,
  documentSourceUnitBoundaryNavigationOffset,
  plainTextMarkdownSourceSelection,
  plainTextMarkdownSourceToken,
  replaceSourceSelectionTransaction,
  sourceControlInitialDeletion,
  sourceFaithfulHeadingBoundaryDeletionTarget
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => annotateHeadingMarkers(tree, file))
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
    docSchema,
    paragraphSchema,
    textSchema,
    blockquoteAttr,
    headingAttr,
    headingIdGenerator,
    sourceFaithfulHeadingRemark,
    sourceFaithfulBlockquoteRemark,
    sourceFaithfulBlockquoteSchema,
    sourceFaithfulHeadingSchema
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

test("setext and closed ATX headings retain their source forms", () => {
  const source = "Title &copy;\n=====\n\n## Section &copy; ##\n";
  assert.equal(roundTrip(source), source);
});

test("nested setext annotation reads the physical underline past quote prefixes", () => {
  const source = "> Quoted title\n> ------\n";
  const processor = unified().use(remarkParse);
  const tree = processor.parse(source);
  annotateHeadingMarkers(tree, { value: source });
  const heading = tree.children[0].children[0];
  assert.equal(heading.markdownStyle, "setext");
  assert.equal(heading.setextMarker, "-");
  assert.equal(heading.setextLength, 6);
});

test("Milkdown preserves a setext underline through text edits and exposes its real marker", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Title\n=====\n");
  assert.deepEqual({
    id: doc.firstChild.attrs.id,
    level: doc.firstChild.attrs.level,
    markdownStyle: doc.firstChild.attrs.markdownStyle,
    setextMarker: doc.firstChild.attrs.setextMarker,
    setextLength: doc.firstChild.attrs.setextLength,
    atxClosingLength: doc.firstChild.attrs.atxClosingLength
  }, {
    id: "",
    level: 1,
    markdownStyle: "setext",
    setextMarker: "=",
    setextLength: 5,
    atxClosingLength: 0
  });
  assert.equal(doc.firstChild.attrs.headingSource, "Title\n=====");
  assert.equal(doc.firstChild.attrs.headingSourceStart, 0);
  assert.equal(doc.firstChild.attrs.headingContentStart, 0);
  assert.equal(doc.firstChild.attrs.headingContentEnd, 5);
  assert.equal(
    doc.firstChild.attrs.headingSourceSignature,
    headingSemanticSignature({
      type: "heading",
      depth: 1,
      children: [{ type: "text", value: "Title" }]
    })
  );
  const dom = doc.firstChild.type.spec.toDOM(doc.firstChild);
  assert.equal(dom[1]["data-md-heading-style"], "setext");
  assert.equal(dom[1]["data-md-heading-marker"], "=====");
  assert.equal(dom[1]["data-md-heading-source"], "Title\n=====");

  const editedHeading = doc.firstChild.type.create(
    doc.firstChild.attrs,
    doc.type.schema.text("Renamed")
  );
  const editedDoc = doc.type.create(null, [editedHeading]);
  assert.equal(serialize(editedDoc), "Renamed\n=====\n");
});

test("Backspace at rendered heading starts deletes the adjacent physical source byte", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const [source, expected] of [
    ["## Title\n", "##Title\n"],
    ["### Title ###\n", "###Title ###\n"]
  ]) {
    const doc = parse(source);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1)
    });
    const target = sourceFaithfulHeadingBoundaryDeletionTarget(
      state,
      serialize,
      "backward"
    );
    assert.ok(target);
    assert.equal(
      sourceControlInitialDeletion(
        target.source,
        target.sourceOffset,
        "backward"
      )?.afterValue,
      expected.trimEnd()
    );
  }

  const setext = parse("Title\n=====\n");
  assert.equal(
    sourceFaithfulHeadingBoundaryDeletionTarget(
      EditorState.create({
        doc: setext,
        selection: TextSelection.create(setext, 1)
      }),
      serialize,
      "backward"
    ),
    null
  );

  for (const [source, expected] of [
    ["## Title ##\n", "## Title##"],
    ["Title\n=====\n", "Title====="]
  ]) {
    const doc = parse(source);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1 + "Title".length)
    });
    const target = sourceFaithfulHeadingBoundaryDeletionTarget(
      state,
      serialize,
      "forward"
    );
    assert.ok(target);
    assert.equal(
      sourceControlInitialDeletion(
        target.source,
        target.sourceOffset,
        "forward"
      )?.afterValue,
      expected
    );
  }
});

test("nested heading boundaries edit the nearest byte in their enclosing physical source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const cases = [
    {
      source: "> ## Title ##\n",
      direction: "backward",
      offset: 0,
      expected: "> ##Title ##"
    },
    {
      source: "> Title\n> =====\n",
      direction: "backward",
      offset: 0,
      expected: ">Title\n> ====="
    },
    {
      source: "> ## Title ##\n",
      direction: "forward",
      offset: "Title".length,
      expected: "> ## Title##"
    },
    {
      source: "> Title\n> =====\n",
      direction: "forward",
      offset: "Title".length,
      expected: "> Title> ====="
    }
  ];

  for (const testCase of cases) {
    const doc = parse(testCase.source);
    const titleStart = textPosition(doc, "Title");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, titleStart + testCase.offset)
    });
    const target = sourceFaithfulHeadingBoundaryDeletionTarget(
      state,
      serialize,
      testCase.direction,
      parse
    );
    assert.ok(target, `${testCase.direction} target for ${JSON.stringify(testCase.source)}`);
    assert.equal(target.source, testCase.source.trimEnd());
    assert.equal(target.unit.documentSource, testCase.source);
    assert.equal(target.unit.sourceStart, 0);
    assert.equal(
      sourceControlInitialDeletion(
        target.source,
        target.sourceOffset,
        testCase.direction
      )?.afterValue,
      testCase.expected
    );
  }
});

test("heading literals navigate and edit through their exact physical source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "## A &copy; and \\*literal\\* ##\n\noutside\n";
  const doc = parse(source);
  assert.equal(serialize(doc), source);
  const rendered = "A © and *literal*";
  const textStart = textPosition(doc, rendered);
  const entity = textStart + rendered.indexOf("©");
  const tokenState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity)
  });
  const token = plainTextMarkdownSourceToken(tokenState, "forward", serialize);
  assert.equal(token?.unit.source, "&copy;");
  assert.equal(token?.unit.segmentSourceOffset, source.indexOf("&copy;"));

  const escape = textStart + rendered.indexOf("*literal*");
  const escapeState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, escape)
  });
  const escapeToken = plainTextMarkdownSourceToken(escapeState, "forward", serialize);
  const afterNextCharacter = documentSourceUnitBoundaryNavigationOffset(
    escapeState,
    escapeToken.unit,
    "forward",
    serialize
  );
  assert.equal(afterNextCharacter, source.indexOf("\\*literal") + 3);
  assert.equal(
    documentPositionAtSourceOffset(escapeState, afterNextCharacter, serialize),
    escape + 2
  );

  const insertion = textStart + rendered.indexOf("literal") + 1;
  const insertionState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, insertion)
  });
  const sourceSelection = plainTextMarkdownSourceSelection(insertionState, serialize);
  const transaction = replaceSourceSelectionTransaction(
    insertionState,
    sourceSelection,
    "X",
    parse
  );
  assert.equal(
    serialize(transaction.doc),
    "## A &copy; and \\*lXiteral\\* ##\n\noutside\n"
  );

  const outside = textPosition(doc, "outside");
  const outsideEdited = EditorState.create({ doc }).tr.insertText("changed", outside, outside + 7);
  assert.equal(serialize(outsideEdited.doc), "## A &copy; and \\*literal\\* ##\n\nchanged\n");
});

test("setext heading content retains physical entities above its underline", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Title &copy;\n=====\n";
  const doc = parse(source);
  const rendered = "Title ©";
  const entity = textPosition(doc, rendered) + rendered.indexOf("©");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity)
  });
  assert.equal(serialize(doc), source);
  const token = plainTextMarkdownSourceToken(state, "forward", serialize);
  assert.equal(token?.unit.source, "&copy;");
  assert.equal(token?.unit.segmentSourceOffset, source.indexOf("&copy;"));
});

test("quoted heading content maps through its enclosing physical prefix", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "> ## Quoted &copy; and \\*literal\\* ##\n";
  const doc = parse(source);
  const rendered = "Quoted © and *literal*";
  const entity = textPosition(doc, rendered) + rendered.indexOf("©");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity)
  });
  assert.equal(doc.firstChild.attrs.blockquoteSource, source.trimEnd());
  assert.equal(doc.firstChild.firstChild.attrs.headingSource, null);
  assert.equal(doc.firstChild.firstChild.attrs.headingContentStart, source.indexOf("Quoted"));
  const documentSource = documentSourceSegments(state, serialize);
  assert.equal(
    documentSource?.fullSource.slice(documentSource.segments[0].from, documentSource.segments[0].to),
    source.trimEnd()
  );
  const token = plainTextMarkdownSourceToken(state, "forward", serialize);
  assert.equal(token?.unit.source, "&copy;");
  assert.equal(token?.unit.segmentSourceOffset, source.indexOf("&copy;"));
  assert.equal(serialize(doc), source);
});
