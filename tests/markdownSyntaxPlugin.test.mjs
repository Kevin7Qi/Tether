import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { AllSelection, EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import {
  activeMarkdownAtomSyntax,
  activeMarkdownBlockSyntax,
  activeMarkdownSyntax,
  adjacentCodeBlockFromSelection,
  adjacentCodeSourceSelection,
  adjacentCodeSourceTarget,
  activateMarkdownBlockSourceAt,
  blockSourceVerticalDirection,
  blockSourceBoundarySelectionDirection,
  completedInlineMarkdownSource,
  continuousMarkdownSource,
  documentSelectionFromCodeBoundary,
  documentSourceUnitStartOffset,
  documentPositionAtSourceOffset,
  documentSourceTarget,
  downgradeAtxHeadingAtCursor,
  enclosingCodeBlock,
  exactSourceSelectionAfterUndo,
  exactSourceSelectionAfterHistory,
  extendSourceSelection,
  inlineSourceBoundaryDeleteDirection,
  inlineSourceBoundaryDirection,
  inlineSourceBoundarySelectionDirection,
  inlineSourceContentOffset,
  inlineSourceVerticalDirection,
  isSourceInputComposing,
  hardbreakBoundaryBackspaceTransaction,
  hardbreakSourceReplacement,
  liftListMarkerAtCursor,
  liftStructuralMarkerAtCursor,
  markdownAtomSyntaxAt,
  markdownBoundarySourceTarget,
  markdownDeletionSourceUnit,
  markdownDeletionTarget,
  markdownSourceSelectionAt,
  markdownTableSyntaxAt,
  mappedPosition,
  moveSourceSelectionHead,
  rootBoundarySourceSelection,
  sourceCaretOffset,
  sourceTabEdit,
  sourceCaretBoundaries,
  sourceCharacterDeletionRange,
  sourceEditCaretOffset,
  sourceLineEndingAt,
  sourceBoundarySelectionRange,
  sourceInputSelection,
  sourceInputWordJumpDirection,
  sourceSelectionAcrossUnitBoundary,
  sourceInitialSelectionRange,
  sourceDocumentJumpEdge,
  sourceLineJumpEdge,
  sourcePointerSelectionRange,
  sourceAtomNearPosition,
  sourceAwareClipboardText,
  sourceNewlineClipboardText,
  sourceNewlineDeletionTransaction,
  sourceNewlineSelectionInfo,
  sourceSelectionFromDocumentSelection,
  sourceSelectionAfterEdit,
  sourceSelectionHasAdjacentBlocks,
  sourceSelectionLineJump,
  sourceSelectionRangeAfterMotion,
  sourceSelectionTabEdit,
  sourceSelectionText,
  sourceSelectionWordJump,
  sourceVerticalOffset,
  sourceWordJumpTarget,
  sourceWordOffset,
  sourceWordSelectionRange,
  sourceWordSelectionAcrossUnitBoundary,
  serializedDocumentGaps,
  structuralBoundarySourceTarget,
  structuralSourceHandoffTarget,
  sourceFaithfulHeadingKeymapConfig,
  sourceFaithfulListItemKeymapConfig,
  textSelectionAcrossBoundary,
  usesContinuousSourceEditor
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*" },
    text: { group: "inline" }
  },
  marks: {
    strong: {},
    emphasis: {},
    inlineCode: {},
    strike_through: {},
    link: { attrs: { href: {}, title: { default: null } } }
  }
});

function stateWithMarks(markNames) {
  const marks = markNames.map((name) => schema.marks[name].create());
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("marked", marks)])]);
  return EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
}

test("activeMarkdownSyntax exposes one continuous strong source range", () => {
  const syntax = activeMarkdownSyntax(stateWithMarks(["strong"]));
  assert.deepEqual(syntax.names, ["strong"]);
  assert.equal(syntax.kind, "inline");
  assert.equal(syntax.to - syntax.from, "marked".length);
});

test("source activation enters textblocks instead of selecting the whole paragraph", () => {
  const paragraph = schema.node("paragraph", null, [schema.text("editable")]);
  const doc = schema.node("doc", null, [paragraph]);
  const atBoundary = markdownSourceSelectionAt(doc, 0);
  const inside = markdownSourceSelectionAt(doc, 4);
  assert.ok(atBoundary instanceof TextSelection);
  assert.equal(atBoundary.from, 1);
  assert.equal(atBoundary.$from.parent.type.name, "paragraph");
  assert.ok(inside instanceof TextSelection);
  assert.equal(inside.from, 4);
});

test("completed inline Markdown is detected at the typing caret", () => {
  assert.equal(completedInlineMarkdownSource("Write **bold**")?.[0], "**bold**");
  assert.equal(completedInlineMarkdownSource("Use `code`")?.[0], "`code`");
  assert.equal(completedInlineMarkdownSource("Math $E=mc^2$")?.[0], "$E=mc^2$");
  assert.equal(completedInlineMarkdownSource("Read [docs](https://example.com)")?.[0], "[docs](https://example.com)");
  assert.equal(completedInlineMarkdownSource("unfinished **bold"), null);
});

test("inline code waits for a closing fence with the same backtick length", () => {
  assert.equal(completedInlineMarkdownSource("Use ``code`")?.[0], undefined);
  assert.equal(completedInlineMarkdownSource("Use ``code``")?.[0], "``code``");
  assert.equal(
    completedInlineMarkdownSource("Use ``code with ` inside``")?.[0],
    "``code with ` inside``"
  );
  assert.equal(completedInlineMarkdownSource("Use ```code``")?.[0], undefined);
  assert.equal(completedInlineMarkdownSource("Use ```code```")?.[0], "```code```");
});

test("escaped inline delimiters stay literal until an unescaped source pair is typed", () => {
  assert.equal(completedInlineMarkdownSource("Write \\*literal*"), null);
  assert.equal(completedInlineMarkdownSource("Write *literal\\*"), null);
  assert.equal(completedInlineMarkdownSource("Write \\**literal**"), null);
  assert.equal(completedInlineMarkdownSource("Use \\`literal`"), null);
  assert.equal(completedInlineMarkdownSource("Math \\$E=mc^2$"), null);
  assert.equal(completedInlineMarkdownSource("Read \\[docs](https://example.com)"), null);

  // An escaped backslash leaves the following delimiter active in Markdown.
  assert.equal(completedInlineMarkdownSource("Write \\\\*italic*")?.[0], "*italic*");
  assert.equal(completedInlineMarkdownSource("Use \\\\`code`")?.[0], "`code`");
});

test("prose that merely resembles Markdown stays literal while typing", () => {
  // Dollar amounts are prices, not math: the "$..$" span here wraps text with
  // whitespace at its edges, and a digit can follow the closing "$".
  assert.equal(completedInlineMarkdownSource("I have $5 and $"), null);
  assert.equal(completedInlineMarkdownSource("range $a$", "9"), null);
  // Intra-word underscores never become emphasis.
  assert.equal(completedInlineMarkdownSource("use snake_case_"), null);
  assert.equal(completedInlineMarkdownSource("path/to_file_"), null);
  assert.equal(completedInlineMarkdownSource("a_b_", "c"), null);
  // Indexing followed by a call is code-shaped, not a link.
  assert.equal(completedInlineMarkdownSource("read arr[i](x)"), null);
  // Boundary-safe versions still convert.
  assert.equal(completedInlineMarkdownSource("some _italic_")?.[0], "_italic_");
  assert.equal(completedInlineMarkdownSource("math $E=mc^2$")?.[0], "$E=mc^2$");
});

test("activeMarkdownSyntax treats nested bold and italic as one source range", () => {
  const syntax = activeMarkdownSyntax(stateWithMarks(["strong", "emphasis"]));
  assert.deepEqual(syntax.names, ["strong", "emphasis"]);
  assert.equal(syntax.to - syntax.from, "marked".length);
});

test("nested formatting exposes a balanced outer source span instead of an invented intersection", () => {
  const strong = schema.marks.strong.create();
  const emphasis = schema.marks.emphasis.create();
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [
    schema.text("outer ", [strong]),
    schema.text("inner", [strong, emphasis]),
    schema.text(" tail", [strong])
  ])]);
  const innerPosition = 1 + "outer ".length + 2;
  const syntax = activeMarkdownSyntax(EditorState.create({
    doc,
    selection: TextSelection.create(doc, innerPosition)
  }));

  assert.deepEqual(syntax.names, ["strong", "emphasis"]);
  assert.equal(syntax.from, 1);
  assert.equal(syntax.to, 1 + "outer inner tail".length);
});

test("activeMarkdownSyntax treats inline code as an opaque Markdown token", () => {
  const syntax = activeMarkdownSyntax(stateWithMarks(["inlineCode", "emphasis"]));
  assert.deepEqual(syntax.names, ["inlineCode"]);
});

test("activeMarkdownSyntax exposes a link destination around its active label", () => {
  const mark = schema.marks.link.create({ href: "https://example.com/docs", title: "Docs" });
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("guide", [mark])])]);
  const syntax = activeMarkdownSyntax(EditorState.create({ doc, selection: TextSelection.create(doc, 3) }));
  assert.deepEqual(syntax.names, ["link"]);
  assert.equal(syntax.to - syntax.from, "guide".length);
});

test("boundary deletion targets the adjacent formatted source delimiter, not visible text", () => {
  const strong = schema.marks.strong.create();
  const emphasis = schema.marks.emphasis.create();
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [
    schema.text("plain "),
    schema.text("bold", [strong]),
    schema.text("ital", [emphasis]),
    schema.text(" tail")
  ])]);
  const strongUnit = activeMarkdownSyntax(EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1 + "plain ".length + 1)
  }));
  const emphasisUnit = activeMarkdownSyntax(EditorState.create({
    doc,
    selection: TextSelection.create(doc, strongUnit.to + 1)
  }));
  const boundary = strongUnit.to;
  const backwardState = EditorState.create({ doc, selection: TextSelection.create(doc, boundary) });
  const forwardState = EditorState.create({ doc, selection: TextSelection.create(doc, boundary) });
  const backward = markdownDeletionTarget(backwardState, "backward");
  const forward = markdownDeletionTarget(forwardState, "forward");

  assert.deepEqual(markdownBoundarySourceTarget(backwardState, "backward"), backward);
  assert.deepEqual(markdownBoundarySourceTarget(forwardState, "forward"), forward);
  assert.equal(backward.edge, "end");
  assert.equal(backward.inlinePosition, boundary - 1);
  assert.deepEqual(markdownDeletionSourceUnit(backwardState, backward), strongUnit);
  assert.equal(forward.edge, "start");
  assert.equal(forward.inlinePosition, boundary + 1);
  assert.deepEqual(markdownDeletionSourceUnit(forwardState, forward), emphasisUnit);
});

test("entering rendered inline source with shift-arrow selects its nearest delimiter", () => {
  assert.deepEqual(sourceBoundarySelectionRange(8, 0, "forward"), {
    start: 0,
    end: 1,
    direction: "forward"
  });
  assert.deepEqual(sourceBoundarySelectionRange(8, 8, "backward"), {
    start: 7,
    end: 8,
    direction: "backward"
  });
  assert.deepEqual(sourceBoundarySelectionRange(0, 0, "forward"), {
    start: 0,
    end: 0,
    direction: "none"
  });
});

