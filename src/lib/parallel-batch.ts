type BatchTask<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Runs one parallel batch under an owned cancellation scope: the first fatal
 * rejection aborts the still-live siblings, every task is awaited to settle
 * (including abort-driven cleanup), and only the original failure propagates.
 * A parent abort cancels the whole batch with the parent's own reason.
 */
export async function allWithSiblingAbort<T extends readonly unknown[]>(
  parent: AbortSignal,
  tasks: { readonly [K in keyof T]: BatchTask<T[K]> },
): Promise<T> {
  const scope = new AbortController();
  const forwardAbort = (): void => scope.abort(parent.reason);
  if (parent.aborted) forwardAbort();
  else parent.addEventListener("abort", forwardAbort, { once: true });

  let fatal: { error: unknown } | undefined;
  const runs: Array<Promise<unknown>> = [];
  for (const task of tasks) {
    runs.push(
      task(scope.signal).catch((error: unknown) => {
        if (!fatal) {
          fatal = { error };
          // Cancel the still-live siblings; their cleanup still settles below.
          scope.abort(new DOMException("The operation was aborted.", "AbortError"));
        }
        throw error;
      }),
    );
  }
  await Promise.allSettled(runs);
  parent.removeEventListener("abort", forwardAbort);
  if (fatal) throw fatal.error;
  // Every task settled without a fatal error; settled values keep the tuple order.
  const values = (await Promise.all(runs)) as unknown as T;
  return values;
}
