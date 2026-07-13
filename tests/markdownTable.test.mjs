import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
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
  inlineCodeAttr,
  htmlSchema,
  imageSchema,
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
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import {
  sourceFaithfulInlineCodeRemark,
  sourceFaithfulInlineCodeSchema
} from "../src/renderer/lib/markdownInlineCode.js";
import {
  serializationAttentionGroupSchema,
  sourceFaithfulAttentionRemark,
  sourceFaithfulAttentionSerializer,
  sourceFaithfulEmphasisSchema,
  sourceFaithfulStrongSchema
} from "../src/renderer/lib/markdownAttention.js";
import {
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "../src/renderer/lib/markdownDocument.js";
import {
  sourceFaithfulInlineMathSchema,
  sourceFaithfulMathRemark
} from "../src/renderer/lib/markdownMath.js";
import {
  renderedInlineHtmlRemark,
  renderedInlineHtmlSchema
} from "../src/renderer/lib/markdownHtml.js";
import {
  annotateTableSources,
  sourceFaithfulTableRemark,
  sourceFaithfulTableSchema,
  tableCellSourceOffsetAtPosition
} from "../src/renderer/lib/markdownTable.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  continuousMarkdownSource,
  documentSourceOffsetAtPosition,
  replaceSourceSelectionTransaction,
  sourceSelectionFromDocumentSelection,
  sourceLineJumpTarget,
  sourceSelectionText,
  sourceAwareClipboardText
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

const testRemarkMath = $remark("testTableRemarkMath", () => remarkMath);
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
    sourceFaithfulDocumentRemark,
    sourceFaithfulDocumentSchema,
    paragraphSchema,
    textSchema,
    inlineCodeAttr,
    htmlSchema,
    imageSchema,
    testRemarkMath,
    testInlineMathSchema,
    sourceFaithfulMathRemark,
    sourceFaithfulInlineMathSchema,
    renderedInlineHtmlRemark,
    renderedInlineHtmlSchema,
    sourceFaithfulAttentionRemark,
    sourceFaithfulEmphasisSchema,
    sourceFaithfulStrongSchema,
    serializationAttentionGroupSchema,
    sourceFaithfulAttentionSerializer,
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

function nodePosition(doc, predicate) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && predicate(node)) position = pos;
  });
  return position;
}

const compactTable = "a|b\n-|:-:\n1|2\n";

test("table line jumps include physical row pipes and padding", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const table = [
    "| Key | Description |",
    "| --- | --- |",
    "| first | A deliberately wide value that changes generated column padding |",
    "| target | short |",
    "| tail | another value |"
  ].join("\n");
  const doc = parse(`${table}\n`);
  const caret = textPosition(doc, "target") + 3;
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, caret)
  });
  const start = sourceLineJumpTarget(state, "start", serialize);
  const end = sourceLineJumpTarget(state, "end", serialize);
  const targetStart = table.indexOf("| target");
  assert.equal(start?.boundaryOffset, targetStart);
  assert.equal(end?.boundaryOffset, table.indexOf("\n", targetStart));
  assert.equal(start?.caretOffset, table.indexOf("target") + 3);
  assert.equal(start?.source, table);
  assert.equal(end?.source, table);
});

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
  assert.equal(doc.firstChild.attrs.markdownTableSource, compactTable.trimEnd());
  assert.ok(doc.firstChild.attrs.markdownTableCells);
  assert.equal(
    tableCellSourceOffsetAtPosition(state, textPosition(doc, "a"), compactTable.trimEnd()),
    0
  );
  const exactSelection = sourceSelectionFromDocumentSelection(state, serialize);
  assert.ok(exactSelection);
  assert.equal(
    exactSelection.fullSource.slice(exactSelection.anchor, exactSelection.head),
    `${compactTable}\nAf`.trimEnd()
  );
});

test("a complete intervening table participates in exact source selection and replacement", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = `Before text\n\n${compactTable}\nAfter text\n`;
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(
      doc,
      textPosition(doc, "Before text") + "Before ".length,
      textPosition(doc, "After text") + "After".length
    )
  });
  const sourceSelection = sourceSelectionFromDocumentSelection(state, serialize);
  assert.ok(sourceSelection);
  const from = Math.min(sourceSelection.anchor, sourceSelection.head);
  const to = Math.max(sourceSelection.anchor, sourceSelection.head);
  assert.equal(sourceSelection.fullSource.slice(from, to), `text\n\n${compactTable}\nAfter`);

  const replacement = replaceSourceSelectionTransaction(state, sourceSelection, "X", parse);
  assert.ok(replacement);
  assert.equal(serialize(replacement.doc), "Before X text\n");
});

