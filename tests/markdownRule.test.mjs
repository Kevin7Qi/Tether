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
import { EditorState } from "@milkdown/kit/prose/state";
import { docSchema, hrAttr, paragraphSchema, textSchema } from "@milkdown/kit/preset/commonmark";
import {
  annotateThematicBreakMarkers,
  sourceFaithfulRuleRemark,
  sourceFaithfulRuleSchema,
  validRuleSource
} from "../src/renderer/lib/markdownRule.js";
import { tetherStringifyOptions } from "../src/renderer/lib/markdownStyle.js";
import { continuousMarkdownSource } from "../src/renderer/lib/markdownSyntaxPlugin.js";

const milkdownTimerEvents = new EventTarget();
globalThis.addEventListener ??= milkdownTimerEvents.addEventListener.bind(milkdownTimerEvents);
globalThis.removeEventListener ??= milkdownTimerEvents.removeEventListener.bind(milkdownTimerEvents);
globalThis.dispatchEvent ??= milkdownTimerEvents.dispatchEvent.bind(milkdownTimerEvents);

function roundTrip(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(() => (tree, file) => annotateThematicBreakMarkers(tree, file))
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
    hrAttr,
    sourceFaithfulRuleRemark,
    sourceFaithfulRuleSchema
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

test("thematic breaks retain marker character, length, and internal spacing", () => {
  for (const source of ["***\n", "___\n", "- - -\n", "* * * * *\n", "> _ _ _ _\n"]) {
    assert.equal(roundTrip(source), source);
  }
});

test("rule-source validation rejects mixed or incomplete marker runs", () => {
  assert.equal(validRuleSource("* * *"), true);
  assert.equal(validRuleSource("_____"), true);
  assert.equal(validRuleSource("**"), false);
  assert.equal(validRuleSource("*-*"), false);
  assert.equal(validRuleSource("---x"), false);
});

test("Milkdown exposes the exact thematic-break token to the source control", async () => {
  const { parse, serialize } = await milkdownTransformer();
  const doc = parse("* * * * *\n");
  assert.equal(doc.firstChild.attrs.ruleSource, "* * * * *");
  assert.equal(doc.firstChild.type.spec.toDOM(doc.firstChild)[1]["data-md-rule-source"], "* * * * *");
  assert.equal(
    continuousMarkdownSource(
      EditorState.create({ doc }),
      { from: 0, to: doc.firstChild.nodeSize, kind: "block", name: "hr" },
      serialize
    ),
    "* * * * *"
  );
});
