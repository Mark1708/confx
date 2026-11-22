// Synthetic specimens only. IDs, prose and opaque IDs are stable so exports can be
// compared independently of the sandbox converter and restored deterministically.
const xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paragraph = (text) => `<p>${text}</p>`;
const macro = (name, id, content = "", parameters = {}) =>
  `<ac:structured-macro ac:name="${name}" ac:macro-id="${id}" ac:schema-version="1">${Object.entries(
    parameters,
  )
    .map(([key, value]) => `<ac:parameter ac:name="${key}">${xml(value)}</ac:parameter>`)
    .join(
      "",
    )}${content ? `<ac:rich-text-body>${content}</ac:rich-text-body>` : ""}</ac:structured-macro>`;
const code = (language, content) =>
  `<pre><code class="language-${language}">${xml(content)}</code></pre>`;
const section = (type, cells) =>
  `<ac:layout-section ac:type="${type}">${cells.map((cell) => `<ac:layout-cell>${cell}</ac:layout-cell>`).join("")}</ac:layout-section>`;
const image =
  '<ac:image ac:alt="Lorem local image" ac:width="96" ac:height="64"><ri:attachment ri:filename="lorem.png"><ri:page ri:content-id="1700" ri:content-title="Lorem links and assets"/></ri:attachment><ac:caption><p>Lorem image caption</p></ac:caption></ac:image>';

export const opaqueLoremMacro =
  '<ac:structured-macro ac:name="lorem-plugin" ac:macro-id="lorem-opaque-001" ac:schema-version="1"><ac:parameter ac:name="mode">ipsum &amp; dolor</ac:parameter><ac:plain-text-body><![CDATA[{"lorem":"<Lorem>","package":"@lorem/ipsum@1.0.0"}]]></ac:plain-text-body></ac:structured-macro>';
const tasks =
  "<ac:task-list><ac:task><ac:task-id>12001</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Lorem task open</ac:task-body></ac:task><ac:task><ac:task-id>12002</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Lorem task complete</ac:task-body></ac:task></ac:task-list>";
const simpleTable =
  "<table><tbody><tr><th>Lorem key</th><th>Lorem value</th></tr><tr><td>ipsum</td><td>dolor</td></tr><tr><td>sit</td><td>amet<br/>consectetur</td></tr></tbody></table>";
const protectedRegions = [
  "Opaque macros, task state and resource identities remain protected; edits to their editor placeholders reject.",
];
const ordinaryEdits = [
  "Edit ordinary paragraphs/headings, supported inline formatting, links, plain PRE/code and unmerged table cells.",
];
function specimen(
  id,
  title,
  parentId,
  components,
  storage,
  edits = ordinaryEdits,
  protectedItems = protectedRegions,
) {
  return {
    id,
    title,
    parentId,
    components,
    storage,
    expectations: { supportedEdits: edits, protectedRegions: protectedItems },
    labels: ["lorem", "sandbox", ...components.slice(0, 2)],
  };
}