test("formatted and escaped table cells map rendered cursor positions to exact source offsets", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const table = "| plain | **bold** | `a\\|b` |\n| --- | --- | --- |\n| one | two | three |";
  const source = `${table}\n\nAfter\n`;
  const doc = parse(source);
  assert.equal(serialize(doc), source);
  const state = EditorState.create({ doc });
  const bold = textPosition(doc, "bold");
  const code = textPosition(doc, "a|b");

  assert.equal(
    tableCellSourceOffsetAtPosition(state, bold + 2, table),
    table.indexOf("bold") + 2
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, bold, table, "forward"),
    table.indexOf("**bold**")
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, bold, table, "backward"),
    table.indexOf("bold")
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, bold + 4, table, "backward"),
    table.indexOf("**bold**") + "**bold**".length
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, bold + 4, table, "forward"),
    table.indexOf("bold") + "bold".length
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, code + 2, table),
    table.indexOf("a\\|b") + 3
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, code, table, "forward"),
    table.indexOf("`a\\|b`")
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, code + 3, table, "backward"),
    table.indexOf("`a\\|b`") + "`a\\|b`".length
  );

  const selection = EditorState.create({
    doc,
    selection: TextSelection.create(doc, bold + 1, textPosition(doc, "After") + 2)
  });
  assert.deepEqual({
    from: documentSourceOffsetAtPosition(selection, selection.selection.from, serialize, "forward"),
    to: documentSourceOffsetAtPosition(selection, selection.selection.to, serialize, "backward")
  }, {
    from: table.indexOf("bold") + 1,
    to: source.indexOf("After") + 2
  });
  const exact = sourceSelectionFromDocumentSelection(selection, serialize);
  assert.ok(exact);
  assert.equal(
    exact.fullSource.slice(Math.min(exact.anchor, exact.head), Math.max(exact.anchor, exact.head)),
    `${table.slice(table.indexOf("bold") + 1)}\n\nAf`
  );
});

test("cross-block selections include complete formatting tokens at table-cell boundaries", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const table = "| plain | **bold** | `a\\|b` |\n| --- | --- | --- |\n| one | two | three |";
  const source = `Before\n\n${table}\n\nAfter\n`;
  const doc = parse(source);
  const before = textPosition(doc, "Before") + 2;
  const boldEnd = textPosition(doc, "bold") + "bold".length;
  const expected = `fore\n\n${table.slice(0, table.indexOf("**bold**") + "**bold**".length)}`;

  for (const [anchor, head] of [[before, boldEnd], [boldEnd, before]]) {
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, anchor, head)
    });
    assert.equal(sourceSelectionText(sourceSelectionFromDocumentSelection(state, serialize)), expected);
  }
});

test("entity and escape spellings map rendered table carets to exact raw offsets", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const table = "| entity | numeric | escape | astral |\n| --- | --- | --- | --- |\n| A &amp; B | x &#124; y | left \\* right | emoji &#x1F600; ok |";
  const source = `Before\n\n${table}\n`;
  const doc = parse(source);
  const state = EditorState.create({ doc });
  const entity = textPosition(doc, "A & B");
  const numeric = textPosition(doc, "x | y");
  const escaped = textPosition(doc, "left * right");
  const astral = textPosition(doc, "emoji 😀 ok");

  assert.equal(
    tableCellSourceOffsetAtPosition(state, entity + 3, table),
    table.indexOf("A &amp; B") + "A &amp;".length
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, numeric + 3, table),
    table.indexOf("x &#124; y") + "x &#124;".length
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, escaped + 6, table),
    table.indexOf("left \\* right") + "left \\*".length
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, astral + "emoji 😀".length, table),
    table.indexOf("emoji &#x1F600; ok") + "emoji &#x1F600;".length
  );

  const before = textPosition(doc, "Before") + 2;
  const entityEnd = entity + "A & B".length;
  const expected = `fore\n\n${table.slice(0, table.indexOf("A &amp; B") + "A &amp; B".length)}`;
  for (const [anchor, head] of [[before, entityEnd], [entityEnd, before]]) {
    const crossBlock = EditorState.create({
      doc,
      selection: TextSelection.create(doc, anchor, head)
    });
    assert.equal(
      sourceSelectionText(sourceSelectionFromDocumentSelection(crossBlock, serialize)),
      expected
    );
  }
});

