import { $node, $remark } from "@milkdown/kit/utils";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

export function annotateDocumentGaps(tree, file) {
  if (tree?.type !== "root") return tree;
  const source = sourceText(file);
  const gaps = [];
  let offset = 0;
  for (const child of tree.children || []) {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      tree.markdownBlockGaps = null;
      return tree;
    }
    gaps.push(source.slice(offset, start));
    offset = end;
  }
  gaps.push(source.slice(offset));
  tree.markdownBlockGaps = JSON.stringify(gaps);
  return tree;
}

export function documentGaps(value, childCount = null) {
  if (typeof value !== "string") return null;
  try {
    const gaps = JSON.parse(value);
    if (!Array.isArray(gaps) || !gaps.every((gap) => typeof gap === "string")) return null;
    if (Number.isFinite(childCount) && gaps.length !== childCount + 1) return null;
    return gaps;
  } catch {
    return null;
  }
}

export function normalizeEmptyMarkdownDocument(doc, markdown) {
  if (markdown !== "" || !doc?.type?.schema?.nodes?.paragraph) return doc;
  const current = doc.childCount === 1 ? doc.firstChild : null;
  const isEmptyEditableBlock = doc.childCount === 0 || (
    current
    && !current.content.size
    && ["paragraph", "code_block"].includes(current.type.name)
  );
  if (!isEmptyEditableBlock || current?.attrs?.tetherSyntheticTrailing) return doc;
  const paragraph = doc.type.schema.nodes.paragraph.create({
    tetherSyntheticTrailing: true
  });
  return doc.type.create(doc.attrs, [paragraph]);
}

export const sourceFaithfulDocumentRemark = $remark(
  "tetherSourceFaithfulDocument",
  () => () => annotateDocumentGaps
);

export const sourceFaithfulDocumentSchema = $node("doc", () => ({
    content: "block+",
    attrs: {
      markdownBlockGaps: { default: null, validate: "string|null" }
    },
    parseMarkdown: {
      match: ({ type }) => type === "root",
      runner: (state, node, type) => {
        state.injectRoot(node, type, {
          markdownBlockGaps: node.markdownBlockGaps ?? null
        });
      }
    },
    toMarkdown: {
      match: (node) => node.type.name === "doc",
      runner: (state, node) => {
        state.openNode("root", undefined, {
          markdownBlockGaps: node.attrs.markdownBlockGaps
        });
        state.next(node.content);
      }
    }
  }));

export function sourceFaithfulRootHandler(node, _parent, state, info) {
  let children = node.children || [];
  let gaps = documentGaps(node.markdownBlockGaps, children.length);
  const trailing = children.at(-1);
  if (
    !gaps
    && trailing?.type === "paragraph"
    && trailing.tetherSyntheticTrailing
    && !trailing.children?.length
  ) {
    children = children.slice(0, -1);
    gaps = documentGaps(node.markdownBlockGaps, children.length);
  }
  if (!gaps) return state.containerFlow(node, info);

  const tracker = state.createTracker(info);
  const results = [tracker.move(gaps[0])];
  state.indexStack.push(-1);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    state.indexStack[state.indexStack.length - 1] = index;
    results.push(tracker.move(state.handle(child, node, state, {
      before: "\n",
      after: "\n",
      ...tracker.current()
    })));
    if (child.type !== "list") state.bulletLastUsed = undefined;
    results.push(tracker.move(gaps[index + 1]));
  }
  state.indexStack.pop();
  return results.join("");
}
