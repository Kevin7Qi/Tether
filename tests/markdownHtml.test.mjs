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
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import {
  docSchema,
  htmlSchema,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  renderedBlockHtmlRemark,
  renderedBlockHtmlSchema,
  renderedInlineHtmlRemark,
  renderedInlineHtmlSchema,
  renderSafeBlockHtml,
  sanitizeBlockHtml
} from "../src/renderer/lib/markdownHtml.js";
import { sourceFaithfulParagraphRemark, sourceFaithfulParagraphSchema } from "../src/renderer/lib/markdownParagraph.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownSyntax,
  activeMarkdownAtomSyntax,
  continuousMarkdownSource,
  sourceAwareClipboardText,
  sourceSelectionFromDocumentSelection,
  sourceSelectionText
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
    renderedBlockHtmlRemark,
    renderedBlockHtmlSchema,
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

test("block HTML nodes are separated from inline HTML before schema parsing", () => {
  const tree = {
    type: "root",
    children: [
      { type: "html", value: "<div>Block</div>" },
      {
        type: "paragraph",
        children: [{ type: "html", value: "<kbd>" }, { type: "text", value: "K" }]
      }
    ]
  };
  renderSafeBlockHtml(tree);
  assert.equal(tree.children[0].type, "htmlBlockElement");
  assert.equal(tree.children[0].value, "<div>Block</div>");
  assert.equal(tree.children[1].children[0].type, "html");
});

test("block HTML sanitization uses a strict non-active allowlist", () => {
  let captured = null;
  const result = sanitizeBlockHtml("<div onclick=\"bad()\">Safe</div>", {
    sanitize(value, options) {
      captured = { value, options };
      return "<div>Safe</div>";
    }
  });
  assert.equal(result, "<div>Safe</div>");
  assert.equal(captured.value, "<div onclick=\"bad()\">Safe</div>");
  assert.ok(captured.options.ALLOWED_TAGS.includes("div"));
  assert.ok(!captured.options.ALLOWED_TAGS.includes("script"));
  assert.ok(!captured.options.ALLOWED_TAGS.includes("iframe"));
  assert.ok(!captured.options.ALLOWED_TAGS.includes("img"));
  assert.ok(!captured.options.ALLOWED_ATTR.includes("href"));
  assert.ok(!captured.options.ALLOWED_ATTR.includes("src"));
  assert.deepEqual(captured.options.FORBID_ATTR, ["style"]);
  assert.equal(captured.options.ALLOW_DATA_ATTR, false);

  const windowLike = { name: "renderer-window" };
  let receivedWindow = null;
  const factoryResult = sanitizeBlockHtml("<strong>Safe</strong>", (candidateWindow) => {
    receivedWindow = candidateWindow;
    return { sanitize: () => "<strong>Safe</strong>" };
  }, windowLike);
  assert.equal(receivedWindow, windowLike);
  assert.equal(factoryResult, "<strong>Safe</strong>");
});

test("safe block HTML renders as one exact source-faithful atom", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = [
    "Before.",
    "",
    '<div class="callout">',
    "  <strong>Rendered</strong>",
    "  <em>content</em>",
    "</div>",
    "",
    "After.",
    ""
  ].join("\n");
  const doc = parse(source);
  assert.deepEqual([...Array(doc.childCount)].map((_, index) => doc.child(index).type.name), [
    "paragraph",
    "html_block",
    "paragraph"
  ]);
  const html = doc.child(1);
  assert.equal(html.attrs.value, '<div class="callout">\n  <strong>Rendered</strong>\n  <em>content</em>\n</div>');
  assert.equal(serialize(doc), source);

  const changed = html.type.create({
    value: html.attrs.value.replace("Rendered", "Changed")
  });
  assert.equal(
    serialize(doc.type.create(doc.attrs, [doc.firstChild, changed, doc.lastChild])),
    source.replace("Rendered", "Changed")
  );
});

test("selected block HTML exposes its complete physical source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before.\n\n<div>Rendered <strong>HTML</strong></div>\n\nAfter.\n";
  const doc = parse(source);
  let htmlPosition = null;
  doc.descendants((node, position) => {
    if (htmlPosition == null && node.type.name === "html_block") htmlPosition = position;
  });
  const state = EditorState.create({
    doc,
    selection: NodeSelection.create(doc, htmlPosition)
  });
  const unit = activeMarkdownAtomSyntax(state);
  assert.equal(unit.name, "html_block");
  assert.equal(unit.kind, "block");
  assert.equal(
    continuousMarkdownSource(state, unit, serialize),
    "<div>Rendered <strong>HTML</strong></div>"
  );
  assert.equal(sourceAwareClipboardText(state, serialize), "<div>Rendered <strong>HTML</strong></div>");
});

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

test("rendered inline-HTML selections retain only traversed tag source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Before <U >under</U > after.\n");
  const position = textPosition(doc, "under");
  const partial = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 1, position + 4)
  });
  assert.equal(sourceAwareClipboardText(partial, serialize), "nde");

  const throughOpeningTag = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position - "Before ".length, position + 3)
  });
  assert.equal(
    sourceSelectionText(sourceSelectionFromDocumentSelection(throughOpeningTag, serialize)),
    "Before <U >und"
  );
});
