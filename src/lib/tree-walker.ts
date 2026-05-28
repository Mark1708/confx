import type { ConfluenceApi, ConfluencePageRaw } from "./confluence-api";

export interface WalkOptions {
  maxDepth?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onPage?: (page: ConfluencePageRaw, depth: number) => void;
}

export interface WalkResultNode {
  page: ConfluencePageRaw;
  depth: number;
  children: WalkResultNode[];
}

export async function walkTree(
  api: ConfluenceApi,
  rootId: string,
  opts: WalkOptions = {},
): Promise<WalkResultNode> {
  const maxDepth = opts.maxDepth ?? 10;
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  const rootPage = await api.getPage(rootId, ["space", "version", "ancestors"], opts.signal);
  const root: WalkResultNode = { page: rootPage, depth: 0, children: [] };
  opts.onPage?.(rootPage, 0);

  const queue: WalkResultNode[] = [root];
  while (queue.length) {
    if (opts.signal?.aborted) break;

    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(
      batch.map(async (node) => {
        if (node.depth >= maxDepth) return [];
        const children = await api.getChildren(node.page.id, 100, opts.signal);
        return children.map((c) => ({ parent: node, page: c }));
      }),
    );
    for (const group of results) {
      for (const { parent, page } of group) {
        const child: WalkResultNode = {
          page,
          depth: parent.depth + 1,
          children: [],
        };
        parent.children.push(child);
        opts.onPage?.(page, child.depth);
        queue.push(child);
      }
    }
  }
  return root;
}

export function flattenTree(root: WalkResultNode): WalkResultNode[] {
  const out: WalkResultNode[] = [];
  const stack: WalkResultNode[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    out.push(node);
    stack.push(...node.children);
  }
  return out;
}

export function treeSize(root: WalkResultNode): number {
  return flattenTree(root).length;
}