test("formatted-source deletion targeting does not intercept an interior character", () => {
  const strong = schema.marks.strong.create();
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [
    schema.text("bold", [strong])
  ])]);
  const interior = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });

  assert.equal(markdownDeletionTarget(interior, "backward"), null);
  assert.equal(markdownDeletionTarget(interior, "forward"), null);
});

test("sourceCaretOffset preserves the clicked character inside inline Markdown", () => {
  const state = stateWithMarks(["inlineCode"]);
  const syntax = activeMarkdownSyntax(state);
  assert.equal(sourceCaretOffset(state, syntax, "`marked`", syntax.from + 3), 4);
  assert.equal(sourceCaretOffset(state, syntax, "`marked`", syntax.from, 5), 5);
});

test("sourceCaretOffset uses a serialized marker for formatted inline text", () => {
  const state = stateWithMarks(["strong"]);
  const syntax = activeMarkdownSyntax(state);
  const serializer = (doc) => {
    let source = "";
    doc.firstChild.forEach((node) => {
      source += node.marks.some((mark) => mark.type.name === "strong") ? `**${node.text}**` : node.text;
    });
    return source;
  };
  assert.equal(sourceCaretOffset(state, syntax, "**marked**", syntax.from + 3, null, serializer), 5);
  assert.equal(sourceCaretOffset(state, syntax, "**marked**", syntax.to, null, serializer), 8);
});

const blockSchema = new Schema({
  nodes: {
    doc: {
      content: "block+",
      attrs: { markdownBlockGaps: { default: null } }
    },
    paragraph: { content: "inline*", group: "block" },
    heading: {
      content: "inline*",
      group: "block",
      attrs: {
        level: { default: 1 },
        markdownStyle: { default: "atx" }
      }
    },
    code_block: {
      content: "text*",
      group: "block",
      marks: "",
      code: true,
      attrs: { language: { default: "" } }
    },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { start: { default: 1 } }
    },
    list_item: {
      content: "paragraph block*",
      attrs: {
        checked: { default: null },
        listType: { default: "bullet" },
        label: { default: "•" }
      }
    },
    table: { content: "table_row+", group: "block" },
    table_row: { content: "(table_header|table_cell)+" },
    table_header: { content: "paragraph+" },
    table_cell: { content: "paragraph+", group: "block" },
    hr: { group: "block", atom: true },
    link_definition: {
      group: "block",
      atom: true,
      attrs: { definitionSource: { default: "" } }
    },
    image: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } }
    },
    hardbreak: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: false,
      attrs: {
        isInline: { default: false },
        markdownMarker: { default: "\\" }
      }
    },
    footnote_reference: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { label: { default: "" } }
    },
    math_inline: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { value: { default: "" } }
    },
    text: { group: "inline" }
  },
  marks: {
    strong: {},
    emphasis: {}
  }
});

function textSelection(doc, needle) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && node.isText && node.text.includes(needle)) position = pos + 1;
  });
  return TextSelection.create(doc, position);
}

function docState(doc) {
  return EditorState.create({ doc });
}

function paragraphStart(doc, text) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && node.type.name === "paragraph" && node.textContent === text) position = pos + 1;
  });
  return position;
}

test("activeMarkdownBlockSyntax exposes the complete heading as one block", () => {
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("heading", { level: 2 }, [blockSchema.text("Heading")])
  ]);
  const syntax = activeMarkdownBlockSyntax(EditorState.create({ doc, selection: textSelection(doc, "Heading") }));
  assert.deepEqual(syntax, { from: 0, to: doc.firstChild.nodeSize, kind: "block", name: "heading" });
});

test("activeMarkdownBlockSyntax exposes a fenced code block as one block", () => {
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("code_block", { language: "js" }, [blockSchema.text("const answer = 42;")])
  ]);
  const syntax = activeMarkdownBlockSyntax(EditorState.create({
    doc,
    selection: textSelection(doc, "answer")
  }));
  assert.deepEqual(syntax, { from: 0, to: doc.firstChild.nodeSize, kind: "block", name: "code_block" });
});

test("sourceCaretOffset maps the clicked code character past the fence prefix", () => {
  const code = "const answer = 42;";
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("code_block", { language: "js" }, [blockSchema.text(code)])
  ]);
  const state = docState(doc);
  const unit = { from: 0, to: doc.firstChild.nodeSize, kind: "block", name: "code_block" };
  const serializer = (partialDoc) => `\`\`\`js\n${partialDoc.firstChild.textContent}\n\`\`\``;
  assert.equal(sourceCaretOffset(state, unit, `\`\`\`js\n${code}\n\`\`\``, 1, null, serializer), 6);
  assert.equal(sourceCaretOffset(state, unit, `\`\`\`js\n${code}\n\`\`\``, 1 + 6, null, serializer), 12);
  assert.equal(sourceCaretOffset(state, unit, `\`\`\`js\n${code}\n\`\`\``, 1 + code.length, null, serializer), 6 + code.length);
});

test("enclosingCodeBlock recovers the code node from an inner DOM position", () => {
  const code = "const answer = 42;";
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("code_block", { language: "js" }, [blockSchema.text(code)])
  ]);
  const match = enclosingCodeBlock(doc, 1 + code.indexOf("answer"));
  assert.equal(match?.position, 0);
  assert.equal(match?.node, doc.firstChild);
});

test("activeMarkdownBlockSyntax exposes the complete list as one multiline block", () => {
  const paragraph = blockSchema.node("paragraph", null, [blockSchema.text("Done")]);
  const item = blockSchema.node("list_item", { checked: true, listType: "bullet", label: "•" }, [paragraph]);
  const doc = blockSchema.node("doc", null, [blockSchema.node("bullet_list", null, [item])]);
  const syntax = activeMarkdownBlockSyntax(EditorState.create({ doc, selection: textSelection(doc, "Done") }));
  assert.deepEqual(syntax, { from: 0, to: doc.firstChild.nodeSize, kind: "block", name: "bullet_list" });
});

test("nested structural content exposes its outer physical source container", () => {
  const nestedItem = blockSchema.node("list_item", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Nested")])
  ]);
  const outerItem = blockSchema.node("list_item", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Outer")]),
    blockSchema.node("bullet_list", null, [nestedItem])
  ]);
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("blockquote", null, [
      blockSchema.node("bullet_list", null, [outerItem])
    ])
  ]);
  const syntax = activeMarkdownBlockSyntax(EditorState.create({
    doc,
    selection: textSelection(doc, "Nested")
  }));
  assert.deepEqual(syntax, {
    from: 0,
    to: doc.firstChild.nodeSize,
    kind: "block",
    name: "blockquote"
  });
});

test("structural boundary arrows expose hidden heading, list, and quote source only at text edges", () => {
  const headingDoc = blockSchema.node("doc", null, [
    blockSchema.node("heading", { level: 2 }, [blockSchema.text("Heading")])
  ]);
  const headingStart = EditorState.create({
    doc: headingDoc,
    selection: TextSelection.create(headingDoc, 1)
  });
  const headingEnd = EditorState.create({
    doc: headingDoc,
    selection: TextSelection.create(headingDoc, 1 + "Heading".length)
  });
  assert.equal(structuralBoundarySourceTarget(headingStart, "ArrowLeft")?.unit.name, "heading");
  assert.equal(structuralBoundarySourceTarget(headingEnd, "ArrowRight")?.direction, "forward");
  assert.equal(structuralBoundarySourceTarget(headingStart, "ArrowRight"), null);

  const item = blockSchema.node("list_item", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Item")])
  ]);
  const listDoc = blockSchema.node("doc", null, [blockSchema.node("bullet_list", null, [item])]);
  const listStart = EditorState.create({
    doc: listDoc,
    selection: TextSelection.create(listDoc, paragraphStart(listDoc, "Item"))
  });
  assert.equal(structuralBoundarySourceTarget(listStart, "ArrowLeft")?.unit.name, "bullet_list");

  const quoteDoc = blockSchema.node("doc", null, [
    blockSchema.node("blockquote", null, [
      blockSchema.node("paragraph", null, [blockSchema.text("Quote")])
    ])
  ]);
  const quoteStart = EditorState.create({
    doc: quoteDoc,
    selection: TextSelection.create(quoteDoc, paragraphStart(quoteDoc, "Quote"))
  });
  assert.equal(structuralBoundarySourceTarget(quoteStart, "ArrowLeft")?.unit.name, "blockquote");

  const plainDoc = blockSchema.node("doc", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Plain")])
  ]);
  const plainStart = EditorState.create({ doc: plainDoc, selection: TextSelection.create(plainDoc, 1) });
  assert.equal(structuralBoundarySourceTarget(plainStart, "ArrowLeft"), null);
});

test("table cell boundary arrows enter the exact hidden pipe source", () => {
  const header = blockSchema.node("table_header", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Name")])
  ]);
  const cell = blockSchema.node("table_cell", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Tether")])
  ]);
  const table = blockSchema.node("table", null, [
    blockSchema.node("table_row", null, [header]),
    blockSchema.node("table_row", null, [cell])
  ]);
  const doc = blockSchema.node("doc", null, [table]);
  const start = paragraphStart(doc, "Name");
  const end = paragraphStart(doc, "Tether") + "Tether".length;
  const backward = structuralBoundarySourceTarget(EditorState.create({
    doc,
    selection: TextSelection.create(doc, start)
  }), "ArrowLeft");
  const forward = structuralBoundarySourceTarget(EditorState.create({
    doc,
    selection: TextSelection.create(doc, end)
  }), "ArrowRight");

  assert.deepEqual(backward, {
    unit: { from: 0, to: table.nodeSize, kind: "block", name: "table" },
    direction: "backward",
    position: start
  });
  assert.deepEqual(forward, {
    unit: { from: 0, to: table.nodeSize, kind: "block", name: "table" },
    direction: "forward",
    position: end
  });
  assert.equal(structuralBoundarySourceTarget(EditorState.create({
    doc,
    selection: TextSelection.create(doc, start + 1)
  }), "ArrowRight"), null);
});

test("inline delimiters precede enclosing structural markers at a textblock edge", () => {
  const strong = blockSchema.marks.strong.create();
  const item = blockSchema.node("list_item", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Bold", [strong])])
  ]);
  const doc = blockSchema.node("doc", null, [blockSchema.node("bullet_list", null, [item])]);
  const start = paragraphStart(doc, "Bold");
  const backwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, start)
  });
  const forwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, start + "Bold".length)
  });
  const backward = structuralBoundarySourceTarget(backwardState, "ArrowLeft");
  const forward = structuralBoundarySourceTarget(forwardState, "ArrowRight");
  assert.equal(backward?.unit.kind, "inline");
  assert.deepEqual(backward?.unit.names, ["strong"]);
  assert.equal(forward?.unit.kind, "inline");
  assert.deepEqual(forward?.unit.names, ["strong"]);
});

