"use client";

import { createClient } from "@/lib/supabase/client";
import { prefetchRouteData } from "@/lib/supabase/read-prefetch";
import { SERVER_SEEDED_ROUTES } from "@/lib/read-seeds/routes";

/** Warm a route's remembered Data API reads before the user navigates there. */
export async function prefetchRoute(href: string, signal?: AbortSignal): Promise<void> {
  if (typeof window === "undefined") return;
  const pathname = new URL(href, window.location.href).pathname;
  if (pathname === window.location.pathname) return;
  // These pages arrive with their reads (server seed) through Next's full Link prefetch.
  if (SERVER_SEEDED_ROUTES.has(pathname)) return;
  try {
    const { data: { session } } = await createClient().auth.getSession();
    if (!session) return;
    await prefetchRouteData(pathname, {
      accessToken: session.access_token,
      apiKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      userId: session.user.id,
    }, signal);
  } catch { /* prefetch is best-effort */ }
}

/** Warm server-seeded pages or remembered Data API reads on pointer, focus or touch intent. */
export function prefetchIntentProps(href: string, prefetchPage?: (href: string) => void) {
  const warm = () => {
    if (typeof window !== "undefined"
      && SERVER_SEEDED_ROUTES.has(new URL(href, window.location.href).pathname)) prefetchPage?.(href);
    void prefetchRoute(href);
  };
  return { onPointerEnter: warm, onFocus: warm, onTouchStart: warm };
}

/** After a page settles, warm the given destinations once while the browser is idle. */
export function prefetchWhenIdle(hrefs: string[]): () => void {
  if (typeof window === "undefined") return () => undefined;
  let cancelled = false;
  const controller = new AbortController();
  const run = async () => {
    // Idle work runs one destination at a time; each destination itself caps Data API concurrency.
    for (const href of hrefs) {
      if (cancelled) return;
      await prefetchRoute(href, controller.signal);
    }
  };
  const timer = window.setTimeout(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(() => { void run(); }); else void run();
  }, 1500);
  return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
}
