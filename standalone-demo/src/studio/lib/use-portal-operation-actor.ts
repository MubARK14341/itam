"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** A mounted form belongs to its first identity, even if another tab signs in. */
export function usePortalOperationActor() {
  const identity = useRef<string | null | undefined>(undefined);
  const invalidated = useRef(false);
  const [actorId, setActorId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [actorChanged, setActorChanged] = useState(false);

  useEffect(() => {
    let active = true;
    const observe = (id: string | null) => {
      if (!active) return;
      if (identity.current === undefined) {
        identity.current = id;
        setActorId(id); setReady(true);
      } else if (identity.current !== id) {
        invalidated.current = true;
        setActorChanged(true);
      }
    };
    const { data } = createClient().auth.onAuthStateChange((_event, session) => observe(session?.user.id ?? null));
    void createClient().auth.getSession().then(({ data }) => {
      if (identity.current === undefined) observe(data.session?.user.id ?? null);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);

  const isCurrent = useCallback((expectedActorId: string) =>
    !invalidated.current && identity.current === expectedActorId, []);
  const invalidate = useCallback(() => {
    invalidated.current = true;
    setActorChanged(true);
  }, []);
  return { actorId, ready, actorChanged, isCurrent, invalidate };
}
