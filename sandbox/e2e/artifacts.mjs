import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect } from "@playwright/test";
import { marked } from "marked";

export function readZipArchive(bytes) {
  const entries = unzipSync(new Uint8Array(bytes));
  const names = Object.keys(entries);
  const roots = [...new Set(names.map((name) => name.split("/")[0]))];
  expect(roots, "A real export ZIP has one content root").toHaveLength(1);
  const root = `${roots[0]}/`;
  expect(names.every((name) => name.startsWith(root))).toBe(true);
  return {
    entries,
    root,
    text(path) {
      expect(entries[root + path], `Archive member ${path}`).toBeDefined();
      return strFromU8(entries[root + path]);
    },
  };
}

export function readArchive(bytes) {
  const archive = readZipArchive(bytes);
  const manifests = Object.keys(archive.entries).filter((name) => /\/manifest\.json$/.test(name));
  expect(manifests, "A real page/tree ZIP contains one export manifest").toHaveLength(1);
  expect(manifests[0]).toBe(`${archive.root}manifest.json`);
  return { ...archive, manifest: JSON.parse(archive.text("manifest.json")) };
}

export function expectLocalMarkdownTargets(archive, markdownPaths) {
  const links = [];
  for (const from of markdownPaths) {
    const tokens = marked.lexer(archive.text(from), { gfm: true });
    marked.walkTokens(tokens, (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const href = token.href;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return;
      const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      expect(posix.isAbsolute(pathname), `${from}: ${href} must be archive-relative`).toBe(false);
      const fullPath = posix.normalize(
        posix.join(archive.root, posix.dirname(from), pathname || posix.basename(from)),
      );
      expect(fullPath.startsWith(archive.root), `${from}: ${href} stays inside the ZIP`).toBe(true);
      expect(
        archive.entries[fullPath],
        `${from}: local target ${href} is actually written`,
      ).toBeDefined();
      links.push({ from, href, target: fullPath.slice(archive.root.length), kind: token.type });
    });
  }
  return links;
}

export async function readDownloadedArchive(download) {
  return readArchive(await readFile(download.path));
}

export function readEditableArtifact(text, kind) {
  const expression = new RegExp(`\\n\\n<!-- confx:${kind}-markdown (.*) -->\\s*$`);
  const footer = expression.exec(text);
  expect(footer, `Downloaded ${kind} Markdown has its real metadata footer`).not.toBeNull();
  const metadata = JSON.parse(footer[1]);
  expect(metadata.format).toMatch(new RegExp(`^confx-${kind}-markdown/[12]$`));
  const markdown = text.slice(0, footer.index);
  if (kind === "storage") {
    const source = Buffer.from(metadata.source, "base64").toString("utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe(metadata.sourceHash);
    return { metadata, markdown, source };
  }
  const entries = unzipSync(new Uint8Array(Buffer.from(metadata.archive, "base64")));
  expect(Object.keys(entries).sort()).toEqual([
    ".confx/baseline.md",
    ".confx/mapping.json",
    ".confx/source.html",
    "index.md",
    "manifest.json",
  ]);
  expect(strFromU8(entries["index.md"])).toBe(markdown);
  expect(strFromU8(entries[".confx/baseline.md"])).toBe(markdown);
  return {
    metadata,
    markdown,
    source: strFromU8(entries[".confx/source.html"]),
    manifest: JSON.parse(strFromU8(entries["manifest.json"])),
  };
}

export function editVisibleMarkdown(text, before, after) {
  const footer = text.lastIndexOf("\n\n<!-- confx:");
  expect(footer, "Edit only visible Markdown; retain the exported source footer").toBeGreaterThan(
    0,
  );
  const visible = text.slice(0, footer);
  expect(visible, `The independent fixture text ${JSON.stringify(before)} is editable`).toContain(
    before,
  );
  expect(after).not.toBe(before);
  const changed = visible.replace(before, after) + text.slice(footer);
  expect(changed.slice(changed.lastIndexOf("\n\n<!-- confx:"))).toBe(text.slice(footer));
  return changed;
}

export function alterProtectedBlock(text) {
  const protectedText = /\[Confx protected [^\]\n]+\]/.exec(text);
  expect(protectedText, "The real exporter visibly marks protected Storage content").not.toBeNull();
  return editVisibleMarkdown(text, protectedText[0], "Lorem attempted protected replacement");
}

export function successfulWrites(entries) {
  return entries.filter(
    (entry) =>
      entry.status >= 200 && entry.status < 300 && /^(POST|PUT|PATCH|DELETE)$/.test(entry.method),
  );
}

export function publishWrites(entries) {
  return entries.filter(
    (entry) => entry.method === "PUT" && /^\/rest\/api\/content\/\d+$/.test(entry.path),
  );
}

export function draftWrites(entries) {
  return entries.filter(
    (entry) => entry.method !== "GET" && /\/pages\/\d+\/draft$/.test(entry.path),
  );
}

export function conversions(entries) {
  return entries.filter(
    (entry) =>
      entry.method === "POST" &&
      /^\/rest\/api\/contentbody\/convert\/(editor|storage)$/.test(entry.path),
  );
}

export function expectReadOnlyConversions(entries) {
  expect(publishWrites(entries), "Confx export/import/apply must not publish").toEqual([]);
  expect(
    draftWrites(entries),
    "Explicit-only drafts must not be created by conversion or apply",
  ).toEqual([]);
  expect(successfulWrites(entries).every((entry) => conversions([entry]).length === 1)).toBe(true);
  for (const entry of conversions(entries)) {
    expect(entry).toMatchObject({ kind: "conversion", status: 200 });
  }
}