export const catalog = [
  specimen(
    "1000",
    "Lorem sandbox overview",
    null,
    ["overview", "headings", "paragraphs", "info", "children"],
    '<h1 id="lorem-overview">Lorem sandbox overview</h1>' +
      paragraph("Lorem ipsum dolor sit amet. This synthetic page contains no workplace content.") +
      paragraph(
        'Lorem specimens: <a href="/pages/viewpage.action?pageId=1100">typography</a>, <a href="/pages/viewpage.action?pageId=1300">tables</a>, <a href="/pages/viewpage.action?pageId=1400">code</a>, <a href="/pages/viewpage.action?pageId=1500">macros</a>, <a href="/pages/viewpage.action?pageId=1600">layouts</a>, <a href="/pages/viewpage.action?pageId=1700">local assets</a>.',
      ) +
      macro(
        "note",
        "lorem-root-note",
        paragraph("Lorem overview note: ordinary text is editable; macros are protected."),
      ) +
      macro("children", "lorem-root-children") +
      paragraph("Lorem overview closing paragraph."),
  ),
  specimen(
    "1100",
    "Lorem typography",
    "1000",
    ["headings", "paragraphs", "formatting", "unicode", "comments"],
    '<h1 id="lorem-type">Lorem typography</h1><h2>Lorem heading two</h2><h3>Lorem heading three</h3><h4>Lorem heading four</h4><h5>Lorem heading five</h5><h6>Lorem heading six</h6>' +
      paragraph("Lorem typography paragraph") +
      paragraph(
        'Lorem <strong>bold ipsum</strong>, <em>italic dolor</em>, <span style="text-decoration: underline;">underlined sit</span>, <s>struck amet</s>, H<sub>2</sub>O, x<sup>2</sup> and <span style="color: #7b3f00;">colored Lorem</span>.',
      ) +
      "<p><br/></p><p>&#160;</p>" +
      paragraph(
        "Lorem Unicode: café, naïve, Ελληνικά, Кириллица, 日本語, &#128161;. Lorem&#160;ipsum nonbreaking space.",
      ) +
      "<!--lorem-typography-comment--><blockquote><p>Lorem quoted paragraph.</p></blockquote>" +
      paragraph("Lorem typography closing paragraph."),
    [
      "Edit Lorem typography paragraph or individual heading text; semantic bold/italic/color formatting is preserved.",
      "Blank paragraphs, NBSP and Unicode are intentional baseline content.",
    ],
    ["The XML comment is retained; unsupported inserted active HTML or custom tags reject."],
  ),
  specimen(
    "1200",
    "Lorem lists and tasks",
    "1000",
    ["lists", "nested-lists", "tasks"],
    "<h1>Lorem lists and tasks</h1>" +
      paragraph("Lorem list specimen") +
      "<ul><li>Lorem unordered alpha<ul><li>Lorem nested beta</li><li>Lorem nested gamma</li></ul></li><li>Lorem unordered delta</li></ul>" +
      '<ol start="3"><li>Lorem ordered alpha<ol><li>Lorem ordered nested beta</li></ol></li><li>Lorem ordered gamma</li></ol>' +
      tasks +
      paragraph("Lorem list closing paragraph."),
    [
      "Native HTML list text and nesting are supported by the sandbox codec; Confx editable Markdown may protect whole list blocks.",
      "Edit Lorem list specimen through native or Storage Markdown.",
    ],
    ["Task IDs and completion state are opaque, noneditable editor placeholders."],
  ),
  specimen(
    "1300",
    "Lorem tables",
    "1000",
    ["tables", "bold-td-header", "merged-cells", "multiline-cells"],
    "<h1>Lorem tables</h1>" +
      paragraph("Lorem table specimen") +
      simpleTable +
      "<table><tbody><tr><td><strong>Lorem bold TD key</strong></td><td><strong>Lorem bold TD value</strong></td></tr><tr><td>adipiscing</td><td>elit</td></tr></tbody></table>" +
      '<table><tbody><tr><th colspan="2">Lorem merged cell</th></tr><tr><td rowspan="2">Lorem row span</td><td>Lorem first row</td></tr><tr><td><p>Lorem multiline cell one</p><p>Lorem multiline cell two<br/>Lorem line break</p><pre><code>  Lorem preformatted cell\n    ipsum\n</code></pre></td></tr></tbody></table>' +
      paragraph("Lorem table closing paragraph."),
    ["Edit simple TH/bold-TD table cells, ordinary paragraphs and native HTML merged-cell text."],
    [
      "Confx Markdown intentionally protects merged/multiline/PRE tables rather than claiming reversible cell edits.",
    ],
  ),
  specimen(
    "1400",
    "Lorem code",
    "1000",
    ["code", "inline-code", "code-whitespace", "six-languages"],
    "<h1>Lorem code</h1>" +
      paragraph("Lorem code specimen") +
      paragraph(
        "Lorem inline <code>/lorem/{code}</code>, <code>@lorem/ipsum@1.0.0</code>, <code>`literal backticks`</code> and nested <strong><code>&lt;Lorem&gt;</code></strong>.<br/>Lorem code line break.",
      ) +
      code("java", 'class Lorem {\n  String ipsum = "<Lorem>";\n}\n') +
      code("js", 'const lorem = `<Lorem>`;\nconst route = "/lorem/{code}";\nlorem.trim();\n') +
      code("json", '{"lorem":"ipsum"}\n') +
      code("yaml", "lorem: ipsum\nnested:\n  dolor: sit\n") +
      code("xml", "<lorem>ipsum</lorem>\n") +
      code("sql", "SELECT lorem FROM ipsum;\n") +
      paragraph("Lorem code closing paragraph."),
    [
      "Edit plain code fence bodies or inline code; leading spaces, newlines, angle brackets and literal backticks survive conversion.",
    ],
    [
      "Code macro payloads on the macro page are opaque; plain PRE/code here are genuinely editable.",
    ],
  ),
  specimen(
    "1500",
    "Lorem macros",
    "1000",
    ["macros", "panels", "expand", "status", "toc", "opaque", "page-properties", "gallery"],
    '<h1 id="lorem-macros">Lorem macros</h1>' +
      paragraph("Lorem macro specimen paragraph") +
      macro("info", "lorem-info", paragraph("Lorem information")) +
      macro("note", "lorem-note", paragraph("Lorem note")) +
      macro("warning", "lorem-warning", paragraph("Lorem warning")) +
      macro("tip", "lorem-tip", paragraph("Lorem tip")) +
      macro("expand", "lorem-expand", paragraph("Lorem expanded details"), {
        title: "Lorem expansion",
      }) +
      macro("status", "lorem-status", "", { title: "LOREM READY", colour: "Green" }) +
      '<ac:structured-macro ac:name="code" ac:macro-id="lorem-code-macro" ac:schema-version="1"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const macroLorem = `<Lorem>`;\n  macroLorem.trim();\n]]></ac:plain-text-body></ac:structured-macro>' +
      macro("toc", "lorem-toc") +
      macro("children", "lorem-children") +
      macro("excerpt", "lorem-excerpt", paragraph("Lorem excerpt")) +
      macro(
        "details",
        "lorem-properties",
        "<table><tbody><tr><th>Lorem property</th><td>Lorem property value</td></tr></tbody></table>",
      ) +
      macro("gallery", "lorem-gallery", image) +
      opaqueLoremMacro +
      paragraph("Lorem macro closing paragraph."),
    [
      "Edit Lorem macro specimen paragraph while retaining each protected macro ID, parameters and CDATA byte-for-byte.",
    ],
    [
      "All macros are noneditable native placeholders; view-only renderings are illustrative public-format projections, not plugin execution.",
    ],
  ),
  specimen(
    "1600",
    "Lorem layouts",
    "1000",
    ["layouts", "one-column", "two-columns", "three-columns"],
    '<ac:layout ac:local-id="lorem-layout-1600">' +
      section("single", ["<h1>Lorem layouts</h1>" + paragraph("Lorem single column")]) +
      section("two_equal", [paragraph("Lorem left column"), paragraph("Lorem right column")]) +
      section("three_equal", [
        paragraph("Lorem first third"),
        paragraph("Lorem middle third"),
        paragraph("Lorem final third"),
      ]) +
      "</ac:layout>",
    [
      "Edit ordinary paragraph text inside one/two/three-column layout cells; layout XML attributes and section order survive.",
    ],
    [
      "Changing the private native layout markers, wrapper hierarchy or unsupported section types rejects.",
    ],
  ),
  specimen(
    "1700",
    "Lorem links and assets",
    "1000",
    ["links", "images", "attachments", "deduplication", "comments"],
    '<h1 id="lorem-assets">Lorem links and assets</h1>' +
      paragraph("Lorem asset specimen") +
      paragraph(
        '<a href="/pages/viewpage.action?pageId=1710">Lorem nested link</a> and <a href="viewpage.action?pageId=1710">Lorem relative link</a>, <a href="#lorem-anchor">Lorem local anchor</a>, <a href="mailto:lorem@example.invalid">Lorem mail link</a>.',
      ) +
      '<h2 id="lorem-anchor">Lorem anchor target</h2>' +
      paragraph(
        '<ac:link><ri:page ri:content-id="1710" ri:content-title="Lorem nested specimen"/><ac:plain-text-link-body><![CDATA[Lorem resource page link]]></ac:plain-text-link-body></ac:link>',
      ) +
      image +
      '<p><img src="/download/attachments/1700/lorem.png" alt="Lorem duplicate image" width="96" height="64"/></p>' +
      paragraph(
        '<a href="/download/attachments/1700/lorem.json">Lorem JSON attachment</a> <a href="/download/attachments/1700/lorem.csv">Lorem CSV attachment</a> <a href="/download/attachments/1700/lorem.pdf">Lorem PDF attachment</a> <a href="/download/attachments/1700/lorem.json">Lorem deduplicated JSON reference</a>',
      ) +
      paragraph("Lorem asset closing paragraph."),
    [
      "Edit ordinary text and local/anchor/mailto link text; local PNG/JSON/CSV/PDF files are real downloadable assets.",
    ],
    [
      "Storage resource nodes and image metadata/captions are protected opaque placeholders. External image/resource loads reject.",
    ],
  ),
  specimen(
    "1710",
    "Lorem nested specimen",
    "1700",
    ["hierarchy", "paragraphs", "parent-link"],
    "<h1>Lorem nested specimen</h1>" +
      paragraph("Lorem nested child paragraph") +
      paragraph('<a href="/pages/viewpage.action?pageId=1700">Lorem parent asset page</a>') +
      paragraph("Lorem nested closing paragraph."),
  ),
  specimen(
    "1800",
    "Lorem combined specimen",
    "1000",
    ["combined", "layouts", "tables", "code", "tasks", "hidden-noise"],
    '<ac:layout ac:local-id="lorem-layout-1800">' +
      section("single", [
        "<h1>Lorem combined specimen</h1>" +
          paragraph("Lorem combined paragraph") +
          "<table><tbody><tr><th>Lorem combined key</th><th>Lorem combined value</th></tr><tr><td>ipsum</td><td>dolor</td></tr></tbody></table>",
      ]) +
      section("two_equal", [
        code("js", "const combinedLorem = 42;\n") +
          paragraph("Lorem combined inline <code>/lorem/{code}</code>."),
        macro("info", "lorem-combined-info", paragraph("Lorem combined information")) +
          tasks +
          paragraph("Lorem combined closing paragraph."),
      ]) +
      "</ac:layout>" +
      '<ac:structured-macro ac:name="editor-settings" ac:macro-id="lorem-editor-settings" ac:schema-version="1"><ac:plain-text-body><![CDATA[{"loremEditor":{"collaboration":false,"seed":"ipsum"}}]]></ac:plain-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="collaboration" ac:macro-id="lorem-collaboration" ac:schema-version="1"><ac:plain-text-body><![CDATA[{"loremSession":"synthetic-only"}]]></ac:plain-text-body></ac:structured-macro>',
    [
      "Edit Lorem combined paragraph, the simple table or the plain JavaScript block within layout cells.",
    ],
    [
      "Tasks and macros retain opaque identities; hidden editor-settings/collaboration JSON is distinct from visible JSON code and excluded from rendered text.",
    ],
  ),
];

