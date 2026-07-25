import assert from "node:assert/strict";
import test from "node:test";
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
import { Fragment } from "@milkdown/kit/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import {
  bulletListAttr,
  hardbreakAttr,
  listItemAttr,
  listItemSchema,
  orderedListAttr,
  remarkLineBreak,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import { sourceFaithfulHardBreakSchema } from "../src/renderer/lib/markdownBreak.js";
import {
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "../src/renderer/lib/markdownDocument.js";
import {
  sourceFaithfulFootnoteDefinitionSchema,
  sourceFaithfulFootnoteReferenceSchema,
  sourceFaithfulFootnoteRemark
} from "../src/renderer/lib/markdownFootnote.js";
import { sourceFaithfulParagraphRemark, sourceFaithfulParagraphSchema } from "../src/renderer/lib/markdownParagraph.js";
import {
  sourceFaithfulBulletListSchema,
  sourceFaithfulBulletRemark,
  sourceFaithfulOrderedListSchema,
  sourceFaithfulTaskListItemSchema
} from "../src/renderer/lib/markdownList.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownAtomSyntax,
  activeMarkdownBlockSyntax,
  continuousMarkdownSource,
  markdownSourceDraftMarkdown,
  sourceCaretOffset,
  sourceFaithfulListMarkerBackspaceTransaction
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

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
    textSchema,
    bulletListAttr,
    orderedListAttr,
    listItemAttr,
    listItemSchema,
    hardbreakAttr,
    remarkLineBreak,
    sourceFaithfulHardBreakSchema,
    sourceFaithfulParagraphRemark,
    sourceFaithfulParagraphSchema,
    sourceFaithfulBulletRemark,
    sourceFaithfulFootnoteRemark,
    sourceFaithfulBulletListSchema,
    sourceFaithfulOrderedListSchema,
    sourceFaithfulTaskListItemSchema,
    sourceFaithfulFootnoteDefinitionSchema,
    sourceFaithfulFootnoteReferenceSchema
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

function nodePosition(doc, name) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && node.type.name === name) position = pos;
  });
  return position;
}

test("footnotes parse as rendered nodes and retain exact labels and definition layout", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = [
    "A note[^Mixed-Case].",
    "",
    "[^Mixed-Case]: body &copy;",
    "    continuation",
    "",
    "    second paragraph",
    ""
  ].join("\n");
  const doc = parse(source);
  const referencePosition = nodePosition(doc, "footnote_reference");
  const definitionPosition = nodePosition(doc, "footnote_definition");
  const reference = doc.nodeAt(referencePosition);
  const definition = doc.nodeAt(definitionPosition);
  assert.equal(reference.attrs.label, "Mixed-Case");
  assert.equal(reference.attrs.footnoteSource, "[^Mixed-Case]");
  assert.equal(definition.attrs.label, "Mixed-Case");
  assert.match(definition.attrs.footnoteDefinitionSource, /&copy;/);
  assert.equal(typeof definition.attrs.footnoteDefinitionSignature, "string");
  assert.equal(serialize(doc), source);
});

test("an outside edit leaves a footnote definition byte-identical", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Change me[^N].\n\n[^N]: keep &copy;\n    continuation\n";
  const doc = parse(source);
  const change = textPosition(doc, "Change me");
  const edited = EditorState.create({ doc }).tr
    .insertText("Changed", change, change + "Change me".length).doc;
  assert.equal(serialize(edited), "Changed[^N].\n\n[^N]: keep &copy;\n    continuation\n");
});

test("editing a footnote body preserves its rendered definition and label", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("A[^Case].\n\n[^Case]: old\n");
  const old = textPosition(doc, "old");
  const edited = EditorState.create({ doc }).tr.insertText("new", old, old + 3).doc;
  assert.equal(serialize(edited), "A[^Case].\n\n[^Case]: new\n");
});

