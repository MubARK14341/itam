import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), reportFailure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.reportFailure }));
import { getReportData, getFinancialDataQuality } from "./queries";

function resultQuery(data: unknown, error: { message: string } | null = null) {
  let from = 0, to = Infinity;
  const chain = {
    select: vi.fn(() => chain), eq: vi.fn(() => chain), order: vi.fn(() => chain),
    range: vi.fn((start: number, end: number) => { from = start; to = end; return chain; }),
    limit: vi.fn(() => chain), abortSignal: vi.fn(() => chain),
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve({
      data: Array.isArray(data) ? data.slice(from, to + 1) : data, error,
      count: Array.isArray(data) ? data.length : null,
    }).then(resolve, reject),
  };
  return chain;
}

describe("report query completeness and selected sources", () => {
  beforeEach(() => { mocks.createClient.mockReset(); mocks.reportFailure.mockReset(); });

  it("loads custody assets without financial projections or unrelated report tables", async () => {
    const from = vi.fn(() => resultQuery([{ id: "asset-1", holder: { id: "holder-1" } }]));
    const rpc = vi.fn();
    mocks.createClient.mockReturnValue({ from, rpc });
    const controller = new AbortController();
    const result = await getReportData(false, { datasets: ["assets"], signal: controller.signal });
    expect(result.error).toBeNull();
    expect(result.assets).toHaveLength(1);
    expect(from.mock.calls).toEqual([["assets"]]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("combines all 1251 financial assets and preserves zero separately from missing cost", async () => {
    const assets = Array.from({ length: 1251 }, (_, index) => ({ id: `asset-${String(index).padStart(5, "0")}` }));
    const from = vi.fn(() => resultQuery(assets));
    const rpc = vi.fn((name: string, params: { p_ids: string[] }) => {
      expect(name).toBe("assets_financial");
      return resultQuery(params.p_ids.map(id => ({ id, purchase_cost: id === assets[0].id ? 0 : null })));
    });
    mocks.createClient.mockReturnValue({ from, rpc });
    const result = await getReportData(true, { datasets: ["assets"] });
    expect(result.error).toBeNull(); expect(result.assets).toHaveLength(1251);
    expect(result.assets[0].purchase_cost).toBe(0); expect(result.assets[1].purchase_cost).toBeNull();
    expect(rpc.mock.calls.flatMap(([, params]) => params.p_ids)).toEqual(assets.map(row => row.id));
    expect(rpc.mock.calls.every(([, params]) => params.p_ids.length <= 500)).toBe(true);
  });

  it("fails the report if a final financial batch is missing an asset projection", async () => {
    const assets = Array.from({ length: 1251 }, (_, index) => ({ id: String(index).padStart(5, "0") }));
    mocks.createClient.mockReturnValue({ from: vi.fn(() => resultQuery(assets)), rpc: vi.fn((_: string, params: { p_ids: string[] }) =>
      resultQuery(params.p_ids.filter(id => id !== "01250").map(id => ({ id, purchase_cost: 1 })))) });
    expect((await getReportData(true, { datasets: ["assets"] })).error).toBe("financial_projection_incomplete");
  });

  it("fails when a required reference read fails and never loads hidden pools", async () => {
    const from = vi.fn((table: string) => resultQuery([], table === "departments" ? { message: "TEST required source failed" } : null));
    mocks.createClient.mockReturnValue({ from, rpc: vi.fn() });
    const result = await getReportData(false, { datasets: ["references"] });
    expect(result.error).toBe("TEST required source failed");
    expect(from.mock.calls.map(([table]) => table).sort()).toEqual(["categories", "companies", "departments", "locations"]);
  });

  it("keeps report filter references beyond the API row ceiling", async () => {
    const categories = Array.from({ length: 1251 }, (_, index) => ({ id: `category-${index}`, name: `Category ${index}` }));
    const from = vi.fn((table: string) => resultQuery(table === "categories" ? categories : []));
    mocks.createClient.mockReturnValue({ from, rpc: vi.fn() });
    const result = await getReportData(false, { datasets: ["references"] });
    expect(result.error).toBeNull();
    expect(result.categories.map(row => row.id)).toEqual(categories.map(row => row.id));
    expect(from).not.toHaveBeenCalledWith("assets");
    expect(from).not.toHaveBeenCalledWith("asset_pools");
  });

  it("returns 200 quality rows with lookahead and does not repeat summary on continuation", async () => {
    const list = resultQuery(Array.from({ length: 201 }, (_, index) => ({ asset_id: String(index) })));
    const summary = resultQuery({ total_assets: 5000 });
    const rpc = vi.fn((name: string) => name === "financial_data_quality_summary" ? summary : list);
    mocks.createClient.mockReturnValue({ rpc });
    const signal = new AbortController().signal;
    const first = await getFinancialDataQuality({ signal });
    expect(first.error).toBeNull(); expect(first.rows).toHaveLength(200); expect(first.nextOffset).toBe(200);
    expect(summary.abortSignal).toHaveBeenCalledWith(signal); expect(list.abortSignal).toHaveBeenCalledWith(signal);
    rpc.mockClear();
    await getFinancialDataQuality({ offset: 200 });
    expect(rpc.mock.calls).toEqual([["financial_data_quality_list", { p_limit: 201, p_offset: 200 }]]);
  });

  it("rejects quality rows on summary failure, including an empty provider message", async () => {
    mocks.createClient.mockReturnValue({ rpc: vi.fn((name: string) => name === "financial_data_quality_summary"
      ? resultQuery(null, { message: "" }) : resultQuery([{ asset_id: "1" }])) });
    expect(await getFinancialDataQuality()).toMatchObject({ rows: [], nextOffset: null, error: "financial_data_quality_failed" });
  });
});
