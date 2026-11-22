import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { canonicalStorage, storageToEditor, editorToStorage, storageToView } from "../codec.mjs";
import { catalog } from "../catalog.mjs";

const window = new JSDOM("").window;
const xmlTree = (source) => {
  const document = new window.DOMParser().parseFromString(
    `<root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">${source}</root>`,
    "text/xml",
  );
  assert.equal(document.querySelector("parsererror"), null, "expected well-formed Storage XML");
  const visit = (node) =>
    node.nodeType === 1
      ? [
          node.nodeName,
          [...node.attributes].map((a) => [a.name, a.value]).sort(),
          [...node.childNodes].map(visit),
        ]
      : [node.nodeType === 4 ? 3 : node.nodeType, node.nodeValue];
  return [...document.documentElement.childNodes].map(visit);
};

const opaque =
  '<ac:structured-macro ac:name="lorem-plugin" ac:macro-id="lorem-opaque-001" ac:schema-version="1"><ac:parameter ac:name="mode">ipsum &amp; dolor</ac:parameter><ac:plain-text-body><![CDATA[{"lorem":"<Lorem>","package":"@lorem/ipsum@1.0.0"}]]></ac:plain-text-body></ac:structured-macro>';

test("editor conversion uses incoming paragraph, inline code, PRE and table edits, not original source", () => {
  const source =
    '<h2>Lorem heading</h2><p>Lorem <strong>ipsum</strong> and <code>/lorem/{code}</code>.</p><pre><code class="language-js">const lorem = `&lt;Lorem&gt;`;\n  lorem();\n</code></pre><table><tbody><tr><th>Lorem key</th><th>Value</th></tr><tr><td>ipsum</td><td><p>dolor</p><p>sit<br/>amet</p></td></tr></tbody></table>';
  const editor = storageToEditor(source);
  const edited = editor
    .replace("Lorem heading", "Lorem revised heading")
    .replace("Lorem <strong>", "Edited Lorem <strong>")
    .replace("/lorem/{code}", "/lorem/{edited}")
    .replace("lorem();", "lorem(42);")
    .replace("<td>ipsum</td>", "<td>changed cell</td>");
  const expected = source
    .replace("Lorem heading", "Lorem revised heading")
    .replace("Lorem <strong>", "Edited Lorem <strong>")
    .replace("/lorem/{code}", "/lorem/{edited}")
    .replace("lorem();", "lorem(42);")
    .replace("<td>ipsum</td>", "<td>changed cell</td>");
  assert.deepEqual(xmlTree(editorToStorage(edited)), xmlTree(expected));
  assert.notEqual(editorToStorage(edited), canonicalStorage(source));
});

test("HTML parser closes void elements and understands entities, comments, styles and native editor metadata", () => {
  const html =
    '<!--lorem-comment--><p style="color: #123456;" data-mce-style="color: #123456;">Lorem&nbsp;<strong>ipsum</strong><br>dolor</p><p><br data-mce-bogus="1"></p><pre><code>  &lt;Lorem&gt;\n\t@lorem/ipsum@1.0.0\n</code></pre>';
  assert.deepEqual(
    xmlTree(editorToStorage(html)),
    xmlTree(
      '<!--lorem-comment--><p style="color: #123456;">Lorem&#160;<strong>ipsum</strong><br/>dolor</p><p><br/></p><pre><code>  &lt;Lorem&gt;\n\t@lorem/ipsum@1.0.0\n</code></pre>',
    ),
  );
});

