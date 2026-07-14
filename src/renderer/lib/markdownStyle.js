// Tether's Markdown output style. The serializer is configured once so the
// document round-trips through the inline editor without rewriting parts the
// user never touched.

import { sourceFaithfulCodeHandler } from "./markdownFence.js";
import { sourceFaithfulHeadingHandler } from "./markdownHeading.js";
import { sourceFaithfulThematicBreakHandler } from "./markdownRule.js";
import { sourceFaithfulListHandler, sourceFaithfulListItemHandler } from "./markdownList.js";
import { sourceFaithfulHardBreakHandler } from "./markdownBreak.js";
import {
  sourceFaithfulDefinitionHandler,
  sourceFaithfulImageHandler,
  sourceFaithfulImageReferenceHandler,
  sourceFaithfulLinkHandler
} from "./markdownReference.js";
import { sourceFaithfulInlineCodeHandler } from "./markdownInlineCode.js";
import { sourceFaithfulTableHandler } from "./markdownTable.js";
import { sourceFaithfulStrikeHandler } from "./markdownStrike.js";
import { sourceFaithfulBlockquoteHandler } from "./markdownBlockquote.js";
import { sourceFaithfulAttentionHandler } from "./markdownAttention.js";
import {
  sourceFaithfulInlineMathHandler,
  sourceFaithfulMathBlockHandler
} from "./markdownMath.js";
import { sourceFaithfulParagraphHandler } from "./markdownParagraph.js";
import { renderedBlockHtmlHandler, renderedInlineHtmlHandler } from "./markdownHtml.js";
import {
  sourceFaithfulFootnoteDefinitionHandler,
  sourceFaithfulFootnoteReferenceHandler
} from "./markdownFootnote.js";
import { documentGaps, sourceFaithfulRootHandler } from "./markdownDocument.js";

// Milkdown stores list `spread` attributes as the strings "true"/"false",
// which the remark serializer treats as always-truthy, so every parsed list
// re-serializes loose (blank lines between items). This join rule restores
// the intended tight/loose behavior for string-valued spreads.
function joinListsByStoredSpread(_left, _right, parent) {
  if ("spread" in parent && typeof parent.spread === "string") {
    return parent.spread === "true" ? 1 : 0;
  }
  return undefined;
}

function joinAdjacentDefinitions(left, right) {
  if (left.type !== "definition" || right.type !== "definition") return undefined;
  return right.adjacentToPreviousDefinition ? 0 : 1;
}

function sourceSuffix(context, fallbackSource = null) {
  if (typeof context === "string") return context.match(/(?:\r\n|\r|\n)*$/)?.[0] ?? "";
  const childCount = context?.childCount;
  const gaps = documentGaps(context?.attrs?.markdownBlockGaps, childCount);
  if (gaps) return gaps[gaps.length - 1];
  if (typeof fallbackSource === "string") {
    return fallbackSource.match(/(?:\r\n|\r|\n)*$/)?.[0] ?? "";
  }
  return null;
}

// Remark adds one final LF when the root handler returns text without a line
// ending. Remove only that synthetic character. Real suffixes—including no
// final newline, CRLF, and deliberate trailing blank lines—stay untouched.
export function normalizeSerializedMarkdown(markdown, context = null, fallbackSource = null) {
  if (!markdown) return markdown;
  return sourceSuffix(context, fallbackSource) === "" && markdown.endsWith("\n")
    ? markdown.slice(0, -1)
    : markdown;
}

export function tetherStringifyOptions(options = {}) {
  return {
    ...options,
    bullet: "-",
    rule: "-",
    handlers: {
      ...(options.handlers || {}),
      blockquote: sourceFaithfulBlockquoteHandler,
      break: sourceFaithfulHardBreakHandler,
      code: sourceFaithfulCodeHandler,
      definition: sourceFaithfulDefinitionHandler,
      emphasis: sourceFaithfulAttentionHandler,
      footnoteDefinition: sourceFaithfulFootnoteDefinitionHandler,
      footnoteReference: sourceFaithfulFootnoteReferenceHandler,
      heading: sourceFaithfulHeadingHandler,
      htmlBlockElement: renderedBlockHtmlHandler,
      htmlInlineElement: renderedInlineHtmlHandler,
      image: sourceFaithfulImageHandler,
      imageReference: sourceFaithfulImageReferenceHandler,
      inlineCode: sourceFaithfulInlineCodeHandler,
      inlineMath: sourceFaithfulInlineMathHandler,
      list: sourceFaithfulListHandler,
      listItem: sourceFaithfulListItemHandler,
      link: sourceFaithfulLinkHandler,
      math: sourceFaithfulMathBlockHandler,
      paragraph: sourceFaithfulParagraphHandler,
      root: sourceFaithfulRootHandler,
      delete: sourceFaithfulStrikeHandler,
      table: sourceFaithfulTableHandler,
      strong: sourceFaithfulAttentionHandler,
      thematicBreak: sourceFaithfulThematicBreakHandler
    },
    join: [...(options.join || []), joinAdjacentDefinitions, joinListsByStoredSpread]
  };
}