export const assetDefinitions = [
  { filename: "lorem.png", file: "lorem.png.base64", mediaType: "image/png", encoding: "base64" },
  { filename: "lorem.json", file: "lorem.json", mediaType: "application/json" },
  { filename: "lorem.csv", file: "lorem.csv", mediaType: "text/csv" },
  { filename: "lorem.pdf", file: "lorem.pdf", mediaType: "application/pdf" },
];

// Deliberately small, read-only Jira corpus; no general JQL engine or issue writes.
export const jiraCatalog = [
  {
    key: "LOR-12",
    summary: "Lorem resources",
    description: "h2. Lorem issue\n\nLorem *ipsum* description.\n\n|| Lorem key || Lorem value ||\n| ipsum | dolor |",
    status: "Open",
    attachments: ["lorem.json"],
    comments: [{ id: "62001", body: "Lorem comment for the resource specimen." }],
  },
  {
    key: "LOR-13",
    summary: "Ipsum plain text",
    description: "Lorem second issue with an independent plain-text paragraph.",
    status: "In Progress",
    attachments: [],
    comments: [],
  },
  {
    key: "LOR-14",
    summary: "Dolor code example",
    description: "Lorem code specimen.\n\n{code:js}\nconst lorem = 42;\n{code}",
    status: "Done",
    attachments: [],
    comments: [],
  },
];
