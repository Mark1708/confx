import { Blob, File } from "node:buffer";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { ArchiveEntry, ExportSummary } from "@/lib/export/contracts";
import { PageSourceError } from "@/lib/export/confluence";
import {
  createDirectorySink,
  createMemoryZipSink,
  createStreamedZipSink,
  DestinationCollisionError,
  EXPORT_MARKER_FILE,
  type DirectoryExportMarker,
} from "@/lib/export/sinks";
import { ZIP_MIME_TYPE, ZipEncoder } from "@/lib/export/zip-encoder";

const signal = () => new AbortController().signal;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const pngBytes = new Uint8Array([0, 255, 13, 10, 128, 42]);

/** The lorem page fixture used by the encoder suite: unicode text plus a binary resource. */
function fixtureEntries(): ArchiveEntry[] {
  return [
    { path: "pages/1700/index.md", body: "# Lorem\n\nПривет — ipsum\n" },
    { path: "pages/1700/images/lorem.png", body: new Blob([pngBytes]) },
    { path: "pages/1700/tables/lorem.csv", body: "id,name\n1,lorem\n" },
    { path: "pages/1800/index.md", body: "## Dolor sit\n" },
  ];
}

function summary(rootName: string, partial = false): ExportSummary {
  return {
    rootName,
    fileName: `${rootName}.zip`,
    outcome: {
      partial,
      successfulPages: 2,
      failedPages: partial ? 1 : 0,
      successfulResources: 1,
      failedResources: null,
      entriesWritten: null,
    },
  };
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

async function enteredBeforeSettled(
  running: Promise<unknown>,
  entered: Promise<void>,
): Promise<void> {
  await Promise.race([
    entered,
    running.then(() => {
      throw new Error("Operation settled before its required I/O gate");
    }),
  ]);
}

type WritableBehavior = {
  beforeCreateWritable?: () => Promise<void>;
  beforeWrite?: (index: number) => Promise<void>;
  beforeClose?: () => Promise<void>;
};

class FakeFile {
  readonly behavior: WritableBehavior;
  committed: Uint8Array | null;
  writes: Array<Uint8Array | string | Blob> = [];
  writeCalls = 0;
  closeCalls = 0;
  abortCalls = 0;
  createWritableCalls = 0;

  constructor(committed: Uint8Array | null = null, behavior: WritableBehavior = {}) {
    this.committed = committed;
    this.behavior = behavior;
  }
}

async function concatWrites(writes: Array<Uint8Array | string | Blob>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const data of writes) {
    if (typeof data === "string") parts.push(textEncoder.encode(data));
    else if (data instanceof Blob) parts.push(new Uint8Array(await data.arrayBuffer()));
    else parts.push(data);
  }
  const combined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

class FakeWritable implements FileSystemWritableFileStream {
  private readonly buffer: Array<Uint8Array | string | Blob> = [];
  private readonly pending: Array<{ reject(error: unknown): void }> = [];
  private state: "open" | "closed" | "aborted" | "errored" = "open";

  constructor(private readonly file: FakeFile) {}

  get locked(): boolean {
    return false;
  }
  getWriter(): WritableStreamDefaultWriter {
    throw new Error("Export sinks never acquire a writer");
  }
  seek(_position: number): Promise<void> {
    return Promise.reject(new Error("Export sinks never seek"));
  }
  truncate(_size: number): Promise<void> {
    return Promise.reject(new Error("Export sinks never truncate"));
  }

  write(data: FileSystemWriteChunkType): Promise<void> {
    const index = (this.file.writeCalls += 1);
    if (this.state !== "open") {
      return Promise.reject(new Error(`Cannot write a ${this.state} stream`));
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const pending = { reject };
    this.pending.push(pending);
    void (async () => {
      try {
        await this.file.behavior.beforeWrite?.(index);
        if (this.state !== "open") return; // abort() already rejected this write
        this.pending.splice(this.pending.indexOf(pending), 1);
        this.file.writes.push(data);
        this.buffer.push(data);
        resolve();
      } catch (error) {
        if (this.state === "open") {
          this.state = "errored";
          this.pending.splice(this.pending.indexOf(pending), 1);
        }
        reject(error);
      }
    })();
    return promise;
  }

  close(): Promise<void> {
    this.file.closeCalls += 1;
    if (this.state !== "open") {
      return Promise.reject(new Error(`Cannot close a ${this.state} stream`));
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const pending = { reject };
    this.pending.push(pending);
    void (async () => {
      try {
        await this.file.behavior.beforeClose?.();
        if (this.state !== "open") return;
        this.state = "closed";
        this.pending.splice(this.pending.indexOf(pending), 1);
        this.file.committed = await concatWrites(this.buffer);
        resolve();
      } catch (error) {
        if (this.state === "open") {
          this.state = "errored";
          this.pending.splice(this.pending.indexOf(pending), 1);
        }
        reject(error);
      }
    })();
    return promise;
  }

  abort(): Promise<void> {
    this.file.abortCalls += 1;
    if (this.state === "aborted") return Promise.resolve();
    this.state = "aborted";
    for (const pending of this.pending.splice(0)) {
      pending.reject(new DOMException("The writable stream was aborted", "AbortError"));
    }
    return Promise.resolve();
  }
}

function assertSegment(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/")) {
    throw new TypeError(`Invalid file system name: ${name}`);
  }
}

class FakeDirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = "directory" as const;
  readonly directories = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFile>();
  readonly removed: string[] = [];
  /** Snapshotted onto every file this directory creates; set it before triggering a write. */
  newFileBehavior: WritableBehavior = {};

  constructor(readonly name: string) {}

  getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FakeDirectoryHandle> {
    return Promise.resolve().then(() => {
      assertSegment(name);
      const directory = this.directories.get(name);
      if (directory) return directory;
      if (this.files.has(name)) {
        throw new DOMException(`"${name}" is a file`, "TypeMismatchError");
      }
      if (!options?.create) throw new DOMException(`"${name}" not found`, "NotFoundError");
      const created = new FakeDirectoryHandle(name);
      // Children inherit the behavior object so late mutations reach nested files.
      created.newFileBehavior = this.newFileBehavior;
      this.directories.set(name, created);
      return created;
    });
  }

  getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FakeFileHandle> {
    return Promise.resolve().then(() => {
      assertSegment(name);
      const file = this.files.get(name);
      if (file) return new FakeFileHandle(name, file);
      if (this.directories.has(name)) {
        throw new DOMException(`"${name}" is a directory`, "TypeMismatchError");
      }
      if (!options?.create) throw new DOMException(`"${name}" not found`, "NotFoundError");
      const created = new FakeFile(null, { ...this.newFileBehavior });
      this.files.set(name, created);
      return new FakeFileHandle(name, created);
    });
  }

  async removeEntry(name: string): Promise<void> {
    assertSegment(name);
    this.removed.push(name);
    this.directories.delete(name);
    this.files.delete(name);
  }
  async resolve(): Promise<string[] | null> {
    return null;
  }
  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }

  putDirectory(name: string): FakeDirectoryHandle {
    const directory = new FakeDirectoryHandle(name);
    this.directories.set(name, directory);
    return directory;
  }
  putFile(name: string, bytes: Uint8Array | null): FakeFile {
    const file = new FakeFile(bytes);
    this.files.set(name, file);
    return file;
  }
}

