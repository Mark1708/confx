import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import type { InlineConfig, Plugin } from "vite";
import { defineConfig, build as viteBuild } from "vite";
import { generateManifest } from "./src/manifest";

const target = process.env.TARGET ?? "chrome";

function copyDirectoryPlugin(name: string, source: string, destination: string): Plugin {
  return {
    name,
    writeBundle: (options: { dir?: string }) => {
      const sourceDir = path.resolve(__dirname, source);
      const outputDir = path.resolve(__dirname, options.dir ?? "dist", destination);

      if (!existsSync(sourceDir)) {
        return;
      }

      cpSync(sourceDir, outputDir, { recursive: true });
    },
  };
}

function manifestPlugin(): Plugin {
  return {
    name: "confx-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: JSON.stringify(generateManifest(), null, 2),
      });
    },
  };
}

function htmlEntriesPlugin(): Plugin {
  const entries = [
    "sidepanel/index.html",
    "options/index.html",
    "viewer/index.html",
    "offscreen/icon-theme.html",
  ] as const;
  return {
    name: "confx-html-entries",
    writeBundle: (options: { dir?: string }) => {
      const outputRoot = path.resolve(__dirname, options.dir ?? "dist");
      entries.forEach((entry) => {
        const source = path.join(outputRoot, "src", entry);
        const destination = path.join(outputRoot, entry);
        if (!existsSync(source)) return;
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(source, destination);
      });
    },
  };
}

function extensionScriptConfig(entry: string, fileName: string, outDir: string): InlineConfig {
  return {
    configFile: false,
    publicDir: false,
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
    build: {
      emptyOutDir: false,
      outDir,
      target: "es2022",
      lib: { entry: path.resolve(__dirname, entry), formats: ["es"] },
      rollupOptions: {
        output: { entryFileNames: fileName, inlineDynamicImports: true },
      },
    },
  };
}

function extensionScriptsPlugin(): Plugin {
  let outDir = path.resolve(__dirname, "dist");
  return {
    name: "confx-extension-scripts",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await viteBuild(extensionScriptConfig("src/content/picker-entry.ts", "content-scripts/picker-entry.js", outDir));
      await viteBuild(extensionScriptConfig("src/background/service-worker.ts", "background/service-worker.js", outDir));
    },
  };
}

function entryFileName(chunkName: string): string {
  if (chunkName === "content-scripts/picker-entry") return "content-scripts/picker-entry.js";
  if (chunkName === "background/service-worker") return "background/service-worker.js";
  return "assets/[name]-[hash].js";
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "confx-target-html",
      transformIndexHtml: (html) => html.split("%TARGET%").join(target),
    },
    manifestPlugin(),
    htmlEntriesPlugin(),
    extensionScriptsPlugin(),
    copyDirectoryPlugin("confx-copy-locales", "public/_locales", "_locales"),
    copyDirectoryPlugin("confx-copy-assets", "src/assets", "assets"),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        viewer: path.resolve(__dirname, "src/viewer/index.html"),
        sidepanel: path.resolve(__dirname, "src/sidepanel/index.html"),
        options: path.resolve(__dirname, "src/options/index.html"),
        "icon-theme": path.resolve(__dirname, "src/offscreen/icon-theme.html"),
        "content-scripts/picker-entry": path.resolve(__dirname, "src/content/picker-entry.ts"),
        "background/service-worker": path.resolve(__dirname, "src/background/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) => entryFileName(chunk.name),
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
