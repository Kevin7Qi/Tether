import test from "node:test";
import assert from "node:assert/strict";
import {
  EDITOR_MODE_SOURCE,
  EDITOR_MODE_WYSIWYG,
  editorModeLabel,
  normalizeEditorMode
} from "../src/renderer/lib/editorModes.js";

test("normalizeEditorMode keeps raw source explicit and migrates legacy modes to WYSIWYG", () => {
  assert.equal(normalizeEditorMode(EDITOR_MODE_SOURCE), EDITOR_MODE_SOURCE);
  assert.equal(normalizeEditorMode(EDITOR_MODE_WYSIWYG), EDITOR_MODE_WYSIWYG);
  assert.equal(normalizeEditorMode("preview"), EDITOR_MODE_WYSIWYG);
  assert.equal(normalizeEditorMode("split"), EDITOR_MODE_WYSIWYG);
  assert.equal(normalizeEditorMode(undefined), EDITOR_MODE_WYSIWYG);
});

test("editorModeLabel returns user-facing mode names", () => {
  assert.equal(editorModeLabel(EDITOR_MODE_WYSIWYG), "Inline editor");
  assert.equal(editorModeLabel(EDITOR_MODE_SOURCE), "Markdown source");
});