test("inline source hands directly into enclosing heading source coordinates", () => {
  const strong = blockSchema.marks.strong.create();
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("heading", { level: 2 }, [blockSchema.text("Bold", [strong])])
  ]);
  const serialize = (partialDoc) => {
    const block = partialDoc.firstChild;
    let inline = "";
    block.forEach((node) => {
      inline += node.marks.some((mark) => mark.type.name === "strong")
        ? `**${node.text}**`
        : node.text;
    });
    return block.type.name === "heading" ? `## ${inline}` : inline;
  };
  const start = 1;
  const end = start + "Bold".length;
  const backwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, start)
  });
  const forwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, end)
  });

  assert.equal(
    documentSourceUnitStartOffset(backwardState, activeMarkdownSyntax(backwardState), serialize),
    "## ".length
  );

  const backwardEdge = structuralSourceHandoffTarget(
    backwardState,
    start,
    "backward",
    serialize
  );
  const backwardMove = structuralSourceHandoffTarget(
    backwardState,
    start,
    "backward",
    serialize,
    true
  );
  const forwardEdge = structuralSourceHandoffTarget(
    forwardState,
    end,
    "forward",
    serialize
  );
  assert.equal(backwardEdge?.source, "## **Bold**");
  assert.equal(backwardEdge?.sourceOffset, "## ".length);
  assert.equal(backwardMove?.sourceOffset, "## ".length - 1);
  assert.equal(forwardEdge, null);
});

test("Backspace at the first list marker lifts the item without joining the preceding heading", () => {
  const heading = blockSchema.node("heading", { level: 2 }, [blockSchema.text("Heading")]);
  const item = (text, attrs = null) => blockSchema.node("list_item", attrs, [
    blockSchema.node("paragraph", null, [blockSchema.text(text)])
  ]);
  const doc = blockSchema.node("doc", null, [
    heading,
    blockSchema.node("bullet_list", null, [item("First"), item("Second")])
  ]);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphStart(doc, "First"))
  });
  let nextState = state;

  assert.equal(liftListMarkerAtCursor(state, (transaction) => {
    nextState = state.apply(transaction);
  }), true);
  assert.deepEqual(
    Array.from({ length: nextState.doc.childCount }, (_, index) => nextState.doc.child(index).type.name),
    ["heading", "paragraph", "bullet_list"]
  );
  assert.equal(nextState.doc.child(0).textContent, "Heading");
  assert.equal(nextState.doc.child(1).textContent, "First");
  assert.equal(nextState.doc.child(2).textContent, "Second");
});

test("Backspace at a middle list marker splits around the lifted paragraph", () => {
  const item = (text) => blockSchema.node("list_item", null, [
    blockSchema.node("paragraph", null, [blockSchema.text(text)])
  ]);
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("bullet_list", null, [item("First"), item("Middle"), item("Last")])
  ]);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphStart(doc, "Middle"))
  });
  let nextState = state;

  assert.equal(liftListMarkerAtCursor(state, (transaction) => {
    nextState = state.apply(transaction);
  }), true);
  assert.deepEqual(
    Array.from({ length: nextState.doc.childCount }, (_, index) => nextState.doc.child(index).type.name),
    ["bullet_list", "paragraph", "bullet_list"]
  );
  assert.deepEqual(
    Array.from({ length: nextState.doc.childCount }, (_, index) => nextState.doc.child(index).textContent),
    ["First", "Middle", "Last"]
  );
});

test("Backspace at a nested marker outdents the item by one list level", () => {
  const paragraph = (text) => blockSchema.node("paragraph", null, [blockSchema.text(text)]);
  const nestedItem = blockSchema.node("list_item", null, [paragraph("Nested")]);
  const outerItem = blockSchema.node("list_item", null, [
    paragraph("Outer"),
    blockSchema.node("bullet_list", null, [nestedItem])
  ]);
  const doc = blockSchema.node("doc", null, [blockSchema.node("bullet_list", null, [outerItem])]);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphStart(doc, "Nested"))
  });
  let nextState = state;

  assert.equal(liftListMarkerAtCursor(state, (transaction) => {
    nextState = state.apply(transaction);
  }), true);
  const list = nextState.doc.firstChild;
  assert.equal(list.type.name, "bullet_list");
  assert.equal(list.childCount, 2);
  assert.equal(list.child(0).textContent, "Outer");
  assert.equal(list.child(1).textContent, "Nested");
});

test("marker lifting works for ordered and checked task items", () => {
  for (const { listName, attrs } of [
    { listName: "ordered_list", attrs: null },
    { listName: "bullet_list", attrs: { checked: true, listType: "bullet", label: "•" } }
  ]) {
    const item = blockSchema.node("list_item", attrs, [
      blockSchema.node("paragraph", null, [blockSchema.text("Item")])
    ]);
    const doc = blockSchema.node("doc", null, [blockSchema.node(listName, null, [item])]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, paragraphStart(doc, "Item"))
    });
    let nextState = state;

    assert.equal(liftListMarkerAtCursor(state, (transaction) => {
      nextState = state.apply(transaction);
    }), true);
    assert.equal(nextState.doc.firstChild.type.name, "paragraph");
    assert.equal(nextState.doc.firstChild.textContent, "Item");
  }
});

test("Backspace at a blockquote paragraph start removes the nearest quote marker", () => {
  const quote = blockSchema.node("blockquote", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Quoted")])
  ]);
  const doc = blockSchema.node("doc", null, [quote]);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, paragraphStart(doc, "Quoted"))
  });
  let nextState = null;

  assert.equal(liftStructuralMarkerAtCursor(state, (transaction) => {
    nextState = state.apply(transaction);
  }), true);
  assert.equal(nextState.doc.firstChild.type.name, "paragraph");
  assert.equal(nextState.doc.textContent, "Quoted");
});

test("nested quote and list markers lift in nearest-source-marker order", () => {
  const paragraph = blockSchema.node("paragraph", null, [blockSchema.text("Nested")]);
  const quoteInList = blockSchema.node("doc", null, [
    blockSchema.node("bullet_list", null, [
      blockSchema.node("list_item", { checked: null, listType: "bullet", label: "•" }, [
        blockSchema.node("paragraph"),
        blockSchema.node("blockquote", null, [paragraph])
      ])
    ])
  ]);
  const listInQuote = blockSchema.node("doc", null, [
    blockSchema.node("blockquote", null, [
      blockSchema.node("bullet_list", null, [
        blockSchema.node("list_item", { checked: null, listType: "bullet", label: "•" }, [paragraph])
      ])
    ])
  ]);

  const liftOnce = (doc) => {
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, paragraphStart(doc, "Nested"))
    });
    let nextState = null;
    assert.equal(liftStructuralMarkerAtCursor(state, (transaction) => {
      nextState = state.apply(transaction);
    }), true);
    return nextState.doc;
  };

  const quoteLiftedFirst = liftOnce(quoteInList);
  assert.equal(quoteLiftedFirst.firstChild.type.name, "bullet_list");
  assert.equal(quoteLiftedFirst.firstChild.firstChild.firstChild.type.name, "paragraph");

  const listLiftedFirst = liftOnce(listInQuote);
  assert.equal(listLiftedFirst.firstChild.type.name, "blockquote");
  assert.equal(listLiftedFirst.firstChild.firstChild.type.name, "paragraph");
});

test("structural marker lifting leaves headings and non-boundary carets to their native keymaps", () => {
  const heading = blockSchema.node("heading", { level: 2 }, [blockSchema.text("Heading")]);
  const quote = blockSchema.node("blockquote", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Quoted")])
  ]);
  const headingDoc = blockSchema.node("doc", null, [blockSchema.node("blockquote", null, [heading])]);
  const quoteDoc = blockSchema.node("doc", null, [quote]);

  assert.equal(liftStructuralMarkerAtCursor(EditorState.create({
    doc: headingDoc,
    selection: textSelection(headingDoc, "Heading")
  })), false);
  assert.equal(liftStructuralMarkerAtCursor(EditorState.create({
    doc: quoteDoc,
    selection: TextSelection.create(quoteDoc, paragraphStart(quoteDoc, "Quoted") + 1)
  })), false);
});

test("marker lifting falls through away from a collapsed list-item start", () => {
  const paragraph = blockSchema.node("paragraph", null, [blockSchema.text("Item")]);
  const list = blockSchema.node("bullet_list", null, [blockSchema.node("list_item", null, [paragraph])]);
  const doc = blockSchema.node("doc", null, [list]);
  const start = paragraphStart(doc, "Item");

  assert.equal(liftListMarkerAtCursor(EditorState.create({
    doc,
    selection: TextSelection.create(doc, start + 1)
  })), false);
  assert.equal(liftListMarkerAtCursor(EditorState.create({
    doc,
    selection: TextSelection.create(doc, start, start + 1)
  })), false);
});

test("the built-in first-item keymap no longer treats forward Delete like marker deletion", () => {
  const config = {
    LiftFirstListItem: { shortcuts: ["Backspace", "Delete"], priority: 50 },
    NextListItem: { shortcuts: "Enter", priority: 50 }
  };
  const next = sourceFaithfulListItemKeymapConfig(config);

  assert.equal(next.LiftFirstListItem.shortcuts, "Backspace");
  assert.equal(next.LiftFirstListItem.priority, 50);
  assert.deepEqual(next.NextListItem, config.NextListItem);
  assert.deepEqual(config.LiftFirstListItem.shortcuts, ["Backspace", "Delete"]);
});

test("the built-in heading keymap yields Backspace to the source-aware handler", () => {
  const config = {
    DowngradeHeading: { shortcuts: ["Delete", "Backspace"], priority: 50 },
    TurnIntoH1: { shortcuts: "Mod-Alt-1", priority: 50 }
  };
  const next = sourceFaithfulHeadingKeymapConfig(config);

  assert.deepEqual(next.DowngradeHeading.shortcuts, []);
  assert.equal(next.DowngradeHeading.priority, 50);
  assert.deepEqual(next.TurnIntoH1, config.TurnIntoH1);
  assert.deepEqual(config.DowngradeHeading.shortcuts, ["Delete", "Backspace"]);
});

test("Backspace downgrades ATX headings but leaves setext line boundaries native", () => {
  const atx = blockSchema.node("heading", { level: 2, markdownStyle: "atx" }, [blockSchema.text("ATX")]);
  const atxDoc = blockSchema.node("doc", null, [atx]);
  const atxState = EditorState.create({ doc: atxDoc, selection: TextSelection.create(atxDoc, 1) });
  let atxTransaction = null;
  assert.equal(downgradeAtxHeadingAtCursor(atxState, (transaction) => {
    atxTransaction = transaction;
  }), true);
  assert.equal(atxTransaction.doc.firstChild.type.name, "heading");
  assert.equal(atxTransaction.doc.firstChild.attrs.level, 1);
  assert.equal(atxTransaction.doc.firstChild.attrs.markdownStyle, "atx");

  const setext = blockSchema.node("heading", { level: 1, markdownStyle: "setext" }, [blockSchema.text("Setext")]);
  const setextDoc = blockSchema.node("doc", null, [setext]);
  const setextState = EditorState.create({ doc: setextDoc, selection: TextSelection.create(setextDoc, 1) });
  assert.equal(downgradeAtxHeadingAtCursor(setextState), false);

  const h1 = blockSchema.node("heading", { level: 1, markdownStyle: "atx" }, [blockSchema.text("Title")]);
  const h1Doc = blockSchema.node("doc", null, [h1]);
  const h1State = EditorState.create({ doc: h1Doc, selection: TextSelection.create(h1Doc, 1) });
  let h1Transaction = null;
  assert.equal(downgradeAtxHeadingAtCursor(h1State, (transaction) => {
    h1Transaction = transaction;
  }), true);
  assert.equal(h1Transaction.doc.firstChild.type.name, "paragraph");
});

