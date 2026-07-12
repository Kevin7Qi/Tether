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
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import {
  docSchema,
  htmlSchema,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  renderedInlineHtmlRemark,
  renderedInlineHtmlSchema
} from "../src/renderer/lib/markdownHtml.js";
import { sourceFaithfulParagraphRemark, sourceFaithfulParagraphSchema } from "../src/renderer/lib/markdownParagraph.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownSyntax,
  continuousMarkdownSource
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
    docSchema,
    paragraphSchema,
    textSchema,
    htmlSchema,
    renderedInlineHtmlRemark,
    renderedInlineHtmlSchema,
    sourceFaithfulParagraphRemark,
    sourceFaithfulParagraphSchema
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

test("safe paired inline HTML renders as marks and retains exact tag source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before <U >under</U > and <kbd>Ctrl</kbd> after.\n";
  const doc = parse(source);
  const under = textPosition(doc, "under");
  const underNode = doc.nodeAt(under);
  const underline = underNode.marks.find((mark) => mark.type.name === "html_inline");
  assert.equal(underline.attrs.tag, "u");
  assert.equal(underline.attrs.openingSource, "<U >");
  assert.equal(underline.attrs.closingSource, "</U >");
  assert.deepEqual(underline.type.spec.toDOM(underline), [
    "u",
    {
      "data-md-html-inline": "",
      "data-md-html-tag": "u",
      "data-md-html-opening": "<U >",
      "data-md-html-closing": "</U >"
    },
    0
  ]);
  assert.equal(serialize(doc), source);
});

test("editing rendered inline HTML changes only its visible text", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Before <mark>old</mark> and <kbd>Ctrl</kbd>.\n");
  const old = textPosition(doc, "old");
  const edited = EditorState.create({ doc }).tr.insertText("new", old, old + 3).doc;
  assert.equal(serialize(edited), "Before <mark>new</mark> and <kbd>Ctrl</kbd>.\n");
});

test("nested inline HTML stays literal rather than producing an inconsistent mark tree", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "<u>under <small>quiet</small></u>\n";
  const doc = parse(source);
  const htmlValues = [];
  doc.descendants((node) => {
    if (node.type.name === "html") htmlValues.push(node.attrs.value);
  });
  assert.deepEqual(htmlValues, ["<u>", "<small>", "</small>", "</u>"]);
  assert.equal(serialize(doc), source);
});

test("attribute-bearing, unpaired, and unsafe HTML stays literal source atoms", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before <u class=\"x\">literal</u> <script>alert(1)</script> <mark>open.\n";
  const doc = parse(source);
  const htmlValues = [];
  doc.descendants((node) => {
    if (node.type.name === "html") htmlValues.push(node.attrs.value);
  });
  assert.deepEqual(htmlValues, ["<u class=\"x\">", "</u>", "<script>", "</script>", "<mark>"]);
  assert.equal(serialize(doc), source);
});

test("rendered inline HTML opens one exact continuous source control", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Before <kbd>Ctrl</kbd> after.\n");
  const ctrl = textPosition(doc, "Ctrl");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, ctrl + 2)
  });
  const unit = activeMarkdownSyntax(state);
  assert.deepEqual(unit?.names, ["html_inline"]);
  assert.equal(continuousMarkdownSource(state, unit, serialize), "<kbd>Ctrl</kbd>");
});