class FakeFileHandle implements FileSystemFileHandle {
  readonly kind = "file" as const;

  constructor(
    readonly name: string,
    private readonly file: FakeFile,
  ) {}

  async createWritable(): Promise<FakeWritable> {
    this.file.createWritableCalls += 1;
    await this.file.behavior.beforeCreateWritable?.();
    return new FakeWritable(this.file);
  }
  async getFile(): Promise<File> {
    return new File([this.file.committed ?? new Uint8Array()], this.name);
  }
  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }
}

function snapshot(directory: FakeDirectoryHandle, prefix = ""): Map<string, Uint8Array | null> {
  const tree = new Map<string, Uint8Array | null>();
  for (const [name, file] of directory.files) {
    tree.set(prefix ? `${prefix}/${name}` : name, file.committed);
  }
  for (const [name, child] of directory.directories) {
    for (const [path, bytes] of snapshot(child, prefix ? `${prefix}/${name}` : name)) {
      tree.set(path, bytes);
    }
  }
  return tree;
}

function markerOf(directory: FakeDirectoryHandle): DirectoryExportMarker {
  const file = directory.files.get(EXPORT_MARKER_FILE);
  if (!file?.committed) throw new Error("The export marker was not written");
  return JSON.parse(textDecoder.decode(file.committed)) as DirectoryExportMarker;
}

