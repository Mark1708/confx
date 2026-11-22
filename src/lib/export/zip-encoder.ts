import { strToU8, Zip, type ZipDeflate, type ZipPassThrough } from "fflate";
import { createZipEntry } from "../zip-compression";
import type { ArchiveEntry } from "./contracts";
import { ArchivePathGuard, assertArchivePath } from "./paths";

export const ZIP_MIME_TYPE = "application/zip";
const CHUNK_BYTES = 64 * 1024;
const EMPTY = new Uint8Array(0);
// All-ones fields are ZIP64 sentinels, not supported classic ZIP values.
const ZIP32_BYTES = 0xffff_fffe;
const ZIP32_ENTRIES = 0xfffe;
const ZIP_NAME_BYTES = 0xffff;

/** Every representable-ZIP32 boundary violation; never a corrupt "successful" archive. */
export class ZipLimitExceededError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "ZIP_LIMIT_EXCEEDED";
  }
}

const yieldToEventLoop: () => Promise<void> = (() => {
  const schedulerLike = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof schedulerLike?.yield === "function") {
    return () => schedulerLike.yield!();
  }
  // One reusable MessageChannel macrotask: Promise.resolve is not an event-loop yield.
  const channel = new MessageChannel();
  const resolvers: Array<(value: void) => void> = [];
  const port1 = channel.port1 as MessagePort & { ref?: () => void; unref?: () => void };
  const port2 = channel.port2 as MessagePort & { unref?: () => void };
  channel.port1.onmessage = () => {
    const resolve = resolvers.shift();
    if (resolvers.length === 0) port1.unref?.();
    resolve?.();
  };
  // A pending yield keeps Node alive; an idle browser-compatible channel never does.
  port1.unref?.();
  port2.unref?.();
  return () =>
    new Promise<void>((resolve) => {
      port1.ref?.();
      resolvers.push(resolve);
      channel.port2.postMessage(null);
    });
})();

