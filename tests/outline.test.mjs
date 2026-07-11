import test from "node:test";
import assert from "node:assert/strict";
import { parseOutline, cleanHeadingText } from "../src/renderer/lib/outline.js";

test("parseOutline captures ATX headings with level and 1-based line", () => {
  const md = ["# Title", "", "intro", "", "## Section", "", "### Deeper"].join("\n");
  assert.deepEqual(parseOutline(md), [
    { level: 1, text: "Title", line: 1, id: "tether-h-1" },
    { level: 2, text: "Section", line: 5, id: "tether-h-5" },
    { level: 3, text: "Deeper", line: 7, id: "tether-h-7" }
  ]);
});

test("parseOutline ignores headings inside fenced code blocks", () => {
  const md = ["# Real", "", "```", "# not a heading", "```", "", "## Also real"].join("\n");
  assert.deepEqual(
    parseOutline(md).map((h) => h.text),
    ["Real", "Also real"]
  );
});

test("parseOutline strips trailing closing hashes and requires a space after hashes", () => {
  const md = ["## Heading ##", "", "#nospace", "", "#### Four"].join("\n");
  assert.deepEqual(
    parseOutline(md).map((h) => `${h.level}:${h.text}`),
    ["2:Heading", "4:Four"]
  );
});

test("parseOutline returns [] for empty or headingless input", () => {
  assert.deepEqual(parseOutline(""), []);
  assert.deepEqual(parseOutline("just a paragraph\nand another"), []);
});

test("cleanHeadingText unwraps inline code, emphasis, links, and math", () => {
  assert.equal(cleanHeadingText("Deploy `fleet` to **prod**"), "Deploy fleet to prod");
  assert.equal(cleanHeadingText("See [the runbook](https://x.y)"), "See the runbook");
  assert.equal(cleanHeadingText("Energy $E = mc^2$ budget"), "Energy E = mc^2 budget");
});

test("cleanHeadingText keeps comparison operators but drops real HTML tags", () => {
  // A bare `<`/`>` used as a comparison must survive (regression: the old
  // `<[^>]+>` rule deleted everything between them).
  assert.equal(cleanHeadingText("If a < b and c > d"), "If a < b and c > d");
  assert.equal(cleanHeadingText("Loop while i <= 5"), "Loop while i <= 5");
  // Tag-shaped spans are removed, matching rendered Markdown text.
  assert.equal(cleanHeadingText("Wrap <span>text</span> here"), "Wrap text here");
  assert.equal(cleanHeadingText("Generic List<T>"), "Generic List");
});

test("parseOutline preserves comparison operators in heading labels", () => {
  const md = ["# When a < b", "", "## Budget > 0"].join("\n");
  assert.deepEqual(
    parseOutline(md).map((h) => h.text),
    ["When a < b", "Budget > 0"]
  );
});

test("parseOutline detects setext headings like the renderer does", () => {
  const md = ["Top Title", "=====", "", "Second Level", "---", "", "para", "---", "", "- item", "---"].join("\n");
  const outline = parseOutline(md);
  assert.deepEqual(
    outline.map((h) => [h.level, h.text, h.line]),
    [
      [1, "Top Title", 1],
      [2, "Second Level", 4],
      // "para" followed by --- is a setext h2 per CommonMark; the --- after a
      // list item is a thematic break and must NOT create a heading.
      [2, "para", 7]
    ]
  );
});

test("parseOutline includes headings inside blockquotes", () => {
  const md = ["# Intro", "", "> # Quoted Title", "> body", "", "## After"].join("\n");
  assert.deepEqual(
    parseOutline(md).map((h) => h.text),
    ["Intro", "Quoted Title", "After"]
  );
});

test("parseOutline allows up to three leading spaces before ATX markers", () => {
  assert.deepEqual(parseOutline("   ## Indented").map((h) => h.text), ["Indented"]);
});

test("parseOutline ignores table delimiter rows", () => {
  const md = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
  assert.deepEqual(parseOutline(md), []);
});
