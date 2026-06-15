import test from "node:test";
import assert from "node:assert/strict";
import {
  basename,
  dirname,
  localDirname,
  canGoUp,
  localCanGoUp,
  parentRemotePath,
  localParentPath,
  compactPath,
  compactPathStart,
  formatSidebarDirectoryPath,
  normalizeLocalComparisonPath,
  pathsReferToSameLocalFile
} from "../src/renderer/lib/paths.js";

test("basename returns the final path segment, with fallbacks", () => {
  assert.equal(basename("a/b/c.md"), "c.md");
  assert.equal(basename("c.md"), "c.md");
  assert.equal(basename("a\\b\\c.md"), "c.md");
  assert.equal(basename("a/b/"), "b");
  assert.equal(basename(""), "Remote file");
  assert.equal(basename(undefined), "Remote file");
});

test("dirname strips the final segment and normalizes separators", () => {
  assert.equal(dirname("a/b/c.md"), "a/b");
  assert.equal(dirname("/a/b"), "/a");
  assert.equal(dirname("c.md"), "/");
  assert.equal(dirname("a\\b\\c.md"), "a/b");
});

test("localDirname handles posix, root, and windows drive paths", () => {
  assert.equal(localDirname("/a/b/c.md"), "/a/b");
  assert.equal(localDirname("c.md"), ".");
  assert.equal(localDirname("/c.md"), "/");
  assert.equal(localDirname("C:/a/b.md"), "C:/a");
  assert.equal(localDirname("C:/x.md"), "C:/");
});

test("canGoUp is falsy at filesystem roots", () => {
  assert.ok(canGoUp("a/b"));
  assert.ok(!canGoUp("."));
  assert.ok(!canGoUp("/"));
  assert.ok(!canGoUp(""));
});

test("localCanGoUp rejects roots and windows drive roots", () => {
  assert.equal(localCanGoUp("/a"), true);
  assert.equal(localCanGoUp("/"), false);
  assert.equal(localCanGoUp("."), false);
  assert.equal(localCanGoUp(""), false);
  assert.equal(localCanGoUp("C:/"), false);
  assert.equal(localCanGoUp("C:"), false);
});

test("parentRemotePath climbs one level and resolves roots", () => {
  assert.equal(parentRemotePath("/a/b"), "/a");
  assert.equal(parentRemotePath("/a"), "/");
  assert.equal(parentRemotePath("a"), ".");
  assert.equal(parentRemotePath("."), ".");
});

test("localParentPath climbs one level unless already at a root", () => {
  assert.equal(localParentPath("/a/b"), "/a");
  assert.equal(localParentPath("C:/"), "C:/");
  assert.equal(localParentPath("/"), "/");
});

test("compactPath abbreviates home and long paths", () => {
  assert.equal(compactPath("/Users/yingjie/docs/x.md"), "~/docs/x.md");
  assert.equal(compactPath("/Users/yingjie"), "~");
  assert.equal(compactPath("/srv/docs"), "/srv/docs");
  assert.equal(compactPath(""), "");
  assert.ok(compactPath("/very/long/path/".padEnd(60, "x")).startsWith("..."));
});

test("compactPathStart keeps short paths and truncates from the front", () => {
  assert.equal(compactPathStart("/a/b", 30), "/a/b");
  const result = compactPathStart("/one/two/three/four/five/six/seven", 20);
  assert.ok(result.startsWith("..."));
  assert.ok(result.length <= 20);
});

test("formatSidebarDirectoryPath returns null for empty and rewrites home", () => {
  assert.equal(formatSidebarDirectoryPath(""), null);
  const result = formatSidebarDirectoryPath("/Users/yingjie/docs");
  assert.equal(result.full, "/Users/yingjie/docs");
  assert.ok(result.display.includes("~"));
});

test("local path comparison is case-insensitive on windows and trims trailing slashes", () => {
  assert.equal(normalizeLocalComparisonPath("/a/b/"), "/a/b");
  assert.equal(normalizeLocalComparisonPath("C:/A/B"), "c:/a/b");
  assert.ok(pathsReferToSameLocalFile("/a/b", "/a/b/"));
  assert.ok(pathsReferToSameLocalFile("C:/A/x.md", "c:/a/x.md"));
  assert.ok(!pathsReferToSameLocalFile("/a/b", "/a/c"));
  assert.ok(!pathsReferToSameLocalFile("", "/a"));
});
