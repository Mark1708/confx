import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = join(root, "tests/reports/readme-preview/staged");
const manifestPath = join(stageRoot, "manifest.json");
const locales = ["en", "ru"];
const maxBytes = 5 * 1024 * 1024;
const RAW_TAIL_SECONDS = 0.5;
const stages = ["page", "subtree", "editable-off", "editable-on", "summary", "ready"].flatMap(
  (name) => [`${name}-before`, `${name}-after`],
);
const require = createRequire(import.meta.url);

function run(bin, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: root,
      env,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(`${bin} failed (${signal ?? code})${capture ? `: ${stderr.trim()}` : ""}`),
          ),
    );
  });
}

async function prerequisites() {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      await run(bin, ["-version"], { capture: true });
    } catch (cause) {
      throw new Error(
        `Install FFmpeg with ffprobe and put both binaries in PATH before generating previews (${bin} unavailable).`,
        { cause },
      );
    }
  }
}

async function hash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function inventory(directory = join(root, "dist"), prefix = "") {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    assert(!entry.isSymbolicLink(), "dist inventory must not contain symlinks");
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...(await inventory(path, `${name}/`)));
    else if (entry.isFile()) result.push({ path: name, sha256: await hash(path) });
    else throw new Error("Unexpected dist inventory member");
  }
  return result;
}

function assertReceipt(receipt, locale, version) {
  assert.equal(receipt.schema, 1, "Unsupported capture schema");
  assert.equal(receipt.locale, locale, "Wrong capture locale");
  assert.equal(receipt.extensionVersion, version, "Capture extension version is stale");
  assert.deepEqual(receipt.viewport, { width: 1120, height: 900 });
  assert(
    Number.isFinite(receipt.clipStartSeconds) && receipt.clipStartSeconds >= 0,
    "Invalid trim start",
  );
  assert(
    Number.isFinite(receipt.clipDurationSeconds) &&
      receipt.clipDurationSeconds >= 12 &&
      receipt.clipDurationSeconds <= 30,
    "Capture must be 12–30 seconds; never time-stretch it",
  );
  assert.deepEqual(receipt.pages, ["1700", "1710"]);
  assert.equal(receipt.editableSidecars, 2);
  for (const key of [
    "completedDownload",
    "localMarkdownTargets",
    "noExternalRequests",
    "readOnlyConversions",
    "noPublicationDraftAttachmentWrites",
    "publishedUnchanged",
  ]) {
    assert.equal(receipt[key], true, `Missing actual export proof: ${key}`);
  }
  assert.deepEqual(
    receipt.stages.map((stage) => stage.name),
    stages,
  );
  let previous = -1;
  for (const [index, stage] of receipt.stages.entries()) {
    assert.equal(stage.screenshot, `${String(index).padStart(2, "0")}-${stage.name}.png`);
    assert(Number.isFinite(stage.seconds) && stage.seconds >= previous, "Invalid stage times");
    assert(
      stage.seconds <= receipt.clipStartSeconds + receipt.clipDurationSeconds,
      "Stage lies outside capture",
    );
    previous = stage.seconds;
  }
  assert.equal(
    receipt.clipStartSeconds,
    receipt.stages[0].seconds + 0.25,
    "Missing setup-frame padding",
  );
}

async function validateGif(path) {
  const probe = JSON.parse(
    await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=codec_name,width,height,nb_read_frames:format=duration",
        "-of",
        "json",
        path,
      ],
      { capture: true },
    ),
  );
  assert.equal(probe.streams.length, 1, "GIF must have one video stream");
  const stream = probe.streams[0];
  assert.equal(stream.codec_name, "gif");
  const metrics = {
    bytes: (await stat(path)).size,
    width: stream.width,
    height: stream.height,
    duration: Number(probe.format.duration),
    frames: Number(stream.nb_read_frames),
  };
  assert(metrics.bytes <= maxBytes, "GIF exceeds 5 MiB");
  assert(metrics.width === 800 || metrics.width === 960, "Wrong GIF width");
  assert(
    Math.abs(metrics.width / metrics.height / (1120 / 900) - 1) <= 0.005,
    "Wrong GIF aspect ratio",
  );
  assert(metrics.duration >= 12 && metrics.duration <= 30, "GIF duration must be 12–30 seconds");
  assert(metrics.frames > 1, "Preview must be animated");
  await run("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"], { capture: true });
  return metrics;
}

async function validateRaw(path, receipt) {
  const probe = JSON.parse(
    await run(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
      { capture: true },
    ),
  );
  assert.equal(probe.streams.length, 1);
  assert.equal(probe.streams[0].width, 1120);
  assert.equal(probe.streams[0].height, 900);
  assert(
    Number(probe.format.duration) >=
      receipt.clipStartSeconds + receipt.clipDurationSeconds + RAW_TAIL_SECONDS,
    "Raw recording must contain the clip plus 0.5s shutdown padding",
  );
}

