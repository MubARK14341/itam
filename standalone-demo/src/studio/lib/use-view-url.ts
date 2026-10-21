"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { filterParams, type FilterValues } from "./view-filters";

/** URL is the source of truth, including native browser history and same-route navigation. */
export function useViewUrl<T extends FilterValues>({ initial, parse, values }: {
  initial: T; parse: (params: URLSearchParams) => T; values: (state: T) => FilterValues;
}) {
  const search = useSearchParams();
  const [state, setState] = useState<T>(initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const next = parse(new URLSearchParams(search.toString()));
    stateRef.current = next;
    setState((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [search, parse]);
  const update = useCallback((change: Partial<T> | ((previous: T) => T)) => {
    const next = parse(filterParams(typeof change === "function" ? values(change(stateRef.current)) : values({ ...stateRef.current, ...change })));
    stateRef.current = next; setState(next);
    const query = filterParams(values(next)).toString();
    const target = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    if (target !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.pushState(null, "", target);
    }
  }, [parse, values]);
  return [state, update] as const;
}
