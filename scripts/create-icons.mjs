import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

// Run explicitly with `node scripts/create-icons.mjs` (or `npm run icons:generate`).
// Normal builds consume committed assets and never launch or install Chromium.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "src/assets");
const svgPath = join(assets, "icon.svg");
const modes = ["light", "dark"];
const palettes = ["violet", "blue", "forest", "graphite", "amber"];
const toolbarSizes = [16, 20, 24, 32, 40, 48, 64];
const pngImageChunks = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

function withoutMetadata(png) {
  const chunks = [png.subarray(0, 8)];
  for (let offset = 8; offset < png.length; ) {
    const end = offset + png.readUInt32BE(offset) + 12;
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (pngImageChunks.has(type)) chunks.push(png.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(chunks);
}

async function launchChromium() {
  try {
    await access(chromium.executablePath());
  } catch (cause) {
    throw new Error(
      "Bundled Playwright Chromium is missing. Install it explicitly with `npx playwright install chromium`, then rerun `npm run icons:generate`. Nothing was installed or generated.",
      { cause },
    );
  }
  try {
    return await chromium.launch({
      channel: "chromium",
      headless: true,
      args: ["--force-color-profile=srgb", "--disable-background-networking"],
    });
  } catch (cause) {
    throw new Error("Bundled Playwright Chromium could not launch; no icons were generated.", {
      cause,
    });
  }
}

async function generate() {
  const [sourceSvg, appearanceCss] = await Promise.all([
    readFile(svgPath, "utf8"),
    readFile(join(root, "src/lib/appearance.css"), "utf8"),
  ]);
  const browser = await launchChromium();
  const output = [];
  let defaultSvg;
  try {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      viewport: { width: 128, height: 128 },
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      colorScheme: "light",
      offline: true,
    });
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body><div id="icon-root" data-confx-appearance></div></body></html>',
    );
    await page.addStyleTag({ content: appearanceCss });

    async function rasterize(mode, palette, size) {
      await page.setViewportSize({ width: size, height: size });
      const svg = await page.evaluate(
        ({ sourceSvg, mode, palette, size }) => {
          const root = document.getElementById("icon-root");
          root.dataset.theme = mode;
          root.dataset.palette = palette;
          const source = new DOMParser().parseFromString(sourceSvg, "image/svg+xml");
          if (source.querySelector("parsererror")) throw new Error("Invalid src/assets/icon.svg");
          const icon = document.importNode(source.documentElement, true);
          if (icon.getAttribute("viewBox") !== "0 0 16 16") {
            throw new Error("Icon geometry must use the 16px source grid.");
          }
          icon.setAttribute("width", String(size));
          icon.setAttribute("height", String(size));
          icon.setAttribute("viewBox", `0 0 ${size} ${size}`);
          root.replaceChildren(icon);
          const colorProbe = document.createElement("span");
          colorProbe.hidden = true;
          root.append(colorProbe);

          for (const path of icon.querySelectorAll("path")) {
            const token = path.getAttribute("data-icon-color");
            if (!["surface", "foreground", "primary", "primary-foreground"].includes(token)) {
              throw new Error(`Unknown icon appearance token: ${token}`);
            }
            // Resolve actual CSS colors in the same scoped root used by extension surfaces.
            colorProbe.style.color = `hsl(var(--${token}))`;
            const fill = getComputedStyle(colorProbe).color;
            path.removeAttribute("style");
            path.setAttribute("fill", fill);

            const geometry = path.getAttribute("d");
            if (!geometry || /[^MLHVQZ\d\s.,-]/.test(geometry)) {
              throw new Error("Icon paths must use absolute M/L/H/V/Q/Z coordinates.");
            }
            // Map the source's 1..15 range onto 1..(size-1), then snap filled edges.
            // Rasterize this native-size SVG directly; never resize an existing PNG.
            path.setAttribute(
              "d",
              geometry.replace(/-?\d+(?:\.\d+)?/g, (coordinate) => {
                const value = Number(coordinate);
                if (value < 1 || value > 15) {
                  throw new Error("Icon geometry must stay inside the 1px source safe margin.");
                }
                return String(Math.round(1 + ((value - 1) * (size - 2)) / 14));
              }),
            );
          }
          colorProbe.remove();
          return new XMLSerializer().serializeToString(icon);
        },
        { sourceSvg, mode, palette, size },
      );
      const png = withoutMetadata(
        await page.screenshot({
          type: "png",
          omitBackground: true,
          animations: "disabled",
          scale: "css",
        }),
      );
      return { png, svg };
    }

    for (const mode of modes) {
      for (const palette of palettes) {
        for (const size of toolbarSizes) {
          const { png, svg } = await rasterize(mode, palette, size);
          output.push({ path: join(assets, `icons/${mode}-${palette}-${size}.png`), content: png });
          if (mode === "dark" && palette === "violet") {
            output.push({ path: join(assets, `icon-${size}.png`), content: png });
            if (size === 16) defaultSvg = `${svg}\n`;
          }
        }
      }
    }
    const { png } = await rasterize("dark", "violet", 128);
    output.push({ path: join(assets, "icon-128.png"), content: png });
  } finally {
    await browser.close();
  }

  // Keep all existing assets untouched if browser rendering fails partway through.
  await mkdir(join(assets, "icons"), { recursive: true });
  for (const file of output) await writeFile(file.path, file.content);
  await writeFile(svgPath, defaultSvg);
  console.log(
    "[icons:generate] Generated 70 themed PNGs, 8 dark-violet PNGs, and dark-violet icon.svg.",
  );
}

generate().catch((error) => {
  console.error(`[icons:generate] ${error.message}`);
  if (error.cause) console.error(error.cause.message);
  process.exitCode = 1;
});
