import { isAbortError } from "../http-client";
import { PageSourceError } from "./confluence";
import type {
  ArchiveEntry,
  ExportReceipt,
  ExportSink,
  ExportSinkStats,
  ExportSummary,
} from "./contracts";
import { ArchivePathGuard, safeZipSegment } from "./paths";
import { ZIP_MIME_TYPE, ZipEncoder } from "./zip-encoder";

export const EXPORT_MARKER_FILE = ".confx-export.json";

export type ExportMarkerStatus = "running" | "completed" | "partial" | "failed" | "cancelled";

export interface DirectoryExportMarker {
  schema: 1;
  jobId: string;
  status: ExportMarkerStatus;
  counts: { entriesWritten: number; bytesWritten: number };
  /** Present only when a failed run identified the page it could not export. */
  unexportedPageId?: string;
}

/** A file or folder with this run's destination name already exists; never reuse or clean it. */
export class DestinationCollisionError extends Error {
  constructor(readonly entryName: string) {
    super(`Export destination already exists: ${entryName}`);
    this.name = "DestinationCollisionError";
  }
}

export interface MemoryZipSink {
  sink: ExportSink;
  blob(): Promise<Blob>;
}

const textEncoder = new TextEncoder();

function verifyPackageRoot(rootName: string, summary: ExportSummary): void {
  if (summary.rootName !== rootName) {
    throw new Error("Export package root changed during production");
  }
}

function errorName(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("name" in error)) return undefined;
  const name: unknown = error.name;
  return typeof name === "string" ? name : undefined;
}

/** Compressed chunks only; the Blob is assembled once, at finish, without a concat copy. */
export function createMemoryZipSink(rootName: string): MemoryZipSink {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const encoder = new ZipEncoder(rootName, async (chunk) => {
    chunks.push(chunk);
  });
  let zipBlob: Blob | undefined;
  let terminal: "finished" | "aborted" | undefined;

  const assertOpen = (action: string): void => {
    if (terminal) throw new Error(`Cannot ${action} a closed ZIP sink`);
  };

  const sink: ExportSink = {
    async write(entry: ArchiveEntry, signal: AbortSignal): Promise<void> {
      assertOpen("write into");
      await encoder.write(entry, signal);
    },
    async finish(summary: ExportSummary, signal: AbortSignal): Promise<ExportReceipt> {
      assertOpen("finish");
      verifyPackageRoot(rootName, summary);
      await encoder.finish(signal);
      zipBlob = new Blob(chunks, { type: ZIP_MIME_TYPE });
      chunks.length = 0;
      terminal = "finished";
      return {
        fileName: summary.fileName,
        entriesWritten: encoder.entriesWritten,
        bytesWritten: encoder.bytesWritten,
      };
    },
    async abort(reason: unknown): Promise<void> {
      if (terminal === "finished") return;
      terminal = "aborted";
      try {
        await encoder.abort(reason);
      } finally {
        chunks.length = 0;
      }
    },
    stats(): ExportSinkStats {
      return { entriesWritten: encoder.entriesWritten, bytesWritten: encoder.bytesWritten };
    },
  };

  return {
    sink,
    blob: () =>
      zipBlob
        ? Promise.resolve(zipBlob)
        : Promise.reject(new Error("The ZIP blob is available only after a successful finish")),
  };
}

/** The caller holds the export lock while this fresh ZIP is created, written, and closed. */
export async function createStreamedZipSink(
  parent: FileSystemDirectoryHandle,
  options: { rootName: string; jobId: string },
  signal?: AbortSignal,
): Promise<ExportSink> {
  signal?.throwIfAborted();
  const safeRoot = safeZipSegment(options.rootName);
  if (!safeRoot) throw new RangeError("Export root name is empty after sanitization");
  const fileName = `${safeRoot}-${options.jobId}.zip`;
  if (safeZipSegment(fileName) !== fileName) {
    throw new RangeError("Export ZIP file name is not a safe path segment");
  }
  const file = await createNewZipFile(parent, fileName, signal);
  signal?.throwIfAborted();
  const writable = await file.createWritable();
  try {
    signal?.throwIfAborted();
    return createWritableZipSink(writable, fileName, options.rootName);
  } catch (error) {
    await discardWritable(writable);
    throw error;
  }
}

