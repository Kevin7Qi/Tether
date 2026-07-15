import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
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
  bulletListAttr,
  hardbreakAttr,
  listItemAttr,
  listItemSchema,
  orderedListAttr,
  remarkLineBreak,
  strongAttr,
  strongSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import { sourceFaithfulHardBreakSchema } from "../src/renderer/lib/markdownBreak.js";
import {
  sourceFaithfulBlockquoteRemark,
  sourceFaithfulBlockquoteSchema
} from "../src/renderer/lib/markdownBlockquote.js";
import {
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "../src/renderer/lib/markdownDocument.js";
import {
  sourceFaithfulParagraphRemark,
  sourceFaithfulParagraphSchema
} from "../src/renderer/lib/markdownParagraph.js";
import {
  annotateBulletListMarkers,
  isInteractiveTaskMarker,
  listItemTextStart,
  renderedListItemLabel,
  sourceFaithfulBulletListSchema,
  sourceFaithfulBulletRemark,
  sourceFaithfulOrderedListSchema,
  sourceFaithfulTaskListItemSchema,
  typedBulletMarkerTransaction,
  uppercaseTaskTransaction
} from "../src/renderer/lib/markdownList.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  activeMarkdownBlockSyntax,
  continuousMarkdownSource,
  documentSourceSegments,
  plainTextMarkdownSourceSelection,
  plainTextMarkdownSourceToken,
  sourceCaretOffset,
  sourceLineJumpTarget,
  sourceAwareClipboardText,
  sourceSelectionFromDocumentSelection,
  sourceSelectionText,
  sourceFaithfulListMarkerBackspaceTransaction,
  replaceSourceSelectionTransaction,
  splitOrderedListItemWithSourceNumber,
  structuralSourceHandoffTarget
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

test("only task markers consume pointer interaction", () => {
  assert.equal(isInteractiveTaskMarker({ attrs: { checked: null, listType: "bullet" } }), false);
  assert.equal(isInteractiveTaskMarker({ attrs: { checked: null, listType: "ordered" } }), false);
  assert.equal(isInteractiveTaskMarker({ attrs: { checked: false, listType: "bullet" } }), true);
  assert.equal(isInteractiveTaskMarker({ attrs: { checked: true, listType: "bullet" } }), true);
});

test("ordinary list markers place the caret at the first item text position", async () => {
  const { parse } = await milkdownTransformer();
  const doc = parse("- first\n- second\n");
  const listPosition = 0;
  const firstItemPosition = listPosition + 1;
  const firstItem = doc.firstChild.firstChild;
  assert.equal(listItemTextStart(firstItemPosition, firstItem), firstItemPosition + 2);
  assert.equal(doc.resolve(listItemTextStart(firstItemPosition, firstItem)).parent.textContent, "first");
});

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree, file) => annotateBulletListMarkers(tree, file))
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
    textSchema,
    bulletListAttr,
    orderedListAttr,
    listItemAttr,
    listItemSchema,
    hardbreakAttr,
    remarkLineBreak,
    strongAttr,
    strongSchema,
    sourceFaithfulHardBreakSchema,
    sourceFaithfulBlockquoteSchema,
    remarkGFMPlugin,
    sourceFaithfulParagraphRemark,
    sourceFaithfulParagraphSchema,
    sourceFaithfulBulletRemark,
    sourceFaithfulBlockquoteRemark,
    sourceFaithfulBulletListSchema,
    sourceFaithfulOrderedListSchema,
    sourceFaithfulTaskListItemSchema
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

test("bullet lists retain distinct top-level and nested marker styles", () => {
  const source = [
    "* alpha",
    "* beta",
    "",
    "+ outer",
    "  - nested",
    "  - next",
    "",
    "> * quoted",
    "> * again",
    ""
  ].join("\n");
  assert.equal(roundTrip(source), source);
});