test("sourceCaretOffset distinguishes repeated text in separate list items", () => {
  const paragraph = () => blockSchema.node("paragraph", null, [blockSchema.text("Same")]);
  const item = () => blockSchema.node("list_item", { checked: null, listType: "bullet", label: "•" }, [paragraph()]);
  const list = blockSchema.node("bullet_list", null, [item(), item()]);
  const doc = blockSchema.node("doc", null, [list]);
  const textPositions = [];
  doc.descendants((node, pos) => {
    if (node.isText) textPositions.push(pos);
  });
  const unit = { from: 0, to: list.nodeSize, kind: "block", name: "bullet_list" };
  const serializer = (partialDoc) => {
    const partialList = partialDoc.firstChild;
    return [...Array(partialList.childCount).keys()]
      .map((index) => `- ${partialList.child(index).textContent}`)
      .join("\n");
  };

  assert.equal(sourceCaretOffset(docState(doc), unit, "- Same\n- Same", textPositions[1] + 2, null, serializer), 11);
});

test("mappedPosition follows a captured destination through an earlier edit", () => {
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("short")]),
    blockSchema.node("paragraph", null, [blockSchema.text("target")])
  ]);
  const state = docState(doc);
  const target = doc.firstChild.nodeSize + 1;
  const transaction = state.tr.insertText(" much longer", 1 + "short".length);
  assert.equal(mappedPosition(transaction.mapping, target), target + " much longer".length);
});

test("selection across a block boundary represents the source newline without consuming text", () => {
  const before = blockSchema.node("paragraph", null, [blockSchema.text("before")]);
  const code = blockSchema.node("code_block", { language: "js" }, [blockSchema.text("code")]);
  const after = blockSchema.node("paragraph", null, [blockSchema.text("after")]);
  const doc = blockSchema.node("doc", null, [before, code, after]);
  const state = docState(doc);
  const codePosition = before.nodeSize;
  const backward = textSelectionAcrossBoundary(state, codePosition, "backward");
  const forward = textSelectionAcrossBoundary(state, codePosition + code.nodeSize, "forward");

  assert.equal(backward.empty, false);
  assert.equal(backward.anchor > backward.head, true);
  assert.equal(doc.textBetween(backward.from, backward.to, ""), "");
  assert.equal(doc.textBetween(backward.from, backward.to, "\n"), "\n");
  assert.equal(forward.empty, false);
  assert.equal(forward.anchor < forward.head, true);
  assert.equal(doc.textBetween(forward.from, forward.to, ""), "");
  assert.equal(doc.textBetween(forward.from, forward.to, "\n"), "\n");
  const newlineState = EditorState.create({ doc, selection: forward });
  assert.equal(sourceNewlineSelectionInfo(newlineState)?.boundary, codePosition + code.nodeSize);
  assert.equal(sourceNewlineClipboardText(newlineState), "\n");

  const fromInlineEnd = textSelectionAcrossBoundary(
    state,
    codePosition + 1 + code.content.size,
    "forward"
  );
  assert.equal(fromInlineEnd.from, forward.from);
  assert.equal(fromInlineEnd.to, forward.to);
});

test("horizontal root-boundary arrows traverse every physical separator newline", () => {
  const first = blockSchema.node("paragraph", null, [blockSchema.text("First")]);
  const second = blockSchema.node("paragraph", null, [blockSchema.text("Second")]);
  const doc = blockSchema.node("doc", {
    markdownBlockGaps: JSON.stringify(["", "\r\n\r\n", ""])
  }, [first, second]);
  const serializer = (value) => {
    const blocks = [];
    value.forEach((node) => blocks.push(node.textContent));
    const gaps = JSON.parse(value.attrs.markdownBlockGaps);
    return blocks.reduce(
      (source, block, index) => `${source}${block}${gaps[index + 1]}`,
      gaps[0]
    );
  };
  const forwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, first.nodeSize - 1)
  });
  const forward = rootBoundarySourceSelection(forwardState, "forward", serializer);
  assert.equal(forward.anchor, "First\r\n".length);
  assert.equal(forward.head, "First\r\n".length);
  assert.equal(sourceSelectionText(forward), "");

  const forwardExtended = rootBoundarySourceSelection(
    forwardState,
    "forward",
    serializer,
    true
  );
  assert.equal(sourceSelectionText(forwardExtended), "\r\n");

  const secondStart = first.nodeSize + 1;
  const backwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, secondStart)
  });
  const backward = rootBoundarySourceSelection(backwardState, "backward", serializer);
  assert.equal(backward.anchor, "First\r\n".length);
  assert.equal(backward.head, "First\r\n".length);
  const backwardExtended = rootBoundarySourceSelection(
    backwardState,
    "backward",
    serializer,
    true
  );
  assert.equal(sourceSelectionText(backwardExtended), "\r\n");
});

test("gap edits preserve CRLF and keep an exact caret while a source gap remains", () => {
  const first = blockSchema.node("paragraph", null, [blockSchema.text("First")]);
  const second = blockSchema.node("paragraph", null, [blockSchema.text("Second")]);
  const gaps = ["", "\r\n\r\n", ""];
  const doc = blockSchema.node("doc", { markdownBlockGaps: JSON.stringify(gaps) }, [first, second]);
  const serializer = (value) => {
    const blocks = [];
    value.forEach((node) => blocks.push(node.textContent));
    const exactGaps = JSON.parse(value.attrs.markdownBlockGaps);
    return blocks.reduce(
      (source, block, index) => `${source}${block}${exactGaps[index + 1]}`,
      exactGaps[0]
    );
  };
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, first.nodeSize - 1)
  });
  const before = rootBoundarySourceSelection(state, "forward", serializer);
  assert.equal(sourceLineEndingAt(before.fullSource, before.head), "\r\n");

  const inserted = state.tr.setDocAttribute(
    "markdownBlockGaps",
    JSON.stringify(["", "\r\n\r\n\r\n", ""])
  );
  const afterInsert = sourceSelectionAfterEdit(inserted, before, serializer);
  assert.equal(afterInsert.head, "First\r\n\r\n".length);
  assert.equal(
    documentSourceTarget(
      { doc: inserted.doc, selection: inserted.selection },
      afterInsert.head,
      serializer,
      "forward"
    )?.kind,
    "gap"
  );

  const deletion = extendSourceSelection(before, "backward");
  const deleted = state.tr.setDocAttribute(
    "markdownBlockGaps",
    JSON.stringify(["", "\r\n", ""])
  );
  const afterDelete = sourceSelectionAfterEdit(deleted, deletion, serializer);
  assert.equal(afterDelete.head, "First".length);
  assert.equal(
    documentSourceTarget(
      { doc: deleted.doc, selection: deleted.selection },
      afterDelete.head,
      serializer,
      "forward"
    )?.kind,
    "gap"
  );
});

test("extended source selections do not invent adjacent block decoration ranges", () => {
  assert.equal(sourceSelectionHasAdjacentBlocks({ boundary: 4 }), false);
  assert.equal(sourceSelectionHasAdjacentBlocks({
    boundary: 4,
    beforeFrom: 0,
    beforeTo: 4,
    afterFrom: 4,
    afterTo: 9
  }), true);
});

test("selection after an enclosing list source captures only its root separator", () => {
  const item = blockSchema.node("list_item", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("item")])
  ]);
  const list = blockSchema.node("bullet_list", null, [item]);
  const after = blockSchema.node("paragraph", null, [blockSchema.text("after")]);
  const doc = blockSchema.node("doc", null, [list, after]);
  const selection = textSelectionAcrossBoundary(docState(doc), list.nodeSize, "forward");

  assert.equal(selection.anchor < selection.head, true);
  assert.equal(doc.textBetween(selection.from, selection.to, ""), "");
  assert.equal(doc.textBetween(selection.from, selection.to, "\n"), "\n");
});

test("deleting a source newline joins exactly the two blocks it separates", () => {
  const before = blockSchema.node("paragraph", null, [blockSchema.text("before")]);
  const code = blockSchema.node("code_block", { language: "js" }, [blockSchema.text("code")]);
  const after = blockSchema.node("paragraph", null, [blockSchema.text("after")]);

  const forwardDoc = blockSchema.node("doc", null, [code, after]);
  const forwardState = docState(forwardDoc);
  const forward = sourceNewlineDeletionTransaction(
    forwardState,
    code.nodeSize,
    "forward"
  );
  assert.equal(forward?.doc.childCount, 1);
  assert.equal(forward?.doc.firstChild.type.name, "code_block");
  assert.equal(forward?.doc.firstChild.textContent, "codeafter");

  const backwardDoc = blockSchema.node("doc", null, [before, code]);
  const backwardState = docState(backwardDoc);
  const backward = sourceNewlineDeletionTransaction(
    backwardState,
    before.nodeSize,
    "backward"
  );
  assert.equal(backward?.doc.childCount, 1);
  assert.equal(backward?.doc.firstChild.type.name, "paragraph");
  assert.equal(backward?.doc.firstChild.textContent, "beforecode");
});

test("a separator selection never swallows an intervening atomic block", () => {
  const before = blockSchema.node("paragraph", null, [blockSchema.text("before")]);
  const rule = blockSchema.node("hr");
  const after = blockSchema.node("paragraph", null, [blockSchema.text("after")]);
  const doc = blockSchema.node("doc", null, [before, rule, after]);
  const state = docState(doc);
  const afterRule = before.nodeSize + rule.nodeSize;
  const selection = textSelectionAcrossBoundary(state, afterRule, "forward");

  assert.equal(doc.textBetween(selection.from, selection.to), "a");
  assert.equal(sourceNewlineSelectionInfo(EditorState.create({ doc, selection })), null);
  assert.equal(sourceNewlineClipboardText(EditorState.create({ doc, selection })), null);
  assert.equal(sourceNewlineDeletionTransaction(state, afterRule, "forward"), null);
});

test("ordinary code-boundary navigation reaches surrounding text but not a fake document edge", () => {
  const before = blockSchema.node("paragraph", null, [blockSchema.text("Before")]);
  const code = blockSchema.node("code_block", { language: "js" }, [blockSchema.text("code")]);
  const after = blockSchema.node("paragraph", null, [blockSchema.text("After")]);
  const doc = blockSchema.node("doc", null, [before, code, after]);
  const state = docState(doc);
  const codePosition = before.nodeSize;

  const backward = documentSelectionFromCodeBoundary(state, codePosition, "backward");
  const forward = documentSelectionFromCodeBoundary(state, codePosition + code.nodeSize, "forward");
  assert.equal(backward.$from.parent.textContent, "Before");
  assert.equal(backward.$from.parentOffset, "Before".length);
  assert.equal(forward.$from.parent.textContent, "After");
  assert.equal(forward.$from.parentOffset, 0);

  const codeOnly = blockSchema.node("doc", null, [code]);
  const codeOnlyState = docState(codeOnly);
  assert.equal(documentSelectionFromCodeBoundary(codeOnlyState, 0, "backward"), null);
  assert.equal(documentSelectionFromCodeBoundary(codeOnlyState, code.nodeSize, "forward"), null);
});

