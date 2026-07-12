import { imageSchema, linkSchema } from "@milkdown/kit/preset/commonmark";
import { Plugin } from "@milkdown/kit/prose/state";
import { $nodeSchema, $prose, $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

function sourceText(file) {
  return typeof file?.value === "string" ? file.value : String(file?.value || "");
}

function imageLabelEnd(raw) {
  for (let index = 2; index < raw.length; index += 1) {
    if (raw[index] !== "]") continue;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= 0 && raw[cursor] === "\\"; cursor -= 1) escapes += 1;
    if (escapes % 2 === 0) return index;
  }
  return -1;
}

export function annotateReferenceSources(tree, file) {
  const source = sourceText(file);
  const definitions = new Map();
  let previousDefinition = null;

  const collect = (node) => {
    if (node?.type === "definition") {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        node.definitionSource = source.slice(start, end);
        const previousEnd = previousDefinition?.position?.end?.offset;
        node.adjacentToPreviousDefinition = Number.isFinite(previousEnd)
          ? !/\r?\n[\t ]*\r?\n/.test(source.slice(previousEnd, start))
          : false;
      }
      previousDefinition = node;
    }
    (node?.children || []).forEach(collect);
  };
  collect(tree);

  const resolve = (node) => {
    if (node?.type === "link") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const lastChildEnd = node.children?.[node.children.length - 1]?.position?.end?.offset;
        if (raw.startsWith("<") && raw.endsWith(">")) {
          node.linkSourceKind = "autolink";
          node.linkSourceText = node.children?.[0]?.value || raw.slice(1, -1);
        } else if (Number.isFinite(lastChildEnd)) {
          const labelEnd = lastChildEnd - start;
          if (raw[labelEnd] === "]") {
            node.linkSourceKind = "inline";
            node.linkSourceSuffix = raw.slice(labelEnd + 1);
          }
        }
        node.linkSourceHref = node.url;
        node.linkSourceTitle = node.title ?? null;
      }
    }
    if (node?.type === "image" || node?.type === "imageReference") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const raw = source.slice(start, end);
        const labelEnd = imageLabelEnd(raw);
        node.imageSourceKind = node.type;
        node.imageSource = raw;
        node.imageSourceSuffix = labelEnd >= 0 ? raw.slice(labelEnd + 1) : null;
        node.imageSourceAlt = node.alt || "";
        if (node.type === "image") {
          node.imageSourceUrl = node.url || "";
          node.imageSourceTitle = node.title ?? null;
        } else {
          node.imageSourceReferenceType = node.referenceType;
          node.imageSourceIdentifier = node.identifier;
          node.imageSourceLabel = node.label || node.identifier;
        }
      }
    }
    if (node?.type === "linkReference" || node?.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      node.resolvedUrl = definition?.url || "";
      node.resolvedTitle = definition?.title ?? null;
    }
    (node?.children || []).forEach(resolve);
  };
  resolve(tree);
  return tree;
}

export const sourceFaithfulReferenceRemark = $remark(
  "tetherSourceFaithfulReference",
  () => () => annotateReferenceSources
);

const referenceAttrs = {
  referenceType: { default: null, validate: "string|null" },
  referenceIdentifier: { default: null, validate: "string|null" },
  referenceLabel: { default: null, validate: "string|null" },
  referenceHref: { default: null, validate: "string|null" },
  referenceTitle: { default: null, validate: "string|null" }
};

const inlineLinkSourceAttrs = {
  linkSourceKind: { default: null, validate: "string|null" },
  linkSourceSuffix: { default: null, validate: "string|null" },
  linkSourceText: { default: null, validate: "string|null" },
  linkSourceHref: { default: null, validate: "string|null" },
  linkSourceTitle: { default: null, validate: "string|null" }
};

const imageSourceAttrs = {
  imageSourceKind: { default: null, validate: "string|null" },
  imageSource: { default: null, validate: "string|null" },
  imageSourceSuffix: { default: null, validate: "string|null" },
  imageSourceAlt: { default: null, validate: "string|null" },
  imageSourceUrl: { default: null, validate: "string|null" },
  imageSourceTitle: { default: null, validate: "string|null" },
  imageSourceReferenceType: { default: null, validate: "string|null" },
  imageSourceIdentifier: { default: null, validate: "string|null" },
  imageSourceLabel: { default: null, validate: "string|null" }
};

