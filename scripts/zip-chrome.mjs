#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const MANIFEST = path.join(DIST, "manifest.json");
const RELEASE_DIR = path.join(ROOT, "release");
const ZIP_PATH = path.join(RELEASE_DIR, "confx-chrome.zip");

if (!existsSync(MANIFEST)) {
  console.error(`[zip:chrome] dist not found: ${MANIFEST}\n  run: npm run build:chrome`);
  process.exit(1);
}

function collectFiles(directory, prefix = "") {
  return readdirSync(directory).reduce((files, entry) => {
    const absolutePath = path.join(directory, entry);
    const archivePath = prefix ? `${prefix}/${entry}` : entry;
    const stats = statSync(absolutePath);

    if (stats.isDirectory()) {
      return { ...files, ...collectFiles(absolutePath, archivePath) };
    }

    return { ...files, [archivePath]: readFileSync(absolutePath) };
  }, {});
}

const files = collectFiles(DIST);

if (!files["manifest.json"]) {
  console.error("[zip:chrome] manifest.json must be at archive root");
  process.exit(1);
}

mkdirSync(RELEASE_DIR, { recursive: true });
writeFileSync(ZIP_PATH, zipSync(files, { level: 9 }));

console.log(`[zip:chrome] packed -> ${path.relative(ROOT, ZIP_PATH)}`);