test("structural Backspace removes one physical list indent without changing its marker", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const { source, expected } of [
    {
      source: "+ outer\n  * nested\n+ after\n",
      expected: "+ outer\n* nested\n+ after\n"
    },
    {
      source: "+ outer\n\n  7) nested\n+ after\n",
      expected: "+ outer\n\n7) nested\n+ after\n"
    },
    {
      source: "+ outer\n  * [X] nested\n+ after\n",
      expected: "+ outer\n* [X] nested\n+ after\n"
    }
  ]) {
    const doc = parse(source);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, textPosition(doc, "nested"))
    });
    const transaction = sourceFaithfulListMarkerBackspaceTransaction(state, parse, serialize);
    assert.ok(transaction);
    assert.equal(serialize(transaction.doc), expected);
    assert.equal(transaction.selection.$from.parent.textContent, "nested");
    assert.equal(transaction.selection.$from.parentOffset, 0);
  }
});

test("structural Backspace removes a top-level marker in exact source coordinates", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "+ first\n+ second\n";
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, textPosition(doc, "first"))
  });
  const transaction = sourceFaithfulListMarkerBackspaceTransaction(state, parse, serialize);
  assert.ok(transaction);
  assert.equal(serialize(transaction.doc), "first\n+ second\n");
  assert.equal(transaction.selection.$from.parent.type.name, "paragraph");
  assert.equal(transaction.selection.$from.parentOffset, 0);
});

test("a leading inline delimiter stays closer than the enclosing list marker", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "+ **bold**\n";
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, textPosition(doc, "bold"))
  });
  assert.equal(sourceFaithfulListMarkerBackspaceTransaction(state, parse, serialize), null);
});

test("structural Backspace keeps quote prefixes while removing the nearest list indentation", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const { source, expected, text } of [
    {
      source: "> + outer\n>   * nested\n> + after\n",
      expected: "> + outer\n> * nested\n> + after\n",
      text: "nested"
    },
    {
      source: "> + first\n> + second\n",
      expected: "> first\n> + second\n",
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

test("partial cross-block clipboard selection retains its list structure", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "+ alpha\n  * nested\n+ omega\n\nAfter\n";
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(
      doc,
      textPosition(doc, "alpha") + 2,
      textPosition(doc, "After") + 2
    )
  });
  assert.equal(
    sourceAwareClipboardText(state, serialize),
    "pha\n  * nested\n+ omega\n\nAf"
  );
});

test("partial cross-block replacement follows literal source coordinates", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "+ alpha\n  * nested\n+ omega\n\nAfter\n";
  const doc = parse(source);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(
      doc,
      textPosition(doc, "alpha") + 2,
      textPosition(doc, "After") + 2
    )
  });
  const sourceSelection = sourceSelectionFromDocumentSelection(state, serialize);
  assert.ok(sourceSelection);
  assert.equal(sourceSelection.fullSource.slice(sourceSelection.anchor, sourceSelection.head),
    "pha\n  * nested\n+ omega\n\nAf");

  const replacement = replaceSourceSelectionTransaction(state, sourceSelection, "X", parse);
  assert.ok(replacement);
  assert.equal(serialize(replacement.doc), "+ alXter\n");
  assert.equal(replacement.selection.$from.parentOffset, 3);

  const deletion = replaceSourceSelectionTransaction(state, sourceSelection, "", parse);
  assert.ok(deletion);
  assert.equal(serialize(deletion.doc), "+ alter\n");
  assert.equal(deletion.selection.$from.parentOffset, 2);
});

test("rendered list literals retain exact escape and entity coordinates", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "+ Before \\*literal\\* and &copy; after.\n";
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
  assert.equal(token?.sourceOffset, 1);

  const entity = textStart + rendered.indexOf("©");
  const entityState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity, entity + 1)
  });
  const entitySelection = plainTextMarkdownSourceSelection(entityState, serialize);
  assert.equal(sourceSelectionText(entitySelection), "&copy;");

  const insertion = textStart + rendered.indexOf("literal") + 1;
  const insertionState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, insertion)
  });
  const insertionSelection = plainTextMarkdownSourceSelection(insertionState, serialize);
  const transaction = replaceSourceSelectionTransaction(
    insertionState,
    insertionSelection,
    "X",
    parse
  );
  assert.equal(serialize(transaction.doc), "+ Before \\*lXiteral\\* and &copy; after.\n");
});

