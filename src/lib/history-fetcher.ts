import type { VersionInfo } from "@/types";
import type { ConfluenceApi } from "./confluence-api";

interface VersionRaw {
  number: number;
  by?: { displayName?: string };
  when?: string;
  message?: string;
}

interface VersionsResponse {
  results: VersionRaw[];
}

export async function fetchHistory(
  pageId: string,
  api: ConfluenceApi,
  signal?: AbortSignal,
): Promise<VersionInfo[]> {
  const res = await api.fetchJson<VersionsResponse>(
    `/rest/api/content/${pageId}/version?limit=50`,
    signal,
  );

  return res.results.map((raw) => ({
    number: raw.number,
    author: raw.by?.displayName ?? "Unknown",
    date: raw.when ?? "",
    message: raw.message,
  }));
}
