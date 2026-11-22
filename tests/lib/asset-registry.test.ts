import { describe, expect, it } from "vitest";
import { AssetRegistry } from "../../src/lib/export/asset-registry";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = `${"b".repeat(8)}${"c".repeat(56)}`;

function registry(deduplicate = true) {
  const assets = new AssetRegistry(deduplicate);
  for (const folder of ["lorem", "lorem/ipsum", "dolor"]) assets.protectPage(folder);
  return assets;
}

describe("committed canonical assets", () => {
  it("reuses only committed physical paths across pages and normalizes extensions", () => {
    const assets = registry();
    const first = assets.beginPage("lorem");
    expect(first.reserve(HASH_A, "PNG", "lorem/images/shared.png")).toEqual({
      archivePath: "lorem/images/shared.png", isNew: true,
    });
    first.commit();
    const second = assets.beginPage("dolor");
    expect(second.reserve(HASH_A, ".png", "dolor/attachments/shared.png")).toEqual({
      archivePath: "lorem/images/shared.png", isNew: false,
    });
    expect(second.reserve(HASH_A, "pdf", "dolor/attachments/shared.pdf").isNew).toBe(true);
  });

  it("never exposes another page's uncommitted reservation", () => {
    const assets = registry();
    assets.beginPage("lorem").reserve(HASH_A, "png", "lorem/images/shared.png");
    expect(assets.beginPage("dolor").reserve(HASH_A, "png", "dolor/images/shared.png")).toEqual({
      archivePath: "dolor/images/shared.png", isNew: true,
    });
  });

  it("discards source-attempt paths and dedup keys before retry", () => {
    const assets = registry();
    const failed = assets.beginPage("lorem");
    failed.reserve(HASH_A, "png", "lorem/images/shared.png");
    failed.discard();
    const retry = assets.beginPage("lorem");
    expect(retry.reserve(HASH_A, "png", "lorem/images/shared.png")).toEqual({
      archivePath: "lorem/images/shared.png", isNew: true,
    });
    retry.commit();
    expect(assets.beginPage("dolor").reserve(HASH_A, "png", "dolor/images/shared.png").isNew).toBe(false);
    expect(() => failed.reserve(HASH_B, "png", "lorem/images/late.png")).toThrow();
    expect(() => failed.commit()).toThrow();
  });

  it("uses hash suffixes for different bytes under the same basename, extending collisions", () => {
    const page = registry().beginPage("lorem");
    const paths = [HASH_A, HASH_B, HASH_C].map((hash) =>
      page.reserve(hash, "pdf", "lorem/attachments/report.pdf").archivePath,
    );
    expect(paths).toEqual([
      "lorem/attachments/report.pdf",
      `lorem/attachments/report-${HASH_B.slice(0, 8)}.pdf`,
      expect.stringMatching(/^lorem\/attachments\/report-b{8}c+\.pdf$/),
    ]);
    expect(new Set(paths).size).toBe(3);
  });

  it("preserves separate files with deterministic numeric collision suffixes when dedup is off", () => {
    const page = registry(false).beginPage("lorem");
    expect([HASH_A, HASH_A, HASH_B].map((hash) =>
      page.reserve(hash, "png", "lorem/images/same.png"),
    )).toEqual([
      { archivePath: "lorem/images/same.png", isNew: true },
      { archivePath: "lorem/images/same-2.png", isNew: true },
      { archivePath: "lorem/images/same-3.png", isNew: true },
    ]);
  });

  it("normalizes NFC and avoids caseless file collisions", () => {
    const page = registry().beginPage("lorem");
    const first = page.reserve(HASH_A, "png", "lorem/images/Cafe\u0301.png");
    const second = page.reserve(HASH_B, "png", "lorem/images/CAFÉ.png");
    expect(first.archivePath).toBe("lorem/images/Café.png");
    expect(second.archivePath.normalize("NFC").toLowerCase()).not.toBe(first.archivePath.toLowerCase());
  });

  it("uses one actual spelling for shared parent directories", () => {
    const page = registry(false).beginPage("lorem");
    const first = page.reserve(HASH_A, "png", "lorem/IMAGES/Subfolder/a.png");
    const second = page.reserve(HASH_B, "png", "lorem/images/subfolder/b.png");
    expect(first.archivePath).toBe("lorem/images/Subfolder/a.png");
    expect(second.archivePath).toBe("lorem/images/Subfolder/b.png");
  });

  it("keeps case-fold-colliding ownership directories distinct", () => {
    const page = registry().beginPage("lorem");
    const first = page.reserve(HASH_A, "png", "lorem/attachments/comments/Foo/shared.png", "comment:Foo");
    const second = page.reserve(HASH_A, "png", "lorem/attachments/comments/foo/shared.png", "comment:foo");
    expect(first.archivePath).toBe("lorem/attachments/comments/Foo/shared.png");
    expect(second.archivePath).toBe(`lorem/attachments/comments/foo-${HASH_A.slice(0, 8)}/shared.png`);
  });

  it("avoids protected page files, directories, and child page prefixes", () => {
    const assets = registry();
    assets.protectPage("lorem/attachments");
    const page = assets.beginPage("lorem");
    for (const [index, proposed] of [
      "lorem/index.md", "lorem/editable.md", "lorem/comments.json", "lorem/history.json",
      "lorem/images", "lorem/attachments/index.md", "lorem/attachments/images",
    ].entries()) {
      const actual = page.reserve(index.toString(16).repeat(64), proposed.endsWith(".md") ? "md" : "json", proposed).archivePath;
      expect(actual.toLowerCase()).not.toBe(proposed.toLowerCase());
    }
  });

  it("renames conflicting parent segments rather than emitting below a file", () => {
    const page = registry(false).beginPage("lorem");
    page.reserve(HASH_A, "bin", "lorem/images/branch");
    const nested = page.reserve(HASH_B, "png", "lorem/images/branch/leaf.png").archivePath;
    expect(nested).not.toBe("lorem/images/branch/leaf.png");
    expect(nested).toMatch(/^lorem\/images\/branch-2\/leaf\.png$/);
    const parent = page.reserve(HASH_A, "bin", "lorem/images/branch-2").archivePath;
    expect(parent).not.toBe("lorem/images/branch-2");
  });

  it("isolates comment ownership and PlantUML pairs from generic byte dedup", () => {
    const assets = registry();
    const page = assets.beginPage("lorem");
    const generic = page.reserve(HASH_A, "png", "lorem/images/shared.png");
    const commentA = page.reserve(HASH_A, "png", "lorem/attachments/comments/a/shared.png", "comment:a");
    const commentB = page.reserve(HASH_A, "png", "lorem/attachments/comments/b/shared.png", "comment:b");
    const uml = page.reserve(HASH_A, "png", "lorem/attachments/linked/plantuml/diagram.png", "plantuml:lorem:diagram");
    expect(new Set([generic, commentA, commentB, uml].map((entry) => entry.archivePath)).size).toBe(4);
    expect([generic, commentA, commentB, uml].every((entry) => entry.isNew)).toBe(true);
    page.commit();
    expect(assets.beginPage("dolor").reserve(HASH_A, "png", "dolor/attachments/linked/plantuml/diagram.png", "plantuml:dolor:diagram").isNew).toBe(true);
  });

  it.each(["/absolute.png", "C:/drive.png", "a\\b.png", "a//b.png", "a/../b.png", "a/./b.png", "a/\0b.png"])("rejects unsafe proposed path %s before links are made", (path) => {
    expect(() => registry().beginPage("lorem").reserve(HASH_A, "png", path)).toThrow();
  });
});
