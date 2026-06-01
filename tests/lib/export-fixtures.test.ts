import { describe, expect, it } from "vitest";

import { fixturePath, readFixtureText } from "../fixtures/fixture-loader";

describe("offline export fixtures", () => {
  it("resolves fixture paths under tests/fixtures", () => {
    expect(fixturePath("export/image-attachment.html")).toContain("tests/fixtures/export/image-attachment.html");
  });

  it("loads the image attachment fixture with the ChatGPT image filename", async () => {
    const html = await readFixtureText("export/image-attachment.html");

    expect(html).toContain("ChatGPT Image");
    expect(html).toContain("ChatGPT%20Image%202026-05-30%2012_34_56.png");
    expect(html).toContain("data-linked-resource-default-alias=\"ChatGPT Image 2026-05-30 12_34_56.png\"");
  });

  it("loads the table fixture with real column headers", async () => {
    const html = await readFixtureText("export/table-page.html");

    expect(html).toContain("Столбец 1");
    expect(html).toContain("Столбец 2");
    expect(html).toContain("Столбец 3");
  });

  it("loads the attachments macro fixture with UI headers", async () => {
    const html = await readFixtureText("export/attachments-macro.html");

    expect(html).toContain("Файл");
    expect(html).toContain("Изменено");
    expect(html).toContain("Файлов еще нет.");
    expect(html).toContain("Загрузить файл");
  });

  it("loads the code block fixture with code block markers", async () => {
    const html = await readFixtureText("export/code-blocks.html");

    expect(html).toContain("<pre><code>");
    expect(html).toContain('data-syntaxhighlighter-params="brush:java;first-line:1"');
    expect(html).toContain('data-syntaxhighlighter-params="brush:json"');
    expect(html).toContain('data-testid="renderer-code-block"');
  });

  it("loads the Jira markup fixture with wiki markup markers", async () => {
    const html = await readFixtureText("export/jira-markup.html");

    expect(html).toContain(
      "[KIP-866|https://cwiki.apache.org/confluence/display/KAFKA/KIP-866+ZooKeeper+to+KRaft+Migration]",
    );
    expect(html).toContain("{*}bold{*}");
    expect(html).toContain("{code}console.log('offline');{code}");
  });

  it("loads the text formatting fixture", async () => {
    const html = await readFixtureText("export/text-formatting.html");

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<s>strike</s>");
    expect(html).toContain("<code>inline()</code>");
  });
});
