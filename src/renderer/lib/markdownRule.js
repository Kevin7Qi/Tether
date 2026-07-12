import { hrSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

export function validRuleSource(value) {
  const source = String(value || "");
  const compact = source.replace(/[\t ]/g, "");
  return compact.length >= 3
    && /^([*_-])\1*$/.test(compact)
    && /^[* _\t-]+$/.test(source);
}

export function annotateThematicBreakMarkers(tree, file) {
  const source = sourceText(file);
  const visit = (node) => {
    if (node?.type === "thematicBreak") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const ruleSource = source.slice(start, end);
        if (validRuleSource(ruleSource)) node.ruleSource = ruleSource;
      }
    }
    (node?.children || []).forEach(visit);
  };
  visit(tree);
  return tree;
}

export const sourceFaithfulRuleRemark = $remark(
  "tetherSourceFaithfulRule",
  () => () => annotateThematicBreakMarkers
);

export const sourceFaithfulRuleSchema = hrSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: {
      ...spec.attrs,
      ruleSource: { default: "---", validate: "string" }
    },
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [dom[0], { ...dom[1], "data-md-rule-source": node.attrs.ruleSource }];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      runner: (state, node, type) => {
        state.addNode(type, { ruleSource: validRuleSource(node.ruleSource) ? node.ruleSource : "---" });
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        state.addNode("thematicBreak", undefined, undefined, { ruleSource: node.attrs.ruleSource });
      }
    }
  };
});

export function sourceFaithfulThematicBreakHandler(node, _parent, state) {
  if (validRuleSource(node.ruleSource)) return node.ruleSource;
  const marker = ["*", "-", "_"].includes(state.options.rule) ? state.options.rule : "*";
  const repetition = Math.max(3, Number(state.options.ruleRepetition) || 3);
  return Array(repetition).fill(marker).join(state.options.ruleSpaces ? " " : "");
}
