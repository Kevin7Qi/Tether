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
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  annotateBlockquoteSources,
  sourceFaithfulBlockquoteRemark,
  sourceFaithfulBlockquoteSchema
} from "../src/renderer/lib/markdownBlockquote.js";
import {
  sourceFaithfulParagraphRemark,
  sourceFaithfulParagraphSchema
} from "../src/renderer/lib/markdownParagraph.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownBlockSyntax,
  continuousMarkdownSource,
  plainTextMarkdownSourceSelection,
  plainTextMarkdownSourceToken,
  sourceCaretOffset,
  sourceSelectionText
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => annotateBlockquoteSources(tree, file))
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
    textSchema,
    blockquoteAttr,
    sourceFaithfulParagraphRemark,
    sourceFaithfulParagraphSchema,
    sourceFaithfulBlockquoteRemark,
    sourceFaithfulBlockquoteSchema
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

test("blockquotes retain spacing, lazy lines, nested markers, and blank quote lines", () => {
  const sources = [
    ">text\n",
    ">  two spaces\n",
    ">\tTabbed\n",
    "> first\nlazy second\n",
    "> first\n>\n> third\n",
    "> >nested\n",
    "> > nested\n",
    ">\n> blank\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("Milkdown keeps physical quote prefixes through ordinary text edits", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const [source, original, changed, expected, prefix] of [
    [">plain\n", "plain", "changed", ">changed\n", ">"],
    [">  plain\n", "plain", "changed", ">  changed\n", ">  "],
    [">\tplain\n", "plain", "changed", ">\tchanged\n", ">\t"],
    ["> >nested\n", "nested", "changed", "> >changed\n", "> "]
  ]) {
    const doc = parse(source);
    const position = textPosition(doc, original);
    const edited = EditorState.create({ doc }).tr
      .insertText(changed, position, position + original.length).doc;
    assert.equal(serialize(edited), expected);
    const quote = doc.firstChild;
    assert.equal(quote.attrs.blockquotePreferredPrefix, prefix);
    assert.equal(quote.type.spec.toDOM(quote)[1]["data-md-blockquote-prefix"], prefix);
  }
});

test("a lazy continuation remains lazy after editing its text", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("> first\nlazy second\n");
  const position = textPosition(doc, "first\nlazy second");
  assert.notEqual(position, null);
  const edited = EditorState.create({ doc }).tr
    .insertText("changed\nlazy second", position, position + "first\nlazy second".length).doc;
  assert.equal(serialize(edited), "> changed\nlazy second\n");
});

test("an outside edit leaves an unusual quote byte-identical", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "> first\nlazy second\n\noutside\n";
  const doc = parse(source);
  const position = textPosition(doc, "outside");
  const edited = EditorState.create({ doc }).tr
    .insertText("changed", position, position + "outside".length).doc;
  assert.equal(serialize(edited), "> first\nlazy second\n\nchanged\n");
});

test("no-space quote source maps the rendered caret past one real marker", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse(">plain\n");
  const position = textPosition(doc, "plain");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 2)
  });
  const unit = activeMarkdownBlockSyntax(state);
  const source = continuousMarkdownSource(state, unit, serialize);
  assert.equal(source, ">plain");
  assert.equal(sourceCaretOffset(state, unit, source, position + 2, null, serialize), 3);
});

test("a lazy blockquote maps a later paragraph caret through its exact physical prefixes", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const markdown = ">outer &copy;\nlazy continuation\n>\n>  target\n";
  const doc = parse(markdown);
  const position = textPosition(doc, "target");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position)
  });
  const unit = activeMarkdownBlockSyntax(state);
  const source = continuousMarkdownSource(state, unit, serialize);
  assert.equal(unit?.name, "blockquote");
  assert.equal(source, markdown.trimEnd());
  assert.equal(
    sourceCaretOffset(state, unit, source, position, null, serialize),
    source.indexOf("target")
  );
});

test("rendered blockquote literals retain exact escape and entity coordinates", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "> Before \\*literal\\* and &copy; after.\n";
  const doc = parse(source);
  const rendered = "Before *literal* and © after.";
  const textStart = textPosition(doc, rendered);
  const escape = textStart + rendered.indexOf("*literal*");
  const tokenState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, escape)
  });
  const token = plainTextMarkdownSourceToken(tokenState, "forward", serialize);
  assert.equal(token?.unit.source, "\\*");
  assert.equal(token?.unit.segmentSourceOffset, source.indexOf("\\*"));

  const entity = textStart + rendered.indexOf("©");
  const entityState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity, entity + 1)
  });
  assert.equal(
    sourceSelectionText(plainTextMarkdownSourceSelection(entityState, serialize)),
    "&copy;"
  );
});
