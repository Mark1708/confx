export type ConfluenceLayoutType =
  | "single"
  | "two_equal"
  | "two_left_sidebar"
  | "two_right_sidebar"
  | "three_equal"
  | "three_with_sidebars";
export const CONFX_LAYOUT_MARKER_VERSION = "1" as const;

export interface ConfluenceLayoutSection<TCell = string> {
  type: ConfluenceLayoutType;
  cells: TCell[];
}

export interface ConfluenceLayout<TCell = string> {
  sections: ConfluenceLayoutSection<TCell>[];
}

export type ConfluenceLayoutExtraction<TCell = string> =
  | { kind: "none"; sections: 0 }
  | { kind: "valid"; sections: number; layout: ConfluenceLayout<TCell> }
  | { kind: "invalid"; sections: number; error: string };

const CELL_COUNTS: Record<ConfluenceLayoutType, number> = {
  single: 1,
  two_equal: 2,
  two_left_sidebar: 2,
  two_right_sidebar: 2,
  three_equal: 3,
  three_with_sidebars: 3,
};

const LAYOUT_END = "<!-- confx:layout:end -->";
const SECTION_END = "<!-- confx:section:end -->";
const CELL_START = "<!-- confx:cell:start -->";
const CELL_END = "<!-- confx:cell:end -->";

export function extractConfluenceLayout(
  viewHtml: string,
  storageHtml?: string,
): ConfluenceLayoutExtraction<HTMLElement> {
  const view = extractViewLayout(viewHtml);
  if (view.kind === "invalid") return view;

  if (storageHtml === undefined) return view;

  const storage = extractStorageLayout(storageHtml);
  if (storage.kind === "invalid") {
    return {
      ...storage,
      sections: view.kind === "valid" ? view.sections : storage.sections,
    };
  }
  if (view.kind === "none" && storage.kind === "none") return view;
  if (view.kind === "none" || storage.kind === "none") {
    return {
      kind: "invalid",
      sections:
        view.kind === "valid" ? view.sections : storage.kind === "valid" ? storage.sections : 0,
      error: "Confluence view and storage layout presence differs",
    };
  }

  if (!sameShape(view.layout, storage.layout)) {
    return {
      kind: "invalid",
      sections: view.sections,
      error: "Confluence view and storage layout shapes differ",
    };
  }

  return view;
}

export function formatConfluenceLayoutMarkdown<TCell>(
  layout: ConfluenceLayout<TCell>,
  convertCell: (cell: TCell) => string,
): string {
  const lines: string[] = [`<!-- confx:layout:start version="${CONFX_LAYOUT_MARKER_VERSION}" -->`];

  for (const section of layout.sections) {
    assertSectionShape(section);
    lines.push("", `<!-- confx:section:start type="${section.type}" -->`);
    for (const cell of section.cells) {
      lines.push("", CELL_START, "", convertCell(cell).trim(), "", CELL_END);
    }
    lines.push("", SECTION_END);
  }

  lines.push("", LAYOUT_END);
  return lines.join("\n");
}

function extractViewLayout(html: string): ConfluenceLayoutExtraction<HTMLElement> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const roots = Array.from(doc.querySelectorAll("div.contentLayout2"));
  if (roots.length === 0) return { kind: "none", sections: 0 };
  if (roots.length !== 1) {
    return { kind: "invalid", sections: 0, error: "multiple Confluence layout roots" };
  }

  const sections: ConfluenceLayoutSection<HTMLElement>[] = [];
  for (const sectionElement of directChildrenWithClass(roots[0], "columnLayout")) {
    const rawType =
      sectionElement.getAttribute("data-layout") ??
      Array.from(sectionElement.classList).find((name) => parseLayoutType(name));
    const type = rawType ? parseLayoutType(rawType) : undefined;
    if (!type) {
      return {
        kind: "invalid",
        sections: sections.length + 1,
        error: `unsupported rendered layout type: ${rawType ?? "missing"}`,
      };
    }

    const cellElements = directChildrenWithClass(sectionElement, "cell");
    const expected = CELL_COUNTS[type];
    if (cellElements.length !== expected) {
      return {
        kind: "invalid",
        sections: sections.length + 1,
        error: `${type} requires ${expected} rendered cells, got ${cellElements.length}`,
      };
    }

    sections.push({
      type,
      cells: cellElements.map((cell) => {
        const inner = directChildrenWithClass(cell, "innerCell")[0];
        return inner ?? cell;
      }),
    });
  }

  if (sections.length === 0) {
    return { kind: "invalid", sections: 0, error: "Confluence layout has no sections" };
  }
  return { kind: "valid", sections: sections.length, layout: { sections } };
}

