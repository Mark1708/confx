// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { isSortableTable, slugify, tableFilename, tableToCsv } from "../../src/lib/table-to-csv";

function parseTable(html: string): HTMLTableElement {
  const doc = new DOMParser().parseFromString(`<table>${html}</table>`, "text/html");
  const table = doc.querySelector("table");

  if (!table) {
    throw new Error("Test table was not parsed");
  }

  return table;
}

function parseTableElement(html: string): HTMLTableElement {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");

  if (!table) {
    throw new Error("Test table was not parsed");
  }

  return table;
}

describe("tableToCsv", () => {
  it("converts a simple 2x2 table with one header and one data row", () => {
    const table = parseTable(`
      <tr><th>Name</th><th>Type</th></tr>
      <tr><td>disabled</td><td>boolean</td></tr>
    `);

    expect(tableToCsv(table)).toBe("Name,Type\ndisabled,boolean");
  });

  it("returns an empty string for a table with no rows", () => {
    const table = parseTable("");

    expect(tableToCsv(table)).toBe("");
  });

  it("duplicates rowspan cell content into covered rows", () => {
    const table = parseTable(`
      <tr><td rowspan="2">Shared</td><td>First</td></tr>
      <tr><td>Second</td></tr>
    `);

    expect(tableToCsv(table)).toBe("Shared,First\nShared,Second");
  });

  it("duplicates colspan cell content into covered columns", () => {
    const table = parseTable(`
      <tr><th colspan="2">Group</th><th>Value</th></tr>
      <tr><td>Left</td><td>Right</td><td>10</td></tr>
    `);

    expect(tableToCsv(table)).toBe("Group,Group,Value\nLeft,Right,10");
  });

  it("duplicates cells across a combined rowspan and colspan area", () => {
    const table = parseTable(`
      <tr><th rowspan="2" colspan="2">Group</th><th>Value</th></tr>
      <tr><td>10</td></tr>
    `);

    expect(tableToCsv(table)).toBe("Group,Group,Value\nGroup,Group,10");
  });

  it("preserves tablesorter header text and removes sorter icons", () => {
    const table = parseTable(`
      <tr>
        <th>
          <div class="tablesorter-header-inner">
            Name<span class="tablesorter-headerIcon">sort</span>
            <span class="tablesorter-header-indicator">asc</span>
          </div>
        </th>
      </tr>
    `);

    expect(tableToCsv(table)).toBe("Name");
  });

  it("converts br tags to newlines inside cell text", () => {
    const table = parseTable("<tr><td>Line 1<br>Line 2</td></tr>");

    expect(tableToCsv(table)).toBe('"Line 1\nLine 2"');
  });

  it("replaces images with alt text when available", () => {
    const table = parseTable('<tr><td><img alt="Diagram" src="diagram.png"></td></tr>');

    expect(tableToCsv(table)).toBe("[image:Diagram]");
  });

  it("replaces images with src when alt text is missing", () => {
    const table = parseTable('<tr><td><img src="fallback.png"></td></tr>');

    expect(tableToCsv(table)).toBe("[image:fallback.png]");
  });

  it("prefixes list items with bullets", () => {
    const table = parseTable("<tr><td><ul><li>First</li><li>Second</li></ul></td></tr>");

    expect(tableToCsv(table)).toBe('"• First\n• Second"');
  });

  it("preserves mixed inline content from links, code, and bold text", () => {
    const table = parseTable(`
      <tr>
        <td><a href="/docs">Docs</a> <code>componentId</code> <strong>required</strong></td>
      </tr>
    `);

    expect(tableToCsv(table)).toBe("Docs componentId required");
  });

  it("escapes CSV fields containing commas, quotes, and newlines", () => {
    const table = parseTable('<tr><td>comma, quote "value"<br>next line</td></tr>');

    expect(tableToCsv(table)).toBe('"comma, quote ""value""\nnext line"');
  });

  it("keeps empty cells as empty fields", () => {
    const table = parseTable("<tr><td>Left</td><td></td><td>Right</td></tr>");

    expect(tableToCsv(table)).toBe("Left,,Right");
  });

  it("pads ragged rows to the maximum column width", () => {
    const table = parseTable(`
      <tr><td>A</td><td>B</td><td>C</td></tr>
      <tr><td>D</td><td>E</td></tr>
    `);

    expect(tableToCsv(table)).toBe("A,B,C\nD,E,");
  });
});

describe("isSortableTable", () => {
  it('returns true when className contains "tablesorter"', () => {
    const table = parseTableElement('<table class="confluenceTable tablesorter stickyTable"></table>');

    expect(isSortableTable(table)).toBe(true);
  });

  it("returns false for plain tables", () => {
    const table = parseTableElement('<table class="confluenceTable"></table>');

    expect(isSortableTable(table)).toBe(false);
  });
});

describe("tableFilename", () => {
  it("uses the slugified section and a zero-padded 1-based index", () => {
    expect(tableFilename("API Component", 0)).toBe("api-component-01.csv");
  });

  it('uses the "table" prefix when section is missing', () => {
    expect(tableFilename(undefined, 0)).toBe("table-01.csv");
  });

  it("increments index before padding", () => {
    expect(tableFilename("API Component", 9)).toBe("api-component-10.csv");
  });
});

describe("slugify", () => {
  it("normalizes Russian text and strips diacritics", () => {
    expect(slugify("Ёлка и API")).toBe("елка-и-api");
  });

  it("converts spaces and special characters to hyphens", () => {
    expect(slugify("Menu Component: API v2 / props")).toBe("menu-component-api-v2-props");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("--- API Component !!!")).toBe("api-component");
  });

  it("limits slugs to 64 characters", () => {
    expect(slugify("a".repeat(80))).toBe("a".repeat(64));
  });

  it("returns an empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });
});