function stripReferenceDomAttrs(attributes = {}) {
  const {
    referenceType: _referenceType,
    referenceIdentifier: _referenceIdentifier,
    referenceLabel: _referenceLabel,
    referenceHref: _referenceHref,
    referenceTitle: _referenceTitle,
    linkSourceKind: _linkSourceKind,
    linkSourceSuffix: _linkSourceSuffix,
    linkSourceText: _linkSourceText,
    linkSourceHref: _linkSourceHref,
    linkSourceTitle: _linkSourceTitle,
    imageSourceKind: _imageSourceKind,
    imageSource: _imageSource,
    imageSourceSuffix: _imageSourceSuffix,
    imageSourceAlt: _imageSourceAlt,
    imageSourceUrl: _imageSourceUrl,
    imageSourceTitle: _imageSourceTitle,
    imageSourceReferenceType: _imageSourceReferenceType,
    imageSourceIdentifier: _imageSourceIdentifier,
    imageSourceLabel: _imageSourceLabel,
    ...domAttrs
  } = attributes;
  return domAttrs;
}

function referenceDataAttrs(attrs) {
  return {
    ...(attrs.referenceType && attrs.referenceIdentifier ? {
      "data-md-reference-type": attrs.referenceType,
      "data-md-reference-identifier": attrs.referenceIdentifier,
      "data-md-reference-label": attrs.referenceLabel || attrs.referenceIdentifier,
      "data-md-reference-href": attrs.referenceHref || "",
      ...(attrs.referenceTitle == null ? {} : { "data-md-reference-title": attrs.referenceTitle })
    } : {}),
    ...(attrs.linkSourceKind ? {
      "data-md-link-source-kind": attrs.linkSourceKind,
      ...(attrs.linkSourceSuffix == null ? {} : { "data-md-link-source-suffix": attrs.linkSourceSuffix }),
      ...(attrs.linkSourceText == null ? {} : { "data-md-link-source-text": attrs.linkSourceText }),
      "data-md-link-source-href": attrs.linkSourceHref || "",
      ...(attrs.linkSourceTitle == null ? {} : { "data-md-link-source-title": attrs.linkSourceTitle })
    } : {}),
    ...(attrs.imageSourceKind ? {
      "data-md-image-source-kind": attrs.imageSourceKind,
      ...(attrs.imageSource == null ? {} : { "data-md-image-source": attrs.imageSource }),
      ...(attrs.imageSourceSuffix == null
        ? {}
        : { "data-md-image-source-suffix": attrs.imageSourceSuffix }),
      ...(attrs.imageSourceAlt == null ? {} : { "data-md-image-source-alt": attrs.imageSourceAlt }),
      ...(attrs.imageSourceUrl == null ? {} : { "data-md-image-source-url": attrs.imageSourceUrl }),
      ...(attrs.imageSourceTitle == null
        ? {}
        : { "data-md-image-source-title": attrs.imageSourceTitle }),
      ...(attrs.imageSourceReferenceType == null
        ? {}
        : { "data-md-image-source-reference-type": attrs.imageSourceReferenceType }),
      ...(attrs.imageSourceIdentifier == null
        ? {}
        : { "data-md-image-source-identifier": attrs.imageSourceIdentifier }),
      ...(attrs.imageSourceLabel == null
        ? {}
        : { "data-md-image-source-label": attrs.imageSourceLabel })
    } : {})
  };
}

