import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCache } from "@/lib/tree-cache";
import { TreeView } from "@/sidepanel/components/TreeView";

vi.mock("@/sidepanel/hooks/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.title ? `${key}:${values.title}` : key,
  }),
}));

const nodes: HostCache = {
  "100": {
    id: "100",
    title: "Lorem root",
    hasChildren: true,
    childrenLoaded: true,
    childrenIds: ["200", "300"],
  },
  "200": {
    id: "200",
    title: "Ipsum branch",
    parentId: "100",
    hasChildren: true,
    childrenLoaded: true,
    childrenIds: ["201"],
  },
  "201": {
    id: "201",
    title: "Ipsum leaf",
    parentId: "200",
    hasChildren: false,
    childrenLoaded: true,
    childrenIds: [],
  },
  "300": {
    id: "300",
    title: "Dolor branch",
    parentId: "100",
    hasChildren: false,
    childrenLoaded: true,
    childrenIds: [],
  },
};

function ControlledTree({ filtered = false }: { filtered?: boolean }) {
  const [expandedIds, setExpandedIds] = useState(["100"]);
  return (
    <TreeView
      nodes={nodes}
      rootId="100"
      expandedIds={expandedIds}
      onExpandedChange={setExpandedIds}
      filter={filtered ? "Ipsum leaf" : ""}
      visibleIds={filtered ? new Set(["100", "200", "201"]) : null}
      matchedIds={filtered ? new Set(["201"]) : null}
      onSelect={() => {}}
      onExpand={() => {}}
      onNavigate={() => {}}
    />
  );
}

describe("controlled export tree expansion", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalScrollTo = HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    HTMLElement.prototype.scrollTo = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    HTMLElement.prototype.scrollTo = originalScrollTo;
  });

  it("does not turn temporary filter expansion into a manual expansion", async () => {
    await act(async () => root.render(<ControlledTree />));
    expect(container.textContent).not.toContain("Ipsum leaf");
    await act(async () => root.render(<ControlledTree filtered />));
    expect(container.textContent).toContain("Ipsum leaf");
    await act(async () => root.render(<ControlledTree />));
    expect(container.textContent).not.toContain("Ipsum leaf");
    expect(container.textContent).toContain("Ipsum branch");
  });

  it("honors restored expansion metadata after unmounting and remounting", async () => {
    const props = {
      nodes,
      rootId: "100",
      expandedIds: ["100", "200"],
      onExpandedChange: vi.fn(),
      onSelect: vi.fn(),
      onExpand: vi.fn(),
      onNavigate: vi.fn(),
    };
    await act(async () => root.render(<TreeView {...props} />));
    expect(container.textContent).toContain("Ipsum leaf");
    await act(async () => root.render(null));
    await act(async () => root.render(<TreeView {...props} selectedId="300" />));
    expect(container.textContent).toContain("Ipsum leaf");
    expect(props.onExpandedChange).not.toHaveBeenCalled();
  });
});
