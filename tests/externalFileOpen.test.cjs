const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const {
  externalDocumentPathsFromArgv,
  isSupportedLocalDocumentPath,
  normalizeExternalDocumentPath
} = require("../src/main/externalFileOpen.cjs");

test("external Markdown opening accepts every supported document extension", () => {
  for (const filePath of [
    "/docs/README.md",
    "/docs/guide.MARKDOWN",
    "/docs/notes.mdown",
    "/docs/draft.mkd",
    "/docs/plain.txt"
  ]) {
    assert.equal(isSupportedLocalDocumentPath(filePath), true, filePath);
  }
  assert.equal(isSupportedLocalDocumentPath("/docs/image.png"), false);
  assert.equal(isSupportedLocalDocumentPath(""), false);
});

test("external document paths normalize relative paths and file URLs", () => {
  const cwd = path.resolve("/workspace");
  assert.equal(
    normalizeExternalDocumentPath("notes/readme.md", cwd),
    path.join(cwd, "notes", "readme.md")
  );
  const absolute = path.resolve("/tmp/External Notes.markdown");
  assert.equal(
    normalizeExternalDocumentPath(pathToFileURL(absolute).toString(), cwd),
    absolute
  );
  assert.equal(normalizeExternalDocumentPath("--inspect=9229", cwd), "");
  assert.equal(normalizeExternalDocumentPath("notes/image.png", cwd), "");
});

test("command-line document extraction ignores app arguments and deduplicates paths", () => {
  const cwd = path.resolve("/workspace");
  assert.deepEqual(
    externalDocumentPathsFromArgv([
      ".",
      "--remote-debugging-port=1234",
      "docs/one.md",
      "docs/two.markdown",
      "docs/one.md",
      "docs/image.png"
    ], cwd),
    [
      path.join(cwd, "docs", "one.md"),
      path.join(cwd, "docs", "two.markdown")
    ]
  );
  assert.deepEqual(
    externalDocumentPathsFromArgv(["C:/Docs/ONE.md", "c:/docs/one.md"], "C:/", "win32"),
    [path.resolve("C:/", "C:/Docs/ONE.md")]
  );
});