test("vertical navigation recognizes only an immediately adjacent fenced block", () => {
  const before = blockSchema.node("paragraph", null, [blockSchema.text("Before")]);
  const code = blockSchema.node("code_block", { language: "js" }, [blockSchema.text("one\ntwo")]);
  const after = blockSchema.node("paragraph", null, [blockSchema.text("After")]);
  const doc = blockSchema.node("doc", null, [before, code, after]);

  const beforeState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, before.nodeSize - 1)
  });
  assert.deepEqual(adjacentCodeBlockFromSelection(beforeState, "down"), {
    position: before.nodeSize,
    node: code
  });
  assert.equal(adjacentCodeBlockFromSelection(beforeState, "up"), null);

  const afterStart = before.nodeSize + code.nodeSize + 1;
  const afterState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, afterStart)
  });
  assert.deepEqual(adjacentCodeBlockFromSelection(afterState, "up"), {
    position: before.nodeSize,
    node: code
  });
  assert.equal(adjacentCodeBlockFromSelection(afterState, "down"), null);

  const gap = blockSchema.node("paragraph", null, [blockSchema.text("Gap")]);
  const separated = blockSchema.node("doc", null, [before, gap, code]);
  const separatedState = EditorState.create({
    doc: separated,
    selection: TextSelection.create(separated, before.nodeSize - 1)
  });
  assert.equal(adjacentCodeBlockFromSelection(separatedState, "down"), null);
});

test("vertical code entry targets physical fence lines and exact Shift selections", () => {
  const before = blockSchema.node("paragraph", null, [blockSchema.text("Before")]);
  const code = blockSchema.node("code_block", { language: "js" }, [blockSchema.text("one\ntwo")]);
  const after = blockSchema.node("paragraph", null, [blockSchema.text("After")]);
  const doc = blockSchema.node("doc", { markdownBlockGaps: null }, [before, code, after]);
  const serializer = (value) => {
    const blocks = [];
    value.forEach((node) => blocks.push(
      node.type.name === "code_block"
        ? `\`\`\`js\n${node.textContent}\n\`\`\``
        : node.textContent
    ));
    let exactGaps = null;
    try {
      exactGaps = JSON.parse(value.attrs.markdownBlockGaps);
    } catch {
      // A null annotation uses the serializer's ordinary root spacing.
    }
    if (Array.isArray(exactGaps) && exactGaps.length === blocks.length + 1) {
      return blocks.reduce(
        (source, block, index) => `${source}${block}${exactGaps[index + 1]}`,
        exactGaps[0]
      );
    }
    return `${blocks.join("\n\n")}\n`;
  };
  const codePosition = before.nodeSize;
  const target = { position: codePosition, node: code };
  const beforeState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, before.nodeSize - 1)
  });
  const downwardTarget = adjacentCodeSourceTarget(beforeState, target, "down", serializer);
  assert.equal(downwardTarget.sourceOffset, 5);
  const downwardSelection = adjacentCodeSourceSelection(
    beforeState,
    target,
    "down",
    serializer
  );
  assert.equal(sourceSelectionText(downwardSelection.sourceSelection), "\n\n\`\`\`js");

  const afterStart = codePosition + code.nodeSize + 1;
  const afterState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, afterStart)
  });
  const upwardTarget = adjacentCodeSourceTarget(afterState, target, "up", serializer);
  assert.equal(upwardTarget.sourceOffset, "```js\none\ntwo\n".length);
  const upwardSelection = adjacentCodeSourceSelection(afterState, target, "up", serializer);
  assert.equal(sourceSelectionText(upwardSelection.sourceSelection), "```\n\n");
});

test("serialized block gaps keep cross-block source selections exact without load metadata", () => {
  const before = blockSchema.node("paragraph", null, [blockSchema.text("Before")]);
  const code = blockSchema.node("code_block", { language: "js" }, [blockSchema.text("code")]);
  const doc = blockSchema.node("doc", { markdownBlockGaps: null }, [before, code]);
  const state = EditorState.create({ doc });
  const serializer = (value) => {
    const blocks = [];
    value.forEach((node) => {
      blocks.push(node.type.name === "code_block"
        ? `\`\`\`js\n${node.textContent}\n\`\`\``
        : node.textContent);
    });
    let exactGaps = null;
    try {
      exactGaps = JSON.parse(value.attrs.markdownBlockGaps);
    } catch {
      // Null metadata uses the serializer's ordinary root spacing below.
    }
    if (Array.isArray(exactGaps) && exactGaps.length === blocks.length + 1) {
      return blocks.reduce(
        (source, block, index) => `${source}${block}${exactGaps[index + 1]}`,
        exactGaps[0]
      );
    }
    return `${blocks.join("\n\n")}\n`;
  };

  assert.deepEqual(serializedDocumentGaps(state, serializer), ["", "\n\n", "\n"]);
  assert.equal(doc.resolve(before.nodeSize - 1).parentOffset, "Before".length);
  assert.equal(sourceCaretOffset(
    state,
    { from: 0, to: before.nodeSize, kind: "block", name: "paragraph" },
    "Before",
    before.nodeSize - 1,
    null,
    serializer
  ), "Before".length);
  const selection = TextSelection.create(
    doc,
    before.nodeSize - 1,
    before.nodeSize + 1 + 3
  );
  const exact = sourceSelectionFromDocumentSelection(state, serializer, selection);
  assert.equal(sourceSelectionText(exact), "\n\n```js\ncod");
});

test("undo matches an exact source edit before restoring its original selection", () => {
  const sourceSelection = {
    anchor: 8,
    head: 2,
    fullSource: "Before",
    boundary: 4,
    verticalColumn: 6
  };
  const history = [{
    beforeSource: "Before",
    afterSource: "B",
    sourceSelection
  }];
  assert.deepEqual(exactSourceSelectionAfterUndo(history, "B", "Before"), sourceSelection);
  assert.equal(exactSourceSelectionAfterUndo(history, "Else", "Before"), null);
  assert.equal(exactSourceSelectionAfterUndo(history, "B", "Different"), null);
  assert.equal(exactSourceSelectionAfterUndo(history, "Before", "Before"), null);
});

test("exact source history restores the original range on undo and the edited caret on redo", () => {
  const sourceSelection = {
    anchor: 2,
    head: 6,
    fullSource: "Before",
    boundary: 3
  };
  const afterSourceSelection = {
    anchor: 3,
    head: 3,
    fullSource: "BeX",
    boundary: 4
  };
  const history = [{
    beforeSource: "Before",
    afterSource: "BeX",
    sourceSelection,
    afterSourceSelection
  }];
  assert.deepEqual(
    exactSourceSelectionAfterHistory(history, "BeX", "Before"),
    sourceSelection
  );
  assert.deepEqual(
    exactSourceSelectionAfterHistory(history, "Before", "BeX"),
    afterSourceSelection
  );
  assert.equal(exactSourceSelectionAfterHistory(history, "Else", "BeX"), null);
  assert.equal(sourceEditCaretOffset(sourceSelection, "BeX"), 3);
});

test("activeMarkdownBlockSyntax leaves table cells visual even inside a blockquote", () => {
  const cell = blockSchema.node("table_cell", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Value")])
  ]);
  const doc = blockSchema.node("doc", null, [blockSchema.node("blockquote", null, [cell])]);
  const syntax = activeMarkdownBlockSyntax(EditorState.create({ doc, selection: textSelection(doc, "Value") }));
  assert.equal(syntax, null);
});

test("markdownTableSyntaxAt exposes a table only through the explicit table path", () => {
  const header = blockSchema.node("table_header", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Name")])
  ]);
  const cell = blockSchema.node("table_cell", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Tether")])
  ]);
  const table = blockSchema.node("table", null, [
    blockSchema.node("table_row", null, [header]),
    blockSchema.node("table_row", null, [cell])
  ]);
  const doc = blockSchema.node("doc", null, [table]);
  const cellTextPosition = 1 + table.firstChild.nodeSize + 2;

  assert.deepEqual(markdownTableSyntaxAt(docState(doc), cellTextPosition), {
    from: 0,
    to: table.nodeSize,
    kind: "block",
    name: "table"
  });
});

test("activeMarkdownAtomSyntax exposes selectable image, math, and rule source", () => {
  const image = blockSchema.node("image", { src: "image.png", alt: "Alt", title: "Title" });
  const imageDoc = blockSchema.node("doc", null, [blockSchema.node("paragraph", null, [image])]);
  const imageSyntax = activeMarkdownAtomSyntax(EditorState.create({
    doc: imageDoc,
    selection: NodeSelection.create(imageDoc, 1)
  }));
  assert.deepEqual(imageSyntax, { from: 1, to: 2, kind: "inline", name: "image" });

  const math = blockSchema.node("math_inline", { value: "E=mc^2" });
  const mathDoc = blockSchema.node("doc", null, [blockSchema.node("paragraph", null, [math])]);
  const mathSyntax = activeMarkdownAtomSyntax(EditorState.create({
    doc: mathDoc,
    selection: NodeSelection.create(mathDoc, 1)
  }));
  assert.deepEqual(mathSyntax, { from: 1, to: 2, kind: "inline", name: "math_inline" });
  assert.deepEqual(markdownAtomSyntaxAt(EditorState.create({ doc: mathDoc }), 1), {
    from: 1,
    to: 2,
    kind: "inline",
    name: "math_inline"
  });
  assert.equal(sourceAtomNearPosition(EditorState.create({ doc: imageDoc }), 2)?.name, "image");

  const ruleDoc = blockSchema.node("doc", null, [blockSchema.node("hr")]);
  const ruleSyntax = activeMarkdownAtomSyntax(EditorState.create({
    doc: ruleDoc,
    selection: NodeSelection.create(ruleDoc, 0)
  }));
  assert.deepEqual(ruleSyntax, { from: 0, to: 1, kind: "block", name: "hr" });
  assert.equal(sourceAtomNearPosition(EditorState.create({ doc: ruleDoc }), 1)?.name, "hr");

  const definition = blockSchema.node("link_definition", {
    definitionSource: "[docs]: https://example.com"
  });
  const definitionDoc = blockSchema.node("doc", null, [definition]);
  const definitionState = EditorState.create({
    doc: definitionDoc,
    selection: NodeSelection.create(definitionDoc, 0)
  });
  const definitionSyntax = activeMarkdownAtomSyntax(definitionState);
  assert.deepEqual(definitionSyntax, {
    from: 0,
    to: definition.nodeSize,
    kind: "block",
    name: "link_definition"
  });
  assert.equal(
    continuousMarkdownSource(definitionState, definitionSyntax, () => "[docs]: https://example.com\n"),
    "[docs]: https://example.com"
  );
});

test("source-aware clipboard preserves atoms, marks, block nodes, and Select All", () => {
  const image = blockSchema.node("image", { src: "image.png", alt: "Alt", title: "Title" });
  const imageDoc = blockSchema.node("doc", null, [blockSchema.node("paragraph", null, [image])]);
  assert.equal(sourceAwareClipboardText(EditorState.create({
    doc: imageDoc,
    selection: NodeSelection.create(imageDoc, 1)
  }), () => '![Alt](image.png "Title")\n'), '![Alt](image.png "Title")');

  const strong = blockSchema.marks.strong.create();
  const markedDoc = blockSchema.node("doc", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Bold", [strong])])
  ]);
  assert.equal(sourceAwareClipboardText(EditorState.create({
    doc: markedDoc,
    selection: TextSelection.create(markedDoc, 1, 5)
  }), () => "**Bold**\n"), "Bold");
  assert.equal(sourceAwareClipboardText(EditorState.create({
    doc: markedDoc,
    selection: TextSelection.create(markedDoc, 2, 4)
  }), () => "**Bold**\n"), "ol");

  const plainDoc = blockSchema.node("doc", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Plain")])
  ]);
  assert.equal(sourceAwareClipboardText(EditorState.create({
    doc: plainDoc,
    selection: TextSelection.create(plainDoc, 1, 6)
  }), () => "Plain\n"), null);

  const ruleDoc = blockSchema.node("doc", null, [blockSchema.node("hr")]);
  assert.equal(sourceAwareClipboardText(EditorState.create({
    doc: ruleDoc,
    selection: NodeSelection.create(ruleDoc, 0)
  }), () => "---\n"), "---");
  assert.equal(sourceAwareClipboardText(EditorState.create({
    doc: markedDoc,
    selection: new AllSelection(markedDoc)
  }), () => "**Bold**\n"), "**Bold**\n");
});

