import { marked } from "marked";
import { describe, expect, it } from "vitest";

import { htmlToMarkdown, htmlToMarkdownWithLayout } from "../../src/lib/html-to-md";

function renderExport(html: string): { markdown: string; document: Document } {
  const markdown = htmlToMarkdown(html);
  return {
    markdown,
    document: new DOMParser().parseFromString(
      marked.parse(markdown, { async: false }),
      "text/html",
    ),
  };
}

describe("rendered HTML export fidelity", () => {
  it("retains all four route placeholders in prose, inline annotations, and fenced code", () => {
    const code = '@Path("/lorem/{ipsum}")\nString lorem = "{noformat} {*}dolor{*} {noformat}";';
    const { document } = renderExport(
      "<p>GET /lorem/{ipsum} and PATCH /lorem/{ipsum}/dolor</p>" +
        '<p><code>@GetMapping("/lorem/{ipsum}")</code></p>' +
        `<pre class="code-fence"><code>${code}</code></pre>`,
    );

    expect(document.body.textContent?.match(/\{ipsum\}/g)).toHaveLength(4);
    expect(document.querySelector("p")?.textContent).toBe(
      "GET /lorem/{ipsum} and PATCH /lorem/{ipsum}/dolor",
    );
    expect(document.querySelector("p code")?.textContent).toBe('@GetMapping("/lorem/{ipsum}")');
    expect(document.querySelector("pre code")?.textContent).toBe(`${code}\n`);
  });

  it.each(["", ' class="code panel"'])(
    "retains raw pre text, nested code siblings, breaks, and final whitespace in wrapper %s",
    (wrapper) => {
      const pre =
        "<pre>  lorem <code>ipsum</code> dolor <code>sit</code><br>amet &lt;Lorem&gt;\n \n\n</pre>";
      const html = wrapper ? `<div${wrapper}>${pre}</div>` : pre;
      const { document } = renderExport(html);

      expect(document.querySelectorAll("pre")).toHaveLength(1);
      expect(document.querySelector("pre code")?.textContent).toBe(
        "  lorem ipsum dolor sit\namet <Lorem>\n \n\n",
      );
    },
  );

  it.each([
    ['<pre class="code-fence"><code class="language-java">lorem</code></pre>', "java"],
    ['<pre class="code" data-code-lang="sql"><code>lorem</code></pre>', "sql"],
    [
      '<div class="code panel"><pre data-syntaxhighlighter-params="brush:groovy;gutter:false"><code class="null">lorem</code></pre></div>',
      "groovy",
    ],
    ['<pre class="code-fence ipsum"><code class="lorem">lorem</code></pre>', ""],
    [
      '<span data-ds--code--code-block="" data-code-lang="java"><code class="code-java">lorem</code></span>',
      "java",
    ],
  ])("uses explicit language metadata rather than incidental classes: %s", (html, language) => {
    const { document } = renderExport(html);
    const code = document.querySelector("pre code");

    expect(code?.textContent).toBe("lorem\n");
    expect(code?.getAttribute("class") ?? "").toBe(language ? `language-${language}` : "");
  });

  it("uses a fence longer than literal backtick runs and retains final blank lines", () => {
    const code = "start\n```\n````js\n`end`  \n\n";
    const { document } = renderExport(`<pre data-code-lang="markdown"><code>${code}</code></pre>`);

    expect(document.querySelectorAll("pre")).toHaveLength(1);
    expect(document.querySelector("pre code")?.textContent).toBe(code);
    expect(document.body.children).toHaveLength(1);
  });

  it("does not guess that separated pre blocks and intervening paragraphs are one block", () => {
    const { document } = renderExport("<pre>first</pre><p>Explanation</p><pre>second</pre>");

    expect(Array.from(document.querySelectorAll("pre code"), (code) => code.textContent)).toEqual([
      "first\n",
      "second\n",
    ]);
    expect(document.querySelector("p")?.textContent).toBe("Explanation");
  });

  it("retains leading code blank lines after the HTML pre opening-newline convention", () => {
    const { document } = renderExport("<pre>\n\n  first\n</pre>");

    expect(document.querySelector("pre code")?.textContent).toBe("\n  first\n");
  });

  it("renders literal generics, XML, and entity-looking text in prose and link labels", () => {
    const { document } = renderExport(
      "<p>List&lt;Lorem&gt; &amp; Map&lt;L,I&gt; &amp;lt;ipsum&amp;gt;<br>dolor sit</p>" +
        '<p><a href="https://example.test/lorem">Lorem &lt;groupId&gt;</a> ' +
        "<code>Map&lt;L,I&gt; with `ipsum`</code></p>",
    );

    expect(document.querySelector("p")?.textContent).toBe(
      "List<Lorem> & Map<L,I> &lt;ipsum&gt;dolor sit",
    );
    expect(document.querySelectorAll("br")).toHaveLength(1);
    expect(document.querySelector("a")?.textContent).toBe("Lorem <groupId>");
    expect(document.querySelector("a")?.getAttribute("href")).toBe("https://example.test/lorem");
    expect(document.querySelector("p code")?.textContent).toBe("Map<L,I> with `ipsum`");
    expect(document.querySelector("lorem, l, groupid, ipsum")).toBeNull();
  });

  it("renders multiline Maven XML and generic links as literal text inside table cells", () => {
    const { document } = renderExport(
      "<table><tr><th>Lorem XML</th><th>Ipsum type</th></tr><tr><td>" +
        "&lt;dependency&gt;<br>&lt;groupId&gt;org.example.lorem&lt;/groupId&gt;<br>" +
        "&lt;artifactId&gt;ipsum-types&lt;/artifactId&gt;<br>&lt;/dependency&gt;" +
        '</td><td><a href="https://example.test/lorem/types">List&lt;Lorem&gt;</a> ' +
        "<code>Map&lt;L,I&gt; `ipsum`</code></td></tr></table>",
    );
    const cells = document.querySelectorAll("tbody td");

    expect(cells).toHaveLength(2);
    expect(cells[0].textContent?.replace(/\s*\n\s*/g, "").replace(/>\s+</g, "><")).toBe(
      "<dependency><groupId>org.example.lorem</groupId><artifactId>ipsum-types</artifactId></dependency>",
    );
    expect(cells[0].querySelectorAll("br")).toHaveLength(3);
    expect(cells[1].querySelector("a")?.textContent).toBe("List<Lorem>");
    expect(cells[1].querySelector("code")?.textContent).toBe("Map<L,I> `ipsum`");
    expect(document.querySelector("dependency, groupid, artifactid, lorem, l")).toBeNull();
  });

  it("keeps user JSON while removing only identified hidden extension settings", () => {
    const { document } = renderExport(
      '<p>{"enableNumbering":true}</p><div>{"payload":[1,2]}</div><span>{}</span>' +
        '<p class="enh-settings hidden">{}</p>' +
        '<p class="enh-settings hidden">{"enableNumbering":false}</p>',
    );

    expect(document.body.textContent).toContain('{"enableNumbering":true}');
    expect(document.body.textContent).toContain('{"payload":[1,2]}');
    expect(document.body.textContent?.match(/\{\}/g)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('"enableNumbering":false');
  });

  it("projects highlighted TD metadata and preview numbering without editor-only content", () => {
    const { document } = renderExport(
      "<html><head><style>.extension-content { color: red }</style></head>" +
        '<body id="tinymce" contenteditable="true"><p class="auto-cursor-target"><br></p>' +
        '<table class="wrapped confluenceTable"><tbody><tr>' +
        '<td class="highlight-#f4f5f7 confluenceTd" data-highlight-colour="#f4f5f7"><strong>Lorem</strong></td>' +
        '<td class="highlight-#f4f5f7 confluenceTd" data-highlight-colour="#f4f5f7"><strong>Ipsum</strong></td>' +
        "</tr><tr><td>Dolor</td><td><code>@lorem/ipsum</code></td></tr></tbody></table>" +
        '<h1 data-numhead-preview="1. ">Lorem overview</h1><ol><li>Dolor sit amet.</li></ol>' +
        '<h1 data-numhead-preview="2. ">Ipsum details</h1>' +
        '<p><img class="editor-inline-macro" data-macro-name="children" src="/plugins/servlet/confluence/placeholder/macro?definition=children"></p>' +
        '<p class="enh-settings hidden">{"enableNumbering":true}</p>' +
        '<div class="synchrony-container synchrony-exclude" data-mce-bogus="true" contenteditable="false">Lorem collaboration control</div>' +
        "</body></html>",
    );

    expect(Array.from(document.querySelectorAll("thead th"), (cell) => cell.textContent)).toEqual([
      "Lorem",
      "Ipsum",
    ]);
    expect(document.querySelector("tbody td code")?.textContent).toBe("@lorem/ipsum");
    expect(Array.from(document.querySelectorAll("h1"), (heading) => heading.textContent)).toEqual([
      "1. Lorem overview",
      "2. Ipsum details",
    ]);
    expect(document.querySelector("ol li")?.textContent).toBe("Dolor sit amet.");
    expect(document.body.textContent).not.toContain("enableNumbering");
    expect(document.body.textContent).not.toContain("Lorem collaboration control");
    expect(document.body.textContent).not.toContain("extension-content");
  });

  it("does not add preview numbers to titles that are already numbered", () => {
    const { document } = renderExport(
      '<h1 data-numhead-preview="1. ">1. Existing</h1>' +
        '<h2 data-numhead-preview="2. "><strong>7. Existing section</strong></h2>' +
        '<h2 data-numhead-preview="2.1. ">2.1. Existing subsection</h2>',
    );

    expect(
      Array.from(document.querySelectorAll("h1,h2"), (heading) => heading.textContent),
    ).toEqual(["1. Existing", "7. Existing section", "2.1. Existing subsection"]);
  });

  it("preserves leading blank lines and complete pre data inside layout cells", () => {
    const result = htmlToMarkdownWithLayout(
      '<div class="contentLayout2"><div class="columnLayout single" data-layout="single">' +
        '<div class="cell"><div class="innerCell">' +
        '<pre data-code-lang="java">\n\n  leading <code>&lt;T&gt;</code><br>tail  \n\n</pre>' +
        "<p>After code</p></div></div></div></div>",
    );
    const document = new DOMParser().parseFromString(
      marked.parse(result.markdown, { async: false }),
      "text/html",
    );

    expect(result.layout).toEqual({ status: "preserved", sections: 1 });
    expect(document.querySelector("pre code")?.textContent).toBe("\n  leading <T>\ntail  \n\n");
    expect(document.querySelector("p")?.textContent).toBe("After code");
  });

  it("preserves paragraph-wrapped YAML as a multiline code block with literal link text", () => {
    const { document } = renderExport(
      '<p class="code-fence"><code class="language-yaml"><span>lorem:<br>' +
        "&nbsp; ipsum:<br>&nbsp; &nbsp; items:<br>&nbsp; &nbsp; &nbsp; - href: " +
        '<a href="https://example.test/lorem">https://example.test/lorem</a><br>' +
        "&nbsp; &nbsp; enabled: true</span></code></p>" +
        "<p>Ipsum <code>dolor sit</code> amet.</p>",
    );

    expect(document.querySelector("pre code")?.textContent).toBe(
      "lorem:\n\u00a0 ipsum:\n\u00a0 \u00a0 items:\n\u00a0 \u00a0 \u00a0 - href: " +
        "https://example.test/lorem\n\u00a0 \u00a0 enabled: true\n",
    );
    expect(document.querySelector("pre code")?.className).toBe("language-yaml");
    expect(document.querySelector("p")?.textContent).toBe("Ipsum dolor sit amet.");
    expect(document.querySelector("p code")?.textContent).toBe("dolor sit");
    expect(document.querySelectorAll("pre")).toHaveLength(1);
  });

  it("keeps single-line and multiline PRE code readable inside table cells", () => {
    const literal =
      "  lorem|ipsum <Lorem> `dolor` *sit* _amet_ ~~ipsum~~ [lorem](https://example.test/lorem) " +
      "![ipsum](https://example.test/ipsum.png) \\lorem lorem@example.test";
    const multiline = `\n${literal.replace(/</g, "&lt;").replace(/>/g, "&gt;")}<br>amet\n  \n\n`;
    const { document } = renderExport(
      "<table><tr><th>Lorem</th><th>Ipsum</th></tr>" +
        '<tr><td>Dolor</td><td><pre class="code-fence"><code class="language-bash">' +
        "<code>@lorem/ipsum</code></code></pre></td></tr>" +
        `<tr><td>Sit</td><td><pre><code>${multiline}</code></pre>` +
        "<p>Ipsum tail</p></td></tr></table>",
    );
    const rows = document.querySelectorAll("tbody tr");

    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll("td")).toHaveLength(2);
    expect(rows[0].querySelectorAll("td")[1].textContent).toBe("@lorem/ipsum");
    expect(rows[0].querySelector("td code")?.textContent).toBe("@lorem/ipsum");
    expect(rows[1].querySelectorAll("td")).toHaveLength(2);
    expect(rows[1].querySelector("td code")?.textContent).toBe(`\n${literal}\namet\n  \n\n`);
    expect(rows[1].textContent).toContain("Ipsum tail");
    expect(document.querySelector("p")).toBeNull();
  });

  it("renders nested inline CODE once without inventing backticks or losing literal ones", () => {
    const { document } = renderExport(
      "<table><tr><th>Lorem</th><th>Ipsum</th></tr><tr>" +
        "<td><code><code>lorem:</code></code>@lorem/ipsum</td>" +
        "<td><code>  `` `ipsum` | &lt;L&gt;  </code></td></tr></table>",
    );
    const cells = document.querySelectorAll("tbody td");

    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe("lorem:@lorem/ipsum");
    expect(cells[0].querySelectorAll("code")).toHaveLength(1);
    expect(cells[1].querySelector("code")?.textContent).toBe("  `` `ipsum` | <L>  ");
  });

  it("retains literal inline code across explicit line breaks without parsing its markup", () => {
    const { document } = renderExport(
      "<p>Lorem <code>`ipsum` *dolor* &lt;L&gt;<br>[sit] @lorem/amet@2.3.4</code> consectetur</p>",
    );
    const code = document.querySelector("p code");

    expect(code?.textContent).toBe("`ipsum` *dolor* <L>[sit] @lorem/amet@2.3.4");
    expect(code?.querySelectorAll("br")).toHaveLength(1);
    expect(code?.querySelector("em, a, li, l")).toBeNull();
    expect(document.querySelector("p")?.textContent).toBe(
      "Lorem `ipsum` *dolor* <L>[sit] @lorem/amet@2.3.4 consectetur",
    );
  });

  it("does not autolink package versions or plaintext emails, while retaining explicit links", () => {
    const command =
      "npm install --save-exact @lorem/ipsum@1.2.3 " +
      "@lorem/dolor-sit@4.5.6 " +
      "@lorem.ipsum/sit-amet@7.8.9";
    const { document } = renderExport(
      `<table><tr><th>Lorem</th></tr><tr><td>${command}</td></tr></table>` +
        "<p>Lorem lorem@example.test</p>" +
        '<p><a href="mailto:lorem@example.test">lorem@example.test</a></p>' +
        '<p><a href="https://example.test/@lorem.ipsum?mode=a@b">Lorem @lorem.ipsum</a></p>',
    );

    expect(document.querySelector("tbody td")?.textContent).toBe(command);
    expect(Array.from(document.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual(
      ["mailto:lorem@example.test", "https://example.test/@lorem.ipsum?mode=a@b"],
    );
    expect(document.querySelector("p")?.textContent).toBe("Lorem lorem@example.test");
    expect(document.querySelector("a")?.textContent).toBe("lorem@example.test");
  });
});