test("nested literal coordinates remain exact after a preceding structural block", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = [
    "+ Before \\*literal\\* and &copy; after.",
    "",
    "> Quoted \\*literal\\* and &copy; after.",
    ""
  ].join("\n");
  const parsed = parse(source);
  const synthetic = parsed.type.schema.nodes.paragraph.create({ tetherSyntheticTrailing: true });
  const doc = parsed.type.create(parsed.attrs, [parsed.child(0), parsed.child(1), synthetic]);
  const rendered = "Quoted *literal* and © after.";
  const textStart = textPosition(doc, rendered);
  const entity = textStart + rendered.indexOf("©");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, entity)
  });
  const segments = documentSourceSegments(state, serialize)?.segments;
  assert.deepEqual(segments?.map(({ from, to, node }) => ({
    from,
    to,
    type: node.type.name
  })), [
    { from: 0, to: 38, type: "bullet_list" },
    { from: 40, to: 78, type: "blockquote" }
  ]);
  const token = plainTextMarkdownSourceToken(state, "forward", serialize);
  assert.equal(token?.unit.source, "&copy;");
  assert.equal(token?.unit.segmentSourceOffset, source.lastIndexOf("&copy;") - source.indexOf(">"));
});

test("ordered lists retain dot and parenthesis delimiters at every nesting level", () => {
  const source = [
    "3) alpha",
    "4) beta",
    "",
    "1. dot",
    "2. next",
    "",
    "* outer",
    "  1) nested",
    "  2) again",
    ""
  ].join("\n");
  assert.equal(roundTrip(source), source);
});

test("ordered lists retain repeated, nonsequential, and nested item numbers", () => {
  const source = [
    "1. one",
    "1. repeated",
    "9. jumped",
    "",
    "3) outer",
    "   1) nested",
    "   1) repeated nested",
    "8) later",
    "100) wide marker",
    "     continuation",
    ""
  ].join("\n");
  assert.equal(roundTrip(source), source);
});

test("rendered ordered markers use each physical source number and delimiter", async () => {
  const { parse } = await milkdownTransformer();
  const dotted = parse("1. one\n1. repeated\n9. jumped\n100. wide\n123456789. maximum\n").firstChild;
  assert.deepEqual(
    [...Array(dotted.childCount)].map((_, index) => renderedListItemLabel(
      dotted.child(index),
      dotted.attrs.orderedDelimiter
    )),
    ["1.", "1.", "9.", "100.", "123456789."]
  );

  const parenthesized = parse("3) alpha\n8) beta\n").firstChild;
  assert.deepEqual(
    [...Array(parenthesized.childCount)].map((_, index) => renderedListItemLabel(
      parenthesized.child(index),
      parenthesized.attrs.orderedDelimiter
    )),
    ["3)", "8)"]
  );

  const newItem = parenthesized.firstChild.type.create({
    ...parenthesized.firstChild.attrs,
    label: "4.",
    listType: "ordered",
    orderedNumber: null
  }, parenthesized.firstChild.content);
  assert.equal(renderedListItemLabel(newItem, parenthesized.attrs.orderedDelimiter), "4)");
  assert.equal(renderedListItemLabel({ attrs: { listType: "bullet", label: "•" } }), "•");
});

test("task lists retain uppercase, lowercase, and unchecked source markers", () => {
  const source = [
    "- [X] uppercase",
    "- [x] lowercase",
    "- [ ] open",
    "- [X] first line",
    "  continuation",
    "",
    "+ [X] plus",
    "",
    "1) [X] ordered",
    "9) [ ] pending",
    ""
  ].join("\n");
  assert.equal(roundTrip(source), source);
});

test("untouched root lists retain continuations, entity spelling, blank layout, and nesting exactly", () => {
  const source = [
    "* alpha &copy;",
    "    unusually indented continuation",
    "",
    "  * nested with &#169;",
    "",
    "* second  ",
    "  line",
    ""
  ].join("\n");
  assert.equal(roundTrip(source), source);
});

