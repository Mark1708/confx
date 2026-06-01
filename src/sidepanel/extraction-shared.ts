import { BrowserApi } from "@/lib/browser/browser-api";

export interface ExtractJobResult {
  fileName: string;
  zipBlob: Blob;
}

export const SUBTREE_PAGE_ATTEMPTS = 2;

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

export async function downloadBlob(blob: Blob, fileName: string): Promise<number> {
  const url = URL.createObjectURL(blob);
  try {
    const id = await BrowserApi.download({
      url,
      filename: fileName,
      saveAs: true,
    });
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