export interface Zip32Limits {
  maxEntryBytes: number;
  maxEntries: number;
  maxArchiveBytes: number;
}
export type WriteZipChunk = (chunk: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<void>;

function limit(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid ZIP limit");
  return Math.min(value, ceiling);
}

/** One active input and one synchronous compressor burst; output must accept it before more input. */
export class ZipEncoder {
  private zip: Zip | null;
  private readonly paths = new ArchivePathGuard();
  private readonly limits: Zip32Limits;
  private pendingChunks: Uint8Array<ArrayBuffer>[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readerCancellation: Promise<void> | null = null;
  private outputWrite: Promise<void> | null = null;
  private producedBytes = 0;
  private acceptedBytes = 0;
  private writtenEntries = 0;
  private centralDirectoryBytes = 0;
  private writing = false;
  private ending = false;
  private finalized = false;
  private failed = false;
  private failure: unknown;

  constructor(
    private readonly rootName: string,
    private readonly writeChunk: WriteZipChunk,
    limits: Partial<Zip32Limits> = {},
  ) {
    assertArchivePath(rootName);
    if (rootName.includes("/")) throw new RangeError("ZIP root must be one path segment");
    this.limits = {
      maxEntryBytes: limit(limits.maxEntryBytes, ZIP32_BYTES),
      maxEntries: limit(limits.maxEntries, ZIP32_ENTRIES),
      maxArchiveBytes: limit(limits.maxArchiveBytes, ZIP32_BYTES),
    };
    this.zip = new Zip((error, data, final) => {
      if (error) {
        this.recordFailure(error);
        return;
      }
      if (this.failed) return;
      const reservedFooter = this.ending ? 0 : this.centralDirectoryBytes + 22;
      if (this.producedBytes + data.byteLength + reservedFooter > this.limits.maxArchiveBytes) {
        this.recordFailure(new ZipLimitExceededError("Archive exceeds the supported ZIP32 size"));
        return;
      }
      this.producedBytes += data.byteLength;
      if (data.byteLength) this.pendingChunks.push(data);
      if (final && !this.ending) this.recordFailure(new Error("Unexpected ZIP finalization"));
    });
  }

  get entriesWritten(): number {
    return this.writtenEntries;
  }
  get bytesWritten(): number {
    return this.acceptedBytes;
  }

  async write(entry: ArchiveEntry, signal: AbortSignal): Promise<void> {
    const abort = () => {
      void this.cancelReader(signal.reason).catch(() => {});
    };
    let ownsWrite = false;
    try {
      this.check(signal);
      if (this.writing || this.ending) throw new Error("ZIP entries must be awaited sequentially");
      this.paths.claim(entry.path);
      const path = `${this.rootName}/${entry.path}`;
      const nameBytes = strToU8(path).byteLength;
      if (nameBytes > ZIP_NAME_BYTES) throw new ZipLimitExceededError("ZIP entry name is too long");
      if (this.writtenEntries >= this.limits.maxEntries)
        throw new ZipLimitExceededError("Too many ZIP32 entries");
      const textBytes = typeof entry.body === "string" ? strToU8(entry.body) : null;
      const declaredBytes = textBytes?.byteLength ?? (entry.body as Blob).size;
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes < 0 ||
        declaredBytes > this.limits.maxEntryBytes
      ) {
        throw new ZipLimitExceededError("Entry exceeds the supported ZIP32 size");
      }
      const nextCentralBytes = this.centralDirectoryBytes + 46 + nameBytes;
      if (
        this.producedBytes + 30 + nameBytes + 16 + nextCentralBytes + 22 >
        this.limits.maxArchiveBytes
      ) {
        throw new ZipLimitExceededError("Archive exceeds the supported ZIP32 size");
      }
      this.centralDirectoryBytes = nextCentralBytes;
      this.writing = true;
      ownsWrite = true;
      signal.addEventListener("abort", abort, { once: true });
      const file = createZipEntry(path);
      this.zip!.add(file);
      await this.drain(signal);
      if (textBytes) {
        await this.pushBytes(file, textBytes, signal);
      } else {
        await this.consumeBlob(file, entry.body as Blob, signal);
      }
      this.check(signal);
      file.push(EMPTY, true);
      await this.drain(signal);
      this.check(signal);
      ++this.writtenEntries;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (ownsWrite) this.writing = false;
    }
  }

  async finish(signal: AbortSignal): Promise<void> {
    try {
      this.check(signal);
      if (this.writing || this.ending) throw new Error("Cannot finalize an active ZIP entry");
      if (this.producedBytes + this.centralDirectoryBytes + 22 > this.limits.maxArchiveBytes) {
        throw new ZipLimitExceededError("Archive exceeds the supported ZIP32 size");
      }
      this.ending = true;
      this.zip!.end();
      await this.drain(signal);
      this.check(signal);
      this.finalized = true;
      this.zip = null;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  async abort(reason: unknown): Promise<void> {
    if (this.finalized) return;
    this.recordFailure(reason);
    const cancellation = this.cancelReader(reason);
    const output = this.outputWrite;
    this.zip?.terminate();
    this.zip = null;
    this.pendingChunks = [];
    // An output's abort implementation releases its native write; never leave cleanup behind the lock.
    const settled = await Promise.allSettled(output ? [cancellation, output] : [cancellation]);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
  }

  private check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.failed) throw this.failure;
    if (this.finalized || !this.zip) throw new Error("ZIP encoder is closed");
  }
  private recordFailure(reason: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.failure = reason ?? new Error("ZIP encoding failed without error details");
  }
  private cancelReader(reason: unknown): Promise<void> {
    if (!this.reader) return Promise.resolve();
    this.readerCancellation ??= this.reader.cancel(reason);
    return this.readerCancellation;
  }
  private async pushBytes(
    file: ZipDeflate | ZipPassThrough,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      this.check(signal);
      file.push(bytes.subarray(offset, offset + CHUNK_BYTES), false);
      await this.drain(signal);
    }
  }
  private async consumeBlob(
    file: ZipDeflate | ZipPassThrough,
    blob: Blob,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = blob.stream().getReader();
    this.reader = reader;
    this.readerCancellation = null;
    let consumed = false;
    let inputBytes = 0;
    try {
      while (true) {
        this.check(signal);
        const next = await reader.read();
        this.check(signal);
        if (next.done) {
          consumed = true;
          break;
        }
        inputBytes += next.value.byteLength;
        if (inputBytes > this.limits.maxEntryBytes)
          throw new ZipLimitExceededError("Entry exceeds the supported ZIP32 size");
        await this.pushBytes(file, next.value, signal);
      }
    } finally {
      try {
        if (!consumed) await this.cancelReader(signal.reason ?? this.failure);
        if (this.readerCancellation) await this.readerCancellation;
      } finally {
        reader.releaseLock();
        this.reader = null;
        this.readerCancellation = null;
      }
    }
  }
  private async drain(signal: AbortSignal): Promise<void> {
    this.check(signal);
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    for (const chunk of chunks) {
      // One macrotask between compressor bursts keeps cancellation and UI input responsive.
      await yieldToEventLoop();
      this.check(signal);
      const writing = this.writeChunk(chunk, signal);
      this.outputWrite = writing;
      try {
        await writing;
        this.acceptedBytes += chunk.byteLength;
      } finally {
        this.outputWrite = null;
      }
    }
    this.check(signal);
  }
}
