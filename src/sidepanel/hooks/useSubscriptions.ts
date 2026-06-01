import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { createTranslator } from "@/i18n";
import { loadSettings } from "@/lib/settings";
import type { PageSnapshot, Subscription, SubscriptionDiff } from "@/lib/subscriptions";
import type { SubscriptionScope } from "@/types";
import {
  acceptChanges,
  checkSubscription,
  deleteSubscription,
  listSubscriptions,
  subscribe,
} from "../watch";

const QUERY_KEY = ["subscriptions"] as const;

export function useSubscriptions() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listSubscriptions,
    staleTime: 5_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const subscribeMut = useMutation({
    mutationFn: (args: {
      host: string;
      rootId: string;
      scope: SubscriptionScope;
      maxDepth?: number;
      onProgress?: (visited: number, title: string) => void;
    }) => subscribe(args),
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSubscription(id),
    onSuccess: invalidate,
  });

  return {
    subscriptions: query.data ?? [],
    loading: query.isLoading,
    error: query.error as Error | null,
    refresh: invalidate,
    subscribe: subscribeMut.mutateAsync,
    subscribing: subscribeMut.isPending,
    remove: deleteMut.mutateAsync,
  };
}

export interface CheckJobState {
  running: boolean;
  message: string;
  visited: number;
  diff?: SubscriptionDiff;
  nextSnapshot?: PageSnapshot;
  subscription?: Subscription;
  error?: string;
}

const INITIAL_CHECK: CheckJobState = {
  running: false,
  message: "",
  visited: 0,
};

export function useCheckSubscription() {
  const qc = useQueryClient();
  const [state, setState] = useState<CheckJobState>(INITIAL_CHECK);

  const run = useCallback(
    async (sub: Subscription) => {
      const settings = await loadSettings();
      const t = createTranslator(settings.locale);

      setState({
        ...INITIAL_CHECK,
        running: true,
        message: t("watchProgress.walking"),
      });
      try {
        const result = await checkSubscription(sub.id, {
          onProgress: (visited, title) =>
            setState((s) => ({
              ...s,
              visited,
              message: t("watchProgress.checking", { title }),
            })),
        });
        setState({
          running: false,
          message: t("watchProgress.done"),
          visited: Object.keys(result.nextSnapshot).length,
          diff: result.diff,
          nextSnapshot: result.nextSnapshot,
          subscription: result.subscription,
        });
        qc.invalidateQueries({ queryKey: QUERY_KEY });
      } catch (e) {
        setState({
          ...INITIAL_CHECK,
          error: String((e as Error)?.message ?? e),
        });
      }
    },
    [qc],
  );

  const accept = useCallback(async () => {
    if (!state.subscription || !state.nextSnapshot) return;
    await acceptChanges(state.subscription.id, state.nextSnapshot);
    setState(INITIAL_CHECK);
    qc.invalidateQueries({ queryKey: QUERY_KEY });
  }, [state, qc]);

  const reset = useCallback(() => setState(INITIAL_CHECK), []);

  return { state, run, accept, reset };
}