test("inline math and images occupy one source-faithful table position", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const table = "| mixed | image |\n| --- | --- |\n| left $x+y$ right | ![Alt](img.png \"T\") |";
  const source = `Before\n\n${table}\n\nAfter\n`;
  const doc = parse(source);
  assert.equal(serialize(doc), source);
  const state = EditorState.create({ doc });
  const math = nodePosition(doc, (node) => node.type.name === "math_inline");
  const image = nodePosition(doc, (node) => node.type.name === "image");

  assert.equal(doc.nodeAt(math).nodeSize, 1);
  assert.equal(doc.nodeAt(image).nodeSize, 1);
  assert.equal(
    tableCellSourceOffsetAtPosition(state, math, table, "forward"),
    table.indexOf("$x+y$")
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, math + 1, table, "backward"),
    table.indexOf("$x+y$") + "$x+y$".length
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, image, table, "forward"),
    table.indexOf("![Alt](img.png \"T\")")
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, image + 1, table, "backward"),
    table.indexOf("![Alt](img.png \"T\")") + "![Alt](img.png \"T\")".length
  );

  const before = textPosition(doc, "Before") + 2;
  const expected = `fore\n\n${table.slice(0, table.indexOf("$x+y$") + "$x+y$".length)}`;
  for (const [anchor, head] of [[before, math + 1], [math + 1, before]]) {
    const selection = EditorState.create({
      doc,
      selection: TextSelection.create(doc, anchor, head)
    });
    assert.equal(
      sourceSelectionText(sourceSelectionFromDocumentSelection(selection, serialize)),
      expected
    );
  }

  const throughImage = EditorState.create({
    doc,
    selection: TextSelection.create(doc, before, image + 1)
  });
  const imageSelection = sourceSelectionFromDocumentSelection(throughImage, serialize);
  assert.equal(
    sourceSelectionText(imageSelection),
    `fore\n\n${table.slice(0, table.indexOf("![Alt](img.png \"T\")") + "![Alt](img.png \"T\")".length)}`
  );
  const replacement = replaceSourceSelectionTransaction(throughImage, imageSelection, "Z", parse);
  assert.ok(replacement);
  assert.equal(serialize(replacement.doc), "BeZ |\n\nAfter\n");
});

test("rendered and literal inline HTML retain exact table source boundaries", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const table = "| rendered | literal |\n| --- | --- |\n| <U >under</U > | <u class=\"x\">literal</u> |";
  const source = `Before\n\n${table}\n\nAfter\n`;
  const doc = parse(source);
  assert.equal(serialize(doc), source);
  const state = EditorState.create({ doc });
  const under = textPosition(doc, "under");
  const htmlNodes = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "html") htmlNodes.push({ node, pos });
  });

  assert.equal(
    tableCellSourceOffsetAtPosition(state, under, table, "forward"),
    table.indexOf("<U >under</U >")
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, under + "under".length, table, "backward"),
    table.indexOf("<U >under</U >") + "<U >under</U >".length
  );
  assert.deepEqual(htmlNodes.map(({ node }) => node.attrs.value), ["<u class=\"x\">", "</u>"]);
  assert.equal(
    tableCellSourceOffsetAtPosition(state, htmlNodes[0].pos, table, "forward"),
    table.indexOf("<u class=\"x\">")
  );
  assert.equal(
    tableCellSourceOffsetAtPosition(state, htmlNodes[1].pos + 1, table, "backward"),
    table.indexOf("<u class=\"x\">literal</u>") + "<u class=\"x\">literal</u>".length
  );

  const before = textPosition(doc, "Before") + 2;
  const expected = `fore\n\n${table.slice(0, table.indexOf("<U >under</U >") + "<U >under</U >".length)}`;
  for (const [anchor, head] of [[before, under + 5], [under + 5, before]]) {
    const selection = EditorState.create({
      doc,
      selection: TextSelection.create(doc, anchor, head)
    });
    assert.equal(
      sourceSelectionText(sourceSelectionFromDocumentSelection(selection, serialize)),
      expected
    );
  }

  const literalEnd = htmlNodes[1].pos + 1;
  const throughLiteral = EditorState.create({
    doc,
    selection: TextSelection.create(doc, before, literalEnd)
  });
  const literalSelection = sourceSelectionFromDocumentSelection(throughLiteral, serialize);
  assert.equal(
    sourceSelectionText(literalSelection),
    `fore\n\n${table.slice(0, table.indexOf("<u class=\"x\">literal</u>") + "<u class=\"x\">literal</u>".length)}`
  );
  const replacement = replaceSourceSelectionTransaction(throughLiteral, literalSelection, "Z", parse);
  assert.ok(replacement);
  assert.equal(serialize(replacement.doc), "BeZ |\n\nAfter\n");
});
