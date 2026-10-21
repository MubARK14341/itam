import { createBrowserClient } from "@supabase/ssr";
import { prefetchAwareFetch } from "@/lib/supabase/read-prefetch";

function browserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Navigation prefetch for Data API reads only; writes/auth/security calls pass straight through.
    { global: { fetch: prefetchAwareFetch } },
  );
}

const SERVER_READ_SCOPE = Symbol.for("itam.serverReadScope");
type ServerReadScope = { getStore(): { client: unknown } | undefined };

export function createClient(): ReturnType<typeof browserClient> {
  if (typeof window === "undefined") {
    // Inside a server read-seed loader (server-read-seed.ts) the lib functions run with the
    // request's own recording client instead.
    const scope = (globalThis as { [SERVER_READ_SCOPE]?: ServerReadScope })[SERVER_READ_SCOPE];
    const scoped = scope?.getStore()?.client;
    if (scoped) return scoped as ReturnType<typeof browserClient>;
  }
  return browserClient();
}
