import { useEffect, useRef, useState } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { latex } from "@milkdown/crepe/feature/latex";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { editorViewCtx } from "@milkdown/kit/core";
import { replaceAll } from "@milkdown/kit/utils";
import { tetherCodeExtensions, tetherCodeLanguages } from "./lib/codeEditor.js";
import { activateMarkdownSourceAt, markdownSyntaxPlugin } from "./lib/markdownSyntaxPlugin.js";

export default function WysiwygSurface({ content, documentId, onChange, onNotice }) {
  const hostRef = useRef(null);
  const crepeRef = useRef(null);
  const contentRef = useRef(content);
  const onChangeRef = useRef(onChange);
  const onNoticeRef = useRef(onNotice);
  const lastMarkdownRef = useRef(content);
  const baselineMarkdownRef = useRef(content);
  const applyingExternalRef = useRef(false);
  const hasUserChangeRef = useRef(false);
  const [state, setState] = useState("loading");

  contentRef.current = content;
  onChangeRef.current = onChange;
  onNoticeRef.current = onNotice;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let disposed = false;
    let created = false;
    const blockTransientImage = (event) => {
      const transfer = event.clipboardData || event.dataTransfer;
      const hasImageFile = Array.from(transfer?.items || transfer?.files || []).some((item) =>
        item.type?.startsWith("image/")
      );
      if (!hasImageFile) return;
      event.preventDefault();
      event.stopPropagation();
      onNoticeRef.current?.("Paste a Markdown image URL; embedded image files are not stored yet");
    };
    const activateFencedSource = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const block = target?.closest(".milkdown-code-block");
      if (!block || target.closest(".tether-continuous-source")) return;
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;

      const view = crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx));
      if (!view) return;
      let position;
      try {
        position = view.posAtDOM(block, 0, -1);
      } catch {
        return;
      }
      if (view.state.doc.nodeAt(position)?.type.name === "code_block") position += 1;
      requestAnimationFrame(() => activateMarkdownSourceAt(view, position));
    };
    const prepareMarkdownWidgets = () => {
      host.querySelectorAll(".milkdown-code-block .preview-panel").forEach((preview) => {
        preview.tabIndex = 0;
        preview.setAttribute("role", "button");
        preview.setAttribute("aria-label", "Edit block formula");
        preview.setAttribute("title", "Click to edit formula");
      });
      host.querySelectorAll(".milkdown-code-block:not(:has(.preview-panel))").forEach((block) => {
        const language = block.querySelector(".language-button")?.textContent?.trim().toLowerCase() || "";
        const fence = `\`\`\`${language}`;
        block.dataset.tetherFence = fence;
        const codeHost = block.querySelector(".codemirror-host");
        if (codeHost) codeHost.dataset.tetherFence = fence;
      });
    };
    const previewObserver = new MutationObserver(prepareMarkdownWidgets);
    host.addEventListener("paste", blockTransientImage, true);
    host.addEventListener("drop", blockTransientImage, true);
    host.addEventListener("mousedown", activateFencedSource, true);
    host.addEventListener("keydown", activateFencedSource, true);
    previewObserver.observe(host, { childList: true, subtree: true });
    const initialMarkdown = contentRef.current || "";
    lastMarkdownRef.current = initialMarkdown;
    applyingExternalRef.current = true;
    hasUserChangeRef.current = false;
    setState("loading");

    const crepe = new CrepeBuilder({
      root: host,
      defaultValue: initialMarkdown
    })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(blockEdit)
      .addFeature(placeholder, { text: "Start writing…", mode: "doc" })
      .addFeature(toolbar)
      .addFeature(codeMirror, {
        extensions: tetherCodeExtensions,
        languages: tetherCodeLanguages,
        previewOnlyByDefault: true
      })
      .addFeature(table)
      .addFeature(latex);
    crepe.editor.use(markdownSyntaxPlugin);

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        lastMarkdownRef.current = markdown;
        if (applyingExternalRef.current) return;
        if (!hasUserChangeRef.current && markdown === baselineMarkdownRef.current) return;
        hasUserChangeRef.current = true;
        onChangeRef.current?.(markdown);
      });
    });

    crepe
      .create()
      .then(() => {
        created = true;
        if (disposed) {
          void crepe.destroy();
          return;
        }

        crepeRef.current = crepe;
        const editor = host.querySelector(".ProseMirror");
        editor?.setAttribute("aria-label", "Markdown document editor");
        editor?.setAttribute("lang", "en");
        editor?.setAttribute("spellcheck", "true");
        prepareMarkdownWidgets();
        const latestMarkdown = contentRef.current || "";
        if (latestMarkdown !== initialMarkdown) {
          crepe.editor.action(replaceAll(latestMarkdown));
        }
        lastMarkdownRef.current = latestMarkdown;
        baselineMarkdownRef.current = crepe.getMarkdown();
        hasUserChangeRef.current = false;
        applyingExternalRef.current = false;
        setState("ready");
      })
      .catch((error) => {
        applyingExternalRef.current = false;
        console.error("Tether inline editor failed to start", error);
        if (!disposed) setState("error");
      });

    return () => {
      disposed = true;
      host.removeEventListener("paste", blockTransientImage, true);
      host.removeEventListener("drop", blockTransientImage, true);
      host.removeEventListener("mousedown", activateFencedSource, true);
      host.removeEventListener("keydown", activateFencedSource, true);
      previewObserver.disconnect();
      if (crepeRef.current === crepe) crepeRef.current = null;
      if (created) void crepe.destroy();
    };
  }, [documentId]);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (!crepe || state !== "ready") return;
    const nextMarkdown = content || "";
    if (nextMarkdown === lastMarkdownRef.current) return;

    applyingExternalRef.current = true;
    crepe.editor.action(replaceAll(nextMarkdown));
    lastMarkdownRef.current = nextMarkdown;
    baselineMarkdownRef.current = crepe.getMarkdown();
    hasUserChangeRef.current = false;
    queueMicrotask(() => {
      applyingExternalRef.current = false;
    });
  }, [content, state]);

  return (
    <div className={`tether-wysiwyg ${state === "ready" ? "is-ready" : "is-loading"}`}>
      <div ref={hostRef} className="tether-wysiwyg-host" />
      {state === "loading" && <div className="wysiwyg-status">Preparing inline editor…</div>}
      {state === "error" && (
        <div className="wysiwyg-status error" role="alert">
          The inline editor could not start. Switch to Markdown source to keep editing.
        </div>
      )}
    </div>
  );
}
