#!/usr/bin/env node
import crx3 from "crx3";
import { mkdirSync, readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

const ROOT = process.cwd();
const KEY_PATH = path.resolve(ROOT, process.env.YANDEX_KEY_PATH ?? "keys/yandex.pem");
const DIST = path.join(ROOT, "dist-yandex");
const MANIFEST = path.join(DIST, "manifest.json");
const RELEASE_DIR = path.join(ROOT, "release");
const CRX_PATH = path.join(RELEASE_DIR, "confx-yandex.crx");
const EXPECTED_EXTENSION_ID = process.env.YANDEX_EXTENSION_ID;

if (!existsSync(KEY_PATH)) {
  console.error(
    `[pack:yandex] key not found: ${KEY_PATH}\n` +
      `  provide the existing release key via YANDEX_KEY_PATH; do not generate a new identity`
  );
  process.exit(1);
}

if (!existsSync(MANIFEST)) {
  console.error(
    `[pack:yandex] dist not found: ${MANIFEST}\n` +
      `  run: npm run build:yandex`
  );
  process.exit(1);
}

function readSigningIdentity() {
  const pem = readFileSync(KEY_PATH, "utf-8");
  const publicKey = createPublicKey(createPrivateKey(pem));
  const der = publicKey.export({ format: "der", type: "spki" });
  const publicKeyBase64 = Buffer.from(der).toString("base64");
  const hash = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = hash.replace(/[0-9a-f]/g, (c) =>
    String.fromCharCode(97 + parseInt(c, 16))
  );
  return { id, publicKeyBase64 };
}

const identity = readSigningIdentity();
const extensionId = identity.id;
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
if (manifest.key !== identity.publicKeyBase64) {
  console.error("[pack:yandex] signing key does not match the built public extension identity");
  process.exit(1);
}

if (EXPECTED_EXTENSION_ID && extensionId !== EXPECTED_EXTENSION_ID) {
  console.error(
    `[pack:yandex] extension id mismatch\n` +
      `  expected: ${EXPECTED_EXTENSION_ID}\n` +
      `  actual:   ${extensionId}`
  );
  process.exit(1);
}

mkdirSync(RELEASE_DIR, { recursive: true });

await crx3([MANIFEST], {
  keyPath: KEY_PATH,
  crxPath: CRX_PATH,
});

console.log(`[pack:yandex] packed -> ${path.relative(ROOT, CRX_PATH)}`);
console.log(`[pack:yandex] extension id: ${extensionId}`);
console.log(
  `[pack:yandex] drag ${path.basename(CRX_PATH)} onto browser://tune in Yandex`
);
