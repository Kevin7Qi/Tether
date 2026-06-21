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
