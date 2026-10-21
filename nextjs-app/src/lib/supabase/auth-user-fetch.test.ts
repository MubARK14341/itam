import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError, createClient } from "@supabase/supabase-js";
import { authUserFetch } from "./auth-user-fetch";
import { getVerifiedUser } from "./verified-user";

const require = createRequire(import.meta.url);
// Use the installed server React cache dispatcher and Next's real dedupe-fetch,
// instead of a mock that could make a failed retry appear to reach the network.
const react = require("react");
const serverReact = require(join(dirname(require.resolve("react")), "cjs/react.react-server.development.js"));
const internals = serverReact.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previousCache = react.cache;
react.cache = serverReact.cache;
const { createDedupeFetch }: { createDedupeFetch: (fetcher: typeof fetch) => typeof fetch } = require("next/dist/server/lib/dedupe-fetch");
react.cache = previousCache;

const authClient = (fetcher: typeof fetch) => createClient("http://localhost:65421", "TEST-public-anon", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
});
const verified = () => new Response(JSON.stringify({ id: "TEST-verified", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-09T00:00:00Z" }), { headers: { "Content-Type": "application/json" } });

describe("server Auth-user fetches outside Next render deduplication", () => {
  let previousDispatcher: unknown;
  beforeEach(() => {
    vi.useFakeTimers();
    previousDispatcher = internals.A;
    const cache = new Map<() => unknown, unknown>();
    internals.A = { getCacheForType: (factory: () => unknown) => {
      if (!cache.has(factory)) cache.set(factory, factory());
      return cache.get(factory);
    } };
  });
  afterEach(() => { internals.A = previousDispatcher; vi.useRealTimers(); });

  it("demonstrates the unwrapped failure: three Auth retries reuse one rejected render GET", async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementation(async () => verified());
    const client = authClient(createDedupeFetch(network));
    const pending = getVerifiedUser(() => client.auth.getUser("TEST-not-a-token"));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.error).toBeInstanceOf(AuthRetryableFetchError);
    expect(result.data.user).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("reaches Auth again and verifies a user after the same render socket failure", async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementation(async () => verified());
    const client = authClient(authUserFetch(createDedupeFetch(network)));
    const pending = getVerifiedUser(() => client.auth.getUser("TEST-not-a-token"));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ error: null, data: { user: { id: "TEST-verified" } } });
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0][1]?.signal).not.toBe(network.mock.calls[1][1]?.signal);
  });

  it("does not retry permanent Auth rejection or fabricate an identity", async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ code: "bad_jwt", msg: "TEST denied" }), { status: 401, headers: { "Content-Type": "application/json" } }));
    const client = authClient(authUserFetch(createDedupeFetch(network)));
    const result = await getVerifiedUser(() => client.auth.getUser("TEST-not-a-token"));
    expect(result.error).toBeInstanceOf(AuthApiError);
    expect(result.data.user).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("stops after three independent unavailable Auth reads", async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const client = authClient(authUserFetch(createDedupeFetch(network)));
    const pending = getVerifiedUser(() => client.auth.getUser("TEST-not-a-token"));
    await vi.runAllTimersAsync();
    expect((await pending).data.user).toBeNull();
    expect(network).toHaveBeenCalledTimes(3);
  });

  it("preserves caller abort signals including Request signals", async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => verified());
    const wrapped = authUserFetch(network);
    const controller = new AbortController();
    controller.abort();
    await wrapped("http://localhost:65421/auth/v1/user", { signal: controller.signal });
    expect(network.mock.calls[0][1]?.signal).toBe(controller.signal);
    const request = new Request("http://localhost:65421/auth/v1/user", { signal: controller.signal });
    await wrapped(request);
    expect(network.mock.calls[1][1]?.signal).toBe(request.signal);
  });

  it("preserves all non-Auth reads and all write options", async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => verified());
    const wrapped = authUserFetch(network);
    const reads = { method: "GET", cache: "no-store" as const };
    const write = { method: "POST", body: "TEST-body" };
    await wrapped("http://localhost:65421/rest/v1/app_users", reads);
    await wrapped("http://localhost:65421/auth/v1/user", write);
    expect(network.mock.calls[0][1]).toBe(reads);
    expect(network.mock.calls[1][1]).toBe(write);
  });
});
