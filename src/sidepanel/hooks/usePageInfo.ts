import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchPageInfo, type PageInfo } from "../page-info";

export type PageInfoResponse = { ok: true } & PageInfo;

export function usePageInfo(host: string | undefined, pageId: string | null | undefined) {
  return useQuery({
    queryKey: ["page-info", host, pageId],
    enabled: Boolean(host && pageId),
    queryFn: async (): Promise<PageInfoResponse> => {
      const info = await fetchPageInfo(host!, pageId!);
      return { ok: true, ...info };
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}