async function encode(locale, version) {
  const directory = join(stageRoot, locale);
  const receipt = JSON.parse(await readFile(join(directory, "capture.json"), "utf8"));
  assertReceipt(receipt, locale, version);
  const source = join(directory, "capture.webm");
  await validateRaw(source, receipt);
  const gif = `confx-export-${locale}.gif`;
  const target = join(stageRoot, gif);
  for (const [width, fps, colors] of [
    [960, 8, 128],
    [800, 8, 128],
    [800, 6, 96],
  ]) {
    const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      source,
      "-ss",
      String(receipt.clipStartSeconds),
      "-t",
      String(receipt.clipDurationSeconds),
      "-filter_complex",
      filter,
      "-an",
      "-map_metadata",
      "-1",
      "-loop",
      "0",
      target,
    ]);
    if ((await stat(target)).size <= maxBytes) {
      const metrics = await validateGif(target);
      return {
        locale,
        gif,
        sha256: await hash(target),
        ...metrics,
        receipt,
        captureSha256: await hash(join(directory, "capture.json")),
        videoSha256: await hash(source),
        stageHashes: await Promise.all(
          receipt.stages.map(async (stage) => ({
            path: stage.screenshot,
            sha256: await hash(join(directory, stage.screenshot)),
          })),
        ),
      };
    }
  }
  throw new Error(
    `${locale} GIF exceeds 5 MiB after all three encoding profiles; public media was not touched.`,
  );
}

async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Preview port ${port} is occupied/unavailable. Set an explicit free SANDBOX_E2E_PORT and run again; no server was stopped or reused.`,
        ),
      ),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

async function generate() {
  try {
    await access(chromium.executablePath());
  } catch (cause) {
    throw new Error(
      "Bundled Chromium is missing. Install explicitly: npx playwright install chromium",
      { cause },
    );
  }
  const port = process.env.SANDBOX_E2E_PORT ?? "4189";
  assert(
    /^[1-9]\d*$/.test(port) && Number(port) <= 65535,
    "SANDBOX_E2E_PORT must be a TCP port from 1 to 65535",
  );
  await assertFreePort(Number(port));
  const dist = await inventory();
  const version = JSON.parse(await readFile(join(root, "dist/manifest.json"), "utf8")).version;
  await mkdir(stageRoot, { recursive: true });
  await rm(manifestPath, { force: true });
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  await run(process.execPath, [cli, "test", "--config", "playwright.preview.config.mjs"], {
    env: { ...process.env, SANDBOX_E2E_PORT: port },
  });
  assert.deepEqual(await inventory(), dist, "dist changed during capture; record a fresh build");
  const captures = [];
  for (const locale of locales) captures.push(await encode(locale, version));
  await writeFile(manifestPath, JSON.stringify({ schema: 1, dist, captures }, null, 2) + "\n");
  console.log(
    "Staged verified EN/RU GIFs and manifest under tests/reports/readme-preview/staged/. Audit stage PNGs and first/middle/last GIF frames with OCR and visual review before --copy-to-docs.",
  );
}

async function copyToDocs() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schema, 1);
  assert.deepEqual(
    await inventory(),
    manifest.dist,
    "Staged media is stale: dist inventory differs",
  );
  assert.deepEqual(
    manifest.captures.map((capture) => capture.locale),
    locales,
  );
  const version = JSON.parse(await readFile(join(root, "dist/manifest.json"), "utf8")).version;
  // Validate both locales before touching either public asset.
  for (const capture of manifest.captures) {
    const { locale } = capture;
    assert.equal(capture.gif, `confx-export-${locale}.gif`);
    assert.equal(
      await hash(join(stageRoot, capture.gif)),
      capture.sha256,
      "Staged GIF hash mismatch",
    );
    assert.deepEqual(await validateGif(join(stageRoot, capture.gif)), {
      bytes: capture.bytes,
      width: capture.width,
      height: capture.height,
      duration: capture.duration,
      frames: capture.frames,
    });
    const directory = join(stageRoot, locale);
    assert.equal(
      await hash(join(directory, "capture.json")),
      capture.captureSha256,
      "Capture receipt hash mismatch",
    );
    const receipt = JSON.parse(await readFile(join(directory, "capture.json"), "utf8"));
    assertReceipt(receipt, locale, version);
    assert.deepEqual(receipt, capture.receipt);
    assert.equal(
      await hash(join(directory, "capture.webm")),
      capture.videoSha256,
      "Recording hash mismatch",
    );
    await validateRaw(join(directory, "capture.webm"), receipt);
    assert.deepEqual(
      capture.stageHashes.map((stage) => stage.path),
      receipt.stages.map((stage) => stage.screenshot),
    );
    for (const stage of capture.stageHashes)
      assert.equal(
        await hash(join(directory, stage.path)),
        stage.sha256,
        "Stage screenshot hash mismatch",
      );
  }
  for (const capture of manifest.captures) {
    const directory = capture.locale === "en" ? "docs/screenshots" : "docs/screenshots-ru";
    await copyFile(join(stageRoot, capture.gif), join(root, directory, capture.gif));
  }
  console.log(
    "Copied both validated previews to their fixed docs paths. Existing static PNGs are unchanged.",
  );
}

try {
  assert(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === "--copy-to-docs"),
    "Usage: node scripts/create-readme-previews.mjs [--copy-to-docs]",
  );
  await prerequisites();
  if (process.argv[2] === "--copy-to-docs") await copyToDocs();
  else await generate();
} catch (error) {
  console.error(`README preview failed: ${error.message}`);
  process.exitCode = 1;
}
