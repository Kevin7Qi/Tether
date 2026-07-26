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
  schemaCtx,
  serializer,
  serializerCtx
} from "@milkdown/kit/core";
import { Clock, Container, Ctx } from "@milkdown/kit/ctx";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import {
  docSchema,
  emphasisAttr,
  paragraphSchema,
  strongAttr,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  annotateAttentionSources,
  sourceFaithfulAttentionRemark,
  sourceFaithfulAttentionSerializer,
  sourceFaithfulEmphasisSchema,
  sourceFaithfulStrongSchema,
  serializationAttentionGroupSchema
} from "../src/renderer/lib/markdownAttention.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownSyntax,
  continuousMarkdownSource,
  sourceAwareClipboardText,
  sourceCaretOffset,
  sourceClipboardEdit,
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
    .use(() => (tree, file) => annotateAttentionSources(tree, file))
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
    emphasisAttr,
    strongAttr,
    sourceFaithfulAttentionRemark,
    sourceFaithfulEmphasisSchema,
    sourceFaithfulStrongSchema,
    serializationAttentionGroupSchema,
    sourceFaithfulAttentionSerializer
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
    return {
      parse: ctx.get(parserCtx),
      proseSchema: ctx.get(schemaCtx),
      serialize: ctx.get(serializerCtx)
    };
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

test("attention marks retain exact star, underscore, mixed, and escaped source", () => {
  const sources = [
    "*one*\n",
    "_one_\n",
    "**two**\n",
    "__two__\n",
    "***both***\n",
    "___both___\n",
    "**_both_**\n",
    "__*both*__\n",
    "*__both__*\n",
    "_**both**_\n",
    "**outer *inner* tail**\n",
    "__outer _inner_ tail__\n",
    "*a \\* b*\n",
    "foo***bar***baz\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("Milkdown preserves marker choice and combined nesting through text edits", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const [source, expected] of [
    ["_plain_\n", "_changed_\n"],
    ["__plain__\n", "__changed__\n"],
    ["***plain***\n", "***changed***\n"],
    ["___plain___\n", "___changed___\n"],
    ["**_plain_**\n", "**_changed_**\n"],
    ["__*plain*__\n", "__*changed*__\n"],
    ["*__plain__*\n", "*__changed__*\n"],
    ["_**plain**_\n", "_**changed**_\n"]
  ]) {
    const doc = parse(source);
    const position = textPosition(doc, "plain");
    const edited = EditorState.create({ doc }).tr
      .insertText("changed", position, position + "plain".length).doc;
    assert.equal(serialize(edited), expected);
  }
});

test("partial nested attention retains each delimiter style after an inner edit", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const [source, expected] of [
    ["__outer *inner* tail__\n", "__outer *changed* tail__\n"],
    ["*outer **inner** tail*\n", "*outer **changed** tail*\n"]
  ]) {
    const doc = parse(source);
    const position = textPosition(doc, "inner");
    const edited = EditorState.create({ doc }).tr
      .insertText("changed", position, position + "inner".length).doc;
    assert.equal(serialize(edited), expected);
  }
});

test("newly created nested marks serialize as one balanced source run", async () => {
  const { proseSchema, serialize } = await milkdownTransformer();
  const emphasis = proseSchema.marks.emphasis.create({ marker: "*" });
  const strong = proseSchema.marks.strong.create({ marker: "*" });
  const paragraph = proseSchema.nodes.paragraph;
  const doc = proseSchema.nodes.doc;

  const strongOutside = doc.create(null, paragraph.create(null, [
    proseSchema.text("outer ", [strong]),
    proseSchema.text("inner", [strong, emphasis]),
    proseSchema.text(" tail", [strong])
  ]));
  assert.equal(serialize(strongOutside), "**outer *inner* tail**\n");

  const emphasisOutside = doc.create(null, paragraph.create(null, [
    proseSchema.text("outer ", [emphasis]),
    proseSchema.text("inner", [emphasis, strong]),
    proseSchema.text(" tail", [emphasis])
  ]));
  assert.equal(serialize(emphasisOutside), "*outer **inner** tail*\n");

  const coextensive = doc.create(null, paragraph.create(null,
    proseSchema.text("both", [emphasis, strong])));
  assert.equal(serialize(coextensive), "***both***\n");
});

test("removing one combined mark does not resurrect it from source metadata", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("**_plain_**\n");
  const position = textPosition(doc, "plain");
  const edited = EditorState.create({ doc }).tr
    .removeMark(position, position + "plain".length, doc.type.schema.marks.strong).doc;
  assert.equal(serialize(edited), "_plain_\n");
});

test("attention marks expose their real marker and escape edited collisions", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("_plain_\n");
  const text = doc.firstChild.firstChild;
  const mark = text.marks.find((candidate) => candidate.type.name === "emphasis");
  assert.equal(mark.attrs.marker, "_");
  assert.equal(mark.type.spec.toDOM(mark)[1]["data-md-attention-marker"], "_");

  const position = textPosition(doc, "plain");
  const collision = EditorState.create({ doc }).tr
    .insertText("has _ marker", position, position + "plain".length).doc;
  assert.equal(serialize(collision), "_has \\_ marker_\n");
});

test("underscore strong source opens at the matching source caret", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Use __plain__ here.\n");
  const position = textPosition(doc, "plain");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 2)
  });
  const unit = activeMarkdownSyntax(state);
  const source = continuousMarkdownSource(state, unit, serialize);
  assert.equal(source, "__plain__");
  assert.equal(sourceCaretOffset(state, unit, source, position + 2, null, serialize), 4);
});

test("partial nested attention opens its exact group source without resurrecting removed marks", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Before **Bold *Both*** after.\n");
  const position = textPosition(doc, "Both");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 2)
  });
  const unit = activeMarkdownSyntax(state);
  assert.deepEqual(unit.names.sort(), ["emphasis", "strong"]);
  assert.equal(
    continuousMarkdownSource(state, unit, serialize),
    "**Bold *Both***"
  );

  const emphasis = doc.type.schema.marks.emphasis;
  const editedDoc = state.tr
    .removeMark(position, position + "Both".length, emphasis)
    .doc;
  const editedState = EditorState.create({
    doc: editedDoc,
    selection: TextSelection.create(editedDoc, position + 2)
  });
  assert.equal(serialize(editedDoc), "Before **Bold Both** after.\n");
  assert.equal(
    continuousMarkdownSource(
      editedState,
      activeMarkdownSyntax(editedState),
      serialize
    ),
    "**Bold Both**"
  );
});

test("rendered attention selections use exact physical source intervals", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("A **bold word** tail\n");
  const position = textPosition(doc, "bold word");
  const partial = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 1, position + 4)
  });
  assert.equal(
    sourceSelectionText(sourceSelectionFromDocumentSelection(partial, serialize)),
    "old"
  );
  assert.equal(sourceAwareClipboardText(partial, serialize), "old");

  const edit = sourceClipboardEdit(partial, "X", parse, serialize);
  assert.equal(edit?.selectedText, "old");
  assert.equal(serialize(edit.transaction.doc), "A **bX word** tail\n");

  const acrossOpeningMarker = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position - 2, position + 4)
  });
  assert.equal(
    sourceSelectionText(sourceSelectionFromDocumentSelection(acrossOpeningMarker, serialize)),
    "A **bold"
  );
});