test("an outside edit leaves an unusual root list byte-identical", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const listSource = [
    "* alpha &copy;",
    "    unusually indented continuation",
    "",
    "  + nested with &#169;",
    ""
  ].join("\n");
  const doc = parse(`${listSource}\noutside\n`);
  const list = doc.firstChild;
  assert.equal(list.attrs.listSource, listSource.trimEnd());
  assert.equal(typeof list.attrs.listSourceSignature, "string");
  assert.equal(list.type.spec.toDOM(list)[1]["data-md-list-source"], listSource.trimEnd());
  assert.equal(list.firstChild.lastChild.attrs.listSource, null);
  assert.equal(list.firstChild.attrs.listItemSource, listSource.trimEnd());
  assert.equal(typeof list.firstChild.attrs.listItemSourceSignature, "string");
  assert.equal(
    list.firstChild.type.spec.toDOM(list.firstChild)[1]["data-md-list-item-source"],
    listSource.trimEnd()
  );
  assert.equal(list.firstChild.lastChild.firstChild.attrs.listItemSource, null);

  const outside = textPosition(doc, "outside");
  const edited = EditorState.create({ doc }).tr
    .insertText("changed", outside, outside + "outside".length).doc;
  assert.equal(serialize(edited), `${listSource}\nchanged\n`);
});

test("the active list source control exposes the exact complete root list", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "3) alpha &copy;\n7) beta\n";
  const doc = parse(source);
  const beta = textPosition(doc, "beta");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, beta + 2)
  });
  const unit = activeMarkdownBlockSyntax(state);
  assert.equal(unit?.name, "ordered_list");
  assert.equal(continuousMarkdownSource(state, unit, serialize), source.trimEnd());
});

test("line-start jumps enter a list item's physical marker while line-end stays rendered", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "- first\n- second\n";
  const doc = parse(source);
  const second = textPosition(doc, "second") + 3;
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, second)
  });
  const start = sourceLineJumpTarget(state, "start", serialize);
  assert.equal(start?.source, source.trimEnd());
  assert.equal(start?.boundaryOffset, source.indexOf("- second"));
  assert.equal(start?.caretOffset, source.indexOf("second") + 3);
  assert.equal(sourceLineJumpTarget(state, "end", serialize), null);
});

test("an exact root-list source maps the caret into an unusually laid-out nested item", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = [
    "* outer &copy;",
    "    unusually indented continuation",
    "",
    "  + nested target",
    ""
  ].join("\n");
  const doc = parse(source);
  const nested = textPosition(doc, "nested target");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, nested)
  });
  const unit = activeMarkdownBlockSyntax(state);
  const exactSource = continuousMarkdownSource(state, unit, serialize);
  assert.equal(exactSource, source.trimEnd());
  assert.equal(
    sourceCaretOffset(state, unit, exactSource, nested, null, serialize),
    exactSource.indexOf("nested target")
  );
});

test("inline source crosses list markers and item newlines without a dead key", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const markdown = "* **&copy;**\n* tail\n";
  const doc = parse(markdown);
  const position = textPosition(doc, "©");
  const startState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position)
  });
  const endState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, position + 1)
  });
  const backwardEdge = structuralSourceHandoffTarget(
    startState,
    position,
    "backward",
    serialize
  );
  const backwardMove = structuralSourceHandoffTarget(
    startState,
    position,
    "backward",
    serialize,
    true
  );
  const forwardMove = structuralSourceHandoffTarget(
    endState,
    position + 1,
    "forward",
    serialize,
    true
  );
  const tokenStart = markdown.indexOf("**&copy;**");
  const tokenEnd = tokenStart + "**&copy;**".length;
  assert.equal(backwardEdge?.source, markdown.trimEnd());
  assert.equal(backwardEdge?.sourceOffset, tokenStart);
  assert.equal(backwardMove?.sourceOffset, tokenStart - 1);
  assert.equal(forwardMove?.sourceOffset, tokenEnd + 1);
});