function parsedReferenceData(dom) {
  if (typeof HTMLElement === "undefined" || !(dom instanceof HTMLElement)) return {};
  const referenceType = dom.dataset.mdReferenceType || null;
  const referenceIdentifier = dom.dataset.mdReferenceIdentifier || null;
  return {
    ...(referenceType && referenceIdentifier ? {
      referenceType,
      referenceIdentifier,
      referenceLabel: dom.dataset.mdReferenceLabel || referenceIdentifier,
      referenceHref: dom.dataset.mdReferenceHref || "",
      referenceTitle: dom.hasAttribute("data-md-reference-title")
        ? dom.dataset.mdReferenceTitle || ""
        : null
    } : {}),
    ...(dom.dataset.mdLinkSourceKind ? {
      linkSourceKind: dom.dataset.mdLinkSourceKind,
      linkSourceSuffix: dom.hasAttribute("data-md-link-source-suffix")
        ? dom.dataset.mdLinkSourceSuffix || ""
        : null,
      linkSourceText: dom.hasAttribute("data-md-link-source-text")
        ? dom.dataset.mdLinkSourceText || ""
        : null,
      linkSourceHref: dom.dataset.mdLinkSourceHref || "",
      linkSourceTitle: dom.hasAttribute("data-md-link-source-title")
        ? dom.dataset.mdLinkSourceTitle || ""
        : null
    } : {}),
    ...(dom.dataset.mdImageSourceKind ? {
      imageSourceKind: dom.dataset.mdImageSourceKind,
      imageSource: dom.hasAttribute("data-md-image-source") ? dom.dataset.mdImageSource || "" : null,
      imageSourceSuffix: dom.hasAttribute("data-md-image-source-suffix")
        ? dom.dataset.mdImageSourceSuffix || ""
        : null,
      imageSourceAlt: dom.hasAttribute("data-md-image-source-alt")
        ? dom.dataset.mdImageSourceAlt || ""
        : null,
      imageSourceUrl: dom.hasAttribute("data-md-image-source-url")
        ? dom.dataset.mdImageSourceUrl || ""
        : null,
      imageSourceTitle: dom.hasAttribute("data-md-image-source-title")
        ? dom.dataset.mdImageSourceTitle || ""
        : null,
      imageSourceReferenceType: dom.dataset.mdImageSourceReferenceType || null,
      imageSourceIdentifier: dom.dataset.mdImageSourceIdentifier || null,
      imageSourceLabel: dom.dataset.mdImageSourceLabel || null
    } : {})
  };
}

function referenceParseDOM(spec) {
  return (spec.parseDOM || []).map((rule) => ({
    ...rule,
    getAttrs: rule.getAttrs
      ? (dom) => {
          const attrs = rule.getAttrs(dom);
          if (attrs === false) return false;
          return { ...(attrs || {}), ...parsedReferenceData(dom) };
        }
      : rule.getAttrs
  }));
}

export const sourceFaithfulReferenceLinkSchema = linkSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: { ...spec.attrs, ...referenceAttrs, ...inlineLinkSourceAttrs },
    parseDOM: referenceParseDOM(spec),
    toDOM: (mark) => {
      const dom = spec.toDOM(mark);
      return [
        dom[0],
        { ...stripReferenceDomAttrs(dom[1]), ...referenceDataAttrs(mark.attrs) },
        ...dom.slice(2)
      ];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      match: (node) => node.type === "link" || node.type === "linkReference",
      runner: (state, node, markType) => {
        if (node.type !== "linkReference") {
          state.openMark(markType, {
            href: node.url,
            title: node.title,
            linkSourceKind: node.linkSourceKind || null,
            linkSourceSuffix: node.linkSourceSuffix ?? null,
            linkSourceText: node.linkSourceText ?? null,
            linkSourceHref: node.linkSourceHref ?? node.url,
            linkSourceTitle: node.linkSourceTitle ?? node.title ?? null
          }).next(node.children).closeMark(markType);
          return;
        }
        state.openMark(markType, {
          href: node.resolvedUrl || "",
          title: node.resolvedTitle ?? null,
          referenceType: node.referenceType,
          referenceIdentifier: node.identifier,
          referenceLabel: node.label || node.identifier,
          referenceHref: node.resolvedUrl || "",
          referenceTitle: node.resolvedTitle ?? null
        }).next(node.children).closeMark(markType);
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, mark) => {
        if (!mark.attrs.referenceType || !mark.attrs.referenceIdentifier) {
          state.withMark(mark, "link", undefined, {
            title: mark.attrs.title,
            url: mark.attrs.href,
            linkSourceKind: mark.attrs.linkSourceKind,
            linkSourceSuffix: mark.attrs.linkSourceSuffix,
            linkSourceText: mark.attrs.linkSourceText,
            linkSourceHref: mark.attrs.linkSourceHref,
            linkSourceTitle: mark.attrs.linkSourceTitle
          });
          return;
        }
        state.withMark(mark, "linkReference", undefined, {
          identifier: mark.attrs.referenceIdentifier,
          label: mark.attrs.referenceLabel || mark.attrs.referenceIdentifier,
          referenceType: mark.attrs.referenceType
        });
      }
    }
  };
});

