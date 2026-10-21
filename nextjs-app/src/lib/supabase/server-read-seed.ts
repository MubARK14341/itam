import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  classifyDataRequest,
  READ_EPOCH_COOKIE,
  SEED_KEY_HEADERS,
  userIdFromAuthorization,
  type ReadSeed,
  type ReadSeedEntry,
} from "@/lib/supabase/read-prefetch";

// Server read seeds: a route's server page runs the page's own first-screen reads (the same lib
// functions, same arguments) next to the database and records the Data API responses. The page
// receives them as a seed (components/providers/read-seed.tsx), so its identical browser requests
// are answered without another round trip to Tokyo.
//
// Safety rules:
// - The requests use the visitor's own session from the request cookies (anon key + user JWT),
//   so RLS applies exactly as in the browser. No elevated keys exist on this path.
// - Only reads are recorded; a write attempted inside a loader is refused before it is sent.
// - The seed is bound to the user whose token fetched it and to the write epoch cookie seen with
//   this request; the browser ignores it for any other user or after a newer write.
// - Best effort: a loader that fails or exceeds its budget yields fewer (or no) entries, and the
//   page then fetches as it always did.

const SCOPE = Symbol.for("itam.serverReadScope");
type Scope = { client: unknown };
const globalScope = globalThis as typeof globalThis & { [SCOPE]?: AsyncLocalStorage<Scope> };
const storage = (globalScope[SCOPE] ??= new AsyncLocalStorage<Scope>());

const BUDGET_MS = 1500;
const MAX_ENTRIES = 40;
const MAX_BYTES = 2_000_000;
// Response headers the browser can see on a cross-origin Data API response and supabase-js reads.
const RESPONSE_HEADERS = ["content-type", "content-range", "content-location", "location", "range-unit", "preference-applied"];

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

/**
 * Run `load` (which calls the page's lib functions) with a recording Supabase client and return
 * the recorded reads as a seed, or null when nothing usable was recorded.
 */
export async function collectReadSeed(
  load: () => Promise<unknown>,
  options: { budgetMs?: number } = {},
): Promise<ReadSeed | null> {
  const budgetMs = options.budgetMs === undefined ? BUDGET_MS : options.budgetMs;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > BUDGET_MS) {
    throw new RangeError("read_seed_budget_invalid");
  }
  const cookieStore = await cookies();
  const epoch = cookieStore.get(READ_EPOCH_COOKIE)?.value ?? "";
  const entries: ReadSeedEntry[] = [];
  let bytes = 0;
  let userId: string | null = null;
  let mixedUsers = false;
  let closed = false;
  const controller = new AbortController();
  const close = () => {
    closed = true;
    controller.abort();
  };

  const recordingFetch: typeof fetch = async (input, init) => {
    controller.signal.throwIfAborted();
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const url = new URL(request?.url ?? String(input));
    const kind = classifyDataRequest(method, url);
    if (kind === "write") throw new Error("read_seed_loader_write_refused");
    const callerSignal = init?.signal ?? request?.signal;
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, signal });
    signal.throwIfAborted();
    if (kind !== "read" || !response.ok) return response;
    const body = typeof init?.body === "string" ? init.body : init?.body == null ? null : undefined;
    if (body === undefined) return response;
    const headers = headerRecord(init?.headers ?? request?.headers);
    const sub = userIdFromAuthorization(headers.authorization);
    if (!sub) return response;
    if (userId && userId !== sub) mixedUsers = true;
    userId ??= sub;

    // Count actual UTF-8 bytes as they arrive, including concurrent responses. Reading a whole
    // response first could allocate an unbounded body even when the seed is capped at 2 MB.
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          if (bytes + value.byteLength > MAX_BYTES) {
            close();
            throw new DOMException("Read seed byte budget exceeded", "AbortError");
          }
          bytes += value.byteLength;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      }
    } finally {
      if (signal.aborted) await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
    if (!closed && entries.length < MAX_ENTRIES) {
      const keyHeaders: Record<string, string> = {};
      for (const name of SEED_KEY_HEADERS) if (headers[name]) keyHeaders[name] = headers[name];
      const responseHeaders: [string, string][] = [];
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value != null) responseHeaders.push([name, value]);
      }
      entries.push({
        method,
        url: url.toString(),
        body,
        headers: keyHeaders,
        status: response.status,
        statusText: response.statusText,
        responseHeaders,
        responseBody: text,
      });
      if (entries.length === MAX_ENTRIES) close();
    }
    return new Response(response.status === 204 ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // The middleware has already refreshed the session for this request; never write cookies here.
      cookies: { getAll: () => cookieStore.getAll(), setAll: () => undefined },
      global: { fetch: recordingFetch },
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      storage.run({ client }, load),
      new Promise((resolve) => { timer = setTimeout(() => { close(); resolve(undefined); }, budgetMs); }),
    ]);
  } catch {
    // Loaders are best effort; whatever was recorded before the failure is still valid.
  } finally {
    if (timer) clearTimeout(timer);
    close();
  }
  if (!userId || mixedUsers || entries.length === 0) return null;
  return { id: randomUUID(), userId, epoch, entries: entries.slice() };
}
