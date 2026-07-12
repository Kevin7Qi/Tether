import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import {
  ConfigReady,
  init,
  parser,
  parserCtx,
  remarkStringifyOptionsCtx,
  schema,
  serializer,
  serializerCtx
} from "@milkdown/kit/core";
import { Clock, Container, Ctx } from "@milkdown/kit/ctx";
import {
  docSchema,
  headingAttr,
  headingIdGenerator,
  paragraphSchema,
  textSchema
} from "@milkdown/kit/preset/commonmark";
import {
  annotateHeadingMarkers,
  sourceFaithfulHeadingRemark,
  sourceFaithfulHeadingSchema
} from "../src/renderer/lib/markdownHeading.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => annotateHeadingMarkers(tree, file))
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
  const userHandlers = [
    docSchema,
    paragraphSchema,
    textSchema,
    headingAttr,
    headingIdGenerator,
    sourceFaithfulHeadingRemark,
    sourceFaithfulHeadingSchema
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

test("setext and closed ATX headings retain their source forms", () => {
  const source = "Title\n=====\n\n## Section ##\n";
  assert.equal(roundTrip(source), source);
});

test("nested setext annotation reads the physical underline past quote prefixes", () => {
  const source = "> Quoted title\n> ------\n";
  const processor = unified().use(remarkParse);
  const tree = processor.parse(source);
  annotateHeadingMarkers(tree, { value: source });
  const heading = tree.children[0].children[0];
  assert.equal(heading.markdownStyle, "setext");
  assert.equal(heading.setextMarker, "-");
  assert.equal(heading.setextLength, 6);
});

test("Milkdown preserves a setext underline through text edits and exposes its real marker", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("Title\n=====\n");
  assert.deepEqual({ ...doc.firstChild.attrs }, {
    id: "",
    level: 1,
    markdownStyle: "setext",
    setextMarker: "=",
    setextLength: 5,
    atxClosingLength: 0
  });
  const dom = doc.firstChild.type.spec.toDOM(doc.firstChild);
  assert.equal(dom[1]["data-md-heading-style"], "setext");
  assert.equal(dom[1]["data-md-heading-marker"], "=====");

  const editedHeading = doc.firstChild.type.create(
    doc.firstChild.attrs,
    doc.type.schema.text("Renamed")
  );
  const editedDoc = doc.type.create(null, [editedHeading]);
  assert.equal(serialize(editedDoc), "Renamed\n=====\n");
});
