import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.join(projectRoot, "index.html")
      },
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (
            normalizedId.includes("/node_modules/react-markdown/") ||
            normalizedId.includes("/node_modules/remark-") ||
            normalizedId.includes("/node_modules/rehype-") ||
            normalizedId.includes("/node_modules/unified/") ||
            normalizedId.includes("/node_modules/unist-") ||
            normalizedId.includes("/node_modules/mdast-") ||
            normalizedId.includes("/node_modules/hast-") ||
            normalizedId.includes("/node_modules/micromark") ||
            normalizedId.includes("/node_modules/katex/")
          ) {
            return "markdown-vendor";
          }
        }
      }
    }
  }
});
