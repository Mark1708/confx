import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { watchStorageKey } from "@/lib/browser/storage-watch";
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
  useEffect(
    () =>
      watchStorageKey("sync", "cx.settings.v1", () => {
        void qc.invalidateQueries({ queryKey: KEY }, { cancelRefetch: false });
      }),
    [qc],
  );
  const mutation = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => saveSettings(patch),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  return {
    ...query,
    update: mutation.mutate,
    updateAsync: mutation.mutateAsync,
    saving: mutation.isPending,
  };
}