export const sourceFaithfulReferenceImageSchema = imageSchema.extendSchema((previous) => (ctx) => {
  const spec = previous(ctx);
  return {
    ...spec,
    attrs: { ...spec.attrs, ...referenceAttrs, ...imageSourceAttrs },
    parseDOM: referenceParseDOM(spec),
    toDOM: (node) => {
      const dom = spec.toDOM(node);
      return [
        dom[0],
        { ...stripReferenceDomAttrs(dom[1]), ...referenceDataAttrs(node.attrs) },
        ...dom.slice(2)
      ];
    },
    parseMarkdown: {
      ...spec.parseMarkdown,
      match: (node) => node.type === "image" || node.type === "imageReference",
      runner: (state, node, type) => {
        if (node.type !== "imageReference") {
          state.addNode(type, {
            src: node.url || "",
            alt: node.alt || "",
            title: node.title || "",
            imageSourceKind: node.imageSourceKind || "image",
            imageSource: node.imageSource ?? null,
            imageSourceSuffix: node.imageSourceSuffix ?? null,
            imageSourceAlt: node.imageSourceAlt ?? node.alt ?? "",
            imageSourceUrl: node.imageSourceUrl ?? node.url ?? "",
            imageSourceTitle: node.imageSourceTitle ?? node.title ?? null
          });
          return;
        }
        state.addNode(type, {
          src: node.resolvedUrl || "",
          alt: node.alt || "",
          title: node.resolvedTitle || "",
          referenceType: node.referenceType,
          referenceIdentifier: node.identifier,
          referenceLabel: node.label || node.identifier,
          referenceHref: node.resolvedUrl || "",
          referenceTitle: node.resolvedTitle ?? null,
          imageSourceKind: node.imageSourceKind || "imageReference",
          imageSource: node.imageSource ?? null,
          imageSourceSuffix: node.imageSourceSuffix ?? null,
          imageSourceAlt: node.imageSourceAlt ?? node.alt ?? "",
          imageSourceReferenceType: node.imageSourceReferenceType ?? node.referenceType,
          imageSourceIdentifier: node.imageSourceIdentifier ?? node.identifier,
          imageSourceLabel: node.imageSourceLabel ?? node.label ?? node.identifier
        });
      }
    },
    toMarkdown: {
      ...spec.toMarkdown,
      runner: (state, node) => {
        if (!node.attrs.referenceType || !node.attrs.referenceIdentifier) {
          state.addNode("image", undefined, undefined, {
            title: node.attrs.title,
            url: node.attrs.src,
            alt: node.attrs.alt,
            imageSourceKind: node.attrs.imageSourceKind,
            imageSource: node.attrs.imageSource,
            imageSourceSuffix: node.attrs.imageSourceSuffix,
            imageSourceAlt: node.attrs.imageSourceAlt,
            imageSourceUrl: node.attrs.imageSourceUrl,
            imageSourceTitle: node.attrs.imageSourceTitle
          });
          return;
        }
        state.addNode("imageReference", undefined, undefined, {
          alt: node.attrs.alt,
          identifier: node.attrs.referenceIdentifier,
          label: node.attrs.referenceLabel || node.attrs.referenceIdentifier,
          referenceType: node.attrs.referenceType,
          imageSourceKind: node.attrs.imageSourceKind,
          imageSource: node.attrs.imageSource,
          imageSourceSuffix: node.attrs.imageSourceSuffix,
          imageSourceAlt: node.attrs.imageSourceAlt,
          imageSourceReferenceType: node.attrs.imageSourceReferenceType,
          imageSourceIdentifier: node.attrs.imageSourceIdentifier,
          imageSourceLabel: node.attrs.imageSourceLabel
        });
      }
    }
  };
});

function canonicalImageLabel(canonical) {
  const end = imageLabelEnd(canonical);
  return end >= 0 ? canonical.slice(0, end + 1) : canonical;
}

function inlineImageTargetUnchanged(node) {
  return node.imageSourceKind === "image"
    && (node.url || "") === (node.imageSourceUrl || "")
    && (node.title || "") === (node.imageSourceTitle || "");
}

function referenceImageTargetUnchanged(node) {
  return node.imageSourceKind === "imageReference"
    && node.referenceType === node.imageSourceReferenceType
    && node.identifier === node.imageSourceIdentifier
    && (node.label || node.identifier) === (node.imageSourceLabel || node.imageSourceIdentifier);
}

