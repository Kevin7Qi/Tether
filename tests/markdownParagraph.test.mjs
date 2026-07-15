import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
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
  docSchema,
  emphasisAttr,
  hardbreakAttr,
  paragraphAttr,
  remarkLineBreak,
  strongAttr,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import { sourceFaithfulHardBreakSchema } from "../src/renderer/lib/markdownBreak.js";
import {
  serializationAttentionGroupSchema,
  sourceFaithfulAttentionRemark,
  sourceFaithfulAttentionSerializer,
  sourceFaithfulEmphasisSchema,
  sourceFaithfulStrongSchema
} from "../src/renderer/lib/markdownAttention.js";
import {
  annotateParagraphSources,
  sourceFaithfulParagraphRemark,
  sourceFaithfulParagraphSchema
} from "../src/renderer/lib/markdownParagraph.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownBlockSyntax,
  documentPositionAtSourceOffset,
  documentSourceUnitBoundaryNavigationOffset,
  plainTextMarkdownSourceSelection,
  plainTextMarkdownSourceToken,
  replaceSourceSelectionTransaction,
  sourceSelectionText
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(() => (tree, file) => annotateParagraphSources(tree, file))
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
    paragraphAttr,
    textSchema,
    emphasisAttr,
    strongAttr,
    hardbreakAttr,
    remarkLineBreak,
    sourceFaithfulHardBreakSchema,
    sourceFaithfulParagraphRemark,
    sourceFaithfulParagraphSchema,
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
    return { parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) };
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
}

function textPosition(doc, text) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && node.isText && node.text.includes(text)) {
      position = pos + node.text.indexOf(text);
    }
  });
  return position;
}

test("top-level prose retains harmless punctuation, entities, escapes, and soft lines", () => {
  const sources = [
    "a * b * c\n",
    "entity &copy; and &#169;\n",
    "backslash \\\\ path\n",
    "line one\nline two\n",
    "plain **bold** and ~~strike~~ with $ x $\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("an edit in another paragraph leaves unusual prose byte-identical", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "a * b * c &copy; and \\\\ path\nsoft continuation\n\nsecond\n";
  const doc = parse(source);
  assert.equal(doc.firstChild.attrs.paragraphSource, "a * b * c &copy; and \\\\ path\nsoft continuation");
  const dom = doc.firstChild.type.spec.toDOM(doc.firstChild);
  assert.equal(dom[1]["data-md-paragraph-source"], doc.firstChild.attrs.paragraphSource);

  const position = textPosition(doc, "second");
  const edited = EditorState.create({ doc }).tr
    .insertText("changed", position, position + "second".length).doc;
  assert.equal(
    serialize(edited),
    "a * b * c &copy; and \\\\ path\nsoft continuation\n\nchanged\n"
  );
});

test("paragraph signatures remain stable around nested rendered formatting", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "a * b with __outer *inner* tail__\n\nsecond\n";
  const doc = parse(source);
  const position = textPosition(doc, "second");
  const edited = EditorState.create({ doc }).tr
    .insertText("changed", position, position + "second".length).doc;
  assert.equal(serialize(edited), "a * b with __outer *inner* tail__\n\nchanged\n");
});

test("the paragraph being edited intentionally falls back to safe Markdown", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("a * b * c &copy;\n");
  const position = textPosition(doc, "a");
  const edited = EditorState.create({ doc }).tr.insertText("changed", position, position + 1).doc;
  const markdown = serialize(edited);
  assert.match(markdown, /^changed \\?\* b \\?\* c ©\n$/);
  assert.notEqual(markdown, "changed * b * c &copy;\n");
});

test("plain paragraph edits preserve untouched escape and entity source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before \\*literal\\* and &copy; after.\n";
  const doc = parse(source);
  const insertion = textPosition(doc, "*literal*") + 2;
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, insertion)
  });
  const sourceSelection = plainTextMarkdownSourceSelection(state, serialize);
  assert.equal(sourceSelection?.head, source.indexOf("literal") + 1);
  const transaction = replaceSourceSelectionTransaction(
    state,
    sourceSelection,
    "X",
    parse
  );
  assert.equal(serialize(transaction.doc), "Before \\*lXiteral\\* and &copy; after.\n");

  const entity = textPosition(doc, "©");
  const entityState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity, entity + 1)
  });
  assert.equal(
    sourceSelectionText(plainTextMarkdownSourceSelection(entityState, serialize)),
    "&copy;"
  );
});

test("literal source remains exact beside rendered emphasis", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before **bold** and &copy; plus \\*literal\\* after.\n";
  const doc = parse(source);
  const rendered = "Before bold and © plus *literal* after.";
  const entity = textPosition(doc, "©");
  const entityState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity)
  });
  const entityToken = plainTextMarkdownSourceToken(entityState, "forward", serialize);
  assert.equal(entityToken?.unit.source, "&copy;");
  assert.equal(entityToken?.unit.segmentSourceOffset, source.indexOf("&copy;"));

  const afterBold = textPosition(doc, "bold") + "bold".length;
  const boldBoundaryState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, afterBold)
  });
  assert.equal(plainTextMarkdownSourceSelection(boldBoundaryState, serialize), null);
  assert.equal(plainTextMarkdownSourceToken(boldBoundaryState, "backward", serialize), null);
  const boldUnit = {
    from: textPosition(doc, "bold"),
    to: afterBold,
    kind: "inline",
    name: "strong",
    names: ["strong"]
  };
  const afterFollowingSpace = documentSourceUnitBoundaryNavigationOffset(
    boldBoundaryState,
    boldUnit,
    "forward",
    serialize
  );
  assert.equal(afterFollowingSpace, source.indexOf(" and") + 1);
  assert.equal(
    documentPositionAtSourceOffset(boldBoundaryState, afterFollowingSpace, serialize),
    afterBold + 1
  );

  const escape = textPosition(doc, "*literal*");
  const escapeState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, escape)
  });
  assert.equal(
    plainTextMarkdownSourceToken(escapeState, "forward", serialize)?.unit.source,
    "\\*"
  );

  const insertion = textPosition(doc, "literal") + 1;
  const insertionState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, insertion)
  });
  const transaction = replaceSourceSelectionTransaction(
    insertionState,
    plainTextMarkdownSourceSelection(insertionState, serialize),
    "X",
    parse
  );
  assert.equal(
    serialize(transaction.doc),
    "Before **bold** and &copy; plus \\*lXiteral\\* after.\n"
  );
  assert.equal(doc.textContent, rendered);
});

test("ordinary paragraph carets stay in rendered editing instead of opening block source", async () => {
  const { parse } = await milkdownTransformer();
  const doc = parse("ordinary prose\n");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, textPosition(doc, "prose") + 2)
  });
  assert.equal(activeMarkdownBlockSyntax(state), null);
});

test("nested paragraphs do not store unsafe physical container prefixes", () => {
  const source = "> quoted\n> continuation\n";
  const processor = unified().use(remarkParse);
  const tree = processor.parse(source);
  annotateParagraphSources(tree, { value: source });
  assert.equal(tree.children[0].children[0].paragraphSource, undefined);
});
