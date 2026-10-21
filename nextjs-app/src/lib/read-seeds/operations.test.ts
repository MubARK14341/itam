import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), seed: vi.fn(), maintenance: vi.fn(), maintenanceSummary: vi.fn(),
  requests: vi.fn(), requestCounts: vi.fn(), options: vi.fn(), report: vi.fn(), requestReport: vi.fn(),
  decisions: vi.fn(), depreciation: vi.fn(), quality: vi.fn(), summaryRpc: vi.fn(), assets: vi.fn(), consumables: vi.fn(), client: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/read-seeds/context", () => ({ handedOffContext: mocks.context,
  searchString: async (params: Promise<Record<string, string | string[] | undefined>>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(await params)) {
      if (Array.isArray(value)) value.forEach(item => query.append(key, item));
      else if (value !== undefined) query.append(key, value);
    }
    const text = query.toString();
    return text ? `?${text}` : "";
  } }));
vi.mock("@/lib/supabase/server-read-seed", () => ({ collectReadSeed: mocks.seed }));
vi.mock("@/lib/queries", () => ({ getMaintenanceOperationalSummary: mocks.maintenanceSummary,
  listMaintenancePage: mocks.maintenance, getReportData: mocks.report, listDepreciationRules: mocks.depreciation,
  getFinancialDataQuality: mocks.quality, getActivity: vi.fn(), listAssetsPage: mocks.assets, listConsumablesPage: mocks.consumables,
  listRegistrationRequests: vi.fn(), listUnsoundReturnedAssets: vi.fn() }));
vi.mock("@/lib/requests", () => ({ listRequestsPage: mocks.requests, getRequestOperationalCounts: mocks.requestCounts,
  getRequestFilterOptions: mocks.options, getRequestsReport: mocks.requestReport, resolveUserLabels: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/action-center", () => ({ getActionAlertOperationalCounts: mocks.decisions,
  listActionAlertsPage: vi.fn(), resolveUserLabels: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@supabase/ssr", async () => {
  const { createClient: createSdkClient } = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
  const rpcClient = (fetcher: typeof fetch) => {
    const sdk = createSdkClient("http://127.0.0.1:65421", "TEST-public-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetcher, headers: {
        authorization: `Bearer x.${Buffer.from(JSON.stringify({ sub: "verified-user" })).toString("base64url")}.y`,
      } },
    });
    return {
    from: sdk.from.bind(sdk),
    rpc: async (name: string, input: Record<string, unknown> = {}) => {
      const response = await fetcher(`http://127.0.0.1:65421/rest/v1/rpc/${name}`, {
        method: "POST", body: JSON.stringify(input),
        headers: { authorization: `Bearer x.${Buffer.from(JSON.stringify({ sub: "verified-user" })).toString("base64url")}.y`, "content-profile": "public" },
      });
      const data: unknown = await response.json();
      return response.ok ? { data, error: null } : { data: null, error: { message: "TEST quality read failed" } };
    },
    };
  };
  return {
    createServerClient: (_url: string, _key: string, options: { global: { fetch: typeof fetch } }) => rpcClient(options.global.fetch),
    createBrowserClient: (_url: string, _key: string, options: { global: { fetch: typeof fetch } }) => rpcClient(options.global.fetch),
  };
});

import { assetsReadSeed, maintenanceReadSeed, reportsReadSeed, requestsReadSeed } from "./operations";
import { reportLoadPlan } from "@/lib/report-load-plan";
import type { ReportTab } from "@/lib/report-layout";

