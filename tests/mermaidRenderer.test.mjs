import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMermaidConfig,
  normalizeMermaidError,
  normalizeMermaidSource,
  normalizeMermaidTheme
} from "../src/renderer/lib/mermaidRenderer.js";

test("normalizeMermaidTheme only exposes light or dark", () => {
  assert.equal(normalizeMermaidTheme("light"), "light");
  assert.equal(normalizeMermaidTheme("dark"), "dark");
  assert.equal(normalizeMermaidTheme("system"), "dark");
  assert.equal(normalizeMermaidTheme(undefined), "dark");
});

test("normalizeMermaidSource trims and normalizes line endings", () => {
  assert.equal(normalizeMermaidSource("\r\nflowchart TD\r\n  A --> B\r\n"), "flowchart TD\n  A --> B");
});

test("buildMermaidConfig keeps strict controlled browser rendering", () => {
  const config = buildMermaidConfig("dark");
  assert.equal(config.startOnLoad, false);
  assert.equal(config.securityLevel, "strict");
  assert.equal(config.htmlLabels, false);
  assert.equal(config.flowchart.htmlLabels, false);
  assert.equal(config.theme, "dark");
  assert.ok(config.secure.includes("securityLevel"));
  assert.ok(config.secure.includes("startOnLoad"));
  assert.ok(config.secure.includes("themeVariables"));
});

test("buildMermaidConfig maps light theme to a light Mermaid theme", () => {
  const config = buildMermaidConfig("light");
  assert.equal(config.theme, "default");
  assert.equal(config.themeVariables.primaryTextColor, "#14171a");
});

test("normalizeMermaidError returns concise display text", () => {
  assert.equal(normalizeMermaidError({ str: "Error: bad\n\n diagram" }), "bad diagram");
  assert.equal(normalizeMermaidError(new Error("boom")), "boom");
  assert.equal(normalizeMermaidError("plain failure"), "plain failure");
  assert.equal(normalizeMermaidError(null), "The diagram source could not be parsed.");
});