function totalCreateWritableCalls(directory: FakeDirectoryHandle): number {
  let total = 0;
  for (const file of directory.files.values()) total += file.createWritableCalls;
  for (const child of directory.directories.values()) total += totalCreateWritableCalls(child);
  return total;
}

describe("memory ZIP sink", () => {
  it("reproduces the current run-export blob byte-for-byte for identical entries", async () => {
    const entries = fixtureEntries();
    const legacy: Uint8Array<ArrayBuffer>[] = [];
    const legacyEncoder = new ZipEncoder("lorem-pages", async (chunk) => {
      legacy.push(chunk);
    });
    for (const entry of entries) await legacyEncoder.write(entry, signal());
    await legacyEncoder.finish(signal());

    const { sink, blob } = createMemoryZipSink("lorem-pages");
    for (const entry of entries) await sink.write(entry, signal());
    const receipt = await sink.finish(summary("lorem-pages"), signal());

    const produced = await blob();
    expect(produced.type).toBe(ZIP_MIME_TYPE);
    const producedBytes = new Uint8Array(await produced.arrayBuffer());
    const expectedBytes = new Uint8Array(
      await new Blob(legacy, { type: ZIP_MIME_TYPE }).arrayBuffer(),
    );
    expect(producedBytes.byteLength).toBe(expectedBytes.byteLength);
    expect(producedBytes).toEqual(expectedBytes);
    expect(receipt.fileName).toBe("lorem-pages.zip");
    expect(receipt.entriesWritten).toBe(entries.length);
    expect(receipt.bytesWritten).toBe(sink.stats().bytesWritten);
    expect(receipt.downloadId).toBeUndefined();
    const files = unzipSync(producedBytes);
    expect(strFromU8(files["lorem-pages/pages/1700/index.md"])).toBe("# Lorem\n\nПривет — ipsum\n");
    expect(files["lorem-pages/pages/1700/images/lorem.png"]).toEqual(pngBytes);
  });

  it("exposes the blob only after a successful finish and closes on abort", async () => {
    const { sink, blob } = createMemoryZipSink("lorem");
    await expect(blob()).rejects.toThrowError(/finish/);
    await sink.write({ path: "index.md", body: "Lorem" }, signal());
    expect(sink.stats().entriesWritten).toBe(1);
    await expect(blob()).rejects.toThrowError(/finish/);
    await sink.abort(new Error("Lorem destination lost"));
    await expect(blob()).rejects.toThrowError(/finish/);
    await expect(sink.write({ path: "late.md", body: "Late" }, signal())).rejects.toThrowError(
      /closed/,
    );
    await expect(sink.finish(summary("lorem"), signal())).rejects.toThrowError(/closed/);
  });

  it("rejects a package root that changed during production", async () => {
    const { sink, blob } = createMemoryZipSink("lorem");
    await sink.write({ path: "index.md", body: "Lorem" }, signal());
    await expect(sink.finish(summary("ipsum"), signal())).rejects.toThrowError(/root changed/);
    await expect(blob()).rejects.toThrowError(/finish/);
  });
});

