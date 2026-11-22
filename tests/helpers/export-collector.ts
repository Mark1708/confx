import type {
  EmitEntry,
  ExportContext,
  ExportSummary,
  PreparedExport,
  ProgressHandler,
} from "@/lib/export/contracts";
import { ZipEncoder, ZIP_MIME_TYPE } from "@/lib/export/zip-encoder";

type Producer = (
  prepared: PreparedExport,
  context: ExportContext,
  emit: EmitEntry,
) => Promise<ExportSummary>;

/** Test artifact boundary: real producer + encoder, without browser download or disk claims. */
export async function collectExport(
  producer: Producer,
  prepared: PreparedExport,
  onProgress?: ProgressHandler,
  signal = new AbortController().signal,
) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let encoder: ZipEncoder | undefined;
  try {
    const summary = await producer(prepared, {
      signal,
      onProgress,
      onPackage(info) {
        if (encoder) throw new Error("Producer announced its package more than once");
        encoder = new ZipEncoder(info.rootName, async (chunk) => { chunks.push(chunk); });
      },
    }, async (entry) => {
      if (!encoder) throw new Error("Producer emitted before announcing its package");
      await encoder.write(entry, signal);
    });
    if (!encoder) throw new Error("Producer did not announce its package");
    signal.throwIfAborted();
    await encoder.finish(signal);
    return { ...summary, zipBlob: new Blob(chunks, { type: ZIP_MIME_TYPE }) };
  } catch (error) {
    await encoder?.abort(error);
    chunks.length = 0;
    throw error;
  }
}

/** Encodes package-writer output without inventing a production producer or compatibility wrapper. */
export async function collectEntries(
  rootName: string,
  produce: (emit: EmitEntry) => Promise<void>,
  signal = new AbortController().signal,
): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const encoder = new ZipEncoder(rootName, async (chunk) => { chunks.push(chunk); });
  try {
    await produce((entry) => encoder.write(entry, signal));
    signal.throwIfAborted();
    await encoder.finish(signal);
    return new Blob(chunks, { type: ZIP_MIME_TYPE });
  } catch (error) {
    await encoder.abort(error);
    chunks.length = 0;
    throw error;
  }
}
