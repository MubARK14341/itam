"use client";

import { useEffect, useState } from "react";
import { getActionAlertOperationalCounts } from "@/lib/action-center";
import { getRequestOperationalCounts } from "@/lib/requests";
import { useSession } from "@/lib/session";
import { clearReadPrefetch, readEpochCookie, READ_INVALIDATION_STORAGE_KEY, subscribeReadInvalidation } from "@/lib/supabase/read-prefetch";

export type ShellCounts = { actions: number | null; requests: number | null };

// Sidebar + top bar share one short-lived cache so a navigation never issues duplicate count RPCs.
// Counts are decoration only: a failed or forbidden RPC simply hides the badge.
const TTL_MS = 30_000;
let cache: { at: number; key: string; promise: Promise<ShellCounts> } | null = null;
let generation = 0;

export function invalidateShellCounts(): void {
  cache = null;
  generation += 1;
}

export function loadShellCounts(userId: string, wantActions: boolean, wantRequests: boolean): Promise<ShellCounts> {
  const key = `${userId}:${readEpochCookie()}:${wantActions ? 1 : 0}${wantRequests ? 1 : 0}`;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.promise;
  const promise = Promise.all([
    wantActions ? getActionAlertOperationalCounts().catch(() => ({ counts: null })) : Promise.resolve({ counts: null }),
    wantRequests ? getRequestOperationalCounts().catch(() => ({ counts: null })) : Promise.resolve({ counts: null }),
  ]).then(([a, r]) => ({
    actions: a.counts ? Number(a.counts.needs_action) || 0 : null,
    requests: r.counts ? (Number(r.counts.review) || 0) + (Number(r.counts.overdue) || 0) : null,
  }));
  cache = { at: Date.now(), key, promise };
  return promise;
}

export function useShellCounts(pathname: string, wantActions: boolean, wantRequests: boolean): ShellCounts {
  const { userId } = useSession();
  const [counts, setCounts] = useState<ShellCounts>({ actions: null, requests: null });
  const [revision, setRevision] = useState(0);
  const key = `${wantActions ? 1 : 0}${wantRequests ? 1 : 0}`;
  useEffect(() => {
    const invalidate = () => {
      invalidateShellCounts();
      setCounts({ actions: null, requests: null });
      setRevision((value) => value + 1);
    };
    const unsubscribe = subscribeReadInvalidation(invalidate);
    const storage = (event: StorageEvent) => {
      if (event.key === READ_INVALIDATION_STORAGE_KEY) clearReadPrefetch();
    };
    window.addEventListener("storage", storage);
    return () => { unsubscribe(); window.removeEventListener("storage", storage); };
  }, []);
  useEffect(() => {
    if (!userId || (!wantActions && !wantRequests)) {
      setCounts({ actions: null, requests: null });
      return;
    }
    let alive = true;
    const startedGeneration = generation;
    loadShellCounts(userId, wantActions, wantRequests).then((c) => {
      if (alive && startedGeneration === generation) setCounts(c);
    });
    return () => { alive = false; };
  }, [pathname, key, userId, revision, wantActions, wantRequests]);
  return counts;
}
