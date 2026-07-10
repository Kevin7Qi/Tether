import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  base: "./",
  plugins: [react()],
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssMinify: "esbuild",
    rollupOptions: {
      input: {
        index: path.join(projectRoot, "index.html")
      },
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          const codeLanguageMatch = normalizedId.match(
            /\/node_modules\/@codemirror\/(lang-[^/]+|legacy-modes)\//
          );
          if (codeLanguageMatch) {
            return `editor-${codeLanguageMatch[1]}`;
          }
          if (
            normalizedId.includes("/node_modules/@codemirror/") ||
            normalizedId.includes("/node_modules/codemirror/")
          ) {
            return "editor-code";
          }
          if (normalizedId.includes("/node_modules/@milkdown/crepe/")) {
            return "editor-ui";
          }
          if (normalizedId.includes("/node_modules/@milkdown/components/")) {
            return "editor-ui";
          }
          if (
            normalizedId.includes("/node_modules/prosemirror-") ||
            normalizedId.includes("/node_modules/@prosemirror-adapter/")
          ) {
            return "editor-prosemirror";
          }
          if (normalizedId.includes("/node_modules/@milkdown/prose/")) {
            return "editor-prosemirror";
          }
          if (normalizedId.includes("/node_modules/@milkdown/plugin-")) {
            return "editor-plugins";
          }
          if (
            normalizedId.includes("/node_modules/@milkdown/preset-") ||
            normalizedId.includes("/node_modules/@milkdown/transformer/") ||
            normalizedId.includes("/node_modules/remark-") ||
            normalizedId.includes("/node_modules/unified/") ||
            normalizedId.includes("/node_modules/unist-") ||
            normalizedId.includes("/node_modules/mdast-") ||
            normalizedId.includes("/node_modules/micromark")
          ) {
            return "editor-markdown";
          }
          if (
            normalizedId.includes("/node_modules/@milkdown/")
          ) {
            return "editor-core";
          }
        }
      }
    }
  }
});