describe("streamed ZIP sink", () => {
  it("keeps one native write in flight and closes only after every chunk is drained", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const sink = await createStreamedZipSink(parent, { rootName: "lorem-pages", jobId: "job-1" });
    const file = parent.files.get("lorem-pages-job-1.zip")!;
    const firstEntered = gate();
    const releaseFirst = gate();
    let peak = 0;
    let active = 0;
    file.behavior.beforeWrite = (index) => {
      active += 1;
      peak = Math.max(peak, active);
      if (index === 1) firstEntered.resolve();
      const done = index === 1 ? releaseFirst.promise : Promise.resolve();
      return done.then(() => {
        active -= 1;
      });
    };
    const first = sink.write(
      { path: "pages/1700/index.md", body: "# Lorem\n\nПривет — ipsum\n" },
      signal(),
    );
    await enteredBeforeSettled(first, firstEntered.promise);
    expect(file.writeCalls).toBe(1);
    releaseFirst.resolve();
    await first;

    file.behavior.beforeWrite = undefined;
    await sink.write({ path: "pages/1700/images/lorem.png", body: new Blob([pngBytes]) }, signal());

    const closeEntered = gate();
    const releaseClose = gate();
    file.behavior.beforeClose = () => {
      closeEntered.resolve();
      return releaseClose.promise;
    };
    const finishing = sink.finish(summary("lorem-pages"), signal());
    await enteredBeforeSettled(finishing, closeEntered.promise);
    expect(file.closeCalls).toBe(1);
    expect(file.committed).toBeNull();
    releaseClose.resolve();
    const receipt = await finishing;

    expect(peak).toBe(1);
    expect(file.abortCalls).toBe(0);
    expect(receipt.fileName).toBe("lorem-pages-job-1.zip");
    expect(receipt.entriesWritten).toBe(2);
    expect(receipt.bytesWritten).toBe(sink.stats().bytesWritten);
    const files = unzipSync(file.committed as Uint8Array);
    expect(strFromU8(files["lorem-pages/pages/1700/index.md"])).toBe("# Lorem\n\nПривет — ipsum\n");
    expect(files["lorem-pages/pages/1700/images/lorem.png"]).toEqual(pngBytes);
  });

  it("propagates writer failures without committing the new ZIP or touching other files", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const previous = textEncoder.encode("previous archive bytes");
    const existing = parent.putFile("existing.zip", previous);
    const sink = await createStreamedZipSink(parent, { rootName: "lorem", jobId: "failure" });
    const file = parent.files.get("lorem-failure.zip")!;
    await sink.write({ path: "first.md", body: "Lorem" }, signal());
    const failure = new Error("Lorem disk full");
    file.behavior.beforeWrite = () => Promise.reject(failure);
    await expect(sink.write({ path: "second.md", body: "Ipsum" }, signal())).rejects.toBe(failure);
    await sink.abort(failure);
    expect(file.abortCalls).toBe(1);
    expect(file.closeCalls).toBe(0);
    expect(file.committed).toBeNull();
    expect(existing.committed).toEqual(previous);
    expect(existing.createWritableCalls).toBe(0);
    expect(parent.removed).toEqual([]);
    await expect(sink.write({ path: "third.md", body: "Dolor" }, signal())).rejects.toThrowError(
      /closed/,
    );
  });

  it("aborts a pending native write without hanging and keeps the stream unclosed", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const previous = textEncoder.encode("keep this unrelated file");
    const existing = parent.putFile("existing.zip", previous);
    const sink = await createStreamedZipSink(parent, { rootName: "lorem", jobId: "cancel" });
    const file = parent.files.get("lorem-cancel.zip")!;
    const entered = gate();
    const release = gate();
    file.behavior.beforeWrite = (index) => {
      if (index === 1) {
        entered.resolve();
        return release.promise;
      }
      return Promise.resolve();
    };
    const writing = sink.write({ path: "index.md", body: "Lorem" }, signal());
    const settled = writing.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await enteredBeforeSettled(writing, entered.promise);
    await sink.abort(new DOMException("Cancelled", "AbortError"));
    expect(file.abortCalls).toBe(1);
    const outcome = await settled;
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    release.resolve();
    await expect(sink.finish(summary("lorem"), signal())).rejects.toThrowError(/closed/);
    expect(file.closeCalls).toBe(0);
    expect(file.committed).toBeNull();
    expect(existing.committed).toEqual(previous);
    expect(existing.createWritableCalls).toBe(0);
    expect(parent.removed).toEqual([]);
  });

  it.each(["file", "directory"] as const)(
    "refuses an existing %s with the unique ZIP name before opening any writable",
    async (kind) => {
      const parent = new FakeDirectoryHandle("downloads");
      const fileName = "lorem-collision.zip";
      const previous = textEncoder.encode("existing bytes must survive");
      if (kind === "file") parent.putFile(fileName, previous);
      else parent.putDirectory(fileName).putFile("sentinel.txt", previous);
      const before = snapshot(parent);

      await expect(
        createStreamedZipSink(parent, { rootName: "lorem", jobId: "collision" }),
      ).rejects.toMatchObject({ name: "DestinationCollisionError", entryName: fileName });

      expect(snapshot(parent)).toEqual(before);
      expect(totalCreateWritableCalls(parent)).toBe(0);
      expect(parent.removed).toEqual([]);
    },
  );

  it("aborts a writable that resolves after cancellation without writing or closing it", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const entered = gate();
    const release = gate();
    const abort = new AbortController();
    parent.newFileBehavior.beforeCreateWritable = () => {
      entered.resolve();
      return release.promise;
    };
    const creating = createStreamedZipSink(
      parent,
      { rootName: "lorem", jobId: "late" },
      abort.signal,
    );
    const settled = creating.then(
      () => null,
      (error: unknown) => error,
    );
    await enteredBeforeSettled(creating, entered.promise);
    abort.abort(new DOMException("Cancelled", "AbortError"));
    release.resolve();

    expect(await settled).toMatchObject({ name: "AbortError" });
    const file = parent.files.get("lorem-late.zip")!;
    expect(file.abortCalls).toBe(1);
    expect(file.writeCalls).toBe(0);
    expect(file.closeCalls).toBe(0);
    expect(file.committed).toBeNull();
  });

  it.each([
    { rootName: "...", jobId: "empty-root" },
    { rootName: "lorem", jobId: "a/b" },
  ])("rejects unsafe ZIP names without creating a file (%j)", async (options) => {
    const parent = new FakeDirectoryHandle("downloads");
    await expect(createStreamedZipSink(parent, options)).rejects.toThrowError(RangeError);
    expect(parent.files.size).toBe(0);
    expect(parent.directories.size).toBe(0);
  });
});

