import { Blob } from "node:buffer";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ArchivePathGuard } from "@/lib/export/paths";
import { ZipEncoder } from "@/lib/export/zip-encoder";

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function recorder(limits?: ConstructorParameters<typeof ZipEncoder>[2]) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const encoder = new ZipEncoder("lorem", async (chunk) => { chunks.push(chunk); }, limits);
  return { encoder, chunks, bytes: () => chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    archive: async () => unzipSync(new Uint8Array(await new Blob(chunks).arrayBuffer())) };
}
const signal = () => new AbortController().signal;

async function enteredBeforeSettled(running: Promise<void>, entered: Promise<void>) {
  await Promise.race([
    entered,
    running.then(() => { throw new Error("Write settled before its required I/O gate"); }),
  ]);
}

describe("awaitable ZIP entry encoding", () => {
  it("preserves UTF-8 text and binary bytes under exactly one package root", async () => {
    const output = recorder();
    const body = new Uint8Array([0, 255, 13, 10, 128, 42]);
    await output.encoder.write({ path: "pages/1700/index.md", body: "# Lorem\n\nПривет — ipsum\n" }, signal());
    await output.encoder.write({ path: "pages/1700/images/lorem.png", body: new Blob([body]) }, signal());
    await output.encoder.finish(signal());
    const files = await output.archive();
    expect(strFromU8(files["lorem/pages/1700/index.md"])).toBe("# Lorem\n\nПривет — ipsum\n");
    expect(files["lorem/pages/1700/images/lorem.png"]).toEqual(body);
    expect(Object.keys(files).sort()).toEqual([
      "lorem/pages/1700/images/lorem.png", "lorem/pages/1700/index.md",
    ]);
    expect(output.encoder.entriesWritten).toBe(2);
    expect(output.encoder.bytesWritten).toBe(output.bytes());
  });

  it("finalizes at the conservative 65,534-entry ceiling and rejects the all-ones sentinel count", async () => {
    let finalChunk: Uint8Array<ArrayBuffer> | undefined;
    const encoder = new ZipEncoder("lorem", async (chunk) => { finalChunk = chunk; });
    const active = signal();
    for (let index = 0; index < 0xfffe; ++index) {
      await encoder.write({ path: `metadata/entry-${index}.png`, body: "" }, active);
    }
    await encoder.finish(active);
    expect(encoder.entriesWritten).toBe(0xfffe);
    const footer = new DataView(finalChunk!.buffer, finalChunk!.byteOffset + finalChunk!.byteLength - 22, 22);
    expect(footer.getUint32(0, true)).toBe(0x06054b50);
    // Without ZIP64, all-ones fields are sentinels; the classic ceiling stays below them.
    expect(footer.getUint16(8, true)).toBe(0xfffe);
    expect(footer.getUint16(10, true)).toBe(0xfffe);

    const limited = recorder();
    for (let index = 0; index < 0xfffe; ++index) {
      await limited.encoder.write({ path: `metadata/entry-${index}.png`, body: "" }, signal());
    }
    await expect(limited.encoder.write({ path: "metadata/one-too-many.png", body: "" }, signal()))
      .rejects.toMatchObject({
        name: "ZIP_LIMIT_EXCEEDED",
        message: expect.stringMatching(/Too many ZIP32 entries/),
      });
  });

  it("accepts a 0xfffffffe declared entry size and rejects the all-ones ZIP64 sentinel", async () => {
    class BoundaryMetadataBlob extends Blob {
      override get size(): number { return 0xffff_fffe; }
    }
    const accepted = recorder();
    await accepted.encoder.write({ path: "metadata.bin", body: new BoundaryMetadataBlob([]) }, signal());
    await accepted.encoder.finish(signal());
    const files = await accepted.archive();
    expect(Object.keys(files)).toEqual(["lorem/metadata.bin"]);

    class SentinelMetadataBlob extends Blob {
      override get size(): number { return 0xffff_ffff; }
    }
    const rejected = recorder();
    await expect(
      rejected.encoder.write({ path: "metadata.bin", body: new SentinelMetadataBlob([]) }, signal()),
    ).rejects.toThrow(/Entry exceeds the supported ZIP32 size/);
  });

  it("keeps sibling claims available after a conflicting archive path claim fails", () => {
    const guard = new ArchivePathGuard();
    guard.claim("a/x");
    expect(() => guard.claim("a/x/y/z")).toThrow(/Conflicting archive directory/);
    expect(() => guard.claim("a/y")).not.toThrow();
    expect(() => guard.claim("a/x")).toThrow(/Duplicate or conflicting archive path/);
  });

  it("does not consume the rest of a Blob while the destination has not accepted a chunk", async () => {
    const bytes = new Uint8Array(8 * 64 * 1024).fill(42);
    const entered = gate();
    const release = gate();
    let pulls = 0;
    class TracedBlob extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        let offset = 0;
        return new ReadableStream({ pull(controller) {
          ++pulls;
          if (offset === bytes.length) { controller.close(); return; }
          controller.enqueue(bytes.subarray(offset, offset += 64 * 1024));
        } });
      }
    }
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const encoder = new ZipEncoder("lorem", async (chunk) => {
      entered.resolve();
      await release.promise;
      chunks.push(chunk);
    });
    const running = encoder.write({ path: "images/lorem.png", body: new TracedBlob([bytes]) }, signal());
    try {
      await enteredBeforeSettled(running, entered.promise);
      // One active read and ReadableStream's one-chunk prefetch, never the whole file.
      expect(pulls).toBeLessThanOrEqual(2);
    } finally { release.resolve(); await running; }
    await encoder.finish(signal());
    const files = unzipSync(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    expect(files["lorem/images/lorem.png"]).toEqual(bytes);
  });

  it("cancels a pending source body and never finalizes the interrupted archive", async () => {
    const entered = gate();
    let cancelled = false;
    class PendingBlob extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled = true; } });
      }
    }
    const abort = new AbortController();
    const output = recorder();
    const writing = output.encoder.write({ path: "images/lorem.png", body: new PendingBlob(["lorem"]) }, abort.signal);
    const settled = writing.then(() => ({ error: null }), (error: unknown) => ({ error }));
    await Promise.race([entered.promise, settled.then(({ error }) => { throw error ?? new Error("Body was not consumed"); })]);
    abort.abort(new DOMException("Cancelled", "AbortError"));
    expect((await settled).error).toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    await expect(output.encoder.finish(abort.signal)).rejects.toBeDefined();
  });

  it("propagates destination write failure and refuses later finalization", async () => {
    const failure = new Error("Lorem destination unavailable");
    const encoder = new ZipEncoder("lorem", async () => { throw failure; });
    await expect(encoder.write({ path: "index.md", body: "Lorem" }, signal())).rejects.toBe(failure);
    await expect(encoder.finish(signal())).rejects.toBeDefined();
  });

  it.each([
    "/absolute.md", "C:/drive.md", "a\\b.md", "a\0b.md", "a//b.md", "a/./b.md", "a/../b.md",
  ])("rejects unsafe final path %j before emitting its data", async (path) => {
    const output = recorder();
    await expect(output.encoder.write({ path, body: "LOREM_UNSAFE_ENTRY" }, signal())).rejects.toBeDefined();
    expect(output.bytes()).toBe(0);
  });

  it.each([
    ["pages/a.md", "pages/a.md"],
    ["Pages/a.md", "pages/A.md"],
    ["pages/café.md", "pages/cafe\u0301.md"],
    ["pages/asset", "pages/asset/index.md"],
    ["pages/asset/index.md", "pages/asset"],
  ])("rejects duplicate or directory-conflicting final paths %j and %j", async (first, second) => {
    const output = recorder();
    await output.encoder.write({ path: first, body: "Lorem first" }, signal());
    const before = output.bytes();
    await expect(output.encoder.write({ path: second, body: "Lorem second" }, signal())).rejects.toBeDefined();
    expect(output.bytes()).toBe(before);
    await expect(output.encoder.finish(signal())).rejects.toBeDefined();
  });

  it("preflights entry size and file count before the offending write", async () => {
    const size = recorder({ maxEntryBytes: 3 });
    await expect(size.encoder.write({ path: "lorem.bin", body: new Blob(["four"]) }, signal())).rejects.toBeDefined();
    expect(size.bytes()).toBe(0);
    const count = recorder({ maxEntries: 1 });
    await count.encoder.write({ path: "first.md", body: "Lorem" }, signal());
    const before = count.bytes();
    await expect(count.encoder.write({ path: "second.md", body: "Ipsum" }, signal())).rejects.toBeDefined();
    expect(count.bytes()).toBe(before);
  });

  it("refuses a central-directory overflow without sending bytes beyond the ZIP32 budget", async () => {
    const output = recorder({ maxArchiveBytes: 100 });
    await expect((async () => {
      await output.encoder.write({ path: "index.md", body: "x" }, signal());
      await output.encoder.finish(signal());
    })()).rejects.toBeDefined();
    expect(output.bytes()).toBeLessThanOrEqual(100);
  });

  it("cannot raise format ceilings through a caller-supplied limit", async () => {
    let read = false;
    class OversizedBlob extends Blob {
      override get size() { return 2 ** 32; }
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        read = true;
        return super.stream();
      }
    }
    const output = recorder({ maxEntryBytes: Number.MAX_SAFE_INTEGER });
    await expect(output.encoder.write({ path: "lorem.bin", body: new OversizedBlob() }, signal())).rejects.toBeDefined();
    expect(read).toBe(false);
    expect(output.bytes()).toBe(0);
  });
});