test("opaque macro payload, attributes and CDATA survive beside real edits", () => {
  const source = `<p>Lorem before</p>${opaque}<p>Lorem after</p>`;
  const editor = storageToEditor(source);
  assert.match(editor, /mceNonEditable/);
  assert.match(editor, /data-sandbox-storage=/);
  const restored = editorToStorage(editor.replace("Lorem before", "Lorem edited before"));
  assert.ok(
    restored.includes(opaque),
    "original serialized opaque macro including CDATA is retained exactly",
  );
  assert.deepEqual(
    xmlTree(restored),
    xmlTree(source.replace("Lorem before", "Lorem edited before")),
  );
  assert.throws(
    () => editorToStorage(editor.replace("Protected macro: lorem-plugin", "Changed macro label")),
    /protected|opaque/i,
  );
  assert.throws(
    () =>
      editorToStorage(
        editor.replace(/data-sandbox-storage="[^"]+"/, 'data-sandbox-storage="bm90LXhtbA"'),
      ),
    /opaque|metadata|digest|storage/i,
  );
});

// Exact opaque DIVs from the native TinyMCE save request captured in the root-page trace.
// TinyMCE retains the protected classes, payload, digest and label, but omits contenteditable.
const nativeOpaqueNote =
  '<div class="sandbox-opaque mceNonEditable" data-sandbox-kind="opaque" data-sandbox-storage="PGFjOnN0cnVjdHVyZWQtbWFjcm8gYWM6bmFtZT0ibm90ZSIgYWM6bWFjcm8taWQ9ImxvcmVtLXJvb3Qtbm90ZSIgYWM6c2NoZW1hLXZlcnNpb249IjEiPjxhYzpyaWNoLXRleHQtYm9keT48cD5Mb3JlbSBvdmVydmlldyBub3RlOiBvcmRpbmFyeSB0ZXh0IGlzIGVkaXRhYmxlOyBtYWNyb3MgYXJlIHByb3RlY3RlZC48L3A-PC9hYzpyaWNoLXRleHQtYm9keT48L2FjOnN0cnVjdHVyZWQtbWFjcm8-" data-sandbox-digest="9a706202a3887cea336799017b9747bdfcdf9165fb8c350a8f2cfdfb846e2063" data-macro-name="note">Protected macro: note</div>';
const nativeOpaqueChildren =
  '<div class="sandbox-opaque mceNonEditable" data-sandbox-kind="opaque" data-sandbox-storage="PGFjOnN0cnVjdHVyZWQtbWFjcm8gYWM6bmFtZT0iY2hpbGRyZW4iIGFjOm1hY3JvLWlkPSJsb3JlbS1yb290LWNoaWxkcmVuIiBhYzpzY2hlbWEtdmVyc2lvbj0iMSI-PC9hYzpzdHJ1Y3R1cmVkLW1hY3JvPg" data-sandbox-digest="b52d1edfb44162fe83a7b9ed8da03f96977d0e270b6854b33dfcbc50c042a90d" data-macro-name="children">Protected macro: children</div>';
const nativeNoteSource =
  '<ac:structured-macro ac:name="note" ac:macro-id="lorem-root-note" ac:schema-version="1"><ac:rich-text-body><p>Lorem overview note: ordinary text is editable; macros are protected.</p></ac:rich-text-body></ac:structured-macro>';
const nativeChildrenSource =
  '<ac:structured-macro ac:name="children" ac:macro-id="lorem-root-children" ac:schema-version="1"></ac:structured-macro>';

test("native opaque placeholders without contenteditable restore exact source beside incoming edits", () => {
  const editor = `<p>Lorem before</p>${nativeOpaqueNote}${nativeOpaqueChildren}<p>Lorem after</p>`;
  const source = `<p>Lorem before</p>${nativeNoteSource}${nativeChildrenSource}<p>Lorem after</p>`;
  assert.equal(editorToStorage(editor), source);
  assert.equal(
    editorToStorage(
      editor.replace("Lorem before", "Edited before").replace("Lorem after", "Edited after"),
    ),
    source.replace("Lorem before", "Edited before").replace("Lorem after", "Edited after"),
  );
});

