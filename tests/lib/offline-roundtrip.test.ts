import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoundtripPackage, applyRoundtripMarkdown } from "@/lib/offline-roundtrip/roundtrip";
import type { EditorSnapshot, RoundtripPackage } from "@/lib/offline-roundtrip/contracts";

const source =
  '<p class="intro">Alpha <span>be</span><span>ta</span> &amp; gamma.</p>' +
  '<table class="confluenceTable" style="width: 75%"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>First<br>Second <code>data.&lt;path&gt;</code></td></tr></tbody></table>' +
  '<pre class="code-fence"><code class="language-text">first<br>second&nbsp;<br><span>\n</span></code></pre>' +
  '<p><img class="editor-inline-macro" src="/placeholder?definition=e3RvY30" data-macro-name="toc" data-macro-id="stable-macro"></p>' +
  '<p class="enh-settings hidden">{}</p>';

function snapshot(html = source): EditorSnapshot {
  return { representation: "editor", html, title: "Offline fixture", pageId: "123" };
}

function editedBlock(
  pkg: RoundtripPackage,
  kind: string,
  edit: (markdown: string) => string,
): string {
  const block = pkg.blocks.find((entry) => entry.kind === kind)!;
  expect(block).toBeDefined();
  const changed = edit(block.markdown);
  expect(changed).not.toBe(block.markdown);
  return pkg.baselineMarkdown.replace(block.markdown, changed);
}

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