/** One native write in flight; the archive exists only after the writable has closed. */
function createWritableZipSink(
  writable: FileSystemWritableFileStream,
  fileName: string,
  rootName: string,
): ExportSink {
  const encoder = new ZipEncoder(rootName, async (chunk, signal) => {
    signal.throwIfAborted();
    await writable.write(chunk);
  });
  let terminal: "finished" | "aborted" | undefined;
  let nativeAbort: Promise<void> | undefined;
  const abortNative = (): Promise<void> => (nativeAbort ??= discardWritable(writable));

  const assertOpen = (action: string): void => {
    if (terminal) throw new Error(`Cannot ${action} a closed streamed sink`);
  };

  return {
    async write(entry: ArchiveEntry, signal: AbortSignal): Promise<void> {
      assertOpen("write into");
      await withWritableAbort(writable, signal, () => encoder.write(entry, signal), abortNative);
    },
    async finish(summary: ExportSummary, signal: AbortSignal): Promise<ExportReceipt> {
      assertOpen("finish");
      verifyPackageRoot(rootName, summary);
      await withWritableAbort(
        writable,
        signal,
        async () => {
          await encoder.finish(signal);
          signal.throwIfAborted();
          await writable.close();
        },
        abortNative,
      );
      signal.throwIfAborted();
      terminal = "finished";
      return {
        fileName,
        entriesWritten: encoder.entriesWritten,
        bytesWritten: encoder.bytesWritten,
      };
    },
    async abort(reason: unknown): Promise<void> {
      if (terminal === "finished") return;
      terminal = "aborted";
      // Abort native I/O before waiting for the encoder's in-flight output promise.
      const released = abortNative();
      await encoder.abort(reason).catch(() => undefined);
      await released;
    },
    stats(): ExportSinkStats {
      return { entriesWritten: encoder.entriesWritten, bytesWritten: encoder.bytesWritten };
    },
  };
}

export interface DirectorySinkOptions {
  rootName: string;
  jobId: string;
}

export async function createDirectorySink(
  parent: FileSystemDirectoryHandle,
  options: DirectorySinkOptions,
  signal?: AbortSignal,
): Promise<ExportSink> {
  signal?.throwIfAborted();
  const safeRoot = safeZipSegment(options.rootName);
  if (!safeRoot) throw new RangeError("Export root name is empty after sanitization");
  const directoryName = `${safeRoot}-${options.jobId}`;
  if (!directoryName || safeZipSegment(directoryName) !== directoryName) {
    throw new RangeError("Export directory name is not a safe path segment");
  }
  const sink = new DirectorySink(
    await createNewDirectory(parent, directoryName),
    directoryName,
    options.rootName,
    options.jobId,
  );
  try {
    await sink.initialize(signal);
    return sink;
  } catch (error) {
    await sink.abort(error);
    throw error;
  }
}

async function createNewDirectory(
  parent: FileSystemDirectoryHandle,
  directoryName: string,
): Promise<FileSystemDirectoryHandle> {
  try {
    await parent.getDirectoryHandle(directoryName);
  } catch (error) {
    const name = errorName(error);
    if (name === "TypeMismatchError") throw new DestinationCollisionError(directoryName);
    if (name !== "NotFoundError") throw error;
    return parent.getDirectoryHandle(directoryName, { create: true });
  }
  throw new DestinationCollisionError(directoryName);
}

async function createNewZipFile(
  parent: FileSystemDirectoryHandle,
  fileName: string,
  signal?: AbortSignal,
): Promise<FileSystemFileHandle> {
  try {
    await parent.getFileHandle(fileName);
  } catch (error) {
    const name = errorName(error);
    if (name === "TypeMismatchError") throw new DestinationCollisionError(fileName);
    if (name !== "NotFoundError") throw error;
    signal?.throwIfAborted();
    // There is no exclusive-create flag: UUID names plus the job lock protect Confx runs,
    // not a concurrent external process creating the same entry after this lookup.
    try {
      return await parent.getFileHandle(fileName, { create: true });
    } catch (error) {
      if (errorName(error) === "TypeMismatchError") throw new DestinationCollisionError(fileName);
      throw error;
    }
  }
  throw new DestinationCollisionError(fileName);
}

/**
 * Plain files, not an archive: no ZipEncoder and no archive-level entry or byte cap.
 * Raw content bytes are counted; the service marker file is counted nowhere.
 */
