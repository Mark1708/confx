/**
 * HTML <table> → CSV.
 * - Handles rowspan/colspan by duplicating values into merged cells.
 * - Strips Confluence tablesorter markup.
 * - Preserves inline text from links, code, lists inside cells.
 */

function cellText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(".tablesorter-header-inner").forEach((n) => {
    n.replaceWith(...Array.from(n.childNodes));
  });
  clone.querySelectorAll(".tablesorter-headerIcon, .tablesorter-header-indicator").forEach(
    (n) => n.remove(),
  );
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  // Prefer visible alt over missing src for images
  clone.querySelectorAll("img").forEach((img) => {
    const alt = img.getAttribute("alt") || "";
    const src = img.getAttribute("data-linked-resource-default-alias") || img.getAttribute("src") || "";
    img.replaceWith(`[image:${alt || src}]`);
  });
  clone.querySelectorAll("li").forEach((li) => {
    const text = li.textContent?.trim() ?? "";
    li.replaceWith(`• ${text}\n`);
  });
  return (clone.textContent ?? "").replace(/\s+\n/g, "\n").replace(/\n+/g, "\n").trim();
}

function escapeCsv(s: string): string {
  if (s === "") return "";
  if (/[",\n\r;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function tableToCsv(table: HTMLTableElement): string {
  const rows = Array.from(table.rows);
  if (!rows.length) return "";

  // Compute grid with rowspan/colspan expansion
  const grid: string[][] = [];
  for (let r = 0; r < rows.length; r++) {
    if (!grid[r]) grid[r] = [];
    const cells = Array.from(rows[r].cells);
    let cIndex = 0;
    for (const cell of cells) {
      while (grid[r][cIndex] !== undefined) cIndex++;
      const text = cellText(cell);
      const rowspan = Math.max(1, Number(cell.getAttribute("rowspan") || "1"));
      const colspan = Math.max(1, Number(cell.getAttribute("colspan") || "1"));
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (!grid[r + dr]) grid[r + dr] = [];
          grid[r + dr][cIndex + dc] = text;
        }
      }
      cIndex += colspan;
    }
  }

  const maxCols = grid.reduce((m, row) => Math.max(m, row.length), 0);
  return grid
    .map((row) => {
      const padded: string[] = [];
      for (let i = 0; i < maxCols; i++) padded.push(row[i] ?? "");
      return padded.map(escapeCsv).join(",");
    })
    .join("\n");
}

export function isSortableTable(table: HTMLTableElement): boolean {
  return /\btablesorter\b/.test(table.className);
}

/** Slug for filename from a section or index. */
export function tableFilename(section: string | undefined, index: number): string {
  const base = section ? slugify(section) : "table";
  return `${base}-${String(index + 1).padStart(2, "0")}.csv`;
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
