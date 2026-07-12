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
import { EditorState } from "@milkdown/kit/prose/state";
import {
  docSchema,
  hardbreakAttr,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  annotateHardBreakMarkers,
  sourceFaithfulHardBreakRemark,
  sourceFaithfulHardBreakSchema
} from "../src/renderer/lib/markdownBreak.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => annotateHardBreakMarkers(tree, file))
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
    docSchema,
    paragraphSchema,
    textSchema,
    hardbreakAttr,
    sourceFaithfulHardBreakRemark,
    sourceFaithfulHardBreakSchema
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

test("hard breaks retain backslash and exact trailing-space markers", () => {
  const source = "two  \nspaces\n\nthree   \nspaces\n\nslash\\\nbreak\n";
  assert.equal(roundTrip(source), source);
});

test("Milkdown retains a trailing-space hard break through an unrelated text edit", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("alpha  \nbeta\n");
  const hardbreak = doc.firstChild.child(1);
  assert.equal(hardbreak.type.name, "hardbreak");
  assert.equal(hardbreak.attrs.markdownMarker, "  ");
  assert.equal(hardbreak.type.spec.toDOM(hardbreak)[1]["data-md-hardbreak-marker"], "  ");

  const alpha = textPosition(doc, "alpha");
  const edited = EditorState.create({ doc }).tr.insertText("renamed", alpha, alpha + "alpha".length).doc;
  assert.equal(serialize(edited), "renamed  \nbeta\n");
});
