import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
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
  remarkGFMPlugin,
  tableCellSchema,
  tableHeaderRowSchema,
  tableHeaderSchema,
  tableRowSchema
} from "@milkdown/kit/preset/gfm";
import {
  sourceFaithfulInlineCodeRemark,
  sourceFaithfulInlineCodeSchema
} from "../src/renderer/lib/markdownInlineCode.js";
import {
  annotateTableSources,
  sourceFaithfulTableRemark,
  sourceFaithfulTableSchema
} from "../src/renderer/lib/markdownTable.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  continuousMarkdownSource,
  sourceAwareClipboardText
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree, file) => annotateTableSources(tree, file))
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
    remarkGFMPlugin,
    tableHeaderRowSchema,
    tableRowSchema,
    tableHeaderSchema,
    tableCellSchema,
    sourceFaithfulInlineCodeRemark,
    sourceFaithfulInlineCodeSchema,
    sourceFaithfulTableRemark,
    sourceFaithfulTableSchema
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

const compactTable = "a|b\n-|:-:\n1|2\n";

test("tables retain outer-pipe, spacing, width, and alignment-row source styles", () => {
  const sources = [
    compactTable,
    "| A   |B|\n|:----|---:|\n| x| y |\n",
    "A | B\n--- | ---\nlong | value\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("Milkdown preserves an unchanged raw table through an outside edit and source activation", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = `Intro\n\n${compactTable}`;
  const doc = parse(source);
  const table = doc.child(1);
  assert.equal(table.type.name, "table");
  assert.equal(table.attrs.markdownTableSource, compactTable.trimEnd());
  assert.ok(table.attrs.markdownTableSignature);
  const dom = table.type.spec.toDOM(table);
  assert.equal(dom[1]["data-md-table-source"], compactTable.trimEnd());

  const intro = textPosition(doc, "Intro");
  const edited = EditorState.create({ doc }).tr.insertText("Changed", intro, intro + 5).doc;
  assert.equal(serialize(edited), `Changed\n\n${compactTable}`);

  const tablePosition = doc.firstChild.nodeSize;
  const unit = { from: tablePosition, to: tablePosition + table.nodeSize, kind: "block", name: "table" };
  assert.equal(continuousMarkdownSource(EditorState.create({ doc }), unit, serialize), compactTable.trimEnd());
});

test("editing a table regenerates valid GFM and escapes inline-code pipes once", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "| code | value |\n| --- | --- |\n| `a\\|b` | x |\n";
  const doc = parse(source);
  const position = textPosition(doc, "x");
  const edited = EditorState.create({ doc }).tr.insertText("changed", position, position + 1).doc;
  const markdown = serialize(edited);
  assert.match(markdown, /`a\\\|b`/);
  assert.doesNotMatch(markdown, /`a\\\\\|b`/);
  assert.match(markdown, /changed/);
  const processor = unified().use(remarkParse).use(remarkGfm);
  const reparsed = processor.parse(markdown);
  assert.equal(reparsed.children[0].type, "table");
  assert.equal(reparsed.children[0].children[1].children[0].children[0].value, "a|b");
});

test("partial clipboard selection from a table into prose keeps valid Markdown structure", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = `${compactTable}\nAfter\n`;
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(
      doc,
      textPosition(doc, "a"),
      textPosition(doc, "After") + 2
    )
  });
  assert.equal(sourceAwareClipboardText(state, serialize), `${compactTable}\nAf`.trimEnd());
});