describe("directory sink", () => {
  it("creates a fresh folder with a running marker and writes plain files", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const jobId = "4f7d1c2e-0000-4000-8000-000000000000";
    const sink = await createDirectorySink(parent, { rootName: "Lorem Subtree", jobId });
    const folder = parent.directories.get(`Lorem Subtree-${jobId}`);
    expect(folder).toBeTruthy();

    const initial = snapshot(folder!);
    expect([...initial.keys()]).toEqual([EXPORT_MARKER_FILE]);
    expect(markerOf(folder!)).toEqual({
      schema: 1,
      jobId,
      status: "running",
      counts: { entriesWritten: 0, bytesWritten: 0 },
    });

    await sink.write({ path: "pages/1700/index.md", body: "# Lorem\n" }, signal());
    await sink.write({ path: "pages/1700/images/lorem.png", body: new Blob([pngBytes]) }, signal());

    const rawBytes = textEncoder.encode("# Lorem\n").byteLength + pngBytes.byteLength;
    expect(sink.stats()).toEqual({ entriesWritten: 2, bytesWritten: rawBytes });
    expect(markerOf(folder!).counts).toEqual({ entriesWritten: 2, bytesWritten: rawBytes });

    const tree = snapshot(folder!);
    expect([...tree.keys()].sort()).toEqual([
      EXPORT_MARKER_FILE,
      "pages/1700/images/lorem.png",
      "pages/1700/index.md",
    ]);
    expect(textDecoder.decode(tree.get("pages/1700/index.md")!)).toBe("# Lorem\n");
    expect(tree.get("pages/1700/images/lorem.png")).toEqual(pngBytes);

    const receipt = await sink.finish(summary("Lorem Subtree"), signal());
    expect(receipt).toEqual({
      fileName: "Lorem Subtree.zip",
      directoryName: `Lorem Subtree-${jobId}`,
      entriesWritten: 2,
      bytesWritten: rawBytes,
    });
    expect(markerOf(folder!).status).toBe("completed");
    await expect(
      sink.write({ path: "pages/late.md", body: "Late" }, signal()),
    ).rejects.toThrowError(/closed/);
  });

  it("does not let an exported entry replace the service marker", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const sink = await createDirectorySink(parent, { rootName: "lorem", jobId: "marker" });
    const folder = parent.directories.get("lorem-marker")!;
    await expect(
      sink.write({ path: EXPORT_MARKER_FILE, body: "corrupt" }, signal()),
    ).rejects.toThrow();
    await sink.abort(new Error("Rejected colliding package entry"));
    expect(markerOf(folder)).toMatchObject({
      status: "failed",
      counts: { entriesWritten: 0, bytesWritten: 0 },
    });
    expect([...snapshot(folder).keys()]).toEqual([EXPORT_MARKER_FILE]);
  });

  it("marks initialization failure instead of leaving a running export without an owner", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const failure = new DOMException("No space for initial marker", "QuotaExceededError");
    parent.newFileBehavior.beforeWrite = async (index) => {
      if (index === 1) throw failure;
    };
    const result = await createDirectorySink(parent, { rootName: "lorem", jobId: "initial" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(result).toBe(failure);
    expect(markerOf(parent.directories.get("lorem-initial")!)).toMatchObject({
      status: "failed",
      counts: { entriesWritten: 0, bytesWritten: 0 },
    });
  });

  it("marks a partial finish with raw byte counts", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const sink = await createDirectorySink(parent, { rootName: "lorem", jobId: "job-partial" });
    await sink.write({ path: "index.md", body: "Lorem" }, signal());
    const receipt = await sink.finish(summary("lorem", true), signal());
    expect(receipt.bytesWritten).toBe(5);
    expect(markerOf(parent.directories.get("lorem-job-partial")!).status).toBe("partial");
  });

  it("refuses an existing destination tree without touching it", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const existing = parent.putDirectory("lorem-job-1");
    existing.putFile("sentinel.txt", textEncoder.encode("keep me"));
    const error = await createDirectorySink(parent, { rootName: "lorem", jobId: "job-1" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DestinationCollisionError);
    expect((error as DestinationCollisionError).entryName).toBe("lorem-job-1");
    const tree = snapshot(existing);
    expect([...tree.keys()]).toEqual(["sentinel.txt"]);
    expect(tree.get("sentinel.txt")).toEqual(textEncoder.encode("keep me"));
  });

  it("treats a colliding file name as a destination collision", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    parent.putFile("lorem-job-2", textEncoder.encode("in the way"));
    await expect(
      createDirectorySink(parent, { rootName: "lorem", jobId: "job-2" }),
    ).rejects.toBeInstanceOf(DestinationCollisionError);
  });

  it("counts a file only after its writable has closed", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const sink = await createDirectorySink(parent, { rootName: "lorem", jobId: "job-close" });
    const folder = parent.directories.get("lorem-job-close")!;
    const entered = gate();
    const release = gate();
    folder.newFileBehavior.beforeClose = () => {
      entered.resolve();
      return release.promise;
    };
    const writing = sink.write({ path: "index.md", body: "Lorem" }, signal());
    await enteredBeforeSettled(writing, entered.promise);
    expect(sink.stats()).toEqual({ entriesWritten: 0, bytesWritten: 0 });
    expect(folder.files.get("index.md")!.committed).toBeNull();
    expect(markerOf(folder).counts.entriesWritten).toBe(0);
    release.resolve();
    await writing;
    expect(sink.stats()).toEqual({ entriesWritten: 1, bytesWritten: 5 });
    expect(textDecoder.decode(folder.files.get("index.md")!.committed!)).toBe("Lorem");
  });

  it("keeps closed files on abort and names the un-exported page", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const sink = await createDirectorySink(parent, { rootName: "lorem", jobId: "job-fail" });
    const folder = parent.directories.get("lorem-job-fail")!;
    await sink.write({ path: "pages/100/index.md", body: "# Root\n" }, signal());
    const entered = gate();
    const release = gate();
    folder.newFileBehavior.beforeWrite = (index) => {
      if (index === 1) {
        entered.resolve();
        return release.promise;
      }
      return Promise.resolve();
    };
    const failing = sink.write({ path: "pages/200/index.md", body: "# Child\n" }, signal());
    const settled = failing.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await enteredBeforeSettled(failing, entered.promise);
    await sink.abort(new PageSourceError("200", new Error("source exhausted")));
    const outcome = await settled;
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    release.resolve();

    const tree = snapshot(folder);
    expect([...tree.keys()].sort()).toEqual([
      EXPORT_MARKER_FILE,
      "pages/100/index.md",
      "pages/200/index.md",
    ]);
    expect(textDecoder.decode(tree.get("pages/100/index.md")!)).toBe("# Root\n");
    expect(tree.get("pages/200/index.md")).toBeNull();
    expect(markerOf(folder)).toEqual({
      schema: 1,
      jobId: "job-fail",
      status: "failed",
      counts: { entriesWritten: 1, bytesWritten: 7 },
      unexportedPageId: "200",
    });
    expect(folder.files.get(EXPORT_MARKER_FILE)!.abortCalls).toBe(0);
    await expect(
      sink.write({ path: "pages/300/index.md", body: "x" }, signal()),
    ).rejects.toThrowError(/closed/);
    await expect(sink.finish(summary("lorem"), signal())).rejects.toThrowError(/closed/);
  });

  it("marks a cancelled run without a page reference", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const sink = await createDirectorySink(parent, { rootName: "lorem", jobId: "job-cancel" });
    await sink.write({ path: "index.md", body: "Lorem" }, signal());
    await sink.abort(new DOMException("Cancelled", "AbortError"));
    const marker = markerOf(parent.directories.get("lorem-job-cancel")!);
    expect(marker.status).toBe("cancelled");
    expect("unexportedPageId" in marker).toBe(false);
    expect(marker.counts).toEqual({ entriesWritten: 1, bytesWritten: 5 });
  });

  it("enforces archive path safety before touching the destination", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    const sink = await createDirectorySink(parent, { rootName: "lorem", jobId: "job-safe" });
    const folder = parent.directories.get("lorem-job-safe")!;
    await expect(sink.write({ path: "/absolute.md", body: "x" }, signal())).rejects.toThrowError();
    await expect(sink.write({ path: "a/../b.md", body: "x" }, signal())).rejects.toThrowError();
    await expect(sink.write({ path: "a//b.md", body: "x" }, signal())).rejects.toThrowError();
    expect(totalCreateWritableCalls(folder)).toBe(1); // only the initial running marker
    await sink.write({ path: "pages/a.md", body: "A" }, signal());
    await expect(sink.write({ path: "pages/a.md", body: "B" }, signal())).rejects.toThrowError();
    const written = folder.directories.get("pages")!.files.get("a.md")!;
    expect(written.createWritableCalls).toBe(1);
    expect(textDecoder.decode(written.committed!)).toBe("A");
  });

  it(
    "imposes no archive-level entry cap on the directory destination",
    { timeout: 30_000 },
    async () => {
      const parent = new FakeDirectoryHandle("downloads");
      const sink = await createDirectorySink(parent, { rootName: "lorem", jobId: "job-big" });
      const count = 0xffff + 2; // beyond every ZIP32 entry ceiling
      for (let index = 0; index < count; index += 1) {
        await sink.write({ path: `flat/e-${index}.md`, body: "x" }, signal());
      }
      const receipt = await sink.finish(summary("lorem"), signal());
      expect(receipt.entriesWritten).toBe(count);
      const folder = parent.directories.get("lorem-job-big")!;
      expect(markerOf(folder).status).toBe("completed");
      expect(folder.directories.get("flat")!.files.size).toBe(count);
      expect(sink.stats().bytesWritten).toBe(count);
    },
  );

  it("rejects a job id that would make the child name unsafe", async () => {
    const parent = new FakeDirectoryHandle("downloads");
    await expect(
      createDirectorySink(parent, { rootName: "lorem", jobId: "a/b" }),
    ).rejects.toThrowError(RangeError);
    expect(parent.directories.size).toBe(0);
    expect(parent.files.size).toBe(0);
  });
});