for (const [label, edited] of [
  ["editable region", nativeOpaqueNote.replace("<div ", '<div contenteditable="true" ')],
  ["empty editable state", nativeOpaqueNote.replace("<div ", '<div contenteditable="" ')],
  ["unknown editable state", nativeOpaqueNote.replace("<div ", '<div contenteditable="inherit" ')],
  ["label edit", nativeOpaqueNote.replace("Protected macro: note", "Changed macro label")],
  [
    "nested label markup",
    nativeOpaqueNote.replace("Protected macro: note", "<strong>Protected macro: note</strong>"),
  ],
  ["extra child", nativeOpaqueNote.replace("</div>", "<br></div>")],
  ["comment child", nativeOpaqueNote.replace("</div>", "<!--unexpected--></div>")],
  ["missing protected class", nativeOpaqueNote.replace(" mceNonEditable", "")],
  ["arbitrary attribute", nativeOpaqueNote.replace("<div ", '<div title="changed" ')],
  [
    "arbitrary sandbox metadata",
    nativeOpaqueNote.replace("<div ", '<div data-sandbox-extra="changed" '),
  ],
  [
    "layout metadata on opaque node",
    nativeOpaqueNote.replace("<div ", '<div data-sandbox-attrs="W10" '),
  ],
  [
    "changed macro name",
    nativeOpaqueNote.replace('data-macro-name="note"', 'data-macro-name="children"'),
  ],
  [
    "changed kind",
    nativeOpaqueNote.replace('data-sandbox-kind="opaque"', 'data-sandbox-kind="invented"'),
  ],
  [
    "changed payload",
    nativeOpaqueNote.replace(/data-sandbox-storage="[^"]+"/, 'data-sandbox-storage="bm90LXhtbA"'),
  ],
  [
    "changed digest",
    nativeOpaqueNote.replace(
      /data-sandbox-digest="[^"]+"/,
      `data-sandbox-digest="${"0".repeat(64)}"`,
    ),
  ],
]) {
  test(`native opaque placeholder rejects ${label}`, () => {
    assert.throws(() => editorToStorage(edited), /protected|opaque|metadata|digest/i);
  });
}

test("resource nodes preserve original identity and render local images and links in view", () => {
  const source =
    '<p><ac:link><ri:page ri:content-title="Lorem nested specimen" ri:content-id="1710"/><ac:plain-text-link-body><![CDATA[Lorem child]]></ac:plain-text-link-body></ac:link></p><ac:image ac:width="96" ac:height="64"><ri:attachment ri:filename="lorem.png"/><ac:caption><p>Lorem image caption</p></ac:caption></ac:image>';
  const editor = storageToEditor(source, { pageId: "1700" });
  assert.deepEqual(xmlTree(editorToStorage(editor)), xmlTree(source));
  const view = storageToView(source, { pageId: "1700" });
  assert.match(view, /pageId=1710/);
  assert.match(view, /\/download\/attachments\/1700\/lorem\.png/);
  assert.match(view, /Lorem image caption/);
  assert.match(view, /width="96"/);
});

test("layouts map to native columns and reconstruct cell edits, type and original attributes", () => {
  const source =
    '<ac:layout ac:local-id="lorem-layout"><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Lorem left</p></ac:layout-cell><ac:layout-cell><p>Lorem right</p>' +
    opaque +
    "</ac:layout-cell></ac:layout-section></ac:layout>";
  const editor = storageToEditor(source);
  assert.match(editor, /contentLayout2/);
  assert.match(editor, /columnLayout/);
  assert.match(editor, /innerCell/);
  assert.deepEqual(
    xmlTree(editorToStorage(editor.replace("Lorem left", "Edited Lorem left"))),
    xmlTree(source.replace("Lorem left", "Edited Lorem left")),
  );
  assert.throws(
    () =>
      storageToEditor(
        '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Lorem</p></ac:layout-cell></ac:layout-section></ac:layout>',
      ),
    /layout|cell/i,
  );
});