export function sourceFaithfulImageHandler(node, parent, state, info) {
  if (inlineImageTargetUnchanged(node) && node.imageSource != null) {
    if ((node.alt || "") === (node.imageSourceAlt || "")) return node.imageSource;
    if (node.imageSourceSuffix != null) {
      const canonical = defaultHandlers.image(node, parent, state, info);
      return `${canonicalImageLabel(canonical)}${node.imageSourceSuffix}`;
    }
  }
  return defaultHandlers.image(node, parent, state, info);
}

export function sourceFaithfulImageReferenceHandler(node, parent, state, info) {
  if (referenceImageTargetUnchanged(node) && node.imageSource != null) {
    if ((node.alt || "") === (node.imageSourceAlt || "")) return node.imageSource;
    if (node.imageSourceSuffix != null) {
      const canonical = defaultHandlers.imageReference(node, parent, state, info);
      return `${canonicalImageLabel(canonical)}${node.imageSourceSuffix}`;
    }
  }
  return defaultHandlers.imageReference(node, parent, state, info);
}

sourceFaithfulImageHandler.peek = defaultHandlers.image.peek;
sourceFaithfulImageReferenceHandler.peek = defaultHandlers.imageReference.peek;

export const sourceFaithfulReferenceDefinitionSchema = $nodeSchema("link_definition", () => ({
  group: "block",
  atom: true,
  selectable: true,
  defining: true,
  attrs: {
    identifier: { default: "", validate: "string" },
    label: { default: "", validate: "string" },
    url: { default: "", validate: "string" },
    title: { default: null, validate: "string|null" },
    definitionSource: { default: "", validate: "string" },
    adjacentToPreviousDefinition: { default: false, validate: "boolean" }
  },
  parseDOM: [{
    tag: "div[data-type='link_definition']",
    getAttrs: (dom) => ({
      identifier: dom.getAttribute("data-identifier") || "",
      label: dom.getAttribute("data-label") || "",
      url: dom.getAttribute("data-url") || "",
      title: dom.getAttribute("data-title"),
      definitionSource: dom.textContent || "",
      adjacentToPreviousDefinition: dom.getAttribute("data-adjacent") === "true"
    })
  }],
  toDOM: (node) => [
    "div",
    {
      class: "tether-reference-definition",
      "data-type": "link_definition",
      "data-identifier": node.attrs.identifier,
      "data-label": node.attrs.label,
      "data-url": node.attrs.url,
      ...(node.attrs.title == null ? {} : { "data-title": node.attrs.title }),
      "data-adjacent": node.attrs.adjacentToPreviousDefinition
    },
    node.attrs.definitionSource
  ],
  parseMarkdown: {
    match: (node) => node.type === "definition",
    runner: (state, node, type) => {
      state.addNode(type, {
        identifier: node.identifier,
        label: node.label || node.identifier,
        url: node.url,
        title: node.title ?? null,
        definitionSource: node.definitionSource || "",
        adjacentToPreviousDefinition: Boolean(node.adjacentToPreviousDefinition)
      });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === "link_definition",
    runner: (state, node) => {
      state.addNode("definition", undefined, undefined, {
        identifier: node.attrs.identifier,
        label: node.attrs.label,
        url: node.attrs.url,
        title: node.attrs.title,
        definitionSource: node.attrs.definitionSource,
        adjacentToPreviousDefinition: node.attrs.adjacentToPreviousDefinition
      });
    }
  }
}));

export function sourceFaithfulDefinitionHandler(node, _parent, _state, _info) {
  return node.definitionSource || `[${node.label || node.identifier}]: ${node.url}`;
}

export function sourceFaithfulLinkHandler(node, parent, state, info) {
  const canonical = defaultHandlers.link(node, parent, state, info);
  if (
    node.linkSourceKind === "inline"
    && node.linkSourceSuffix
    && node.url === node.linkSourceHref
    && (node.title ?? null) === (node.linkSourceTitle ?? null)
  ) {
    const labelEnd = canonical.indexOf("](");
    if (labelEnd >= 0) return `${canonical.slice(0, labelEnd + 1)}${node.linkSourceSuffix}`;
    const reference = defaultHandlers.linkReference({
      type: "linkReference",
      children: node.children,
      identifier: "tether-reference-label",
      label: "tether-reference-label",
      referenceType: "full"
    }, parent, state, info);
    const referenceEnd = reference.lastIndexOf("][");
    if (referenceEnd >= 0) return `${reference.slice(0, referenceEnd + 1)}${node.linkSourceSuffix}`;
  }
  return canonical;
}

sourceFaithfulLinkHandler.peek = defaultHandlers.link.peek;

function documentDefinitions(doc) {
  const definitions = new Map();
  doc.descendants((node) => {
    if (node.type.name !== "link_definition") return;
    if (!definitions.has(node.attrs.identifier)) {
      definitions.set(node.attrs.identifier, {
        url: node.attrs.url,
        title: node.attrs.title ?? null,
        source: node.attrs.definitionSource
      });
    }
  });
  return definitions;
}

function definitionsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [identifier, definition] of left) {
    const other = right.get(identifier);
    if (
      !other
      || other.url !== definition.url
      || other.title !== definition.title
      || other.source !== definition.source
    ) return false;
  }
  return true;
}

