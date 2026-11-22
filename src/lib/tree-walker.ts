import type { ConfluenceApi, ConfluencePageRaw } from "./confluence-api";
import { allWithSiblingAbort } from "./parallel-batch";

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
  const batchSignal = opts.signal ?? new AbortController().signal;
  while (queue.length) {
    if (batchSignal.aborted) break;

    const batch = queue.splice(0, concurrency);
    // A fatal child read cancels its in-flight siblings; the batch settles
    // (cleanup tails included) before the original failure propagates.
    const results = await allWithSiblingAbort(
      batchSignal,
      batch.map(
        (node) =>
          (
            read: AbortSignal,
          ): Promise<Array<{ parent: WalkResultNode; page: ConfluencePageRaw }>> => {
            if (node.depth >= maxDepth) return Promise.resolve([]);
            return api
              .getChildren(node.page.id, 100, read)
              .then((children) => children.map((child) => ({ parent: node, page: child })));
          },
      ),
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
