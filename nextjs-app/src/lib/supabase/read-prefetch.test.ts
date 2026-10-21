import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API = "https://publication-disabled.invalid";
const tokenFor = (sub: string) =>
  `Bearer x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("read prefetch buffer", () => {
  let calls: string[];
  let counter: number;

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    counter = 0;
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { pathname: "/dashboard", href: "http://localhost/dashboard" },
      localStorage: {
        get length() { return store.size; },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      counter += 1;
      return jsonResponse({ n: counter });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function load() {
    return import("./read-prefetch");
  }

  async function visitAssets(mod: Awaited<ReturnType<typeof load>>, user = "u1") {
    (window as unknown as { location: { pathname: string } }).location.pathname = "/assets";
    await mod.prefetchAwareFetch(`${API}/rest/v1/assets?select=id`, { method: "GET", headers: { authorization: tokenFor(user) } });
    (window as unknown as { location: { pathname: string } }).location.pathname = "/dashboard";
  }

  it("hands a prefetched read to the first identical request only", async () => {
    const mod = await load();
    await visitAssets(mod);
    await mod.prefetchRouteData("/assets", { accessToken: tokenFor("u1").slice(7), apiKey: "anon", userId: "u1" });
    const before = calls.length;
    const first = await mod.prefetchAwareFetch(`${API}/rest/v1/assets?select=id`, { method: "GET", headers: { authorization: tokenFor("u1") } });
    expect(calls.length).toBe(before); // served from the buffer
    expect(await first.json()).toEqual({ n: 2 });
    await mod.prefetchAwareFetch(`${API}/rest/v1/assets?select=id`, { method: "GET", headers: { authorization: tokenFor("u1") } });
    expect(calls.length).toBe(before + 1); // second use goes to the network
  });

  it("never shares a prefetched response across sessions", async () => {
    const mod = await load();
    await visitAssets(mod);
    await mod.prefetchRouteData("/assets", { accessToken: tokenFor("u1").slice(7), apiKey: "anon", userId: "u1" });
    const before = calls.length;
    await mod.prefetchAwareFetch(`${API}/rest/v1/assets?select=id`, { method: "GET", headers: { authorization: tokenFor("u2") } });
    expect(calls.length).toBe(before + 1);
  });

  it("clears the buffer on any write", async () => {
    const mod = await load();
    await visitAssets(mod);
    await mod.prefetchRouteData("/assets", { accessToken: tokenFor("u1").slice(7), apiKey: "anon", userId: "u1" });
    await mod.prefetchAwareFetch(`${API}/rest/v1/rpc/asset_update_atomic`, { method: "POST", body: "{}", headers: { authorization: tokenFor("u1") } });
    const before = calls.length;
    await mod.prefetchAwareFetch(`${API}/rest/v1/assets?select=id`, { method: "GET", headers: { authorization: tokenFor("u1") } });
    expect(calls.length).toBe(before + 1);
  });

  it("never buffers auth, identity or security calls", async () => {
    const mod = await load();
    for (const path of ["/auth/v1/user", "/rest/v1/rpc/auth_security_state", "/rest/v1/rpc/my_capabilities", "/rest/v1/rpc/app_user_role"]) {
      const method = path.startsWith("/auth") ? "GET" : "POST";
      await mod.prefetchAwareFetch(`${API}${path}`, { method, body: method === "POST" ? "{}" : undefined, headers: { authorization: tokenFor("u1") } });
      await mod.prefetchAwareFetch(`${API}${path}`, { method, body: method === "POST" ? "{}" : undefined, headers: { authorization: tokenFor("u1") } });
    }
    expect(calls).toHaveLength(8);
    const stored = window.localStorage.getItem("itam:prefetch:v1:u1") ?? "";
    expect(stored).not.toContain("auth_security_state");
    expect(stored).not.toContain("Bearer");
  });

  it("forgets remembered shapes on sign-out", async () => {
    const mod = await load();
    await visitAssets(mod);
    expect(window.localStorage.getItem("itam:prefetch:v1:u1")).toContain("/rest/v1/assets");
    mod.forgetPrefetchShapes();
    expect(window.localStorage.getItem("itam:prefetch:v1:u1")).toBeNull();
  });

  it("persists an identical request shape once while every ordinary read still reaches the network", async () => {
    const writes = vi.spyOn(window.localStorage, "setItem"), mod = await load();
    const body = JSON.stringify({ p_ids: Array.from({ length: 500 }, (_, index) => `TEST-id-${index}`) });
    const url = `${API}/rest/v1/rpc/assets_financial`, headers = { authorization: tokenFor("u1"), "content-type": "application/json", prefer: "count=exact" };
    for (let index = 0; index < 5; index++) await mod.prefetchAwareFetch(url, { method: "POST", body, headers });
    expect(writes).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(5);
    const stored = window.localStorage.getItem("itam:prefetch:v1:u1") ?? "";
    expect(stored).toContain(body.replaceAll('"', '\\"')); expect(stored).not.toContain("Bearer");
    // A later document reloads the remembered shapes without rewriting the same metadata.
    vi.resetModules(); const reloaded = await load();
    await reloaded.prefetchAwareFetch(url, { method: "POST", body, headers });
    expect(writes).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(6);
  });

  it("persists changes to replay headers, body, method and URL within the actor's namespace", async () => {
    const writes = vi.spyOn(window.localStorage, "setItem"), mod = await load();
    const url = `${API}/rest/v1/rpc/assets_financial`, body = JSON.stringify({ p_ids: ["TEST-a"] });
    const headers = { authorization: tokenFor("u1"), prefer: "count=exact", "content-type": "application/json", "accept-profile": "public" };
    await mod.prefetchAwareFetch(url, { method: "POST", body, headers });
    // Header insertion order and a refreshed token for the same actor are not replay changes.
    const refreshedAuthorization = `Bearer x.${Buffer.from(JSON.stringify({ sub: "u1", iat: 1 })).toString("base64url")}.y`;
    await mod.prefetchAwareFetch(url, { method: "POST", body,
      headers: { "accept-profile": "public", "content-type": "application/json", prefer: "count=exact", authorization: refreshedAuthorization } });
    expect(writes).toHaveBeenCalledTimes(1);
    await mod.prefetchAwareFetch(url, { method: "POST", body, headers: { ...headers, prefer: "count=planned" } });
    await mod.prefetchAwareFetch(url, { method: "POST", body: JSON.stringify({ p_ids: ["TEST-b"] }), headers });
    await mod.prefetchAwareFetch(url, { method: "GET", headers });
    await mod.prefetchAwareFetch(`${url}?offset=500`, { method: "POST", body, headers });
    expect(writes).toHaveBeenCalledTimes(5);
    const firstActor = window.localStorage.getItem("itam:prefetch:v1:u1");
    expect(firstActor).toContain("count=planned"); expect(firstActor).not.toContain("Bearer");
    await mod.prefetchAwareFetch(url, { method: "POST", body, headers: { ...headers, authorization: tokenFor("u2") } });
    expect(writes).toHaveBeenCalledTimes(6);
    expect(window.localStorage.getItem("itam:prefetch:v1:u1")).toBe(firstActor);
    expect(window.localStorage.getItem("itam:prefetch:v1:u2")).toContain("TEST-a");
  });

  it("warms at most two reads at a time and stops outstanding/queued work on invalidation", async () => {
    const mod = await load();
    (window as unknown as { location: { pathname: string } }).location.pathname = "/assets";
    for (let i = 0; i < 5; i += 1) {
      await mod.prefetchAwareFetch(`${API}/rest/v1/assets?select=id&page=${i}`, { headers: { authorization: tokenFor("u1") } });
    }
    (window as unknown as { location: { pathname: string } }).location.pathname = "/dashboard";
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    const warming = mod.prefetchRouteData("/assets", { accessToken: tokenFor("u1").slice(7), apiKey: "anon", userId: "u1" });
    expect(signals).toHaveLength(2);
    mod.clearReadPrefetch();
    await warming;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("does not reuse a warmed response after a write invalidates the waiting read", async () => {
    const mod = await load();
    await visitAssets(mod);
    let release: (response: Response) => void = () => undefined;
    const ordinaryFetch = fetch;
    let warmStarted = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!warmStarted && String(input).includes("/assets?")) {
        warmStarted = true;
        // Deliberately ignore cancellation to model a response already on the wire.
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      return ordinaryFetch(input, init);
    }));
    const warming = mod.prefetchRouteData("/assets", { accessToken: tokenFor("u1").slice(7), apiKey: "anon", userId: "u1" });
    const reading = mod.prefetchAwareFetch(`${API}/rest/v1/assets?select=id`, { headers: { authorization: tokenFor("u1") } });
    await mod.prefetchAwareFetch(`${API}/rest/v1/rpc/asset_update_atomic`, { method: "POST", body: "{}", headers: { authorization: tokenFor("u1") } });
    release(jsonResponse({ stale: true }));
    await warming;
    expect(await (await reading).json()).not.toEqual({ stale: true });
  });
});

describe("server read seeds", () => {
  let calls: string[];
  let cookieJar: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    cookieJar = new Map();
    vi.stubGlobal("window", {
      location: { pathname: "/requests", href: "http://localhost/requests", protocol: "http:" },
      localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    });
    vi.stubGlobal("document", {
      get cookie() { return [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; "); },
      set cookie(value: string) {
        const [pair] = value.split(";");
        const index = pair.indexOf("=");
        cookieJar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return jsonResponse({ network: true });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const LIST = `${API}/rest/v1/requests?select=id&order=created_at.desc`;
  function seed(overrides: Partial<{ id: string; userId: string; epoch: string; method: string; url: string; body: string | null }> = {}) {
    return {
      id: overrides.id ?? "seed-1",
      userId: overrides.userId ?? "u1",
      epoch: overrides.epoch ?? "",
      entries: [{
        method: overrides.method ?? "GET",
        url: overrides.url ?? LIST,
        body: overrides.body ?? null,
        headers: { "accept-profile": "public" },
        status: 200,
        statusText: "OK",
        responseHeaders: [["content-type", "application/json"]] as [string, string][],
        responseBody: JSON.stringify({ seeded: true }),
      }],
    };
  }
  const read = (mod: typeof import("./read-prefetch"), user = "u1") =>
    mod.prefetchAwareFetch(LIST, { method: "GET", headers: { authorization: tokenFor(user), "accept-profile": "public" } });

  it("answers the page's identical first read once, then goes to the network", async () => {
    const mod = await import("./read-prefetch");
    mod.seedReadPrefetch(seed());
    expect(await (await read(mod)).json()).toEqual({ seeded: true });
    expect(calls).toHaveLength(0);
    expect(await (await read(mod)).json()).toEqual({ network: true });
    expect(calls).toEqual(["GET /rest/v1/requests"]);
  });

  it("does not consume a valid seed for an already-cancelled read", async () => {
    const mod = await import("./read-prefetch");
    mod.seedReadPrefetch(seed());
    const controller = new AbortController();
    controller.abort();
    await expect(mod.prefetchAwareFetch(LIST, { method: "GET", signal: controller.signal,
      headers: { authorization: tokenFor("u1"), "accept-profile": "public" } })).rejects.toMatchObject({ name: "AbortError" });
    expect(await (await read(mod)).json()).toEqual({ seeded: true });
    expect(calls).toHaveLength(0);
  });

  it("never answers another user's request", async () => {
    const mod = await import("./read-prefetch");
    mod.seedReadPrefetch(seed({ userId: "u1" }));
    expect(await (await read(mod, "u2")).json()).toEqual({ network: true });
    expect(await (await read(mod, "u1")).json()).toEqual({ network: true }); // discarded, not kept around
  });

  it("ignores repeated renders of one visit but applies again on a later visit", async () => {
    vi.useFakeTimers();
    try {
      const mod = await import("./read-prefetch");
      mod.seedReadPrefetch(seed());
      mod.seedReadPrefetch(seed()); // same visit: no second entry
      await read(mod);
      expect(await (await read(mod)).json()).toEqual({ network: true });
      vi.advanceTimersByTime(5_000);
      mod.seedReadPrefetch(seed()); // the page payload reused from Next's router cache
      expect(await (await read(mod)).json()).toEqual({ seeded: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats the financial truth projections as reads", async () => {
    const mod = await import("./read-prefetch");
    for (const rpc of ["maintenance_financial_truth", "consumable_txn_financial_detail", "assets_financial", "consumables_financial",
      "consumable_txn_financial", "depreciation_financial", "maintenance_financial", "purchase_request_items_financial", "request_items_financial"]) {
      expect(mod.classifyDataRequest("POST", new URL(`${API}/rest/v1/rpc/${rpc}`))).toBe("read");
    }
    for (const rpc of ["unknown_financial", "consumable_stock_move", "consumable_stock_move_idempotent", "purchase_request_item_receive_idempotent"]) {
      expect(mod.classifyDataRequest("POST", new URL(`${API}/rest/v1/rpc/${rpc}`))).toBe("write");
    }
    expect(mod.classifyDataRequest("POST", new URL(`${API}/rest/v1/rpc/portal_get_request_attachment_path`))).toBe("neutral");
  });

  it("never changes the epoch or notifies invalidation during known financial reads", async () => {
    const mod = await import("./read-prefetch");
    cookieJar.set(mod.READ_EPOCH_COOKIE, "financial-read-epoch");
    const invalidated = vi.fn(), unsubscribe = mod.subscribeReadInvalidation(invalidated);
    mod.seedReadPrefetch(seed({ epoch: "financial-read-epoch" }));
    for (const rpc of ["assets_financial", "consumables_financial", "consumable_txn_financial", "depreciation_financial", "maintenance_financial", "purchase_request_items_financial", "request_items_financial"]) {
      await mod.prefetchAwareFetch(`${API}/rest/v1/rpc/${rpc}`, { method: "POST", body: "{}", headers: { authorization: tokenFor("u1") } });
    }
    expect(cookieJar.get(mod.READ_EPOCH_COOKIE)).toBe("financial-read-epoch");
    expect(invalidated).not.toHaveBeenCalled();
    expect(await (await read(mod)).json()).toEqual({ seeded: true });
    unsubscribe();
  });

  it("consumes an exact financial POST seed once and only for its recorded user", async () => {
    const mod = await import("./read-prefetch");
    const body = JSON.stringify({ p_ids: ["asset-1"] }), url = `${API}/rest/v1/rpc/assets_financial`;
    const financial = seed({ id: "financial-seed", method: "POST", url, body });
    mod.seedReadPrefetch(financial);
    const init = { method: "POST", body, headers: { authorization: tokenFor("u1"), "accept-profile": "public" } };
    expect(await (await mod.prefetchAwareFetch(url, init)).json()).toEqual({ seeded: true });
    expect(calls).toHaveLength(0);
    expect(await (await mod.prefetchAwareFetch(url, init)).json()).toEqual({ network: true });
    mod.seedReadPrefetch({ ...financial, id: "foreign-financial-seed" });
    expect(await (await mod.prefetchAwareFetch(url, { ...init, headers: { ...init.headers, authorization: tokenFor("u2") } })).json()).toEqual({ network: true });
  });

  it("ignores a seed recorded before the latest write, in this or another tab", async () => {
    const mod = await import("./read-prefetch");
    cookieJar.set(mod.READ_EPOCH_COOKIE, "after-write");
    mod.seedReadPrefetch(seed({ epoch: "before-write" }));
    expect(await (await read(mod)).json()).toEqual({ network: true });
  });

  it("drops pending seeds on a write and moves the epoch forward", async () => {
    const mod = await import("./read-prefetch");
    mod.seedReadPrefetch(seed());
    await mod.prefetchAwareFetch(`${API}/rest/v1/rpc/request_approve`, { method: "POST", body: "{}", headers: { authorization: tokenFor("u1") } });
    const epoch = cookieJar.get(mod.READ_EPOCH_COOKIE);
    expect(epoch).toBeTruthy();
    expect(await (await read(mod)).json()).toEqual({ network: true });
    mod.seedReadPrefetch(seed({ id: "seed-2", epoch }));
    expect(await (await read(mod)).json()).toEqual({ seeded: true });
  });

  it("keeps the epoch when the Action Center only reconciles its own alerts", async () => {
    const mod = await import("./read-prefetch");
    await mod.prefetchAwareFetch(`${API}/rest/v1/rpc/action_alerts_sync`, { method: "POST", body: "{}", headers: { authorization: tokenFor("u1") } });
    expect(cookieJar.has(mod.READ_EPOCH_COOKIE)).toBe(false);
  });

  it("never seeds anything but reads", async () => {
    const mod = await import("./read-prefetch");
    const write = `${API}/rest/v1/rpc/request_approve`;
    mod.seedReadPrefetch(seed({ method: "POST", url: write }));
    await mod.prefetchAwareFetch(write, { method: "POST", headers: { authorization: tokenFor("u1"), "accept-profile": "public" } });
    expect(calls).toEqual(["POST /rest/v1/rpc/request_approve"]);
  });
});
