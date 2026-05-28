import { describe, expect, it } from "vitest";

import { createExportJob, ExportJob } from "../../src/lib/export-job";
import type { ExportJobConfig } from "../../src/types";

const config: ExportJobConfig = {
  kind: "extract-page",
  host: "https://confluence.example.com",
  presetId: "generic",
  pageId: "123",
};

describe("ExportJob state machine", () => {
  it('starts with status "pending"', () => {
    const job = new ExportJob("job-1", config);

    expect(job.status).toBe("pending");
    expect(job.signal).toBeUndefined();
    expect(job.progress).toEqual({ current: 0, total: 0, message: "" });
  });

  it('start() transitions to "running"', () => {
    const job = new ExportJob("job-1", config);

    job.start();

    expect(job.status).toBe("running");
    expect(job.signal).toBeInstanceOf(AbortSignal);
  });

  it('complete() transitions to "completed"', () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.complete("page.zip");

    expect(job.status).toBe("completed");
  });

  it('fail() transitions to "failed"', () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.fail("Network failed");

    expect(job.status).toBe("failed");
  });

  it('cancel() transitions to "cancelled"', () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.cancel();

    expect(job.status).toBe("cancelled");
  });

  it("cancel() aborts the signal", () => {
    const job = new ExportJob("job-1", config);

    job.start();
    const signal = job.signal;
    job.cancel();

    expect(signal?.aborted).toBe(true);
  });

  it("cannot transition from pending to completed", () => {
    const job = new ExportJob("job-1", config);

    expect(() => job.complete("page.zip")).toThrow("Invalid export job transition: pending -> completed");
  });

  it("cannot transition from completed to running", () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.complete("page.zip");

    expect(() => job.start()).toThrow("Invalid export job transition: completed -> running");
  });

  it("cannot transition from failed to completed", () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.fail("Network failed");

    expect(() => job.complete("page.zip")).toThrow("Invalid export job transition: failed -> completed");
  });

  it("cannot double-start", () => {
    const job = new ExportJob("job-1", config);

    job.start();

    expect(() => job.start()).toThrow("Invalid export job transition: running -> running");
  });

  it("start() sets startedAt timestamp", () => {
    const job = new ExportJob("job-1", config);

    job.start();

    expect(job.startedAt).toEqual(expect.any(String));
    expect(Date.parse(job.startedAt ?? "")).not.toBeNaN();
  });

  it("complete() sets completedAt timestamp and result", () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.complete("page.zip");

    expect(job.completedAt).toEqual(expect.any(String));
    expect(Date.parse(job.completedAt ?? "")).not.toBeNaN();
    expect(job.result).toEqual({ fileName: "page.zip" });
  });

  it("fail() sets error", () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.fail("Network failed");

    expect(job.error).toBe("Network failed");
  });

  it("updateProgress() works when running", () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.updateProgress(1, 3, "Extracting page");

    expect(job.progress).toEqual({ current: 1, total: 3, message: "Extracting page" });
  });

  it("updateProgress() is no-op when not running", () => {
    const job = new ExportJob("job-1", config);

    job.updateProgress(1, 3, "Extracting page");

    expect(job.progress).toEqual({ current: 0, total: 0, message: "" });
  });

  it("toState() returns correct ExportJobState", () => {
    const job = new ExportJob("job-1", config);

    job.start();
    job.updateProgress(1, 1, "Сборка архива…");
    job.complete("page.zip");

    expect(job.toState()).toEqual({
      id: "job-1",
      status: "completed",
      config,
      progress: { current: 1, total: 1, message: "Сборка архива…" },
      error: undefined,
      result: { fileName: "page.zip" },
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
  });
});

describe("createExportJob", () => {
  it("creates job with generated ID and given config", () => {
    const job = createExportJob(config);

    expect(job.id).toEqual(expect.any(String));
    expect(job.id.length).toBeGreaterThan(0);
    expect(job.config).toBe(config);
    expect(job.status).toBe("pending");
  });
});
