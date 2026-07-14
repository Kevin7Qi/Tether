import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import {
  ConfigReady,
  editorViewCtx,
  init,
  parser,
  parserCtx,
  remarkStringifyOptionsCtx,
  schema,
  serializer,
  serializerCtx
} from "@milkdown/kit/core";
import { Clock, Container, Ctx } from "@milkdown/kit/ctx";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import {
  imageAttr,
  linkAttr,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  sourceFaithfulDocumentRemark,
  sourceFaithfulDocumentSchema
} from "../src/renderer/lib/markdownDocument.js";
import {
  sourceFaithfulParagraphRemark,
  sourceFaithfulParagraphSchema
} from "../src/renderer/lib/markdownParagraph.js";
import {
  annotateReferenceSources,
  referenceSyncTransaction,
  sourceFaithfulReferenceDefinitionSchema,
  sourceFaithfulReferenceImageSchema,
  sourceFaithfulReferenceLinkSchema,
  sourceFaithfulReferenceRemark
} from "../src/renderer/lib/markdownReference.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import {
  continuousMarkdownSource,
  inlineSourceWithReferenceDefinitions,
  markdownAtomSyntaxAt,
  sourceAwareClipboardText,
  sourceClipboardEdit,
  sourceSelectionFromDocumentSelection,
  sourceSelectionText
} from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => annotateReferenceSources(tree, file))
    .use(remarkStringify, tetherStringifyOptions({}));
  return processor.processSync(markdown).toString();
}

async function milkdownTransformer() {
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args);
    timer.unref?.();
    return timer;
  };
  const ctx = new Ctx(new Container(), new Clock());
  const initHandler = init({})(ctx);
  const schemaHandler = schema(ctx);
  const parserHandler = parser(ctx);
  const serializerHandler = serializer(ctx);
  ctx.inject(editorViewCtx, { state: { doc: { lastChild: null } } });
  const userHandlers = [
    sourceFaithfulDocumentRemark,
    sourceFaithfulDocumentSchema,
    sourceFaithfulParagraphRemark,
    sourceFaithfulParagraphSchema,
    textSchema,
    linkAttr,
    imageAttr,
    sourceFaithfulReferenceRemark,
    sourceFaithfulReferenceLinkSchema,
    sourceFaithfulReferenceImageSchema,
    sourceFaithfulReferenceDefinitionSchema
  ].flat().map((plugin) => plugin(ctx));
  ctx.record(ConfigReady);
  ctx.update(remarkStringifyOptionsCtx, (options) => tetherStringifyOptions(options));
  const promises = [
    ...userHandlers.map((handler) => handler()),
    schemaHandler(),
    parserHandler(),
    serializerHandler()
  ];
  const initPromise = initHandler();
  ctx.done(ConfigReady);
  try {
    await Promise.all([initPromise, ...promises]);
    return { parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) };
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
}

function textPosition(doc, text) {
  let position = null;
  doc.descendants((node, pos) => {
    if (position == null && node.isText && node.text === text) position = pos;
  });
  return position;
}

const referenceSource = [
  "[full][Dest], [collapsed][], [shortcut], and ![image][img].",
  "",
  "[Dest]: <a b> 'Title'",
  "[collapsed]: /collapsed",
  "[shortcut]: /shortcut",
  "[img]: image.png",
  ""
].join("\n");

test("reference links, images, and exact definitions round-trip without inlining", () => {
  assert.equal(roundTrip(referenceSource), referenceSource);
});