function extractStorageLayout(html: string): ConfluenceLayoutExtraction {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const roots = Array.from(doc.body.children).filter(
    (element) => element.tagName.toLowerCase() === "ac:layout",
  );
  if (roots.length === 0) {
    const legacySections = Array.from(doc.querySelectorAll("div.columnLayout"));
    if (legacySections.length === 0) return { kind: "none", sections: 0 };
    return shapeFromLegacySections(legacySections);
  }
  if (roots.length !== 1) {
    return { kind: "invalid", sections: 0, error: "multiple storage layout roots" };
  }

  const sections: ConfluenceLayoutSection[] = [];
  for (const sectionElement of directChildrenByTag(roots[0], "ac:layout-section")) {
    const rawType = sectionElement.getAttribute("ac:type") ?? sectionElement.getAttribute("type");
    const type = rawType ? parseLayoutType(rawType) : undefined;
    if (!type) {
      return {
        kind: "invalid",
        sections: sections.length + 1,
        error: `unsupported storage layout type: ${rawType ?? "missing"}`,
      };
    }
    const cells = directChildrenByTag(sectionElement, "ac:layout-cell");
    const expected = CELL_COUNTS[type];
    if (cells.length !== expected) {
      return {
        kind: "invalid",
        sections: sections.length + 1,
        error: `${type} requires ${expected} storage cells, got ${cells.length}`,
      };
    }
    sections.push({ type, cells: cells.map((cell) => cell.innerHTML) });
  }

  if (sections.length === 0) {
    return { kind: "invalid", sections: 0, error: "storage layout has no sections" };
  }
  return { kind: "valid", sections: sections.length, layout: { sections } };
}

function shapeFromLegacySections(sectionElements: Element[]): ConfluenceLayoutExtraction {
  const sections: ConfluenceLayoutSection[] = [];
  for (const sectionElement of sectionElements) {
    const rawType =
      sectionElement.getAttribute("data-layout") ??
      Array.from(sectionElement.classList).find((name) => parseLayoutType(name));
    const type = rawType ? parseLayoutType(rawType) : undefined;
    if (!type) {
      return { kind: "invalid", sections: sections.length + 1, error: "unsupported legacy layout" };
    }
    const cells = directChildrenWithClass(sectionElement, "cell");
    if (cells.length !== CELL_COUNTS[type]) {
      return { kind: "invalid", sections: sections.length + 1, error: "invalid legacy cell count" };
    }
    sections.push({ type, cells: cells.map((cell) => cell.innerHTML) });
  }
  return { kind: "valid", sections: sections.length, layout: { sections } };
}

function parseLayoutType(value: string): ConfluenceLayoutType | undefined {
  const normalized = value.trim().replaceAll("-", "_");
  return normalized in CELL_COUNTS ? (normalized as ConfluenceLayoutType) : undefined;
}

function directChildrenWithClass(element: Element, className: string): HTMLElement[] {
  return Array.from(element.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains(className),
  );
}

function directChildrenByTag(element: Element, tagName: string): HTMLElement[] {
  return Array.from(element.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.tagName.toLowerCase() === tagName,
  );
}

function sameShape(left: ConfluenceLayout<unknown>, right: ConfluenceLayout<unknown>): boolean {
  return (
    left.sections.length === right.sections.length &&
    left.sections.every(
      (section, index) =>
        section.type === right.sections[index]?.type &&
        section.cells.length === right.sections[index]?.cells.length,
    )
  );
}

function assertSectionShape(section: ConfluenceLayoutSection<unknown>): void {
  const expected = CELL_COUNTS[section.type];
  if (section.cells.length !== expected) {
    throw new Error(`${section.type} requires ${expected} cells, got ${section.cells.length}`);
  }
}