test("editing inside a root list invalidates raw reuse but keeps structural source markers", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("3) alpha &copy;\n7) beta &copy;\n    continuation  \n");
  const alpha = textPosition(doc, "alpha ©");
  const edited = EditorState.create({ doc }).tr
    .insertText("renamed", alpha, alpha + "alpha ©".length).doc;
  assert.equal(serialize(edited), "3) renamed\n7) beta &copy;\n    continuation  \n");
});

test("editing one task item preserves an untouched sibling's exact source", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("- [x] change me\n- [X] keep &copy; \n  continued\n");
  const change = textPosition(doc, "change me");
  const edited = EditorState.create({ doc }).tr
    .insertText("changed", change, change + "change me".length).doc;
  assert.equal(serialize(edited), "- [x] changed\n- [X] keep &copy; \n  continued\n");
});

test("editing one loose-list item preserves an untouched sibling's internal layout", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "* change me\n\n* keep &copy;\n\n  second paragraph\n";
  const doc = parse(source);
  const change = textPosition(doc, "change me");
  const edited = EditorState.create({ doc }).tr
    .insertText("changed", change, change + "change me".length).doc;
  assert.equal(serialize(edited), "* changed\n\n* keep &copy;\n\n  second paragraph\n");
});

test("Milkdown keeps a bullet marker through ordinary list text edits", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("+ alpha\n+ beta\n");
  assert.equal(doc.firstChild.attrs.bulletMarker, "+");
  assert.equal(doc.firstChild.type.spec.toDOM(doc.firstChild)[1]["data-md-bullet-marker"], "+");

  const alpha = textPosition(doc, "alpha");
  const edited = EditorState.create({ doc }).tr.insertText("renamed", alpha, alpha + "alpha".length).doc;
  assert.equal(serialize(edited), "+ renamed\n+ beta\n");
});

test("Milkdown keeps an ordered-list delimiter through ordinary text edits", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("3) alpha\n4) beta\n");
  assert.equal(doc.firstChild.attrs.order, 3);
  assert.equal(doc.firstChild.attrs.orderedDelimiter, ")");
  assert.equal(doc.firstChild.type.spec.toDOM(doc.firstChild)[1]["data-md-ordered-delimiter"], ")");

  const alpha = textPosition(doc, "alpha");
  const edited = EditorState.create({ doc }).tr.insertText("renamed", alpha, alpha + "alpha".length).doc;
  assert.equal(serialize(edited), "3) renamed\n4) beta\n");
});

test("Milkdown preserves item numbers through edits and assigns a fallback only to new items", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("1. alpha\n1. beta\n9. gamma\n");
  const list = doc.firstChild;
  assert.deepEqual([...Array(list.childCount)].map((_, index) => list.child(index).attrs.orderedNumber), [1, 1, 9]);
  assert.equal(list.child(1).type.spec.toDOM(list.child(1))[1]["data-md-ordered-number"], 1);

  const alpha = textPosition(doc, "alpha");
  const edited = EditorState.create({ doc }).tr.insertText("renamed", alpha, alpha + "alpha".length).doc;
  assert.equal(serialize(edited), "1. renamed\n1. beta\n9. gamma\n");

  const listItemType = list.firstChild.type;
  const paragraphType = list.firstChild.firstChild.type;
  const insertedItem = listItemType.create(
    { ...list.firstChild.attrs, orderedNumber: null },
    paragraphType.create(null, doc.type.schema.text("inserted"))
  );
  const insertedList = list.type.create(list.attrs, [list.child(0), insertedItem, list.child(2)]);
  const insertedDoc = doc.type.create(null, [insertedList]);
  assert.equal(serialize(insertedDoc), "1. alpha\n2. inserted\n9. gamma\n");

  const deletedList = list.type.create(list.attrs, [list.child(0), list.child(2)]);
  const deletedDoc = doc.type.create(null, [deletedList]);
  assert.equal(serialize(deletedDoc), "1. alpha\n9. gamma\n");
});

