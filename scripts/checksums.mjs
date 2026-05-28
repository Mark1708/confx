#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, "release");
const ARTIFACTS = ["confx-chrome.zip", "confx-yandex.crx"];
const CHECKSUMS_PATH = path.join(RELEASE_DIR, "SHA256SUMS");

const missingArtifacts = ARTIFACTS.filter((artifact) => !existsSync(path.join(RELEASE_DIR, artifact)));

if (missingArtifacts.length > 0) {
  console.error(`[checksums] missing release artifacts: ${missingArtifacts.join(", ")}`);
  process.exit(1);
}

const lines = ARTIFACTS.map((artifact) => {
  const bytes = readFileSync(path.join(RELEASE_DIR, artifact));
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `${hash}  ${artifact}`;
});

writeFileSync(CHECKSUMS_PATH, `${lines.join("\n")}\n`);

console.log(`[checksums] wrote -> ${path.relative(ROOT, CHECKSUMS_PATH)}`);
