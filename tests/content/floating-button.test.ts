import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebouncedReconcile } from "@/content/floating-button";

describe("createDebouncedReconcile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a burst of 50 calls into at most two reconcile executions (leading + trailing)", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const debounced = createDebouncedReconcile(reconcile, 150);

    for (let i = 0; i < 50; i++) debounced();

    // Leading edge fired synchronously on the first call.
    expect(reconcile).toHaveBeenCalledTimes(1);

    // After the burst settles and the trailing delay passes, exactly one more.
    await vi.advanceTimersByTimeAsync(150);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("isolated single call triggers only the leading edge", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const debounced = createDebouncedReconcile(reconcile, 150);

    debounced();

    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("reentrancy guard prevents concurrent reconcile executions", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const reconcile = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 1) {
        // First invocation hangs until the test resolves it.
        await firstCall;
      }
      inFlight -= 1;
    });

    const debounced = createDebouncedReconcile(reconcile, 150);

    // Leading edge: first safeReconcile starts, enters reconcile, hangs.
    debounced();
    // Flush microtasks so the async body reaches `await firstCall`.
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Trailing edge fires at +150ms while the first reconcile is still in flight.
    await vi.advanceTimersByTimeAsync(150);
    // Guard short-circuited the trailing safeReconcile: reconcile NOT called again.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    // Release the first call; reconciling flag resets. Trailing edge already
    // completed (it returned early) and will not retry.
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);
  });

  it("after an idle period, a new call triggers leading edge again", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const debounced = createDebouncedReconcile(reconcile, 150);

    debounced();
    expect(reconcile).toHaveBeenCalledTimes(1);
    // Guard timer expires without a trailing call (no subsequent calls arrived).
    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).toHaveBeenCalledTimes(1);

    // New call after idle triggers a fresh leading edge.
    debounced();
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("cancels pending reconciliation when its owner is torn down", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const debounced = createDebouncedReconcile(reconcile, 150);
    debounced();
    debounced();
    debounced.cancel();
    await vi.advanceTimersByTimeAsync(300);
    debounced();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