class DirectorySink implements ExportSink {
  private readonly guard = new ArchivePathGuard();
  private readonly directories = new Map<string, FileSystemDirectoryHandle>();
  private markerHandle: FileSystemFileHandle | undefined;
  private writable: FileSystemWritableFileStream | null = null;
  private entries = 0;
  private bytes = 0;
  private terminal: "finished" | "aborted" | undefined;
  private markerWrites: Promise<void> = Promise.resolve();
  private aborting: Promise<void> | undefined;

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly directoryName: string,
    private readonly rootName: string,
    private readonly jobId: string,
  ) {
    this.guard.claim(EXPORT_MARKER_FILE);
  }

  /** Writes the initial running marker; called once by the factory before the sink is returned. */
  async initialize(signal?: AbortSignal): Promise<void> {
    await this.writeMarker("running", undefined, signal);
  }
  async write(entry: ArchiveEntry, signal: AbortSignal): Promise<void> {
    this.assertOpen("write into");
    signal.throwIfAborted();
    this.guard.claim(entry.path);
    const parts = entry.path.split("/");
    const fileName = parts.pop() as string;
    const directory = await this.directoryFor(parts, signal);
    signal.throwIfAborted();
    this.assertOpen("write into");
    const file = await directory.getFileHandle(fileName, { create: true });
    signal.throwIfAborted();
    this.assertOpen("write into");
    let data: Uint8Array<ArrayBuffer> | Blob;
    let bytes: number;
    if (typeof entry.body === "string") {
      data = textEncoder.encode(entry.body);
      bytes = data.byteLength;
    } else {
      data = entry.body;
      bytes = entry.body.size;
    }
    await this.writeConfirmed(file, data, signal);
    this.entries += 1;
    this.bytes += bytes;
    signal.throwIfAborted();
    await this.writeMarker("running", undefined, signal);
  }

  async finish(summary: ExportSummary, signal: AbortSignal): Promise<ExportReceipt> {
    this.assertOpen("finish");
    signal.throwIfAborted();
    verifyPackageRoot(this.rootName, summary);
    await this.writeMarker(summary.outcome.partial ? "partial" : "completed", undefined, signal);
    signal.throwIfAborted();
    this.terminal = "finished";
    return {
      fileName: summary.fileName,
      directoryName: this.directoryName,
      entriesWritten: this.entries,
      bytesWritten: this.bytes,
    };
  }

  abort(reason: unknown): Promise<void> {
    if (this.aborting) return this.aborting;
    if (this.terminal) return Promise.resolve();
    this.terminal = "aborted";
    this.aborting = this.discardAndMark(reason);
    return this.aborting;
  }

  private async discardAndMark(reason: unknown): Promise<void> {
    const writable = this.writable;
    this.writable = null;
    if (writable) await discardWritable(writable);
    const unexported = reason instanceof PageSourceError ? reason.pageId : undefined;
    try {
      await this.writeMarker(isAbortError(reason) ? "cancelled" : "failed", unexported);
    } catch {
      // Already-closed files stay; the terminal marker is best-effort.
    }
  }

  stats(): ExportSinkStats {
    return { entriesWritten: this.entries, bytesWritten: this.bytes };
  }

  private assertOpen(action: string): void {
    if (this.terminal) throw new Error(`Cannot ${action} a closed directory sink`);
  }

  private async directoryFor(
    parts: readonly string[],
    signal: AbortSignal,
  ): Promise<FileSystemDirectoryHandle> {
    let directory = this.root;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let next = this.directories.get(prefix);
      if (!next) {
        signal.throwIfAborted();
        next = await directory.getDirectoryHandle(part, { create: true });
        this.directories.set(prefix, next);
      }
      directory = next;
    }
    return directory;
  }

  /** A file exists only once createWritable → write → close has fully settled. */
  private async writeConfirmed(
    file: FileSystemFileHandle,
    data: Uint8Array<ArrayBuffer> | Blob,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const writable = await file.createWritable();
    this.writable = writable;
    try {
      await withWritableAbort(writable, signal, async () => {
        await writable.write(data);
        signal?.throwIfAborted();
        await writable.close();
      });
    } catch (error) {
      this.writable = null;
      await discardWritable(writable);
      throw error;
    } finally {
      if (this.writable === writable) this.writable = null;
    }
  }

  /** Serialized so a terminal abort can never be overwritten by a straggling running update. */
  private writeMarker(
    status: ExportMarkerStatus,
    unexportedPage?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const task = this.markerWrites.then(() =>
      this.writeMarkerSnapshot(status, unexportedPage, signal),
    );
    this.markerWrites = task.catch(() => undefined);
    return task;
  }

  private async writeMarkerSnapshot(
    status: ExportMarkerStatus,
    unexportedPage?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const marker: DirectoryExportMarker = {
      schema: 1,
      jobId: this.jobId,
      status,
      counts: { entriesWritten: this.entries, bytesWritten: this.bytes },
    };
    if (unexportedPage !== undefined) marker.unexportedPageId = unexportedPage;
    const handle =
      this.markerHandle ??
      (this.markerHandle = await this.root.getFileHandle(EXPORT_MARKER_FILE, { create: true }));
    await this.writeConfirmed(handle, textEncoder.encode(JSON.stringify(marker)), signal);
  }
}

async function discardWritable(writable: FileSystemWritableFileStream): Promise<void> {
  try {
    await writable.abort();
  } catch {
    // Discarding a partially written file is best-effort cleanup.
  }
}

/** A signal must abort the pending native operation, not wait for it before cleanup. */
async function withWritableAbort<T>(
  writable: FileSystemWritableFileStream,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  abortNative: () => Promise<void> = () => discardWritable(writable),
): Promise<T> {
  let aborting: Promise<void> | undefined;
  const abort = (): void => {
    aborting ??= abortNative();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    signal?.throwIfAborted();
    return await operation();
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await aborting;
  }
}