test("catalog exposes deterministic hierarchy, independent expectations and a rich component taxonomy", () => {
  assert.deepEqual(
    catalog.map((page) => page.id),
    ["1000", "1100", "1200", "1300", "1400", "1500", "1600", "1700", "1710", "1800"],
  );
  assert.equal(catalog.find((page) => page.id === "1710").parentId, "1700");
  for (const page of catalog) {
    const baseline = canonicalStorage(page.storage);
    assert.deepEqual(
      xmlTree(editorToStorage(storageToEditor(baseline, { pageId: page.id }))),
      xmlTree(baseline),
      `catalog page ${page.id} roundtrips without normalization loss`,
    );
  }
  const all = catalog.map((page) => page.storage).join("");
  for (const name of [
    "info",
    "note",
    "warning",
    "tip",
    "expand",
    "status",
    "code",
    "toc",
    "children",
    "excerpt",
    "details",
    "lorem-plugin",
    "gallery",
  ]) {
    assert.ok(all.includes(`ac:name="${name}"`), `catalog includes ${name}`);
  }
  for (const value of [
    "language-java",
    "language-js",
    "language-json",
    "language-yaml",
    "language-xml",
    "language-sql",
    "rowspan=",
    "colspan=",
    "ac:task-list",
    "two_equal",
    "three_equal",
    "lorem.png",
    "lorem.json",
    "lorem.csv",
    "lorem.pdf",
  ]) {
    assert.ok(all.includes(value), `catalog includes ${value}`);
  }
});

test("rendered macro views have meaningful Lorem content instead of an opaque-only page", () => {
  const page = catalog.find((item) => item.id === "1500");
  const view = storageToView(page.storage, {
    pageId: page.id,
    children: [{ id: "1710", title: "Lorem nested specimen" }],
  });
  for (const text of [
    "Lorem information",
    "Lorem note",
    "Lorem warning",
    "Lorem tip",
    "Lorem expanded details",
    "LOREM READY",
    "Lorem excerpt",
    "lorem-plugin",
  ])
    assert.ok(view.includes(text), text);
  assert.match(view, /<pre/);
  assert.match(view, /data-macro-name="toc"/);
});

for (const [label, source] of [
  ["active HTML", "<p>Lorem</p><script>alert(1)</script>"],
  ["event handler", '<p onclick="alert(1)">Lorem</p>'],
  ["unsafe URL", '<p><a href="jav&#97;script:alert(1)">Lorem</a></p>'],
  ["remote resource", '<p><img src="https://example.invalid/lorem.png"/></p>'],
  ["CSS URL", '<p style="background: url(https://example.invalid)">Lorem</p>'],
  ["unsupported HTML", '<video src="/lorem.mp4"></video>'],
  ["foreign namespace", '<other:node xmlns:other="urn:foreign">Lorem</other:node>'],
  ["doctype", '<!DOCTYPE x [<!ENTITY y "Lorem">]><p>&y;</p>'],
]) {
  test(`unsafe or unsupported Storage rejects ${label} without sanitizing it away`, () => {
    assert.throws(
      () => storageToEditor(source),
      /unsafe|unsupported|invalid|local|namespace|doctype/i,
    );
  });
}

for (const source of [
  "<script>alert(1)</script>",
  '<p onmouseover="alert(1)">Lorem</p>',
  '<p><a href="java&#x0a;script:alert(1)">Lorem</a></p>',
  '<p style="color:expression(alert(1))">Lorem</p>',
  '<iframe src="/health"></iframe>',
  "<p><custom-lorem>ipsum</custom-lorem></p>",
  '<div data-sandbox-kind="invented">Lorem</div>',
]) {
  test(`editor rejects unsafe or unsupported source: ${source.slice(0, 45)}`, () => {
    assert.throws(() => editorToStorage(source), /unsafe|unsupported|invalid|metadata/i);
  });
}

test("codec bounds source size and depth and rejects malformed XML", () => {
  assert.throws(() => storageToEditor("<p>"), /invalid|xml/i);
  assert.throws(
    () => storageToEditor("<p>" + "x".repeat(2 * 1024 * 1024) + "</p>"),
    /limit|large|size/i,
  );
  assert.throws(
    () => editorToStorage("<div>".repeat(140) + "Lorem" + "</div>".repeat(140)),
    /depth|limit/i,
  );
});
