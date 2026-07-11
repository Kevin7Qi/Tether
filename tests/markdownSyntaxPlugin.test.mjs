import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import {
  activeMarkdownAtomSyntax,
  activeMarkdownBlockSyntax,
  activeMarkdownSyntax,
  enclosingCodeBlock,
  markdownAtomSyntaxAt,
  mappedPosition,
  sourceCaretOffset
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

test("activeMarkdownSyntax treats nested bold and italic as one source range", () => {
  const syntax = activeMarkdownSyntax(stateWithMarks(["strong", "emphasis"]));
  assert.deepEqual(syntax.names, ["strong", "emphasis"]);
  assert.equal(syntax.to - syntax.from, "marked".length);
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
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: {
      content: "inline*",
      group: "block",
      attrs: { level: { default: 1 } }
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
    list_item: {
      content: "paragraph+",
      attrs: {
        checked: { default: null },
        listType: { default: "bullet" },
        label: { default: "•" }
      }
    },
    table_cell: { content: "paragraph+", group: "block" },
    hr: { group: "block", atom: true },
    image: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { src: { default: "" }, alt: { default: "" }, title: { default: "" } }
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
  assert.equal(sourceCaretOffset(state, unit, `\`\`\`js\n${code}\n\`\`\``, 1 + 6, null, serializer), 12);
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

test("activeMarkdownBlockSyntax leaves table cells visual even inside a blockquote", () => {
  const cell = blockSchema.node("table_cell", null, [
    blockSchema.node("paragraph", null, [blockSchema.text("Value")])
  ]);
  const doc = blockSchema.node("doc", null, [blockSchema.node("blockquote", null, [cell])]);
  const syntax = activeMarkdownBlockSyntax(EditorState.create({ doc, selection: textSelection(doc, "Value") }));
  assert.equal(syntax, null);
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

  const ruleDoc = blockSchema.node("doc", null, [blockSchema.node("hr")]);
  const ruleSyntax = activeMarkdownAtomSyntax(EditorState.create({
    doc: ruleDoc,
    selection: NodeSelection.create(ruleDoc, 0)
  }));
  assert.deepEqual(ruleSyntax, { from: 0, to: 1, kind: "block", name: "hr" });
});