test("footnote references and definitions expose exact source controls", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "A[^Case].\n\n[^Case]: body &copy;\n";
  const doc = parse(source);
  const referencePosition = nodePosition(doc, "footnote_reference");
  const referenceState = EditorState.create({
    doc,
    selection: NodeSelection.create(doc, referencePosition)
  });
  const referenceUnit = activeMarkdownAtomSyntax(referenceState);
  assert.equal(continuousMarkdownSource(referenceState, referenceUnit, serialize), "[^Case]");
  assert.equal(
    markdownSourceDraftMarkdown(
      referenceState,
      parse,
      serialize,
      referenceUnit,
      "^Case]"
    ),
    "A^Case].\n\n[^Case]: body &copy;\n"
  );

  const body = textPosition(doc, "body ©");
  const definitionState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, body + 2)
  });
  const definitionUnit = activeMarkdownBlockSyntax(definitionState);
  assert.equal(definitionUnit?.name, "footnote_definition");
  assert.equal(
    continuousMarkdownSource(definitionState, definitionUnit, serialize),
    "[^Case]: body &copy;"
  );
});

test("changing a footnote label intentionally regenerates its source token", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("A[^Old].\n\n[^Old]: body\n");
  const position = nodePosition(doc, "footnote_reference");
  const reference = doc.nodeAt(position);
  const edited = EditorState.create({ doc }).tr.setNodeMarkup(position, undefined, {
    ...reference.attrs,
    label: "New"
  }).doc;
  assert.match(serialize(edited), /^A\[\^New\]\./);
});

test("a multi-paragraph footnote maps a later caret through exact indentation", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const markdown = [
    "Lead[^N].",
    "",
    "[^N]: outer &copy;",
    "    continuation",
    "",
    "      target",
    ""
  ].join("\n");
  const doc = parse(markdown);
  const position = textPosition(doc, "target");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position)
  });
  const unit = activeMarkdownBlockSyntax(state);
  const source = continuousMarkdownSource(state, unit, serialize);
  assert.equal(unit?.name, "footnote_definition");
  assert.equal(source, markdown.slice(markdown.indexOf("[^N]:")).trimEnd());
  assert.equal(
    sourceCaretOffset(state, unit, source, position, null, serialize),
    source.indexOf("target")
  );
});

test("list Backspace inside a footnote removes only the nearest physical indentation", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const { source, expected, text } of [
    {
      source: "Lead[^N].\n\n[^N]:\n    + outer\n      * nested\n    + after\n",
      expected: "Lead[^N].\n\n[^N]:\n    + outer\n    * nested\n    + after\n",
      text: "nested"
    },
    {
      source: "Lead[^N].\n\n[^N]:\n    + first\n    + second\n",
      expected: "Lead[^N].\n\n[^N]:\n    first\n    + second\n",
      text: "first"
    }
  ]) {
    const doc = parse(source);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, textPosition(doc, text))
    });
    const transaction = sourceFaithfulListMarkerBackspaceTransaction(state, parse, serialize);
    assert.ok(transaction);
    assert.equal(serialize(transaction.doc), expected);
    assert.equal(transaction.selection.$from.parentOffset, 0);
  }
});

test("changing a list marker inside a footnote invalidates its stale raw definition source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Lead[^N].\n\n[^N]:\n    + item\n";
  const doc = parse(source);
  const position = nodePosition(doc, "bullet_list");
  const list = doc.nodeAt(position);
  const edited = EditorState.create({ doc }).tr.setNodeMarkup(position, undefined, {
    ...list.attrs,
    bulletMarker: "*"
  }).doc;
  assert.equal(serialize(edited), "Lead[^N].\n\n[^N]: * item\n");
});

test("a marked empty editor paragraph inside a terminal footnote is serialization-only chrome", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Lead[^N].\n\n[^N]: note\n";
  const doc = parse(source);
  const definition = doc.lastChild;
  const synthetic = doc.type.schema.nodes.paragraph.create({ tetherSyntheticTrailing: true });
  const withSynthetic = definition.type.create(
    definition.attrs,
    definition.content.append(Fragment.from(synthetic))
  );
  const edited = doc.type.create(doc.attrs, [doc.firstChild, withSynthetic]);
  assert.equal(serialize(edited), source);
});