test("Backspace at a rendered math boundary targets its Markdown source", () => {
  const math = blockSchema.node("math_inline", { value: "E=mc^2" });
  const paragraph = blockSchema.node("paragraph", null, [
    blockSchema.text("Before "),
    math,
    blockSchema.text(" after")
  ]);
  const doc = blockSchema.node("doc", null, [paragraph]);
  const mathPosition = 1 + "Before ".length;
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, mathPosition + math.nodeSize)
  });

  const target = markdownDeletionTarget(state, "backward");
  assert.deepEqual(target, {
    position: mathPosition,
    atomPosition: mathPosition,
    explicitUnitPosition: null,
    edge: "end"
  });
  assert.deepEqual(markdownDeletionSourceUnit(state, target), {
    from: mathPosition,
    to: mathPosition + math.nodeSize,
    kind: "inline",
    name: "math_inline"
  });
  const beforeState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, mathPosition)
  });
  assert.deepEqual(markdownBoundarySourceTarget(beforeState, "forward"), {
    position: mathPosition,
    atomPosition: mathPosition,
    explicitUnitPosition: null,
    edge: "start"
  });
});

test("hard-break navigation exposes only its hidden marker source", () => {
  const hardbreak = blockSchema.node("hardbreak", {
    isInline: false,
    markdownMarker: "  "
  });
  const paragraph = blockSchema.node("paragraph", null, [
    blockSchema.text("alpha"),
    hardbreak,
    blockSchema.text("beta")
  ]);
  const doc = blockSchema.node("doc", null, [paragraph]);
  const state = EditorState.create({ doc });
  const position = 1 + "alpha".length;
  const unit = markdownAtomSyntaxAt(state, position);

  assert.deepEqual(unit, {
    from: position,
    to: position + hardbreak.nodeSize,
    kind: "inline",
    name: "hardbreak"
  });
  assert.equal(continuousMarkdownSource(state, unit, () => "ignored"), "  ");
  assert.deepEqual(markdownBoundarySourceTarget(EditorState.create({
    doc,
    selection: TextSelection.create(doc, position)
  }), "forward"), {
    position,
    atomPosition: position,
    explicitUnitPosition: null,
    edge: "start"
  });

  const softbreak = blockSchema.node("hardbreak", {
    isInline: true,
    markdownMarker: null
  });
  const softDoc = blockSchema.node("doc", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("a"), softbreak, blockSchema.text("b")])
  ]);
  assert.equal(markdownAtomSyntaxAt(EditorState.create({ doc: softDoc }), 2), null);
});

test("Backspace after a hard break deletes only the source newline", () => {
  for (const marker of ["\\", "  ", "   "]) {
    const hardbreak = blockSchema.node("hardbreak", {
      isInline: false,
      markdownMarker: marker
    });
    const paragraph = blockSchema.node("paragraph", null, [
      blockSchema.text("alpha"),
      hardbreak,
      blockSchema.text("beta")
    ]);
    const doc = blockSchema.node("doc", null, [paragraph]);
    const afterBreak = 1 + "alpha".length + hardbreak.nodeSize;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, afterBreak)
    });
    const transaction = hardbreakBoundaryBackspaceTransaction(state);
    assert.equal(transaction?.doc.firstChild.textContent, `alpha${marker}beta`);
    assert.equal(transaction?.selection.from, 1 + "alpha".length + marker.length);
  }
});

test("editing a hard-break marker preserves the source newline semantics", () => {
  const node = blockSchema.node("hardbreak", {
    isInline: false,
    markdownMarker: "  "
  });

  const reduced = hardbreakSourceReplacement(blockSchema, node, " ");
  assert.equal(reduced.childCount, 2);
  assert.equal(reduced.firstChild.text, " ");
  assert.equal(reduced.lastChild.type.name, "hardbreak");
  assert.equal(reduced.lastChild.attrs.isInline, true);
  assert.equal(reduced.lastChild.attrs.markdownMarker, null);

  const removed = hardbreakSourceReplacement(blockSchema, node, "");
  assert.equal(removed.childCount, 1);
  assert.equal(removed.firstChild.attrs.isInline, true);

  const changed = hardbreakSourceReplacement(blockSchema, node, "\\");
  assert.equal(changed.childCount, 1);
  assert.equal(changed.firstChild.attrs.isInline, false);
  assert.equal(changed.firstChild.attrs.markdownMarker, "\\");
});

test("structural block boundaries keep native rendered editing", () => {
  const heading = blockSchema.node("heading", { level: 2 }, [blockSchema.text("Heading")]);
  const doc = blockSchema.node("doc", null, [heading]);
  const state = EditorState.create({
    doc,
    selection: NodeSelection.create(doc, 0)
  });

  assert.equal(markdownDeletionTarget(state, "backward"), null);
});

test("inline source arrows hand off only at an unmodified collapsed boundary", () => {
  assert.equal(inlineSourceBoundaryDirection("ArrowLeft", 0, 0, 8), "backward");
  assert.equal(inlineSourceBoundaryDirection("ArrowRight", 8, 8, 8), "forward");
  assert.equal(inlineSourceBoundaryDirection("ArrowLeft", 1, 1, 8), null);
  assert.equal(inlineSourceBoundaryDirection("ArrowRight", 7, 7, 8), null);
  assert.equal(inlineSourceBoundaryDirection("ArrowLeft", 0, 2, 8), null);
  assert.equal(inlineSourceBoundaryDirection("ArrowRight", 8, 8, 8, true), null);
});

test("inline and block source deletion hands off only beyond outer delimiters", () => {
  assert.equal(inlineSourceBoundaryDeleteDirection("Backspace", 0, 0, 8), "backward");
  assert.equal(inlineSourceBoundaryDeleteDirection("Delete", 8, 8, 8), "forward");
  assert.equal(inlineSourceBoundaryDeleteDirection("Backspace", 1, 1, 8), null);
  assert.equal(inlineSourceBoundaryDeleteDirection("Delete", 7, 7, 8), null);
  assert.equal(inlineSourceBoundaryDeleteDirection("Backspace", 0, 2, 8), null);
  assert.equal(inlineSourceBoundaryDeleteDirection("Delete", 8, 8, 8, true), null);
});

test("inline source vertical arrows always return a collapsed caret to the document", () => {
  assert.equal(inlineSourceVerticalDirection("ArrowUp", 3, 3), "up");
  assert.equal(inlineSourceVerticalDirection("ArrowDown", 3, 3), "down");
  assert.equal(inlineSourceVerticalDirection("ArrowLeft", 3, 3), null);
  assert.equal(inlineSourceVerticalDirection("ArrowUp", 1, 4), null);
  assert.equal(inlineSourceVerticalDirection("ArrowDown", 3, 3, true), null);
});

test("block source vertical arrows hand off only from the outer source lines", () => {
  const source = "$$\nformula\n$$";
  assert.equal(blockSourceVerticalDirection("ArrowUp", 1, 1, source), "up");
  assert.equal(blockSourceVerticalDirection("ArrowUp", 4, 4, source), null);
  assert.equal(blockSourceVerticalDirection("ArrowDown", 10, 10, source), null);
  assert.equal(blockSourceVerticalDirection("ArrowDown", source.length, source.length, source), "down");
  assert.equal(blockSourceVerticalDirection("ArrowLeft", 0, 0, source), null);
  assert.equal(blockSourceVerticalDirection("ArrowDown", source.length, source.length, source, true), null);
});

test("inline and block source shift-arrows extend selection across an outer boundary", () => {
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowLeft", 0, 0, 8, true), "backward");
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowRight", 8, 8, 8, true), "forward");
  const multilineSource = "| A |\n| - |\n| B |";
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowLeft", 0, 0, multilineSource.length, true), "backward");
  assert.equal(
    inlineSourceBoundarySelectionDirection(
      "ArrowRight",
      multilineSource.length,
      multilineSource.length,
      multilineSource.length,
      true
    ),
    "forward"
  );
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowLeft", 1, 1, 8, true), null);
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowRight", 7, 7, 8, true), null);
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowLeft", 0, 2, 8, true), null);
  assert.equal(
    inlineSourceBoundarySelectionDirection("ArrowLeft", 0, 2, 8, true, false, "backward"),
    "backward"
  );
  assert.equal(
    inlineSourceBoundarySelectionDirection("ArrowRight", 2, 8, 8, true, false, "forward"),
    "forward"
  );
  assert.equal(
    inlineSourceBoundarySelectionDirection("ArrowLeft", 0, 2, 8, true, false, "forward"),
    null
  );
  assert.equal(
    inlineSourceBoundarySelectionDirection("ArrowRight", 2, 8, 8, true, false, "backward"),
    null
  );
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowRight", 8, 8, 8, false), null);
  assert.equal(inlineSourceBoundarySelectionDirection("ArrowRight", 8, 8, 8, true, true), null);
});

test("multiline source shift-arrows hand off from the moving head on an outer line", () => {
  const source = "| A |\n| - |\n| B |";
  assert.equal(blockSourceBoundarySelectionDirection("ArrowUp", 2, 2, source, true), "up");
  assert.equal(
    blockSourceBoundarySelectionDirection("ArrowUp", 1, 7, source, true, false, "backward"),
    "up"
  );
  assert.equal(
    blockSourceBoundarySelectionDirection("ArrowUp", 1, 7, source, true, false, "forward"),
    null
  );
  assert.equal(
    blockSourceBoundarySelectionDirection(
      "ArrowDown",
      7,
      source.length,
      source,
      true,
      false,
      "forward"
    ),
    "down"
  );
  assert.equal(
    blockSourceBoundarySelectionDirection(
      "ArrowDown",
      7,
      source.length,
      source,
      true,
      false,
      "backward"
    ),
    null
  );
  assert.equal(blockSourceBoundarySelectionDirection("ArrowUp", 2, 2, source, false), null);
  assert.equal(blockSourceBoundarySelectionDirection("ArrowDown", 2, 2, source, true, true), null);
});

