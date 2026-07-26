import assert from "node:assert/strict";
import test from "node:test";
import { pendingSourceDraftDecision } from "../src/renderer/lib/sourceDraft.js";

test("a pending source draft outranks stale model output before its control mounts", () => {
  assert.deepEqual(
    pendingSourceDraftDecision("- ##Title\n", "- ## Title\n", false),
    { suppressModelUpdate: true, settled: false }
  );
});

test("a mounted source control owns its draft even when the model happens to match", () => {
  assert.deepEqual(
    pendingSourceDraftDecision("- ##Title\n", "- ##Title\n", true),
    { suppressModelUpdate: true, settled: false }
  );
});

test("a committed model settles matching pending source bytes after control teardown", () => {
  assert.deepEqual(
    pendingSourceDraftDecision("- ##Title\n", "- ##Title\n", false),
    { suppressModelUpdate: false, settled: true }
  );
});

test("ordinary model updates proceed when no source draft is pending", () => {
  assert.deepEqual(
    pendingSourceDraftDecision(null, "Paragraph\n", false),
    { suppressModelUpdate: false, settled: false }
  );
});
