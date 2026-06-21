import test from "node:test";
import assert from "node:assert/strict";
import {
  countWords,
  countLines,
  formatLatency,
  formatPoll,
  formatFileTimestamp,
  formatFileModifiedLabel,
  healthCheckPendingMessage,
  healthCheckSuccessMessage,
  healthCheckErrorMessage,
  statusTextForLoading,
  formatConnectionTarget,
  applyConnectionTarget,
  formatSourcePathDetail
} from "../src/renderer/lib/format.js";

test("countWords counts whitespace-separated tokens", () => {
  assert.equal(countWords("  hello   world "), 2);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("solo"), 1);
});

test("countLines counts lines across CR/LF variants, min 1", () => {
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\r\nb\rc"), 3);
  assert.equal(countLines(""), 1);
});

test("formatLatency clamps sub-1ms and rounds", () => {
  assert.equal(formatLatency(0.5), "<1ms");
  assert.equal(formatLatency(5), "5ms");
  assert.equal(formatLatency(5.5), "5.5ms");
  assert.equal(formatLatency(42), "42ms");
  assert.equal(formatLatency(42.7), "43ms");
  assert.equal(formatLatency("nope"), "<1ms");
});

test("formatPoll renders seconds or milliseconds", () => {
  assert.equal(formatPoll(1000), "1s");
  assert.equal(formatPoll(2000), "2s");
  assert.equal(formatPoll(500), "500ms");
  assert.equal(formatPoll(0), "0ms");
});

test("file timestamp helpers return empty string for falsy/invalid input", () => {
  assert.equal(formatFileTimestamp(""), "");
  assert.equal(formatFileTimestamp("not-a-date"), "");
  assert.equal(formatFileModifiedLabel(""), "");
  assert.equal(formatFileModifiedLabel("not-a-date"), "");
  // Valid input produces a non-empty "edited ..." label (locale-dependent text).
  assert.ok(formatFileModifiedLabel("2026-01-01T12:00:00Z").startsWith("edited "));
});

test("healthCheckPendingMessage branches on backend + source", () => {
  assert.equal(healthCheckPendingMessage({ hasNativeBackend: false }), "checking preview");
  assert.equal(healthCheckPendingMessage({ hasNativeBackend: true, documentSource: "remote" }), "checking server");
  assert.equal(healthCheckPendingMessage({ hasNativeBackend: true, documentSource: "sample" }), "checking sample");
  assert.equal(healthCheckPendingMessage({ hasNativeBackend: true, documentSource: "local" }), "checking local source");
  assert.equal(healthCheckPendingMessage({ hasNativeBackend: true, documentSource: "none" }), "checking source");
});

test("healthCheck success/error messages format kind + latency", () => {
  assert.equal(healthCheckSuccessMessage({ kind: "remote", latencyMs: 42 }), "server checked · 42ms");
  assert.equal(healthCheckSuccessMessage({ kind: "sample", latencyMs: 1 }), "sample checked · 1ms");
  assert.equal(healthCheckSuccessMessage({ kind: "other", latencyMs: 0.5 }), "source checked · <1ms");
  assert.equal(healthCheckErrorMessage({ message: "boom" }), "check failed · boom");
  assert.equal(healthCheckErrorMessage(undefined), "check failed · Unable to reach source.");
});

test("statusTextForLoading branches on source", () => {
  assert.equal(statusTextForLoading("remote"), "Refreshing the remote file tree.");
  assert.equal(statusTextForLoading("local"), "Reading the local folder.");
  assert.equal(statusTextForLoading("sample"), "Resolving connection and files.");
});

test("formatConnectionTarget builds user@host:path", () => {
  assert.equal(formatConnectionTarget({ username: "u", host: "h", remotePath: "/p" }), "u@h:/p");
  assert.equal(formatConnectionTarget({ host: "h", remotePath: "" }), "h");
  assert.equal(formatConnectionTarget({ username: "u", host: "h" }), "u@h");
});

test("applyConnectionTarget parses user@host:path into updates", () => {
  const updates = {};
  applyConnectionTarget("deploy@docs.example.com:/srv/readme.md", (field, value) => {
    updates[field] = value;
  });
  assert.equal(updates.host, "docs.example.com");
  assert.equal(updates.username, "deploy");
  assert.equal(updates.remotePath, "/srv/readme.md");

  const hostOnly = {};
  applyConnectionTarget("just-a-host", (field, value) => {
    hostOnly[field] = value;
  });
  assert.equal(hostOnly.host, "just-a-host");
  // No ":path" → the path is explicitly cleared (empty path browses from home),
  // not left holding a stale previous path.
  assert.equal(hostOnly.remotePath, "");
});

test("formatSourcePathDetail returns display path or empty", () => {
  assert.equal(formatSourcePathDetail(""), "");
  assert.ok(formatSourcePathDetail("/Users/yingjie/docs").includes("~"));
});
