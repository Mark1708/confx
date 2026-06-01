import { describe, expect, it, vi } from "vitest";

import { buildTurndown, htmlToMarkdown } from "../../src/lib/html-to-md";
import { readFixtureText } from "../fixtures/fixture-loader";

function normalizeWhitespace(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").trim();
}

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

  it("converts Jira wiki links and bold markup to Markdown", () => {
    const markdown = htmlToMarkdown(`
      <p>[KIP-866|https://cwiki.apache.org/confluence/display/KAFKA/KIP-866] {*}Kafka v3.5.1{*}</p>
    `);

    expect(markdown).toContain(
      "[KIP-866](https://cwiki.apache.org/confluence/display/KAFKA/KIP-866)",
    );
    expect(markdown).toContain("**Kafka v3.5.1**");
  });

  it("converts Jira wiki code macros to fenced code", () => {
    const markdown = htmlToMarkdown("<p>{code:sql}select 1;{code}</p>");

    expect(markdown).toContain("```sql\nselect 1;\n```");
  });

  it("drops attachments macro UI noise", () => {
    const markdown = htmlToMarkdown(`
      <div class="conf-macro" data-macro-name="attachments">
        <table><tr><th>Файл</th><th>Изменено</th></tr></table>
        <p>Файлов еще нет.</p>
        <p>Загрузить файл <img src="/wiki/images/icons/wait.gif"></p>
      </div>
    `);

    expect(markdown).toBe("");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("strips Confluence noise before conversion", () => {
    const markdown = htmlToMarkdown(`
      <p>&nbsp;</p>
      <p>{"enableNumbering":true}</p>
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

  it("converts tables with thead to GFM tables", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <thead><tr><th>Name</th><th>Type</th></tr></thead>
        <tbody><tr><td>items</td><td>MenuItem[]</td></tr></tbody>
      </table>
    `);

    expect(markdown).toContain("| Name | Type |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| items | MenuItem\\[\\] |");
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

  it("adds a synthetic header for key-value tables", () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tr><th>Name</th><td>Menu</td></tr>
        <tr><th>Mode</th><td>Vertical</td></tr>
      </table>
    `);

    expect(markdown).toContain("| Поле | Значение |");
    expect(markdown).toContain("| Name | Menu |");
    expect(markdown).toContain("| Mode | Vertical |");
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
  it("converts open jira issue to linked markdown with summary and status", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue" data-jira-key="KAFKA-15501">
        <a href="https://issues.apache.org/jira/browse/KAFKA-15501" class="jira-issue-key">
          <img class="icon" src="https://issues.apache.org/jira/secure/viewavatar?size=xsmall&amp;avatarId=10318&amp;avatarType=issuetype">KAFKA-15501
        </a>
        -
        <span class="summary">Create step navigation</span>
        <span class="aui-lozenge aui-lozenge-subtle aui-lozenge-current jira-macro-single-issue-export-pdf">Review</span>
      </span>
    `);
    expect(md).toContain("[KAFKA-15501](https://issues.apache.org/jira/browse/KAFKA-15501)");
    expect(md).toContain("- Create step navigation");
    expect(md).toContain("[Review]");
    expect(md).not.toContain("~~");
  });

  it("converts resolved jira issue with strikethrough", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue resolved" data-jira-key="KAFKA-15502">
        <a href="https://issues.apache.org/jira/browse/KAFKA-15502" class="jira-issue-key">KAFKA-15502</a>
        -
        <span class="summary">Implement UI</span>
        <span class="aui-lozenge aui-lozenge-success jira-macro-single-issue-export-pdf">Done</span>
      </span>
    `);
    expect(md).toContain("~~");
    expect(md).toContain("[KAFKA-15502]");
    expect(md).toContain("- Implement UI");
    expect(md).toContain("[Done]");
  });

  it("handles jira issue without summary", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue" data-jira-key="KAFKA-100">
        <a href="https://issues.apache.org/jira/browse/KAFKA-100" class="jira-issue-key">KAFKA-100</a>
      </span>
    `);
    expect(md).toContain("[KAFKA-100]");
    expect(md).toContain("https://issues.apache.org/jira/browse/KAFKA-100");
  });
});

describe("aui lozenge badge", () => {
  it("converts standalone lozenge to bracketed text", () => {
    const md = htmlToMarkdown('<span class="aui-lozenge aui-lozenge-subtle">In Progress</span>');
    expect(md).toContain("[In Progress]");
  });

  it("converts success lozenge", () => {
    const md = htmlToMarkdown('<span class="aui-lozenge aui-lozenge-success">Done</span>');
    expect(md).toContain("[Done]");
  });

  it("does not double-render lozenge inside jira-issue", () => {
    const md = htmlToMarkdown(`
      <span class="jira-issue" data-jira-key="KEY-1">
        <a href="https://jira.com/browse/KEY-1" class="jira-issue-key">KEY-1</a>
        <span class="aui-lozenge">Open</span>
      </span>
    `);
    const lozengeCount = (md.match(/\[Open\]/g) || []).length;
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
  it("converts user link to @username", () => {
    const md = htmlToMarkdown(
      '<a class="confluence-userlink url fn" data-username="john" href="/display/~john">John Doe</a>',
    );
    expect(md).toContain("@john");
  });

  it("converts span userlink to @username", () => {
    const md = htmlToMarkdown(
      '<span class="confluence-userlink" data-username="jane">@jane</span>',
    );
    expect(md).toContain("@jane");
  });
});

describe("unknown macro fallback", () => {
  it("renders unknown macro as placeholder with name", () => {
    const md = htmlToMarkdown(`
      <div class="conf-macro output-inline" data-hasbody="false" data-macro-name="pagetree">
        <div class="plugin_pagetree">Tree content</div>
      </div>
    `);
    expect(md).toContain("[macro:pagetree]");
  });

  it("renders unknown macro with body in HTML comment", () => {
    const md = htmlToMarkdown(`
      <div class="conf-macro output-block" data-hasbody="true" data-macro-name="custom-widget">
        <p>Widget content here</p>
      </div>
    `);
    expect(md).toContain("[macro:custom-widget]");
  });
});

describe("htmlToMarkdown integration", () => {
  it("converts the Confluence page fixture with expected custom output", async () => {
    const html = await readFixtureText("confluence-page.html");

    const markdown = normalizeWhitespace(htmlToMarkdown(html));

    expect(markdown).toContain("# Other blocks Page");
    expect(markdown).toContain("lorem lorem");
    expect(markdown).toContain("Some content 1");
    expect(markdown).toContain("Some content 2");
    expect(markdown).toContain("Some status");
    expect(markdown).toContain("# Выбор макроса");
    expect(markdown).toContain("#### Excel");
    expect(markdown).toContain("JSM Incident Timeline");
    expect(markdown).toContain("![");
    expect(markdown).not.toContain("enableNumbering");
    expect(markdown).not.toContain("toc-macro");
    expect(markdown).not.toContain("auto-cursor-target");
    expect(markdown).not.toContain("confluence-anchor-link");
  });
});