test("inline links retain explicit, literal-destination, and title-delimiter syntax", () => {
  const sources = [
    "[label](url  'single')\n",
    "[label](url (parenthesized))\n",
    "[label](<url>)\n",
    "[https://example.com](https://example.com)\n",
    "<person@example.com>\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("inline images retain destinations, title delimiters, spacing, and escaped labels", () => {
  const sources = [
    "![alt](url  'single')\n",
    "![alt](url (parenthesized))\n",
    "![alt](<a b> \"Title\")\n",
    "![a\\]lt](<url>)\n"
  ];
  for (const source of sources) assert.equal(roundTrip(source), source);
});

test("duplicate definitions resolve first and retain deliberate blank separation", async () => {
  const source = "[duplicate]\n\n[duplicate]: /first\n\n[duplicate]: /second\n";
  assert.equal(roundTrip(source), source);

  const { parse, serialize } = await milkdownTransformer();
  const doc = parse(source);
  const link = doc.firstChild.firstChild.marks.find((mark) => mark.type.name === "link");
  assert.equal(link.attrs.href, "/first");
  assert.equal(doc.child(1).attrs.adjacentToPreviousDefinition, false);
  assert.equal(doc.child(2).attrs.adjacentToPreviousDefinition, false);
  assert.equal(serialize(doc), source);
});

test("Milkdown keeps rendered references and definitions through a label edit", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse(referenceSource);
  assert.equal(doc.childCount, 5);
  assert.equal(doc.child(1).type.name, "link_definition");
  assert.equal(doc.child(1).attrs.definitionSource, "[Dest]: <a b> 'Title'");

  const full = doc.firstChild.firstChild;
  const link = full.marks.find((mark) => mark.type.name === "link");
  assert.equal(link.attrs.href, "a b");
  assert.equal(link.attrs.title, "Title");
  assert.equal(link.attrs.referenceType, "full");
  assert.equal(link.attrs.referenceIdentifier, "dest");
  assert.equal(link.attrs.referenceLabel, "Dest");
  const linkDOM = link.type.spec.toDOM(link);
  assert.equal(linkDOM[1]["data-md-reference-type"], "full");
  assert.equal(linkDOM[1]["data-md-reference-identifier"], "dest");
  assert.equal(linkDOM[1].referenceType, undefined);

  const image = doc.firstChild.child(doc.firstChild.childCount - 2);
  assert.equal(image.type.name, "image");
  assert.equal(image.attrs.src, "image.png");
  assert.equal(image.attrs.referenceType, "full");
  const imageDOM = image.type.spec.toDOM(image);
  assert.equal(imageDOM[1]["data-md-reference-identifier"], "img");
  assert.equal(imageDOM[1].referenceIdentifier, undefined);

  const position = textPosition(doc, "full");
  const edited = EditorState.create({ doc }).tr.insertText("renamed", position, position + 4).doc;
  assert.equal(serialize(edited), referenceSource.replace("[full][Dest]", "[renamed][Dest]"));

  const isolated = parse(inlineSourceWithReferenceDefinitions({ doc }, "[renamed][Dest]"));
  const isolatedLink = isolated.firstChild.firstChild.marks.find((mark) => mark.type.name === "link");
  assert.equal(isolatedLink.attrs.href, "a b");
  assert.equal(isolatedLink.attrs.referenceIdentifier, "dest");
});

test("definition edits refresh references and direct URL edits detach one occurrence", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse(referenceSource);
  const oldState = EditorState.create({ doc });
  let definitionPosition = null;
  doc.descendants((node, pos) => {
    if (definitionPosition == null && node.type.name === "link_definition") definitionPosition = pos;
  });
  const definition = doc.nodeAt(definitionPosition);
  const definitionEdit = oldState.tr.setNodeMarkup(definitionPosition, undefined, {
    ...definition.attrs,
    url: "https://changed.example",
    title: "Changed",
    definitionSource: "[Dest]: https://changed.example \"Changed\""
  });
  const definitionState = EditorState.create({ doc: definitionEdit.doc });
  const syncedDefinition = referenceSyncTransaction(oldState, definitionState);
  const syncedLink = syncedDefinition.doc.firstChild.firstChild.marks.find((mark) => mark.type.name === "link");
  assert.equal(syncedLink.attrs.href, "https://changed.example");
  assert.equal(syncedLink.attrs.title, "Changed");
  assert.equal(syncedLink.attrs.referenceHref, "https://changed.example");
  assert.match(serialize(syncedDefinition.doc), /\[Dest\]: https:\/\/changed\.example "Changed"/);
  assert.equal(
    referenceSyncTransaction(definitionState, EditorState.create({ doc: syncedDefinition.doc })),
    null
  );

  const linkPosition = textPosition(doc, "full");
  const originalLink = doc.firstChild.firstChild.marks.find((mark) => mark.type.name === "link");
  const directEdit = oldState.tr
    .removeMark(linkPosition, linkPosition + 4, originalLink)
    .addMark(linkPosition, linkPosition + 4, originalLink.type.create({
      ...originalLink.attrs,
      href: "https://direct.example"
    }));
  const directState = EditorState.create({ doc: directEdit.doc });
  const detached = referenceSyncTransaction(oldState, directState);
  const detachedLink = detached.doc.firstChild.firstChild.marks.find((mark) => mark.type.name === "link");
  assert.equal(detachedLink.attrs.href, "https://direct.example");
  assert.equal(detachedLink.attrs.referenceType, null);
  assert.match(serialize(detached.doc), /^\[full\]\(https:\/\/direct\.example/);
  assert.equal(referenceSyncTransaction(directState, EditorState.create({ doc: detached.doc })), null);
});

