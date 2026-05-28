import path from "node:path";
import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./src/manifest";

const target = process.env.TARGET ?? "chrome";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "confx-target-html",
      transformIndexHtml: (html) => html.split("%TARGET%").join(target),
    },
    crx({ manifest }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        viewer: path.resolve(__dirname, "src/viewer/index.html"),
      },
      output: {
        chunkFileNames: "assets/chunk-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
