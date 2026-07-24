import assert from "node:assert/strict";
import test from "node:test";
import { isPrimaryShortcutModifier } from "../src/renderer/lib/constants.js";

test("application shortcuts use Command on macOS and Control elsewhere", () => {
  assert.equal(isPrimaryShortcutModifier({ metaKey: true }, true), true);
  assert.equal(isPrimaryShortcutModifier({ ctrlKey: true }, true), false);
  assert.equal(isPrimaryShortcutModifier({ metaKey: true, ctrlKey: true }, true), false);

  assert.equal(isPrimaryShortcutModifier({ ctrlKey: true }, false), true);
  assert.equal(isPrimaryShortcutModifier({ metaKey: true }, false), false);
  assert.equal(isPrimaryShortcutModifier({ metaKey: true, ctrlKey: true }, false), false);
  assert.equal(isPrimaryShortcutModifier(null, true), false);
});