describe("first-screen read seed parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ session: { userId: "verified-user", role: "admin", approvalStatus: "approved" } });
    mocks.seed.mockImplementation(async (load: () => Promise<unknown>) => { await load(); return null; });
    mocks.requests.mockResolvedValue({ rows: [] });
    mocks.assets.mockResolvedValue({ rows: [], nextCursor: null, total: 0, error: null });
    mocks.consumables.mockResolvedValue({ rows: [], nextCursor: null, total: 0, error: null });
    mocks.options.mockResolvedValue({ options: { responsible_ids: [] } });
    mocks.summaryRpc.mockResolvedValue({ data: null, error: null });
    mocks.client.mockReturnValue({ rpc: mocks.summaryRpc });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("seeds the assigned request filter with the verified identity on its first read", async () => {
    await requestsReadSeed(Promise.resolve({ responsible: "__mine" }));
    expect(mocks.requests).toHaveBeenCalledOnce();
    expect(mocks.requests.mock.calls[0][0].filters.responsibleId).toBe("verified-user");
  });

  it("shares the exact maintenance cutoff and mine filter with its client page", async () => {
    const nowMs = Date.parse("2026-10-09T01:00:00.123Z");
    await maintenanceReadSeed(Promise.resolve({ view: "followup", mine: "1" }), nowMs);
    const input = mocks.maintenance.mock.calls[0][0];
    expect(input.filters).toMatchObject({ view: "followup", todayISO: "2026-10-09",
      longBeforeISO: "2026-09-25T01:00:00.123Z", technicianId: "verified-user" });
  });

  it("never seeds an unfiltered mine list when no verified identity is available", async () => {
    mocks.context.mockResolvedValue({ session: { role: "admin" } });
    await requestsReadSeed(Promise.resolve({ responsible: "__mine" }));
    await maintenanceReadSeed(Promise.resolve({ mine: "1" }));
    expect(mocks.requests).not.toHaveBeenCalled();
    expect(mocks.maintenance).not.toHaveBeenCalled();
    expect(mocks.maintenanceSummary).toHaveBeenCalledOnce();
  });

  it.each(["requests", "maintenance", "custody"] as ReportTab[])(
    "preserves the small selected seed sources for the %s report without any full dataset collector", async (tab) => {
      await reportsReadSeed(tab);
      const plan = reportLoadPlan(tab);
      if (plan.datasets.includes("references")) expect(mocks.report).toHaveBeenCalledExactlyOnceWith(tab !== "custody", { datasets: ["references"], assetProjection: plan.assetProjection });
      else expect(mocks.report).not.toHaveBeenCalled();
      expect(mocks.report.mock.calls.every(([, options]) => options.datasets.every((dataset: string) => dataset === "references"))).toBe(true);
      expect(mocks.requestReport).not.toHaveBeenCalled();
      expect(mocks.decisions).toHaveBeenCalledTimes(plan.decisionCounts ? 1 : 0);
      expect(mocks.depreciation).toHaveBeenCalledTimes(plan.depreciationRules ? 1 : 0);
      if (plan.depreciationRules) expect(mocks.depreciation).toHaveBeenCalledWith(true, { strictFinancial: true });
      expect(mocks.quality).not.toHaveBeenCalled();
      expect(mocks.summaryRpc.mock.calls).toEqual(plan.financialQuality ? [["financial_data_quality_summary"]] : []);
    },
  );

  it.each(["admin", "it_manager", "viewer", "auditor", "technician", "warehouse_manager"])(
    "leaves inventory and executive optional sources to the ordinary browser loaders for %s", async (role) => {
      mocks.context.mockResolvedValue({ session: { userId: "verified-user", role } });
      expect(await reportsReadSeed("inventory")).toBeNull();
      expect(await reportsReadSeed("executive")).toBeNull();
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.seed).not.toHaveBeenCalled();
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.summaryRpc).not.toHaveBeenCalled();
      for (const read of [mocks.report, mocks.requestReport, mocks.decisions, mocks.depreciation, mocks.quality]) {
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["inventory", "executive"] as ReportTab[])(
    "returns no seed for %s before resolving the optional read context", async (tab) => {
      mocks.context.mockImplementation(() => { throw new Error("TEST optional context must not resolve"); });
      expect(await reportsReadSeed(tab)).toBeNull();
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.seed).not.toHaveBeenCalled();
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.summaryRpc).not.toHaveBeenCalled();
      for (const read of [mocks.report, mocks.requestReport, mocks.decisions, mocks.depreciation, mocks.quality]) {
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { role: "admin", summary: { as_of: "2026-10-10T00:00:00Z", coverage_threshold_pct: 100, total_assets: 0,
      missing_purchase_cost: 0, missing_purchase_date: 0, missing_warranty_end: 0, missing_manufacturer: 0, missing_model: 0 } },
    { role: "it_manager", summary: null },
  ])("lets the unchanged browser quality loader preserve zero or null summaries for $role", async ({ role, summary }) => {
    const actualClient = await vi.importActual<typeof import("@/lib/supabase/client")>("@/lib/supabase/client");
    const actualQueries = await vi.importActual<typeof import("@/lib/queries")>("@/lib/queries");
    const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("financial_data_quality_list")) {
        expect(JSON.parse(String(init?.body))).toEqual({ p_limit: 201, p_offset: 0 });
        return new Response("[]", { status: 200 });
      }
      expect(path).toBe("/rest/v1/rpc/financial_data_quality_summary");
      return new Response(JSON.stringify(summary), { status: 200 });
    });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:65421");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "TEST-public-key");
    mocks.context.mockResolvedValue({ session: { userId: "verified-user", role } });
    mocks.client.mockImplementation(actualClient.createClient);

    expect(await reportsReadSeed("inventory")).toBeNull();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    const loaded = await actualQueries.getFinancialDataQuality();
    expect(loaded.error).toBeNull();
    expect(loaded.summary).toEqual(summary);
    expect(loaded.rows).toEqual([]);
    expect(loaded.nextOffset).toBeNull();
    expect(network.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/rest/v1/rpc/financial_data_quality_summary", "/rest/v1/rpc/financial_data_quality_list",
    ]);
    expect(mocks.quality).not.toHaveBeenCalled();
  });

  it.each(["financial_data_quality_summary", "financial_data_quality_list"])(
    "keeps a failed browser %s read eligible for retry without returning partial quality rows", async (failedRpc) => {
      const actualClient = await vi.importActual<typeof import("@/lib/supabase/client")>("@/lib/supabase/client");
      const actualQueries = await vi.importActual<typeof import("@/lib/queries")>("@/lib/queries");
      const summary = { total_assets: 201, missing_purchase_cost: 0 };
      const rows = Array.from({ length: 201 }, (_, index) => ({ asset_id: `TEST-${index}`, asset_tag: null, asset_name: null, missing_fields: ["model"], updated_at: "2026-10-10T00:00:00Z" }));
      let failed = false;
      const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("financial_data_quality_list")) {
          expect(JSON.parse(String(init?.body))).toEqual({ p_limit: 201, p_offset: 0 });
        } else expect(path).toBe("/rest/v1/rpc/financial_data_quality_summary");
        if (!failed && path.endsWith(failedRpc)) {
          failed = true;
          return new Response(JSON.stringify({ message: "TEST quality read failed" }), { status: 503 });
        }
        return new Response(JSON.stringify(path.endsWith("financial_data_quality_list") ? rows : summary), { status: 200 });
      });
      vi.stubGlobal("fetch", network);
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:65421");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "TEST-public-key");
      mocks.client.mockImplementation(actualClient.createClient);

      expect(await reportsReadSeed("inventory")).toBeNull();
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.seed).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(mocks.quality).not.toHaveBeenCalled();
      const first = await actualQueries.getFinancialDataQuality();
      expect(first.error).toBe("TEST quality read failed");
      expect(first.rows).toEqual([]);
      expect(first.nextOffset).toBeNull();
      const retried = await actualQueries.getFinancialDataQuality();
      expect(retried.error).toBeNull();
      expect(retried.summary).toEqual(summary);
      expect(retried.rows).toHaveLength(200);
      expect(retried.rows[0]).toMatchObject({ asset_tag: null, asset_name: null });
      expect(retried.nextOffset).toBe(200);
      expect(network.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        "/rest/v1/rpc/financial_data_quality_summary", "/rest/v1/rpc/financial_data_quality_list",
        "/rest/v1/rpc/financial_data_quality_summary", "/rest/v1/rpc/financial_data_quality_list",
      ]);
    },
  );

  it.each(["requests", "maintenance"] as ReportTab[])("returns no seed for %s without even resolving an unnecessary session", async (tab) => {
    expect(await reportsReadSeed(tab)).toBeNull();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.seed).not.toHaveBeenCalled();
    for (const read of [mocks.report, mocks.requestReport, mocks.decisions, mocks.depreciation, mocks.quality]) expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["missing context", null],
    ["missing staff session", { session: null }],
    ["missing role", { session: { userId: "verified-user", role: null } }],
  ])("preserves custody seed rejection with %s", async (_label, context) => {
    mocks.context.mockResolvedValue(context);
    expect(await reportsReadSeed("custody")).toBeNull();
    expect(mocks.context).toHaveBeenCalledOnce();
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.summaryRpc).not.toHaveBeenCalled();
    for (const read of [mocks.report, mocks.requestReport, mocks.decisions, mocks.depreciation, mocks.quality]) expect(read).not.toHaveBeenCalled();
  });

  it.each(["admin", "it_manager", "viewer", "auditor", "technician", "warehouse_manager"])(
    "seeds only the two ordinary initial inventory pages for %s", async role => {
      mocks.context.mockResolvedValue({ session: { userId: "verified-user", role, approvalStatus: "approved" } });
      await assetsReadSeed(Promise.resolve({}));
      expect(mocks.context).toHaveBeenCalledOnce();
      expect(mocks.seed).toHaveBeenCalledOnce();
      expect(mocks.seed).toHaveBeenCalledWith(expect.any(Function), { budgetMs: 100 });
      expect(mocks.assets).toHaveBeenCalledExactlyOnceWith({ cursor: null });
      expect(mocks.consumables).toHaveBeenCalledExactlyOnceWith({ cursor: null, includeFinancial: false });
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.summaryRpc).not.toHaveBeenCalled();
      for (const read of [mocks.report, mocks.requestReport, mocks.depreciation, mocks.quality, mocks.requests,
        mocks.options, mocks.requestCounts, mocks.maintenance, mocks.maintenanceSummary, mocks.decisions]) {
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { q: "TEST search" }, { q: "" }, { type: "consumables" }, { type: "assets" }, { view: "missing_location" },
    { cat: "TEST-category" }, { loc: "TEST-location" }, { company: "TEST-company" }, { status: "available" },
    { unknown: "" }, { q: ["TEST-one", "TEST-two"] },
  ])("leaves every nonempty inventory query to its existing browser loader: %j", async params => {
    mocks.context.mockImplementation(() => { throw new Error("TEST query-specific context must not resolve"); });
    expect(await assetsReadSeed(Promise.resolve(params))).toBeNull();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.seed).not.toHaveBeenCalled();
    for (const read of [mocks.assets, mocks.consumables, mocks.client, mocks.summaryRpc]) expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["missing context", null],
    ["missing staff session", { session: null }],
    ["missing role", { session: { userId: "verified-user", role: null, approvalStatus: "approved" } }],
    ["employee route denied", { session: { userId: "verified-user", role: "employee", approvalStatus: "approved" } }],
    ["unknown role", { session: { userId: "verified-user", role: "TEST-unknown-role", approvalStatus: "approved" } }],
    ["missing user identity", { session: { role: "admin", approvalStatus: "approved" } }],
    ["empty user identity", { session: { userId: "", role: "admin", approvalStatus: "approved" } }],
    ["malformed user identity", { session: { userId: 42, role: "admin", approvalStatus: "approved" } }],
    ["pending approval", { session: { userId: "verified-user", role: "admin", approvalStatus: "pending" } }],
    ["rejected approval", { session: { userId: "verified-user", role: "admin", approvalStatus: "rejected" } }],
    ["missing approval", { session: { userId: "verified-user", role: "admin" } }],
  ])("does not read an inventory seed with %s", async (_label, context) => {
    mocks.context.mockResolvedValue(context);
    expect(await assetsReadSeed(Promise.resolve({}))).toBeNull();
    expect(mocks.context).toHaveBeenCalledOnce();
    expect(mocks.summaryRpc).not.toHaveBeenCalled();
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    for (const read of [mocks.assets, mocks.consumables, mocks.report, mocks.requestReport, mocks.depreciation, mocks.quality]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("starts both inventory sources before either first-page result settles", async () => {
    let releaseAsset: () => void = () => undefined, releaseConsumable: () => void = () => undefined;
    mocks.assets.mockImplementation(() => new Promise<void>(resolve => { releaseAsset = resolve; }));
    mocks.consumables.mockImplementation(() => new Promise<void>(resolve => { releaseConsumable = resolve; }));
    let settled = false;
    const pending = assetsReadSeed(Promise.resolve({})).then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => { expect(mocks.assets).toHaveBeenCalledOnce(); expect(mocks.consumables).toHaveBeenCalledOnce(); });
      expect(settled).toBe(false);
      releaseAsset();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally { releaseAsset(); releaseConsumable(); }
    await pending;
    expect(settled).toBe(true);
  });

  const fixtureRows = (resource: "assets" | "consumables") => Array.from({ length: 101 }, (_, index) => resource === "assets"
    ? { id: `TEST-asset-${index}`, asset_tag: `TEST-${String(index).padStart(5, "0")}`, qr_token: `TEST-qr-${index}`,
      name: "TEST device", serial_number: null, status: "available", category_id: "TEST-category", location_id: null,
      company_id: null, pool_id: null, last_return_condition: null, special_attributes: index % 2 ? false : null,
      category: null, model: { brand: null, model_name: "TEST model" }, location: null, holder: null, company: null, pool: null }
    : { id: `TEST-consumable-${index}`, name: `TEST supply ${String(index).padStart(5, "0")}`, brand: null, sku: null,
      rfid_tag: null, unit: "piece", quantity_on_hand: 0, reorder_level: 0, category_id: "TEST-category",
      company_id: null, supplier_id: null, location_id: null, notes: null, category: null, company: null, location: null });

  const ordinaryResponse = (resource: "assets" | "consumables", empty = false) => new Response(JSON.stringify(empty ? [] : fixtureRows(resource)), {
    status: empty ? 200 : 206, headers: { "content-type": "application/json", "content-range": empty ? "*/0" : `0-100/${resource === "assets" ? 5014 : 2021}` },
  });

  async function actualInventoryReads(transport: typeof fetch) {
    const actualClient = await vi.importActual<typeof import("@/lib/supabase/client")>("@/lib/supabase/client");
    const actualQueries = await vi.importActual<typeof import("@/lib/queries")>("@/lib/queries");
    const collector = await vi.importActual<typeof import("@/lib/supabase/server-read-seed")>("@/lib/supabase/server-read-seed");
    const replay = await import("@/lib/supabase/read-prefetch");
    replay.clearReadPrefetch(false);
    vi.stubGlobal("fetch", transport);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:65421");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "TEST-public-key");
    mocks.client.mockImplementation(actualClient.createClient);
    mocks.seed.mockImplementation(collector.collectReadSeed);
    mocks.assets.mockImplementation(actualQueries.listAssetsPage);
    mocks.consumables.mockImplementation(actualQueries.listConsumablesPage);
    return { actualQueries, replay };
  }

  function browserEnvironment() {
    const store = new Map<string, string>();
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("window", { location: { pathname: "/assets", href: "http://localhost/assets", protocol: "http:" },
      localStorage: { get length() { return store.size; }, key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); } } });
  }

  async function browserFirstPages(queries: typeof import("@/lib/queries")) {
    const signal = new AbortController().signal;
    return Promise.all([
      queries.listAssetsPage({ cursor: null, signal, filters: { q: "", categoryId: "", status: "", locationId: "", companyId: "", poolId: "", view: null } }),
      queries.listConsumablesPage({ cursor: null, includeFinancial: false, signal, filters: { q: "", categoryId: "", locationId: "", companyId: "" } }),
    ]);
  }

  it("replays the installed SDK's exact two default browser requests once with100rows, counts and cursors", async () => {
    const calls: { url: string; prefer: string | null; signal: AbortSignal | null | undefined }[] = [];
    const transport: typeof fetch = async (input, init) => {
      const address = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url: address.toString(), prefer: new Headers(init?.headers).get("prefer"), signal: init?.signal });
      expect(init?.method).toBe("GET"); expect(address.searchParams.get("limit")).toBe("101");
      expect(address.searchParams.get("is_active")).toBe("eq.true");
      expect(address.searchParams.get("select")).not.toMatch(/purchase_cost|unit_cost|financial/);
      expect(calls.at(-1)?.prefer).toBe("count=exact");
      if (address.pathname === "/rest/v1/assets") {
        expect(address.searchParams.get("archived_at")).toBe("is.null");
        expect(address.searchParams.get("order")).toBe("asset_tag.asc");
        return ordinaryResponse("assets");
      }
      expect(address.pathname).toBe("/rest/v1/consumables");
      expect(address.searchParams.get("order")).toBe("name.asc,id.asc");
      return ordinaryResponse("consumables");
    };
    const { actualQueries, replay } = await actualInventoryReads(transport);
    try {
      const seed = await assetsReadSeed(Promise.resolve({}));
      expect(seed?.userId).toBe("verified-user"); expect(seed?.epoch).toBe(""); expect(seed?.entries).toHaveLength(2);
      expect(seed?.entries.every(entry => entry.method === "GET" && entry.body === null)).toBe(true);
      expect(JSON.stringify(seed)).not.toContain("Bearer");
      expect(calls).toHaveLength(2); expect(calls.every(call => call.signal?.aborted)).toBe(true);
      browserEnvironment(); replay.seedReadPrefetch(seed);
      const [assets, consumables] = await browserFirstPages(actualQueries);
      expect(assets.error).toBeNull(); expect(consumables.error).toBeNull();
      expect(assets.rows).toEqual(fixtureRows("assets").slice(0, 100)); expect(assets.total).toBe(5014);
      expect(consumables.rows).toEqual(fixtureRows("consumables").slice(0, 100)); expect(consumables.total).toBe(2021);
      expect(assets.nextCursor).toEqual({ value: "TEST-00099", id: "TEST-asset-99" });
      expect(consumables.nextCursor).toEqual({ value: "TEST supply 00099", id: "TEST-consumable-99" });
      expect(calls).toHaveLength(2);
      const refreshed = await browserFirstPages(actualQueries);
      expect(refreshed).toEqual([assets, consumables]); expect(calls).toHaveLength(4);
      expect(calls.slice(2).map(call => call.url).sort()).toEqual(calls.slice(0, 2).map(call => call.url).sort());
    } finally { replay.clearReadPrefetch(false); }
  });

  it.each(["assets", "consumables"] as const)("keeps a malformed successful %s seed body as a visible source error", async malformed => {
    const transport: typeof fetch = async input => {
      const address = new URL(input instanceof Request ? input.url : String(input));
      expect(["/rest/v1/assets", "/rest/v1/consumables"]).toContain(address.pathname);
      const resource = address.pathname.endsWith("/assets") ? "assets" : "consumables";
      return resource === malformed ? new Response("null", { status: 200, headers: { "content-type": "application/json" } }) : ordinaryResponse(resource);
    };
    const network = vi.fn(transport), { actualQueries, replay } = await actualInventoryReads(network);
    try {
      const seed = await assetsReadSeed(Promise.resolve({})); expect(seed?.entries).toHaveLength(2);
      browserEnvironment(); replay.seedReadPrefetch(seed);
      const [assets, consumables] = await browserFirstPages(actualQueries), failed = malformed === "assets" ? assets : consumables;
      expect(failed.rows).toEqual([]); expect(failed.nextCursor).toBeNull(); expect(failed.total).toBeNull();
      expect(failed.error).toBe(malformed === "assets" ? "asset_inventory_shape_invalid" : "consumable_inventory_location_invalid");
      expect(network).toHaveBeenCalledTimes(2);
    } finally { replay.clearReadPrefetch(false); }
  });

  it("leaves failed HTTP reads unseeded, preserves the browser error and allows a fresh successful retry", async () => {
    let assetCalls = 0, consumableCalls = 0, recovered = false;
    const transport: typeof fetch = async input => {
      const address = new URL(input instanceof Request ? input.url : String(input));
      if (address.pathname === "/rest/v1/assets") {
        assetCalls++;
        if (!recovered) return new Response(JSON.stringify({ message: "TEST initial assets failed" }), {
          status: 503, headers: { "Retry-After": "0" },
        });
        return ordinaryResponse("assets");
      }
      expect(address.pathname).toBe("/rest/v1/consumables"); consumableCalls++; return ordinaryResponse("consumables");
    };
    const { actualQueries, replay } = await actualInventoryReads(transport);
    try {
      const seed = await assetsReadSeed(Promise.resolve({}));
      expect(seed?.entries).toHaveLength(1); expect(seed?.entries[0].url).toContain("/rest/v1/consumables?");
      const seedAssetCalls = assetCalls;
      expect(seedAssetCalls).toBeGreaterThan(0); expect(consumableCalls).toBe(1);
      browserEnvironment(); replay.seedReadPrefetch(seed);
      const [assets, consumables] = await browserFirstPages(actualQueries);
      expect(assets.error).toBe("TEST initial assets failed"); expect(assets.rows).toEqual([]); expect(assets.nextCursor).toBeNull();
      expect(assets.total).toBeNull();
      expect(consumables.error).toBeNull(); expect(consumables.rows).toHaveLength(100);
      expect(assetCalls).toBeGreaterThan(seedAssetCalls); expect(consumableCalls).toBe(1);
      const failedAssetCalls = assetCalls;
      recovered = true;
      const retried = await actualQueries.listAssetsPage({ cursor: null });
      expect(retried.error).toBeNull(); expect(retried.rows).toHaveLength(100); expect(retried.total).toBe(5014);
      expect(assetCalls).toBe(failedAssetCalls + 1); expect(consumableCalls).toBe(1);
    } finally { replay.clearReadPrefetch(false); }
  });

  it("preserves genuine zero-row and count0 success in both first-page seeds", async () => {
    const network = vi.fn(async (input: RequestInfo | URL) => {
      const address = new URL(input instanceof Request ? input.url : String(input));
      expect(["/rest/v1/assets", "/rest/v1/consumables"]).toContain(address.pathname);
      return ordinaryResponse(address.pathname.endsWith("/assets") ? "assets" : "consumables", true);
    });
    const { actualQueries, replay } = await actualInventoryReads(network);
    try {
      const seed = await assetsReadSeed(Promise.resolve({})); expect(seed?.entries).toHaveLength(2);
      browserEnvironment(); replay.seedReadPrefetch(seed);
      const pages = await browserFirstPages(actualQueries);
      expect(pages).toEqual([{ rows: [], nextCursor: null, total: 0, error: null }, { rows: [], nextCursor: null, total: 0, error: null }]);
      expect(network).toHaveBeenCalledTimes(2);
    } finally { replay.clearReadPrefetch(false); }
  });


  it("replays the completed consumable page once and falls back for an assets read closed at100ms", async () => {
    vi.useFakeTimers();
    let assetCalls = 0, consumableCalls = 0, browserPhase = false;
    const held: { signal?: AbortSignal | null; release?: (response: Response) => void } = {};
    const transport: typeof fetch = async (input, init) => {
      const address = new URL(input instanceof Request ? input.url : String(input));
      expect(init?.method).toBe("GET");
      expect(address.searchParams.get("limit")).toBe("101");
      expect(address.searchParams.get("select")).not.toMatch(/purchase_cost|unit_cost|financial/);
      if (address.pathname === "/rest/v1/assets") {
        assetCalls++;
        if (!browserPhase) {
          held.signal = init?.signal;
          return new Promise<Response>(resolve => { held.release = resolve; });
        }
        return ordinaryResponse("assets");
      }
      expect(address.pathname).toBe("/rest/v1/consumables");
      consumableCalls++; return ordinaryResponse("consumables");
    };
    const { actualQueries, replay } = await actualInventoryReads(transport);
    const collector = await vi.importActual<typeof import("@/lib/supabase/server-read-seed")>("@/lib/supabase/server-read-seed");
    let loaderStarted = false;
    let finishLoad: () => void = () => undefined;
    const loadFinished = new Promise<void>(resolve => { finishLoad = resolve; });
    mocks.seed.mockImplementation((load: () => Promise<unknown>, options: { budgetMs?: number }) => collector.collectReadSeed(async () => {
      loaderStarted = true;
      try { return await load(); } finally { finishLoad(); }
    }, options));
    try {
      let settled = false;
      const pending = assetsReadSeed(Promise.resolve({})).then(seed => { settled = true; return seed; });
      await vi.advanceTimersByTimeAsync(99);
      expect(assetCalls).toBe(1); expect(consumableCalls).toBe(1);
      expect(held.signal?.aborted).toBe(false); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const seed = await pending;
      expect(held.signal?.aborted).toBe(true);
      expect(seed?.userId).toBe("verified-user"); expect(seed?.entries).toHaveLength(1);
      expect(seed?.entries[0].url).toContain("/rest/v1/consumables?");
      browserPhase = true; browserEnvironment(); replay.seedReadPrefetch(seed);
      const pages = await browserFirstPages(actualQueries);
      expect(pages[0].error).toBeNull(); expect(pages[1].error).toBeNull();
      expect(pages[0].rows).toEqual(fixtureRows("assets").slice(0, 100)); expect(pages[0].total).toBe(5014);
      expect(pages[1].rows).toEqual(fixtureRows("consumables").slice(0, 100)); expect(pages[1].total).toBe(2021);
      expect(pages[0].nextCursor).toEqual({ value: "TEST-00099", id: "TEST-asset-99" });
      expect(pages[1].nextCursor).toEqual({ value: "TEST supply 00099", id: "TEST-consumable-99" });
      expect(assetCalls).toBe(2); expect(consumableCalls).toBe(1);
      expect(held.release).toBeDefined(); held.release?.(ordinaryResponse("assets"));
      await loadFinished;
      expect(seed?.entries).toHaveLength(1);
      expect(assetCalls).toBe(2); expect(consumableCalls).toBe(1);
      const refreshed = await browserFirstPages(actualQueries);
      expect(refreshed).toEqual(pages);
      expect(assetCalls).toBe(3); expect(consumableCalls).toBe(2);
    } finally {
      try {
        held.release?.(ordinaryResponse("assets"));
        if (loaderStarted) await loadFinished;
      } finally { replay.clearReadPrefetch(false); vi.useRealTimers(); }
    }
  });
});