test("inline link label edits preserve source suffixes while target edits intentionally normalize", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "[label](url  'single') and [https://example.com](https://example.com)\n";
  const doc = parse(source);
  const firstLink = doc.firstChild.firstChild.marks.find((mark) => mark.type.name === "link");
  assert.equal(firstLink.attrs.linkSourceKind, "inline");
  assert.equal(firstLink.attrs.linkSourceSuffix, "(url  'single')");
  const linkDOM = firstLink.type.spec.toDOM(firstLink);
  assert.equal(linkDOM[1]["data-md-link-source-suffix"], "(url  'single')");
  assert.equal(linkDOM[1].linkSourceSuffix, undefined);

  const labelPosition = textPosition(doc, "label");
  const labelEdited = EditorState.create({ doc }).tr
    .insertText("renamed", labelPosition, labelPosition + "label".length).doc;
  assert.equal(
    serialize(labelEdited),
    "[renamed](url  'single') and [https://example.com](https://example.com)\n"
  );

  const oldState = EditorState.create({ doc });
  const targetEdit = oldState.tr
    .removeMark(labelPosition, labelPosition + "label".length, firstLink)
    .addMark(labelPosition, labelPosition + "label".length, firstLink.type.create({
      ...firstLink.attrs,
      href: "https://changed.example"
    }));
  const targetState = EditorState.create({ doc: targetEdit.doc });
  const detached = referenceSyncTransaction(oldState, targetState);
  const changedMark = detached.doc.firstChild.firstChild.marks.find((mark) => mark.type.name === "link");
  assert.equal(changedMark.attrs.linkSourceKind, null);
  assert.equal(changedMark.attrs.href, "https://changed.example");
  assert.match(serialize(detached.doc), /^\[label\]\(https:\/\/changed\.example "single"\)/);
});

test("rendered link selections copy the exact label and destination source interval", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "[label](url  'single') and tail\n";
  const doc = parse(source);
  const labelPosition = textPosition(doc, "label");
  const partialLabel = EditorState.create({
    doc,
    selection: TextSelection.create(doc, labelPosition + 1, labelPosition + 4)
  });
  assert.equal(sourceAwareClipboardText(partialLabel, serialize), "abe");

  const throughDestination = EditorState.create({
    doc,
    selection: TextSelection.create(doc, labelPosition + 2, labelPosition + "label".length + 4)
  });
  const exact = sourceSelectionFromDocumentSelection(throughDestination, serialize);
  assert.equal(sourceSelectionText(exact), "bel](url  'single') and");
  assert.equal(sourceAwareClipboardText(throughDestination, serialize), "bel](url  'single') and");
});

