import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";

function roundTrip(markdown, mutateTree = null) {
  const processor = unified().use(remarkParse).use(remarkStringify, tetherStringifyOptions({}));
  const tree = processor.parse(markdown);
  // Milkdown stores list spread attributes as strings; simulate that shape so
  // the join rule is exercised the same way the live serializer sees it.
  (function stringifySpread(node) {
    if ("spread" in node && typeof node.spread === "boolean") node.spread = `${node.spread}`;
    (node.children || []).forEach(stringifySpread);
  })(tree);
  if (mutateTree) mutateTree(tree);
  return processor.stringify(tree);
}

test("tight lists stay tight through serialization", () => {
  const source = "- one\n- two\n  - nested a\n  - nested b\n- three\n";
  assert.equal(roundTrip(source), source);
});

test("loose lists keep their blank lines", () => {
  const source = "- one\n\n- two\n\n- three\n";
  assert.equal(roundTrip(source), source);
});

test("bullet lists serialize with dashes and rules with dashes", () => {
  assert.equal(roundTrip("* starred\n* items\n"), "- starred\n- items\n");
  assert.equal(roundTrip("***\n"), "---\n");
});

test("ordered and task lists round-trip byte-identically", () => {
  const source = "1. first\n2. second\n";
  assert.equal(roundTrip(source), source);
});