test("source controls preserve the selection anchor while crossing their outer boundary", () => {
  assert.deepEqual(sourceInputSelection(0, 4, "backward"), { anchor: 4, head: 0 });
  assert.deepEqual(sourceInputSelection(2, 8, "forward"), { anchor: 2, head: 8 });
  assert.deepEqual(sourceInputSelection(3, 3, "none"), { anchor: 3, head: 3 });

  const source = "before **bold**\r\nafter";
  const unitStart = source.indexOf("**bold**");
  assert.deepEqual(
    sourceSelectionAcrossUnitBoundary(
      source,
      unitStart,
      { anchor: 4, head: 0 },
      "backward"
    ),
    {
      anchor: unitStart + 4,
      head: unitStart - 1,
      fullSource: source,
      verticalColumn: null
    }
  );
  assert.deepEqual(
    sourceSelectionAcrossUnitBoundary(
      source,
      unitStart,
      { anchor: 2, head: "**bold**".length },
      "forward"
    ),
    {
      anchor: unitStart + 2,
      head: unitStart + "**bold**".length + 2,
      fullSource: source,
      verticalColumn: null
    }
  );

  const emoji = "a😀b";
  assert.equal(
    sourceSelectionAcrossUnitBoundary(emoji, 0, { anchor: 0, head: 1 }, "forward").head,
    3
  );

  const multiline = "above\r\n$$\r\nformula\r\n$$\r\nbelow";
  const blockStart = multiline.indexOf("$$");
  const blockSource = "$$\r\nformula\r\n$$";
  assert.deepEqual(
    sourceSelectionAcrossUnitBoundary(
      multiline,
      blockStart,
      { anchor: blockSource.length, head: 1 },
      "up"
    ),
    {
      anchor: blockStart + blockSource.length,
      head: 1,
      fullSource: multiline,
      verticalColumn: 1
    }
  );
  assert.deepEqual(
    sourceSelectionAcrossUnitBoundary(
      multiline,
      blockStart,
      { anchor: 0, head: blockSource.length - 1 },
      "down"
    ),
    {
      anchor: blockStart,
      head: multiline.length - "below".length + 1,
      fullSource: multiline,
      verticalColumn: 1
    }
  );
});

test("source controls hand Option-word jumps across an outer boundary", () => {
  assert.equal(
    sourceInputWordJumpDirection("ArrowLeft", 0, 0, 8, false, true),
    "backward"
  );
  assert.equal(
    sourceInputWordJumpDirection("ArrowRight", 8, 8, 8, false, true),
    "forward"
  );
  assert.equal(
    sourceInputWordJumpDirection("ArrowLeft", 0, 4, 8, true, true, false, "backward"),
    "backward"
  );
  assert.equal(
    sourceInputWordJumpDirection("ArrowRight", 4, 8, 8, true, true, false, "forward"),
    "forward"
  );
  assert.equal(
    sourceInputWordJumpDirection("ArrowLeft", 0, 4, 8, false, true, false, "backward"),
    null
  );
  assert.equal(sourceInputWordJumpDirection("ArrowLeft", 1, 1, 8, false, true), null);
  assert.equal(sourceInputWordJumpDirection("ArrowLeft", 0, 0, 8, false, false), null);
  assert.equal(sourceInputWordJumpDirection("ArrowLeft", 0, 0, 8, false, true, true), null);

  const fullSource = "before **bold** after";
  const unitStart = fullSource.indexOf("**bold**");
  assert.deepEqual(
    sourceWordSelectionAcrossUnitBoundary(
      fullSource,
      unitStart,
      { anchor: 4, head: 0 },
      "backward",
      true
    ),
    {
      anchor: unitStart + 4,
      head: 0,
      fullSource,
      verticalColumn: null
    }
  );
  assert.deepEqual(
    sourceWordSelectionAcrossUnitBoundary(
      fullSource,
      unitStart,
      { anchor: 8, head: 8 },
      "forward"
    ),
    {
      anchor: fullSource.length,
      head: fullSource.length,
      fullSource,
      verticalColumn: null
    }
  );
});

test("physical source offsets map back to rendered text but not hidden delimiters", () => {
  const strong = blockSchema.marks.strong.create();
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("paragraph", null, [
      blockSchema.text("Bold", [strong]),
      blockSchema.text(" after")
    ])
  ]);
  const serialize = (partialDoc) => {
    let source = "";
    partialDoc.firstChild?.forEach((node) => {
      source += node.marks.some((mark) => mark.type.name === "strong")
        ? `**${node.text}**`
        : node.text;
    });
    return source;
  };
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
  const source = serialize(doc);
  assert.equal(documentPositionAtSourceOffset(state, source.length, serialize), 1 + "Bold after".length);
  assert.equal(documentPositionAtSourceOffset(state, source.indexOf("after"), serialize), 1 + "Bold ".length);
  assert.equal(documentPositionAtSourceOffset(state, 0, serialize), null);
  assert.equal(documentPositionAtSourceOffset(state, 1, serialize), null);
});

test("fenced source selection crosses hidden newlines and fence lines in source coordinates", () => {
  const source = "```js\nalpha\n```";
  const contentStart = "```js\n".length;
  const contentEnd = contentStart + "alpha".length;

  assert.deepEqual(sourceInitialSelectionRange(source, contentStart, "backward"), {
    start: contentStart - 1,
    end: contentStart,
    direction: "backward"
  });
  assert.deepEqual(sourceInitialSelectionRange(source, contentEnd, "forward"), {
    start: contentEnd,
    end: contentEnd + 1,
    direction: "forward"
  });
  assert.deepEqual(sourceInitialSelectionRange(source, contentStart + 2, "up"), {
    start: 2,
    end: contentStart + 2,
    direction: "backward"
  });
  assert.deepEqual(sourceInitialSelectionRange(source, contentEnd, "down"), {
    start: contentEnd,
    end: source.length,
    direction: "forward"
  });

  const crlfSource = "```js\r\nlong-column\r\n```";
  const crlfContentStart = crlfSource.indexOf("long-column");
  const crlfClosingStart = crlfSource.lastIndexOf("\n") + 1;
  assert.deepEqual(sourceInitialSelectionRange(crlfSource, crlfContentStart + 10, "up"), {
    start: 5,
    end: crlfContentStart + 10,
    direction: "backward"
  });
  assert.deepEqual(sourceInitialSelectionRange(crlfSource, crlfContentStart + 10, "down"), {
    start: crlfContentStart + 10,
    end: crlfClosingStart + 3,
    direction: "forward"
  });
});

test("line-jump shortcuts distinguish physical line edges from word and document jumps", () => {
  assert.equal(sourceLineJumpEdge({ key: "Home" }), "start");
  assert.equal(sourceLineJumpEdge({ key: "End", shiftKey: true }), "end");
  assert.equal(sourceLineJumpEdge({ key: "ArrowLeft", metaKey: true }), "start");
  assert.equal(sourceLineJumpEdge({ key: "ArrowRight", metaKey: true, shiftKey: true }), "end");
  assert.equal(sourceLineJumpEdge({ key: "ArrowLeft", ctrlKey: true }), null);
  assert.equal(sourceLineJumpEdge({ key: "Home", metaKey: true }), null);
  assert.equal(sourceLineJumpEdge({ key: "Home", altKey: true }), null);
});

test("exact source selections own physical line and word jumps across CRLF gaps", () => {
  const fullSource = "First\r\n\r\n**bold** tail";
  const gapCaret = fullSource.indexOf("\r\n", fullSource.indexOf("\r\n") + 2);
  const sourceSelection = {
    anchor: gapCaret,
    head: gapCaret,
    fullSource,
    boundary: 7
  };

  assert.deepEqual(sourceSelectionLineJump(sourceSelection, "start"), {
    ...sourceSelection,
    verticalColumn: null
  });
  assert.deepEqual(sourceSelectionLineJump(sourceSelection, "end"), {
    ...sourceSelection,
    verticalColumn: null
  });

  const nextLineCaret = fullSource.indexOf("**bold**");
  const nextLineSelection = {
    ...sourceSelection,
    anchor: nextLineCaret + 4,
    head: nextLineCaret + 4
  };
  assert.deepEqual(sourceSelectionLineJump(nextLineSelection, "start"), {
    ...nextLineSelection,
    anchor: nextLineCaret,
    head: nextLineCaret,
    verticalColumn: null
  });
  assert.deepEqual(sourceSelectionLineJump(nextLineSelection, "end", true), {
    ...nextLineSelection,
    head: fullSource.length,
    verticalColumn: null
  });

  const afterFirst = "First".length;
  const wordStart = sourceWordOffset(fullSource, afterFirst, "forward");
  assert.equal(wordStart, nextLineCaret + 2);
  assert.deepEqual(sourceSelectionWordJump({
    ...sourceSelection,
    anchor: afterFirst,
    head: afterFirst
  }, "forward"), {
    ...sourceSelection,
    anchor: wordStart,
    head: wordStart,
    verticalColumn: null
  });
  assert.deepEqual(sourceSelectionWordJump({
    ...sourceSelection,
    anchor: afterFirst,
    head: wordStart
  }, "backward"), {
    ...sourceSelection,
    anchor: afterFirst,
    head: afterFirst,
    verticalColumn: null
  });
  assert.deepEqual(sourceSelectionWordJump({
    ...sourceSelection,
    anchor: afterFirst,
    head: wordStart
  }, "forward", true), {
    ...sourceSelection,
    anchor: afterFirst,
    head: nextLineCaret + "**bold".length,
    verticalColumn: null
  });
});

test("exact source selections indent physical lines without losing direction", () => {
  const fullSource = "one\r\ntwo\r\nthree";
  const forward = {
    anchor: 1,
    head: fullSource.indexOf("three"),
    fullSource,
    boundary: 4
  };
  assert.deepEqual(sourceSelectionTabEdit(forward), {
    ...forward,
    anchor: 2,
    head: fullSource.indexOf("three") + 2,
    fullSource: "\tone\r\n\ttwo\r\nthree",
    verticalColumn: null
  });

  const backward = { ...forward, anchor: forward.head, head: forward.anchor };
  assert.deepEqual(sourceSelectionTabEdit(backward), {
    ...backward,
    anchor: fullSource.indexOf("three") + 2,
    head: 2,
    fullSource: "\tone\r\n\ttwo\r\nthree",
    verticalColumn: null
  });

  const gapSource = "one\r\n\r\nthree";
  const blankLine = gapSource.indexOf("\r\n") + 2;
  assert.deepEqual(sourceSelectionTabEdit({
    ...forward,
    anchor: blankLine,
    head: blankLine,
    fullSource: gapSource
  }), {
    ...forward,
    anchor: blankLine + 1,
    head: blankLine + 1,
    fullSource: "one\r\n\t\r\nthree",
    verticalColumn: null
  });

  assert.deepEqual(sourceSelectionTabEdit({
    ...forward,
    anchor: 2,
    head: 2,
    fullSource: "\tone"
  }, true), {
    ...forward,
    anchor: 1,
    head: 1,
    fullSource: "one",
    verticalColumn: null
  });
});

test("document-jump shortcuts cover native macOS and Windows key combinations", () => {
  assert.equal(sourceDocumentJumpEdge({ key: "ArrowUp", metaKey: true }), "start");
  assert.equal(sourceDocumentJumpEdge({ key: "ArrowDown", metaKey: true, shiftKey: true }), "end");
  assert.equal(sourceDocumentJumpEdge({ key: "Home", ctrlKey: true }), "start");
  assert.equal(sourceDocumentJumpEdge({ key: "End", ctrlKey: true, shiftKey: true }), "end");
  assert.equal(sourceDocumentJumpEdge({ key: "Home", metaKey: true }), "start");
  assert.equal(sourceDocumentJumpEdge({ key: "End", metaKey: true }), "end");
  assert.equal(sourceDocumentJumpEdge({ key: "ArrowUp", ctrlKey: true }), null);
  assert.equal(sourceDocumentJumpEdge({ key: "ArrowUp", metaKey: true, altKey: true }), null);
  assert.equal(sourceDocumentJumpEdge({ key: "Home" }), null);
});

