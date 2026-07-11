// Tether's Markdown output style. The serializer is configured once so the
// document round-trips through the inline editor without rewriting parts the
// user never touched.

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

// Serialized documents end with exactly one newline, matching the on-disk
// convention so an untouched document never diffs by a trailing blank line.
export function normalizeSerializedMarkdown(markdown) {
  if (!markdown) return markdown;
  return markdown.replace(/\n*$/, "\n");
}

export function tetherStringifyOptions(options = {}) {
  return {
    ...options,
    bullet: "-",
    rule: "-",
    join: [...(options.join || []), joinListsByStoredSpread]
  };
}