describe("signal cancellation during destination writes", () => {
  it.each(["directory", "streamed"] as const)(
    "%s rejects a pending native write on signal abort without requiring an external sink.abort first",
    async (mode) => {
      const entered = gate();
      const release = gate();
      const abort = new AbortController();
      const previous = textEncoder.encode("existing file stays");
      const parent = new FakeDirectoryHandle("downloads");
      const existing = parent.putFile("existing.zip", previous);
      const sink =
        mode === "directory"
          ? await createDirectorySink(parent, { rootName: "lorem", jobId: "signal" })
          : await createStreamedZipSink(parent, { rootName: "lorem", jobId: "signal" });
      const file = parent.files.get("lorem-signal.zip");
      const behavior =
        mode === "directory"
          ? parent.directories.get("lorem-signal")!.newFileBehavior
          : file!.behavior;
      behavior.beforeWrite = () => {
        entered.resolve();
        return release.promise;
      };
      const writing = sink.write({ path: "index.md", body: "not committed" }, abort.signal);
      let outcome: { error: unknown } | undefined;
      const settled = writing.then(
        () => {
          outcome = { error: null };
        },
        (error: unknown) => {
          outcome = { error };
        },
      );
      const checkpoint = new MessageChannel();
      try {
        await enteredBeforeSettled(writing, entered.promise);
        abort.abort(new DOMException("Cancelled", "AbortError"));
        // The fake native abort rejects synchronously; observe its promise at the next task,
        // without releasing the I/O gate or guessing a wall-clock duration.
        await new Promise<void>((resolve) => {
          checkpoint.port1.onmessage = () => resolve();
          checkpoint.port2.postMessage(null);
        });
        expect(outcome?.error).toMatchObject({ name: "AbortError" });
        expect(sink.stats().entriesWritten).toBe(0);
        expect(existing.committed).toEqual(previous);
        expect(existing.createWritableCalls).toBe(0);
        expect(parent.removed).toEqual([]);
        if (mode === "streamed") {
          expect(file!.committed).toBeNull();
          expect(file!.closeCalls).toBe(0);
        }
      } finally {
        checkpoint.port1.close();
        checkpoint.port2.close();
        release.resolve();
        await settled;
        await sink.abort(abort.signal.reason);
      }
      if (mode === "streamed") {
        expect(file!.abortCalls).toBe(1);
        expect(file!.writes).toEqual([]);
        expect(file!.committed).toBeNull();
      }
    },
  );
});