test("word-wise source movement traverses Markdown punctuation and whitespace groups", () => {
  const source = "```js\nasync value\n```";
  const contentStart = source.indexOf("async");
  const contentEnd = source.indexOf("\n```", contentStart);
  assert.equal(sourceWordOffset(source, contentStart, "backward"), source.indexOf("js"));
  assert.equal(sourceWordOffset(source, contentEnd, "forward"), source.length);
  assert.equal(sourceWordOffset("**bold**", 0, "forward"), 2);
  assert.equal(sourceWordOffset("**bold**", 8, "backward"), 6);
  assert.deepEqual(sourceWordSelectionRange(8, 6), {
    start: 6,
    end: 8,
    direction: "backward"
  });
});

test("an existing code selection keeps its source anchor while crossing fence lines", () => {
  const source = "```js\r\nfirst\r\n```";
  const anchor = source.indexOf("first") + 2;
  const head = source.indexOf("\r\n", anchor);
  assert.deepEqual(sourceSelectionRangeAfterMotion(source, anchor, head, "forward"), {
    start: anchor,
    end: head + 2,
    direction: "forward"
  });
  assert.deepEqual(sourceSelectionRangeAfterMotion(source, anchor, head, "down"), {
    start: anchor,
    end: source.length,
    direction: "forward"
  });

  const reverseAnchor = source.indexOf("first") + 3;
  const reverseHead = source.indexOf("first");
  assert.deepEqual(sourceSelectionRangeAfterMotion(
    source,
    reverseAnchor,
    reverseHead,
    "up"
  ), {
    start: 0,
    end: reverseAnchor,
    direction: "backward"
  });
});

test("word jumps enter the exact hidden delimiter beside rendered inline text", () => {
  const strong = blockSchema.marks.strong.create();
  const before = "Before ";
  const marked = "Bold";
  const doc = blockSchema.node("doc", null, [
    blockSchema.node("paragraph", null, [
      blockSchema.text(before),
      blockSchema.text(marked, [strong]),
      blockSchema.text(" after")
    ])
  ]);
  const serialize = (partialDoc) => {
    let result = "";
    partialDoc.firstChild.forEach((node) => {
      result += node.marks.some((mark) => mark.type.name === "strong")
        ? `**${node.text}**`
        : node.text;
    });
    return result;
  };
  const start = 1 + before.length;
  const end = start + marked.length;
  const forwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, start)
  });
  const backwardState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, end)
  });
  const forward = sourceWordJumpTarget(
    forwardState,
    { key: "ArrowRight", altKey: true },
    serialize
  );
  const backward = sourceWordJumpTarget(
    backwardState,
    { key: "ArrowLeft", altKey: true, shiftKey: true },
    serialize
  );
  assert.equal(forward.source, "**Bold**");
  assert.equal(forward.currentOffset, 0);
  assert.equal(forward.targetOffset, 2);
  assert.equal(backward.currentOffset, "**Bold**".length);
  assert.equal(backward.targetOffset, "**Bold".length);
  assert.equal(sourceWordJumpTarget(
    forwardState,
    { key: "ArrowRight", ctrlKey: true },
    serialize
  ), null);
});

test("multi-click source activation selects the physical word or line", () => {
  assert.deepEqual(sourcePointerSelectionRange("**bold text**", 6, 2), {
    start: 2,
    end: 6,
    direction: "forward"
  });
  assert.deepEqual(sourcePointerSelectionRange("**bold text**", 8, 2), {
    start: 7,
    end: 11,
    direction: "forward"
  });
  assert.deepEqual(sourcePointerSelectionRange("**bold**", 0, 2), {
    start: 0,
    end: 2,
    direction: "forward"
  });
  assert.deepEqual(sourcePointerSelectionRange("one\ntwo\nthree", 6, 3), {
    start: 4,
    end: 8,
    direction: "forward"
  });
  assert.equal(sourcePointerSelectionRange("word", 2, 1), null);
});

test("source line selections include hidden prefixes and suffixes with CRLF", () => {
  const source = "- one\r\n- two\r\n";
  const caret = source.indexOf("two") + 2;
  assert.deepEqual(sourceInitialSelectionRange(source, caret, "line-start"), {
    start: source.indexOf("- two"),
    end: caret,
    direction: "backward"
  });
  assert.deepEqual(sourceInitialSelectionRange(source, caret, "line-end"), {
    start: caret,
    end: source.indexOf("two") + "two".length,
    direction: "forward"
  });
});

test("source boundary selections keep CRLF and Unicode code points indivisible", () => {
  const crlf = "~~~\r\n~~~";
  const contentStart = crlf.indexOf("\n") + 1;
  assert.deepEqual(sourceInitialSelectionRange(crlf, contentStart, "backward"), {
    start: contentStart - 2,
    end: contentStart,
    direction: "backward"
  });
  assert.deepEqual(sourceInitialSelectionRange("a😀b", 1, "forward"), {
    start: 1,
    end: 3,
    direction: "forward"
  });
  assert.deepEqual(sourceInitialSelectionRange("a😀b", 3, "backward"), {
    start: 1,
    end: 3,
    direction: "backward"
  });
});

test("source editing uses native-like grapheme boundaries for deletion and pointer carets", () => {
  const source = "A👨‍👩‍👧‍👦e\u0301\r\nB";
  const afterFamily = source.indexOf("e");
  const afterAccent = source.indexOf("\r");
  const afterCrlf = source.indexOf("\n") + 1;
  assert.deepEqual(sourceCaretBoundaries(source), [
    0,
    1,
    afterFamily,
    afterAccent,
    afterCrlf,
    source.length
  ]);
  assert.deepEqual(sourceCharacterDeletionRange(source, afterFamily, "backward"), {
    from: 1,
    to: afterFamily
  });
  assert.deepEqual(sourceCharacterDeletionRange(source, 1, "forward"), {
    from: 1,
    to: afterFamily
  });
  assert.deepEqual(sourceCharacterDeletionRange(source, afterCrlf, "backward"), {
    from: afterAccent,
    to: afterCrlf
  });
  assert.deepEqual(sourceCharacterDeletionRange(source, afterFamily, "forward"), {
    from: afterFamily,
    to: afterAccent
  });
  assert.equal(sourceWordOffset("e\u0301", "e\u0301".length, "backward"), 0);
  assert.equal(sourceWordOffset("e\u0301", 0, "forward"), "e\u0301".length);
  assert.equal(sourceWordOffset(source, 1, "forward"), afterFamily);
  assert.equal(sourceWordOffset(source, afterFamily, "backward"), 1);
  assert.deepEqual(sourcePointerSelectionRange("e\u0301 value", 1, 2), {
    start: 0,
    end: 2,
    direction: "forward"
  });
  assert.deepEqual(sourcePointerSelectionRange("👨‍👩‍👧‍👦", 4, 2), {
    start: 0,
    end: "👨‍👩‍👧‍👦".length,
    direction: "forward"
  });
});

test("source selections move vertically by physical source lines and preserve columns", () => {
  const source = "ab\r\n12345\r\nz";
  const secondLineColumn = source.indexOf("12345") + 3;
  assert.equal(sourceVerticalOffset(source, secondLineColumn, "up"), 2);
  assert.equal(sourceVerticalOffset(source, secondLineColumn, "down"), source.length);

  const selection = {
    anchor: source.indexOf("12345"),
    head: secondLineColumn,
    fullSource: source,
    boundary: 4
  };
  const movedUp = moveSourceSelectionHead(selection, "up");
  assert.equal(movedUp.head, 2);
  assert.equal(movedUp.verticalColumn, 3);
  assert.equal(moveSourceSelectionHead(movedUp, "down").head, secondLineColumn);
  assert.equal(moveSourceSelectionHead(selection, "down").head, source.length);
  const movedBackward = moveSourceSelectionHead(selection, "backward");
  assert.equal(movedBackward.head, secondLineColumn - 1);
  assert.equal(movedBackward.verticalColumn, null);
});

test("block source Tab inserts at a collapsed caret and indents selected physical lines", () => {
  assert.deepEqual(sourceTabEdit("alpha", 2, 2), {
    value: "al\tpha",
    selectionStart: 3,
    selectionEnd: 3
  });

  assert.deepEqual(sourceTabEdit("one\ntwo\nthree", 1, 8), {
    value: "\tone\n\ttwo\nthree",
    selectionStart: 2,
    selectionEnd: 10
  });
  assert.deepEqual(sourceTabEdit("one\ntwo\nthree", 0, 8), {
    value: "\tone\n\ttwo\nthree",
    selectionStart: 1,
    selectionEnd: 10
  });
});

test("block source Shift-Tab outdents tabs or one four-space indentation unit", () => {
  assert.deepEqual(sourceTabEdit("\talpha", 4, 4, true), {
    value: "alpha",
    selectionStart: 3,
    selectionEnd: 3
  });
  assert.deepEqual(sourceTabEdit("    one\n  two\nthree", 4, 15, true), {
    value: "one\ntwo\nthree",
    selectionStart: 0,
    selectionEnd: 9
  });
  assert.deepEqual(sourceTabEdit("alpha", 2, 2, true), {
    value: "alpha",
    selectionStart: 2,
    selectionEnd: 2
  });
});

test("continuous source controls are reserved for inline, atomic, and explicit source units", () => {
  const heading = { from: 0, to: 5, kind: "block", name: "heading" };
  const code = { from: 0, to: 5, kind: "block", name: "code_block" };
  const rule = { from: 0, to: 1, kind: "block", name: "hr" };
  const inline = { from: 1, to: 4, kind: "inline", names: ["strong"] };
  const table = { from: 0, to: 10, kind: "block", name: "table" };

  assert.equal(usesContinuousSourceEditor(heading), false);
  assert.equal(usesContinuousSourceEditor(heading, heading), true);
  assert.equal(usesContinuousSourceEditor(code), false);
  assert.equal(usesContinuousSourceEditor(rule), true);
  assert.equal(usesContinuousSourceEditor(inline), true);
  assert.equal(usesContinuousSourceEditor(table, table), true);
});

test("inline source offsets map through delimiters and syntax-only regions", () => {
  const inlineParser = (source) => {
    const code = source.match(/^`([\s\S]*)`$/);
    const link = source.match(/^\[([^\]]+)\]\(([^)]*)\)$/);
    const text = code?.[1] ?? link?.[1] ?? source;
    return schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]);
  };

  assert.equal(inlineSourceContentOffset("`marked`", 0, inlineParser), 0);
  assert.equal(inlineSourceContentOffset("`marked`", 4, inlineParser), 3);
  assert.equal(inlineSourceContentOffset("`marked`", 8, inlineParser), 6);
  assert.equal(inlineSourceContentOffset("[docs](https://example.com)", 15, inlineParser), 4);
});

test("source controls leave IME composition keystrokes entirely native", () => {
  assert.equal(isSourceInputComposing({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isSourceInputComposing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isSourceInputComposing({ isComposing: false, keyCode: 13 }), false);
});

test("explicit block source activation targets a fenced node without broadening native code editing", () => {
  const code = blockSchema.node("code_block", { language: "math" }, [blockSchema.text("x^2")]);
  const doc = blockSchema.node("doc", null, [code]);
  let transaction = null;
  const view = {
    state: docState(doc),
    dispatch(nextTransaction) {
      transaction = nextTransaction;
    },
    focus() {}
  };

  assert.equal(activateMarkdownBlockSourceAt(view, 2), true);
  assert.equal(transaction?.selection.from, 2);
});
