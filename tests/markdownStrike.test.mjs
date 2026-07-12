import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
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
import { docSchema, paragraphSchema, textSchema } from "@milkdown/kit/preset/commonmark";
import { remarkGFMPlugin, strikethroughAttr } from "@milkdown/kit/preset/gfm";
import {
  annotateStrikeSources,
  sourceFaithfulStrikeInputRule,
  sourceFaithfulStrikeRemark,
  sourceFaithfulStrikeSchema,
  strikeInputAttributes
} from "../src/renderer/lib/markdownStrike.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownSyntax,
  continuousMarkdownSource,
  sourceCaretOffset
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree, file) => annotateStrikeSources(tree, file))
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
    strikethroughAttr,
    remarkGFMPlugin,
    sourceFaithfulStrikeRemark,
    sourceFaithfulStrikeSchema,
    sourceFaithfulStrikeInputRule
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
      serialize: ctx.get(serializerCtx),
      strikeInputRule: sourceFaithfulStrikeInputRule.inputRule
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

test("strikethrough retains single and double source delimiters exactly", () => {
  const sources = [
    "~one~\n",
    "~~two~~\n",
    "a~intra~b\n",
    "~a ~ b~\n",
    "~one~ and ~~two~~\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("Milkdown keeps strike delimiter width through text edits and escapes collisions", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const single = parse("Use ~plain~ here.\n");
  const position = textPosition(single, "plain");
  const mark = single.firstChild.child(1).marks.find((candidate) => candidate.type.name === "strike_through");
  assert.equal(mark.attrs.strikeMarkerLength, 1);
  assert.equal(mark.attrs.strikeSource, "~plain~");
  assert.equal(mark.type.spec.toDOM(mark)[1]["data-md-strike-marker"], 1);

  const edited = EditorState.create({ doc: single }).tr
    .insertText("changed", position, position + 5).doc;
  assert.equal(serialize(edited), "Use ~changed~ here.\n");

  const collision = EditorState.create({ doc: single }).tr
    .insertText("has ~ tilde", position, position + 5).doc;
  assert.equal(serialize(collision), "Use ~has \\~ tilde~ here.\n");

  const double = parse("Use ~~plain~~ here.\n");
  const doublePosition = textPosition(double, "plain");
  const doubleEdited = EditorState.create({ doc: double }).tr
    .insertText("changed", doublePosition, doublePosition + 5).doc;
  assert.equal(serialize(doubleEdited), "Use ~~changed~~ here.\n");
});

test("typed strike delimiters create matching source-width attributes", async () => {
  assert.deepEqual(strikeInputAttributes(["~one~", "~", "one"]), { strikeMarkerLength: 1 });
  assert.deepEqual(strikeInputAttributes(["~~two~~", "~~", "two"]), { strikeMarkerLength: 2 });

  const { proseSchema, serialize, strikeInputRule } = await milkdownTransformer();
  for (const [source, marker, content, expectedLength] of [
    ["~one~", "~", "one", 1],
    ["~~two~~", "~~", "two", 2]
  ]) {
    const doc = proseSchema.nodes.doc.create(null,
      proseSchema.nodes.paragraph.create(null, proseSchema.text(source)));
    const state = EditorState.create({ doc });
    const transaction = strikeInputRule.handler(
      state,
      [source, marker, content],
      1,
      source.length + 1
    );
    const transformed = transaction.doc;
    const mark = transformed.firstChild.firstChild.marks.find(
      (candidate) => candidate.type.name === "strike_through"
    );
    assert.equal(mark.attrs.strikeMarkerLength, expectedLength);
    assert.equal(serialize(transformed), `${source}\n`);
  }
});

test("single-tilde strike opens source at the matching source caret", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Use ~plain~ here.\n");
  const position = textPosition(doc, "plain");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 2)
  });
  const unit = activeMarkdownSyntax(state);
  const source = continuousMarkdownSource(state, unit, serialize);
  assert.equal(source, "~plain~");
  assert.equal(sourceCaretOffset(state, unit, source, position + 2, null, serialize), 3);
});
