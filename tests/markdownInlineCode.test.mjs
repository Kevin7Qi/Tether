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
  docSchema,
  inlineCodeAttr,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  annotateInlineCodeSources,
  sourceFaithfulInlineCodeRemark,
  sourceFaithfulInlineCodeSchema
} from "../src/renderer/lib/markdownInlineCode.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownSyntax,
  continuousMarkdownSource,
  sourceAwareClipboardText,
  sourceCaretOffset,
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
    .use(() => (tree, file) => annotateInlineCodeSources(tree, file))
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
    inlineCodeAttr,
    sourceFaithfulInlineCodeRemark,
    sourceFaithfulInlineCodeSchema
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

test("inline code retains redundant fences, padding, ticks, and physical line breaks", () => {
  const sources = [
    "``plain``\n",
    "`` plain ``\n",
    "``code ` tick``\n",
    "`line\nbreak`\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("Milkdown keeps inline-code style through edits and grows only for collisions", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Use ``plain`` here.\n");
  const code = doc.firstChild.child(1);
  const mark = code.marks.find((candidate) => candidate.type.name === "inlineCode");
  assert.equal(mark.attrs.inlineCodeFenceLength, 2);
  assert.equal(mark.attrs.inlineCodeRawContent, "plain");
  assert.equal(mark.attrs.inlineCodeSourceText, "plain");
  const dom = mark.type.spec.toDOM(mark);
  assert.equal(dom[1]["data-md-inline-code-fence"], 2);
  assert.equal(dom[1]["data-md-inline-code-raw"], "plain");

  const position = textPosition(doc, "plain");
  const edited = EditorState.create({ doc }).tr.insertText("changed", position, position + 5).doc;
  assert.equal(serialize(edited), "Use ``changed`` here.\n");

  const collision = EditorState.create({ doc }).tr
    .insertText("has `` ticks", position, position + 5).doc;
  assert.equal(serialize(collision), "Use ```has `` ticks``` here.\n");
});

test("rendered inline-code selections retain only the traversed backtick source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Use ``plain`` after.\n");
  const position = textPosition(doc, "plain");
  const partial = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 1, position + 4)
  });
  assert.equal(sourceAwareClipboardText(partial, serialize), "lai");

  const throughClosingFence = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 2, position + "plain".length + 3)
  });
  assert.equal(
    sourceSelectionText(sourceSelectionFromDocumentSelection(throughClosingFence, serialize)),
    "ain`` af"
  );
});

test("editing padded inline code retains its deliberate padding", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("`` padded ``\n");
  const position = textPosition(doc, "padded");
  const edited = EditorState.create({ doc }).tr.insertText("changed", position, position + 6).doc;
  assert.equal(serialize(edited), "`` changed ``\n");
});

test("multi-backtick inline code opens source at the matching source caret", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Use ``plain`` here.\n");
  const position = textPosition(doc, "plain");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 2)
  });
  const unit = activeMarkdownSyntax(state);
  const source = continuousMarkdownSource(state, unit, serialize);
  assert.equal(source, "``plain``");
  assert.equal(sourceCaretOffset(state, unit, source, position + 2, null, serialize), 4);
});
