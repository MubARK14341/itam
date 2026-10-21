import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API = "https://publication-disabled.invalid";
const tokenFor = (sub: string) =>
  `Bearer x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;

let capturedFetch: typeof fetch | null = null;
let epochCookie: string | undefined;

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "itam_read_epoch" && epochCookie !== undefined ? { value: epochCookie } : undefined),
    getAll: () => [],
  }),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { global: { fetch: typeof fetch } }) => {
    capturedFetch = options.global.fetch;
    return { scoped: true };
  },
  createBrowserClient: () => ({ scoped: false }),
}));

describe("collectReadSeed", () => {
  let network: string[];

  beforeEach(() => {
    vi.resetModules();
    capturedFetch = null;
    epochCookie = undefined;
    network = [];
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", API);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      network.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json", "content-range": "0-0/1", "set-cookie": "x=y" },
      });
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const get = (path: string, user = "u1") => capturedFetch!(`${API}${path}`, {
    method: "GET",
    headers: { authorization: tokenFor(user), apikey: "anon", "accept-profile": "public" },
  });

  it("records reads for the requesting user, without the token, with the request's epoch", async () => {
    epochCookie = "epoch-7";
    const { collectReadSeed } = await import("./server-read-seed");
    const seed = await collectReadSeed(async () => {
      const response = await get("/rest/v1/requests?select=id");
      expect(await response.json()).toEqual([{ id: 1 }]); // the loader still gets the body
    });
    expect(seed).toMatchObject({ userId: "u1", epoch: "epoch-7" });
    expect(seed!.entries).toHaveLength(1);
    expect(seed!.entries[0].headers).toEqual({ "accept-profile": "public" });
    expect(JSON.stringify(seed)).not.toContain("Bearer");
    expect(seed!.entries[0].responseHeaders).toEqual([
      ["content-type", "application/json"],
      ["content-range", "0-0/1"],
    ]);
  });

  it("refuses writes before they reach the network", async () => {
    const { collectReadSeed } = await import("./server-read-seed");
    let refused = false;
    await collectReadSeed(async () => {
      await capturedFetch!(`${API}/rest/v1/rpc/request_approve`, {
        method: "POST",
        body: "{}",
        headers: { authorization: tokenFor("u1") },
      }).catch(() => { refused = true; });
    });
    expect(refused).toBe(true);
    expect(network).toEqual([]);
  });

  it("records the canonical financial projections as user-bound POST reads", async () => {
    const { collectReadSeed } = await import("./server-read-seed");
    const body = JSON.stringify({ p_ids: ["asset-1"] });
    const seed = await collectReadSeed(async () => {
      for (const rpc of ["assets_financial", "consumables_financial", "consumable_txn_financial", "depreciation_financial", "maintenance_financial", "purchase_request_items_financial", "request_items_financial"]) {
        await capturedFetch!(`${API}/rest/v1/rpc/${rpc}`, { method: "POST", body, headers: { authorization: tokenFor("u1"), "content-profile": "public" } });
      }
    });
    expect(seed?.userId).toBe("u1");
    expect(seed?.entries).toHaveLength(7);
    expect(seed?.entries.every(entry => entry.method === "POST" && entry.body === body)).toBe(true);
    expect(JSON.stringify(seed)).not.toContain("Bearer");
    expect(network).toHaveLength(7);
  });

  it("returns nothing when reads ran under more than one user", async () => {
    const { collectReadSeed } = await import("./server-read-seed");
    const seed = await collectReadSeed(async () => {
      await get("/rest/v1/requests?select=id", "u1");
      await get("/rest/v1/assets?select=id", "u2");
    });
    expect(seed).toBeNull();
  });

  it("hands the recording client to lib code only inside the loader", async () => {
    const { collectReadSeed } = await import("./server-read-seed");
    const { createClient } = await import("./client");
    let inside: unknown = null;
    await collectReadSeed(async () => { inside = createClient(); });
    expect(inside).toEqual({ scoped: true });
    expect(createClient()).toEqual({ scoped: false });
  });

  it("aborts timed-out network work, keeps completed entries and refuses late reads", async () => {
    vi.useFakeTimers();
    let pendingSignal: AbortSignal | null = null;
    const ordinaryFetch = fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("slow")) return ordinaryFetch(input, init);
      pendingSignal = init!.signal!;
      return new Promise<Response>((_, reject) => {
        pendingSignal!.addEventListener("abort", () => reject(pendingSignal!.reason), { once: true });
      });
    }));
    const { collectReadSeed } = await import("./server-read-seed");
    const result = collectReadSeed(async () => {
      await get("/rest/v1/requests?select=id");
      await get("/rest/v1/slow?select=id");
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect((pendingSignal as unknown as AbortSignal).aborted).toBe(true);
    expect((await result)?.entries).toHaveLength(1);
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await expect(get("/rest/v1/assets?select=id")).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBefore);
  });

  it("preserves a caller's cancellation without aborting a different read in the same loader", async () => {
    const caller = new AbortController();
    caller.abort();
    const { collectReadSeed } = await import("./server-read-seed");
    const seed = await collectReadSeed(async () => {
      await expect(capturedFetch!(`${API}/rest/v1/assets`, {
        signal: caller.signal, headers: { authorization: tokenFor("u1") },
      })).rejects.toMatchObject({ name: "AbortError" });
      await get("/rest/v1/requests?select=id");
    });
    expect(network).toEqual(["GET /rest/v1/requests"]);
    expect(seed?.entries).toHaveLength(1);
  });

  it("limits actual UTF-8 bytes and retains completed entries when a later body exceeds the cap", async () => {
    const ordinaryFetch = fetch;
    let oversizeSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("oversize")) return ordinaryFetch(input, init);
      oversizeSignal = init!.signal!;
      return Promise.resolve(new Response("أ".repeat(1_000_001)));
    }));
    const { collectReadSeed } = await import("./server-read-seed");
    const seed = await collectReadSeed(async () => {
      await get("/rest/v1/requests?select=id");
      await get("/rest/v1/oversize?select=id");
    });
    expect(seed?.entries).toHaveLength(1);
    expect((oversizeSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(seed?.entries[0].url).toContain("/requests?");
  });

  it("refuses additional reads as soon as the entry budget is reached", async () => {
    const { collectReadSeed } = await import("./server-read-seed");
    const seed = await collectReadSeed(async () => {
      for (let i = 0; i < 41; i += 1) await get(`/rest/v1/requests?select=id&page=${i}`);
    });
    expect(seed?.entries).toHaveLength(40);
    expect(network).toHaveLength(40);
  });


  it.each([0, -1, 1501, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects an invalid optional budget before creating a client or starting reads: %s", async budgetMs => {
      const { collectReadSeed } = await import("./server-read-seed");
      const load = vi.fn(async () => undefined);
      await expect(collectReadSeed(load, { budgetMs })).rejects.toMatchObject({ name: "RangeError", message: "read_seed_budget_invalid" });
      expect(load).not.toHaveBeenCalled();
      expect(capturedFetch).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("returns no seed and aborts a300ms read that has not received headers", async () => {
    vi.useFakeTimers();
    const state: { signal?: AbortSignal | null } = {};
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      state.signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        state.signal?.addEventListener("abort", () => reject(state.signal?.reason), { once: true });
      });
    }));
    const { collectReadSeed } = await import("./server-read-seed");
    let settled = false;
    const result = collectReadSeed(() => get("/rest/v1/assets?select=id"), { budgetMs: 300 })
      .then(seed => { settled = true; return seed; });
    await vi.advanceTimersByTimeAsync(299);
    expect(state.signal).toBeDefined(); expect(state.signal?.aborted).toBe(false); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull(); expect(state.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the complete sibling at300ms, cancels a late body and refuses later reads", async () => {
    vi.useFakeTimers();
    epochCookie = "epoch-short";
    const ordinaryFetch = fetch;
    const state: { signal?: AbortSignal | null; stream?: ReadableStreamDefaultController<Uint8Array>; cancelled: boolean } = { cancelled: false };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("slow-body")) return ordinaryFetch(input, init);
      state.signal = init?.signal;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { state.stream = controller; },
        cancel() { state.cancelled = true; },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    const { collectReadSeed } = await import("./server-read-seed");
    let finishLoad: () => void = () => undefined;
    const loadFinished = new Promise<void>(resolve => { finishLoad = resolve; });
    let settled = false;
    const result = collectReadSeed(async () => {
      try {
        await get("/rest/v1/assets?select=id");
        await expect(get("/rest/v1/requests?slow-body=1")).rejects.toMatchObject({ name: "AbortError" });
      } finally { finishLoad(); }
    }, { budgetMs: 300 }).then(seed => { settled = true; return seed; });
    await vi.advanceTimersByTimeAsync(299);
    expect(state.stream).toBeDefined(); expect(state.signal?.aborted).toBe(false); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const seed = await result;
    expect(seed).toMatchObject({ userId: "u1", epoch: "epoch-short" });
    expect(seed?.entries).toHaveLength(1);
    expect(seed?.entries[0].url).toContain("/assets?select=id");
    expect(seed?.entries[0].responseBody).toBe(JSON.stringify([{ id: 1 }]));
    expect(state.signal?.aborted).toBe(true);
    state.stream?.enqueue(new TextEncoder().encode(JSON.stringify([{ id: "TEST late body" }])));
    await loadFinished;
    expect(state.cancelled).toBe(true); expect(seed?.entries).toHaveLength(1);
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await expect(get("/rest/v1/assets?select=id")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(callsBefore);
  });
});