test("image alt edits preserve exact suffixes while target edits intentionally normalize", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before ![alt](<a b>  'Title') after.\n";
  const doc = parse(source);
  let imagePosition = null;
  doc.descendants((node, pos) => {
    if (imagePosition == null && node.type.name === "image") imagePosition = pos;
  });
  const image = doc.nodeAt(imagePosition);
  assert.equal(image.attrs.imageSource, "![alt](<a b>  'Title')");
  assert.equal(image.attrs.imageSourceSuffix, "(<a b>  'Title')");
  const imageDOM = image.type.spec.toDOM(image);
  assert.equal(imageDOM[1]["data-md-image-source-suffix"], "(<a b>  'Title')");
  assert.equal(imageDOM[1].imageSourceSuffix, undefined);

  const altEdited = EditorState.create({ doc }).tr.setNodeMarkup(imagePosition, undefined, {
    ...image.attrs,
    alt: "renamed"
  }).doc;
  assert.equal(serialize(altEdited), "Before ![renamed](<a b>  'Title') after.\n");

  const targetEdited = EditorState.create({ doc }).tr.setNodeMarkup(imagePosition, undefined, {
    ...image.attrs,
    src: "changed.png"
  }).doc;
  assert.equal(serialize(targetEdited), "Before ![alt](changed.png \"Title\") after.\n");
});

test("reference image alt edits retain full, collapsed, and shortcut source forms", async () => {
  const { parse, serialize } = await milkdownTransformer();
  for (const [source, expected] of [
    ["![alt][Image]\n\n[Image]: image.png\n", "![renamed][Image]\n\n[Image]: image.png\n"],
    ["![alt][]\n\n[alt]: image.png\n", "![renamed][]\n\n[alt]: image.png\n"],
    ["![alt]\n\n[alt]: image.png\n", "![renamed]\n\n[alt]: image.png\n"]
  ]) {
    const doc = parse(source);
    const image = doc.firstChild.firstChild;
    const edited = EditorState.create({ doc }).tr.setNodeMarkup(1, undefined, {
      ...image.attrs,
      alt: "renamed"
    }).doc;
    assert.equal(serialize(edited), expected);
  }
});

test("rendered image atoms expose their exact Markdown token", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Before ![alt](<a b> 'Title') after.\n");
  let imagePosition = null;
  doc.descendants((node, pos) => {
    if (imagePosition == null && node.type.name === "image") imagePosition = pos;
  });
  const state = EditorState.create({ doc });
  const unit = markdownAtomSyntaxAt(state, imagePosition);
  assert.equal(continuousMarkdownSource(state, unit, serialize), "![alt](<a b> 'Title')");
});

test("text selections across rendered images use the full physical image token", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Before ![alt](<a b>  'Title') after.\n";
  const doc = parse(source);
  let imagePosition = null;
  doc.descendants((node, pos) => {
    if (imagePosition == null && node.type.name === "image") imagePosition = pos;
  });
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, imagePosition, imagePosition + 1)
  });
  const token = "![alt](<a b>  'Title')";
  assert.equal(sourceSelectionText(sourceSelectionFromDocumentSelection(state, serialize)), token);
  assert.equal(sourceAwareClipboardText(state, serialize), token);
  const edit = sourceClipboardEdit(state, "image", parse, serialize);
  assert.equal(edit?.selectedText, token);
  assert.equal(serialize(edit.transaction.doc), "Before image after.\n");
});

test("mixed link-to-image selections follow one literal Markdown source interval", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const source = "Start [label](url  'single') + ![alt](x.png) end\n";
  const doc = parse(source);
  const labelPosition = textPosition(doc, "label");
  let imagePosition = null;
  doc.descendants((node, pos) => {
    if (imagePosition == null && node.type.name === "image") imagePosition = pos;
  });
  const imageToken = "![alt](x.png)";
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, labelPosition + 2, imagePosition + 3)
  });
  const physicalFrom = source.indexOf("label") + 2;
  const physicalTo = source.indexOf(imageToken) + imageToken.length + 2;
  const selectedSource = source.slice(physicalFrom, physicalTo);
  assert.equal(
    sourceSelectionText(sourceSelectionFromDocumentSelection(state, serialize)),
    selectedSource
  );
  assert.equal(sourceAwareClipboardText(state, serialize), selectedSource);

  const edit = sourceClipboardEdit(state, "X", parse, serialize);
  assert.equal(edit?.selectedText, selectedSource);
  assert.equal(
    serialize(edit.transaction.doc),
    `${source.slice(0, physicalFrom)}X${source.slice(physicalTo)}`
  );
});
