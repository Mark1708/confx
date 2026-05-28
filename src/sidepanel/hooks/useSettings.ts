import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { loadSettings, saveSettings } from "@/lib/settings";
import type { AppSettings } from "@/types";

const KEY = ["settings"] as const;

export function useSettings() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: loadSettings,
    staleTime: Infinity,
  });
  const mutation = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => saveSettings(patch),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  return { ...query, update: mutation.mutate, saving: mutation.isPending };
}
