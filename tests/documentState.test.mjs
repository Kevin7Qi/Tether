import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentState, documentReducer } from "../src/renderer/lib/documentState.js";

const file = (content, version) => ({ content, version, metadata: {}, refreshedAt: "t" });

test("createDocumentState seeds a clean, non-dirty base", () => {
  const state = createDocumentState("hello");
  assert.deepEqual(state, {
    content: "hello",
    editorContent: "hello",
    fileVersion: null,
    dirty: false,
    conflict: false,
    remoteShadow: null
  });
});

test("LOAD_FRESH adopts a file as the clean base and clears dirty/conflict/shadow", () => {
  const dirtyConflicted = {
    content: "base",
    editorContent: "my edits",
    fileVersion: "v1",
    dirty: true,
    conflict: true,
    remoteShadow: file("remote", "v2")
  };
  const next = documentReducer(dirtyConflicted, { type: "LOAD_FRESH", file: file("loaded", "v3") });
  assert.equal(next.content, "loaded");
  assert.equal(next.editorContent, "loaded");
  assert.equal(next.fileVersion, "v3");
  assert.equal(next.dirty, false);
  assert.equal(next.conflict, false);
  assert.equal(next.remoteShadow, null);
});

test("REMOTE_UPDATE while dirty stashes a conflict shadow and preserves local edits", () => {
  const state = { content: "base", editorContent: "my edits", fileVersion: "v1", dirty: true, conflict: false, remoteShadow: null };
  const incoming = file("newer remote", "v2");
  const next = documentReducer(state, { type: "REMOTE_UPDATE", file: incoming });
  assert.equal(next.conflict, true);
  assert.equal(next.remoteShadow, incoming);
  // Local edits and base are untouched while the conflict is pending.
  assert.equal(next.content, "base");
  assert.equal(next.editorContent, "my edits");
  assert.equal(next.fileVersion, "v1");
  assert.equal(next.dirty, true);
});

test("REMOTE_UPDATE while clean adopts the incoming file in place", () => {
  const state = createDocumentState("base");
  const next = documentReducer(state, { type: "REMOTE_UPDATE", file: file("fresher", "v9") });
  assert.equal(next.content, "fresher");
  assert.equal(next.editorContent, "fresher");
  assert.equal(next.fileVersion, "v9");
  assert.equal(next.dirty, false);
  assert.equal(next.conflict, false);
  assert.equal(next.remoteShadow, null);
});

test("EDIT marks dirty when the value diverges from the base", () => {
  const state = createDocumentState("base");
  const next = documentReducer(state, { type: "EDIT", value: "base!" });
  assert.equal(next.editorContent, "base!");
  assert.equal(next.dirty, true);
  assert.equal(next.conflict, false);
});

test("EDIT reverting to base while in conflict clears the stuck conflict (the bug fix)", () => {
  const conflicted = {
    content: "base",
    editorContent: "edited",
    fileVersion: "v1",
    dirty: true,
    conflict: true,
    remoteShadow: file("remote", "v2")
  };
  const next = documentReducer(conflicted, { type: "EDIT", value: "base" });
  assert.equal(next.dirty, false);
  assert.equal(next.conflict, false);
  assert.equal(next.remoteShadow, null);
  assert.equal(next.editorContent, "base");
});

test("EDIT reverting to base without a conflict simply clears dirty", () => {
  const state = { content: "base", editorContent: "edited", fileVersion: "v1", dirty: true, conflict: false, remoteShadow: null };
  const next = documentReducer(state, { type: "EDIT", value: "base" });
  assert.equal(next.dirty, false);
  assert.equal(next.conflict, false);
  assert.equal(next.remoteShadow, null);
});

test("SET_TEXT installs a clean version-less placeholder base", () => {
  const dirty = { content: "x", editorContent: "y", fileVersion: "v1", dirty: true, conflict: true, remoteShadow: file("r", "v2") };
  const next = documentReducer(dirty, { type: "SET_TEXT", text: "# Choose a file" });
  assert.equal(next.content, "# Choose a file");
  assert.equal(next.editorContent, "# Choose a file");
  assert.equal(next.fileVersion, null);
  assert.equal(next.dirty, false);
  assert.equal(next.conflict, false);
  assert.equal(next.remoteShadow, null);
});

test("SET_TEXT defaults to empty string when text is omitted (clearLocalDocument)", () => {
  const next = documentReducer(createDocumentState("x"), { type: "SET_TEXT" });
  assert.equal(next.content, "");
  assert.equal(next.editorContent, "");
});

test("CONFLICT_DETECTED holds the shadow and flags conflict without touching edits", () => {
  const state = { content: "base", editorContent: "edited", fileVersion: "v1", dirty: true, conflict: false, remoteShadow: null };
  const latest = file("latest on disk", "v2");
  const next = documentReducer(state, { type: "CONFLICT_DETECTED", shadow: latest });
  assert.equal(next.conflict, true);
  assert.equal(next.remoteShadow, latest);
  assert.equal(next.editorContent, "edited");
  assert.equal(next.dirty, true);
  assert.equal(next.content, "base");
});

test("'take theirs' is LOAD_FRESH with the shadow file (adopts remote, clears conflict)", () => {
  const conflicted = {
    content: "base",
    editorContent: "edited",
    fileVersion: "v1",
    dirty: true,
    conflict: true,
    remoteShadow: file("remote wins", "v2")
  };
  const next = documentReducer(conflicted, { type: "LOAD_FRESH", file: conflicted.remoteShadow });
  assert.equal(next.content, "remote wins");
  assert.equal(next.editorContent, "remote wins");
  assert.equal(next.fileVersion, "v2");
  assert.equal(next.dirty, false);
  assert.equal(next.conflict, false);
  assert.equal(next.remoteShadow, null);
});

test("reducer is pure: unknown actions return the same state reference", () => {
  const state = createDocumentState("base");
  assert.equal(documentReducer(state, { type: "NOPE" }), state);
});