describe("offline source-preserving roundtrip", () => {
  it("returns byte-identical source for an unedited document, including opaque and hidden nodes", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const result = await applyRoundtripMarkdown(pkg, pkg.baselineMarkdown);
    expect(result.status).toBe("unchanged");
    expect(result.html).toBe(source);
    expect(result.changes).toEqual([]);
  });

  it("edits text spanning adjacent wrappers without replacing unrelated source", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const markdown = editedBlock(pkg, "paragraph", (text) => text.replace("beta", "better"));
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    const originalTail = source.slice(source.indexOf("<table"));
    expect(result.html?.slice(result.html.indexOf("<table"))).toBe(originalTail);
    const doc = new DOMParser().parseFromString(result.html!, "text/html");
    expect(doc.querySelector("p")?.textContent).toBe("Alpha better & gamma.");
    expect(doc.querySelectorAll("p.intro span")).toHaveLength(2);
  });

  it("edits a table cell without losing widths, BR, inline code or macro identity", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const markdown = editedBlock(pkg, "table", (text) => text.replace("First", "Updated"));
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toBe(source.replace("First", "Updated"));
  });

  it("preserves exact code whitespace while inserting a line", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const markdown = editedBlock(pkg, "code", (text) =>
      text.replace("first\n", "first\ninserted\n"),
    );
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    const doc = new DOMParser().parseFromString(result.html!, "text/html");
    const pre = doc.querySelector("pre")!;
    pre.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    expect(pre.textContent).toBe("first\ninserted\nsecond\u00a0\n\n");
    expect(pre.querySelector("code")?.className).toBe("language-text");
    expect(result.html?.slice(result.html.indexOf("<p><img"))).toBe(
      source.slice(source.indexOf("<p><img")),
    );
  });

  it("does not silently trim an edited terminal blank code line", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const markdown = editedBlock(pkg, "code", (text) => text.replace(/\n```$/, "\n\n```"));
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    const doc = new DOMParser().parseFromString(result.html!, "text/html");
    const pre = doc.querySelector("pre")!;
    pre.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    expect(pre.textContent).toBe("first\nsecond\u00a0\n\n\n");
  });

  it("treats roundtrip-looking comments inside code as code, not mapping markers", async () => {
    const html = '<pre>&lt;!-- confx:block id="fake" --&gt;<br>code<br></pre>';
    const pkg = await createRoundtripPackage(snapshot(html));
    const result = await applyRoundtripMarkdown(
      pkg,
      pkg.baselineMarkdown.replace("code\n", "changed\n"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toContain("changed");
  });

  it("rejects missing or replaced block identity rather than matching by text", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const markdown = pkg.baselineMarkdown.replace(`id="${pkg.blocks[0].id}"`, 'id="unknown"');
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
  });

  it("blocks changed opaque macros and retains the complete original when no change is requested", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const markdown = editedBlock(pkg, "opaque", (text) => `${text} changed`);
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
    expect(result.issues.some((issue) => issue.blockId)).toBe(true);
  });

  it("rejects a stale or altered source even if its baseline Markdown was retained", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const changed = { ...pkg, snapshot: { ...pkg.snapshot, html: `${source}<p>Other edit</p>` } };
    const result = await applyRoundtripMarkdown(changed, pkg.baselineMarkdown);
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
  });

  it("applies safe formatting changes together with text changes in other blocks", async () => {
    const pkg = await createRoundtripPackage(snapshot());
    const markdown = editedBlock(pkg, "paragraph", (text) =>
      text.replace("Alpha", "Updated"),
    ).replace("First", "**First**");
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toContain("Updated");
    expect(
      new DOMParser().parseFromString(result.html!, "text/html").querySelector("td strong")
        ?.textContent,
    ).toBe("First");
    expect(result.changes.every((change) => change.supported)).toBe(true);
  });

  it("allows safe link target changes but rejects raw active HTML", async () => {
    const pkg = await createRoundtripPackage(
      snapshot('<p><a href="https://example.com/a">Read</a></p>'),
    );
    const result = await applyRoundtripMarkdown(
      pkg,
      pkg.baselineMarkdown.replace("example.com/a", "example.com/b"),
    );
    expect(result.status).toBe("ready");
    expect(result.html).toBe('<p><a href="https://example.com/b">Read</a></p>');
    const injected = await applyRoundtripMarkdown(
      pkg,
      pkg.baselineMarkdown.replace("Read", "<img src=x onerror=alert(1)>"),
    );
    expect(injected.status).toBe("blocked");
    expect(injected.html).toBeUndefined();
  });

  it("preserves merged tables as opaque instead of inventing a lossy GFM grid", async () => {
    const html = '<table><tr><td colspan="2">Merged</td></tr></table>';
    const pkg = await createRoundtripPackage(snapshot(html));
    expect(pkg.blocks[0].kind).toBe("opaque");
    expect((await applyRoundtripMarkdown(pkg, pkg.baselineMarkdown)).html).toBe(html);
  });

  it("does not redistribute replacement text across differently styled spans", async () => {
    const html = '<p><span style="color:red">be</span><span style="color:blue">ta</span></p>';
    const pkg = await createRoundtripPackage(snapshot(html));
    const markdown = editedBlock(pkg, "paragraph", (text) => text.replace("beta", "longer"));
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("blocked");
    expect(result.html).toBeUndefined();
  });

  it("does not split literal pipes in table text or inline code into extra cells", async () => {
    const html =
      "<table><thead><tr><th>Text</th><th>Code</th></tr></thead><tbody><tr><td>A | B</td><td><code>x|y</code></td></tr></tbody></table>";
    const pkg = await createRoundtripPackage(snapshot(html));
    const markdown = editedBlock(pkg, "table", (text) => text.replace("A", "Updated"));
    const result = await applyRoundtripMarkdown(pkg, markdown);
    expect(result.status).toBe("ready");
    expect(result.html).toBe(html.replace("A | B", "Updated | B"));
  });

  it("preserves a snapshot when macro metadata contains a newline and marker-like text", async () => {
    const html =
      '<p><img data-macro-name="toc&#10;&lt;!-- confx:end id=&quot;b0000&quot; --&gt;" /></p>';
    const pkg = await createRoundtripPackage(snapshot(html));
    const result = await applyRoundtripMarkdown(pkg, pkg.baselineMarkdown);
    expect(result.status).toBe("unchanged");
    expect(result.html).toBe(html);
  });
});
