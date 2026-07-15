import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalWorkspaceSourceSession,
  consolidateSourceSessions,
  sourceSessionIdentity
} from "../src/renderer/lib/sourceSessions.js";

function localFile(path, updatedAt) {
  const directory = path.slice(0, path.lastIndexOf("/")) || "/";
  return {
    id: `local-file:${path}`,
    kind: "local-file",
    label: path.split("/").pop(),
    detail: directory,
    title: path,
    tag: "file",
    rootPath: directory,
    directory,
    selectedPath: path,
    updatedAt
  };
}

test("same-directory local files migrate into one workspace source", () => {
  const older = localFile("/work/Tether/samples/fence-audit.md", "2026-07-15T10:00:00.000Z");
  const newest = localFile("/work/Tether/samples/sample.md", "2026-07-15T12:00:00.000Z");
  const consolidated = consolidateSourceSessions([older, newest]);

  assert.equal(consolidated.length, 1);
  assert.deepEqual(
    {
      id: consolidated[0].id,
      kind: consolidated[0].kind,
      label: consolidated[0].label,
      rootPath: consolidated[0].rootPath,
      selectedPath: consolidated[0].selectedPath
    },
    {
      id: "local-folder:/work/Tether/samples",
      kind: "local-folder",
      label: "samples",
      rootPath: "/work/Tether/samples",
      selectedPath: "/work/Tether/samples/sample.md"
    }
  );
});

test("a folder source and direct files with the same root share one identity", () => {
  const folder = {
    id: "local-folder:/work/docs/",
    kind: "local-folder",
    label: "docs",
    detail: "docs",
    title: "/work/docs/",
    tag: "local",
    rootPath: "/work/docs/",
    directory: "/work/docs/",
    selectedPath: "",
    updatedAt: "2026-07-15T09:00:00.000Z"
  };
  const file = localFile("/work/docs/notes.md", "2026-07-15T11:00:00.000Z");

  assert.equal(sourceSessionIdentity(folder), sourceSessionIdentity(file));
  const consolidated = consolidateSourceSessions([folder, file]);
  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0].selectedPath, "/work/docs/notes.md");
  assert.equal(consolidated[0].id, "local-folder:/work/docs");
});

test("different workspace roots remain separate and are ordered by recency", () => {
  const older = localFile("/work/a/one.md", "2026-07-15T08:00:00.000Z");
  const newest = localFile("/work/b/two.md", "2026-07-15T13:00:00.000Z");
  const consolidated = consolidateSourceSessions([older, newest]);

  assert.deepEqual(consolidated.map((session) => session.rootPath), ["/work/b", "/work/a"]);
});

test("direct file opens build a stable parent-workspace session", () => {
  const first = buildLocalWorkspaceSourceSession("/work/docs/a.md", "/work/docs/");
  const second = buildLocalWorkspaceSourceSession(
    "/work/docs/b.md",
    "/work/docs",
    "local-file:/work/docs/a.md"
  );

  assert.equal(first.id, "local-folder:/work/docs");
  assert.equal(second.id, first.id);
  assert.equal(second.kind, "local-folder");
  assert.equal(second.selectedPath, "/work/docs/b.md");
});