test("Enter creates a sequential continuation without renumbering existing source items", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("1. alpha\n1. beta\n");
  const alpha = textPosition(doc, "alpha");
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, alpha + "alpha".length)
  });
  let transaction = null;
  assert.equal(splitOrderedListItemWithSourceNumber(state, (next) => { transaction = next; }), true);
  const numbers = [...Array(transaction.doc.firstChild.childCount)]
    .map((_, index) => transaction.doc.firstChild.child(index).attrs.orderedNumber);
  assert.deepEqual(numbers, [1, null, 1]);
  assert.equal(serialize(transaction.doc), "1. alpha\n2.\n1. beta\n");
});

test("Milkdown preserves task marker case through edits and reconciles checkbox toggles", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("- [X] alpha\n- [x] beta\n- [ ] open\n");
  const firstItem = doc.firstChild.firstChild;
  assert.equal(firstItem.attrs.checked, true);
  assert.equal(firstItem.attrs.taskMarker, "X");
  assert.equal(firstItem.type.spec.toDOM(firstItem)[1]["data-md-task-marker"], "X");

  const alpha = textPosition(doc, "alpha");
  const edited = EditorState.create({ doc }).tr.insertText("renamed", alpha, alpha + "alpha".length).doc;
  assert.equal(serialize(edited), "- [X] renamed\n- [x] beta\n- [ ] open\n");

  let itemPosition = null;
  edited.descendants((node, pos) => {
    if (itemPosition == null && node.type.name === "list_item") itemPosition = pos;
  });
  const unchecked = EditorState.create({ doc: edited }).tr.setNodeAttribute(itemPosition, "checked", false).doc;
  assert.equal(serialize(unchecked), "- [ ] renamed\n- [x] beta\n- [ ] open\n");
  const rechecked = EditorState.create({ doc: unchecked }).tr.setNodeAttribute(itemPosition, "checked", true).doc;
  assert.equal(serialize(rechecked), "- [X] renamed\n- [x] beta\n- [ ] open\n");
});

test("uppercase task input converts the current list item without losing marker case", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const base = parse("- item\n");
  const item = textPosition(base, "item");
  const doc = EditorState.create({ doc: base }).tr.insertText("[X]", item, item + "item".length).doc;
  const marker = textPosition(doc, "[X]");
  const transaction = uppercaseTaskTransaction(EditorState.create({ doc }), marker, marker + 3);
  assert.equal(transaction?.doc.firstChild.firstChild.attrs.checked, true);
  assert.equal(transaction?.doc.firstChild.firstChild.attrs.taskMarker, "X");
  assert.equal(serialize(transaction.doc), "- [X]\n");
});

test("typed star and plus markers survive the built-in wrapping input rule", async () => {
  const { parse } = await milkdownTransformer();
  for (const marker of ["*", "+"]) {
    const newDoc = parse("- item\n");
    const oldDoc = newDoc.type.create(null, [
      newDoc.type.schema.nodes.paragraph.create(null, [newDoc.type.schema.text(marker)])
    ]);
    const oldState = EditorState.create({
      doc: oldDoc,
      selection: TextSelection.create(oldDoc, 1 + marker.length)
    });
    const newState = EditorState.create({
      doc: newDoc,
      selection: TextSelection.create(newDoc, textPosition(newDoc, "item") + 1)
    });
    const transaction = typedBulletMarkerTransaction(oldState, newState);
    assert.equal(transaction?.doc.firstChild.attrs.bulletMarker, marker);
  }

  const existingDoc = parse("- \\*\n");
  const existingState = EditorState.create({
    doc: existingDoc,
    selection: TextSelection.create(existingDoc, textPosition(existingDoc, "*") + 1)
  });
  const nextDoc = parse("- item\n");
  const nextState = EditorState.create({
    doc: nextDoc,
    selection: TextSelection.create(nextDoc, textPosition(nextDoc, "item") + 1)
  });
  assert.equal(typedBulletMarkerTransaction(existingState, nextState), null);
});
