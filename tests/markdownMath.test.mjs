import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkMath from "remark-math";
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
  codeBlockAttr,
  docSchema,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import {
  sourceFaithfulCodeBlockSchema,
  sourceFaithfulFenceRemark
} from "../src/renderer/lib/markdownFence.js";
import {
  annotateMathSources,
  scanMathBlocks,
  sourceFaithfulInlineMathSchema,
  sourceFaithfulMathRemark
} from "../src/renderer/lib/markdownMath.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownBlockSyntax,
  continuousMarkdownSource,
  markdownAtomSyntaxAt,
  sourceAwareClipboardText,
  sourceClipboardEdit,
  sourceSelectionFromDocumentSelection,
  sourceSelectionText
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

const testRemarkMath = $remark("testRemarkMath", () => remarkMath);
const testInlineMathSchema = $nodeSchema("math_inline", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: { value: { default: "", validate: "string" } },
  parseDOM: [{ tag: "span[data-type='math_inline']" }],
  toDOM: (node) => ["span", { "data-type": "math_inline", "data-value": node.attrs.value }],
  parseMarkdown: {
    match: (node) => node.type === "inlineMath",
    runner: (state, node, type) => state.addNode(type, { value: node.value || "" })
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_inline",
    runner: (state, node) => state.addNode("inlineMath", undefined, node.attrs.value)
  }
}));
const testMathBlockTransform = $remark("testMathBlockTransform", () => () => (tree) => {
  const visit = (node) => {
    if (!node?.children) return;
    node.children = node.children.map((child) => {
      if (child.type === "math") {
        return { type: "code", lang: "LaTeX", value: child.value };
      }
      visit(child);
      return child;
    });
  };
  visit(tree);
});

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(() => (tree, file) => annotateMathSources(tree, file))
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
    codeBlockAttr,
    testRemarkMath,
    testMathBlockTransform,
    testInlineMathSchema,
    sourceFaithfulFenceRemark,
    sourceFaithfulMathRemark,
    sourceFaithfulCodeBlockSchema,
    sourceFaithfulInlineMathSchema
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

function nodePosition(doc, predicate) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && predicate(node)) position = pos;
  });
  return position;
}

test("inline and block math retain exact dollar runs, padding, metadata, and closing length", () => {
  const sources = [
    "$ x $\n",
    "$$x$$\n",
    "$$$x$$$\n",
    "$$\nx+y\n$$\n",
    "$$$  tag\nx+y\n$$$$\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("Milkdown preserves inline math style through edits and grows for dollar collisions", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Use $$ plain $$ here.\n");
  const position = nodePosition(doc, (node) => node.type.name === "math_inline");
  const math = doc.nodeAt(position);
  assert.equal(math.attrs.mathDelimiterLength, 2);
  assert.equal(math.attrs.mathRawContent, " plain ");

  const edited = EditorState.create({ doc }).tr.setNodeMarkup(position, undefined, {
    ...math.attrs,
    value: "changed"
  }).doc;
  assert.equal(serialize(edited), "Use $$ changed $$ here.\n");

  const collision = EditorState.create({ doc }).tr.setNodeMarkup(position, undefined, {
    ...math.attrs,
    value: "has $$ dollars"
  }).doc;
  assert.equal(serialize(collision), "Use $$$ has $$ dollars $$$ here.\n");
});

test("display math remains dollar-fenced after content edits while fenced LaTeX stays fenced", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "$$$  tag\nx+y\n$$$$\n";
  const doc = parse(source);
  const block = doc.firstChild;
  assert.equal(block.type.name, "code_block");
  assert.equal(block.attrs.mathBlock, true);
  assert.equal(block.attrs.mathOpeningLength, 3);
  assert.equal(block.attrs.mathClosingLength, 4);
  assert.equal(serialize(doc), source);

  const textPosition = nodePosition(doc, (node) => node.isText && node.text === "x+y");
  const edited = EditorState.create({ doc }).tr
    .insertText("a+b", textPosition, textPosition + 3).doc;
  assert.equal(serialize(edited), "$$$  tag\na+b\n$$$$\n");

  const collision = EditorState.create({ doc }).tr
    .insertText("has $$$ dollars", textPosition, textPosition + 3).doc;
  assert.equal(serialize(collision), "$$$$  tag\nhas $$$ dollars\n$$$$\n");

  const fenced = "```latex\nx+y\n```\n";
  assert.equal(serialize(parse(fenced)), fenced);
});

test("math source controls expose exact inline and display tokens", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const inlineDoc = parse("Use $$x$$ here.\n");
  const inlinePosition = nodePosition(inlineDoc, (node) => node.type.name === "math_inline");
  const inlineState = EditorState.create({ doc: inlineDoc });
  assert.equal(
    continuousMarkdownSource(
      inlineState,
      markdownAtomSyntaxAt(inlineState, inlinePosition),
      serialize
    ),
    "$$x$$"
  );

  const blockDoc = parse("$$\nx+y\n$$\n");
  const selectedBlockState = EditorState.create({
    doc: blockDoc,
    selection: TextSelection.create(blockDoc, 1)
  });
  const unit = activeMarkdownBlockSyntax(selectedBlockState);
  assert.equal(continuousMarkdownSource(selectedBlockState, unit, serialize), "$$\nx+y\n$$");
});

test("inline-math selections preserve the complete physical dollar token", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Before $$ x+y $$ after.\n");
  const position = nodePosition(doc, (node) => node.type.name === "math_inline");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position, position + 1)
  });
  assert.equal(
    sourceSelectionText(sourceSelectionFromDocumentSelection(state, serialize)),
    "$$ x+y $$"
  );
  assert.equal(sourceAwareClipboardText(state, serialize), "$$ x+y $$");
  const edit = sourceClipboardEdit(state, "formula", parse, serialize);
  assert.equal(edit?.selectedText, "$$ x+y $$");
  assert.equal(serialize(edit.transaction.doc), "Before formula after.\n");
});

test("math block scanning pairs nested container fences without storing unsafe parent prefixes", () => {
  const source = "> $$$ meta\n> x+y\n> $$$$\n";
  const blocks = scanMathBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].openingLength, 3);
  assert.equal(blocks[0].closingLength, 4);

  const tree = {
    type: "root",
    children: [{
      type: "blockquote",
      children: [{ type: "code", lang: "LaTeX", value: "x+y" }]
    }]
  };
  annotateMathSources(tree, { value: source });
  const math = tree.children[0].children[0];
  assert.equal(math.mathBlock, true);
  assert.equal(math.mathSource, undefined);
  assert.equal(math.mathOpeningSuffix, " meta");
});