function clearReferenceAttrs(attrs) {
  return {
    ...attrs,
    referenceType: null,
    referenceIdentifier: null,
    referenceLabel: null,
    referenceHref: null,
    referenceTitle: null
  };
}

function clearInlineLinkSourceAttrs(attrs) {
  return {
    ...attrs,
    linkSourceKind: null,
    linkSourceSuffix: null,
    linkSourceText: null,
    linkSourceHref: null,
    linkSourceTitle: null
  };
}

export function referenceSyncTransaction(oldState, newState) {
  const oldDefinitions = documentDefinitions(oldState.doc);
  const definitions = documentDefinitions(newState.doc);
  const definitionsChanged = !definitionsEqual(oldDefinitions, definitions);
  let transaction = newState.tr;
  let changed = false;

  newState.doc.descendants((node, position) => {
    if (node.isText) {
      for (const mark of node.marks) {
        if (mark.type.name !== "link") continue;
        if (!mark.attrs.referenceType) {
          if (
            !mark.attrs.linkSourceKind
            || (mark.attrs.href === mark.attrs.linkSourceHref
              && mark.attrs.title === mark.attrs.linkSourceTitle)
          ) continue;
          const replacement = mark.type.create(clearInlineLinkSourceAttrs(mark.attrs));
          transaction = transaction
            .removeMark(position, position + node.nodeSize, mark)
            .addMark(position, position + node.nodeSize, replacement);
          changed = true;
          continue;
        }
        const definition = definitions.get(mark.attrs.referenceIdentifier) || { url: "", title: null };
        const targetAttrs = definitionsChanged
          ? {
              ...mark.attrs,
              href: definition.url,
              title: definition.title,
              referenceHref: definition.url,
              referenceTitle: definition.title
            }
          : mark.attrs.href !== mark.attrs.referenceHref || mark.attrs.title !== mark.attrs.referenceTitle
            ? clearReferenceAttrs(mark.attrs)
            : null;
        if (!targetAttrs) continue;
        const replacement = mark.type.create(targetAttrs);
        transaction = transaction
          .removeMark(position, position + node.nodeSize, mark)
          .addMark(position, position + node.nodeSize, replacement);
        changed = true;
      }
      return;
    }

    if (node.type.name !== "image" || !node.attrs.referenceType) return;
    const definition = definitions.get(node.attrs.referenceIdentifier) || { url: "", title: null };
    const targetAttrs = definitionsChanged
      ? {
          ...node.attrs,
          src: definition.url,
          title: definition.title || "",
          referenceHref: definition.url,
          referenceTitle: definition.title
        }
      : node.attrs.src !== node.attrs.referenceHref
        || (node.attrs.title || null) !== node.attrs.referenceTitle
        ? clearReferenceAttrs(node.attrs)
        : null;
    if (!targetAttrs) return;
    transaction = transaction.setNodeMarkup(position, undefined, targetAttrs);
    changed = true;
  });

  return changed ? transaction : null;
}

export const sourceFaithfulReferenceSyncPlugin = $prose(() => new Plugin({
  appendTransaction(transactions, oldState, newState) {
    if (!transactions.some((transaction) => transaction.docChanged)) return null;
    return referenceSyncTransaction(oldState, newState);
  }
}));
