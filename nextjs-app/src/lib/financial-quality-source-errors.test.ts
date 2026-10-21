import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ client: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.failure }));
import { getFinancialDataQuality, type FinancialDataQualityRow, type FinancialDataQualitySummary } from "./queries";
import { collectFinancialQualityPages } from "./report-load-plan";

type Endpoint = "financial_data_quality_summary" | "financial_data_quality_list";
type Reply = { status: number; body: string };
const failedBodies = [
  { name: "top-level false", body: "false" },
  { name: "top-level zero", body: "0" },
  { name: "top-level empty string", body: '""' },
  { name: "top-level NULL", body: "null" },
  { name: "top-level array", body: "[]" },
  { name: "top-level string", body: JSON.stringify("TEST denied") },
  { name: "empty message", body: JSON.stringify({ message: "" }) },
  { name: "whitespace message", body: JSON.stringify({ message: " \t\n" }) },
  { name: "non-string message", body: JSON.stringify({ message: [] }) },
  { name: "missing message", body: JSON.stringify({ code: "42501" }) },
];
const invalidLists = [
  { name: "NULL", body: "null" }, { name: "false", body: "false" },
  { name: "zero", body: "0" }, { name: "empty string", body: '""' },
  { name: "object", body: "{}" }, { name: "invalid JSON", body: "TEST invalid JSON" },
];
const zeroSummary: FinancialDataQualitySummary = {
  as_of: "2026-10-11T00:00:00.000Z", coverage_threshold_pct: 0, total_assets: 0,
  missing_purchase_cost: 0, missing_purchase_date: 0, missing_warranty_end: 0,
  missing_manufacturer: 0, missing_model: 0,
};
let rows: FinancialDataQualityRow[], summary: FinancialDataQualitySummary | null;
let replies: Map<string, Reply>, calls: { endpoint: Endpoint; offset: number }[];
function replyAt(endpoint: Endpoint, offset: number, reply: Reply) { replies.set(`${endpoint}:${offset}`, reply); }

beforeEach(() => {
  rows = Array.from({ length: 1251 }, (_, index) => ({
    asset_id: `TEST-${String(index).padStart(5, "0")}`, asset_tag: index === 0 ? null : `TEST-${index}`,
    asset_name: "TEST asset", missing_fields: index === 0 ? [] : ["purchase_cost"], updated_at: "2026-10-11T00:00:00.000Z",
  }));
  summary = zeroSummary; replies = new Map(); calls = [];
  mocks.client.mockReset(); mocks.failure.mockReset();
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const address = new URL(request.url);
    const endpoint = address.pathname.replace("/rest/v1/rpc/", "");
    if (endpoint !== "financial_data_quality_summary" && endpoint !== "financial_data_quality_list") {
      throw new Error("Unexpected TEST financial quality endpoint");
    }
    const params = JSON.parse(await request.text()) as { p_limit?: number; p_offset?: number };
    const offset = endpoint === "financial_data_quality_list" ? params.p_offset ?? 0 : 0;
    calls.push({ endpoint, offset });
    if (calls.length > 16) throw new Error("TEST financial quality read overflow");
    const forced = replies.get(`${endpoint}:${offset}`);
    const body = forced?.body ?? JSON.stringify(endpoint === "financial_data_quality_summary"
      ? summary : rows.slice(offset, offset + (params.p_limit ?? 201)));
    return new Response(body, { status: forced?.status ?? 200, headers: { "content-type": "application/json" } });
  };
  mocks.client.mockReturnValue(createSdkClient("http://localhost:65421", "TEST-public-placeholder", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport },
  }));
});

for (const endpoint of ["financial_data_quality_summary", "financial_data_quality_list"] as const) {
  describe(`${endpoint} through the installed SDK`, () => {
    it.each(failedBodies)("fails closed on403 $name", async failure => {
      replyAt(endpoint, 0, { status: 403, body: failure.body });
      expect(await getFinancialDataQuality()).toMatchObject({ rows: [], nextOffset: null, error: "financial_data_quality_failed" });
      expect(mocks.failure).toHaveBeenCalledWith("financial_data_quality_failed", "financial_data_quality_failed");
      expect(calls).toHaveLength(2);
    });
    it.each([302, 401, 403, 500])("rejects public non-success status%i even with a NULL SDK error", async status => {
      replyAt(endpoint, 0, { status, body: "null" });
      expect(await getFinancialDataQuality()).toMatchObject({ rows: [], nextOffset: null, error: "financial_data_quality_failed" });
      expect(calls).toHaveLength(2);
    });
    it("retains a genuine nonempty provider message", async () => {
      replyAt(endpoint, 0, { status: 403, body: JSON.stringify({ message: " TEST denied " }) });
      expect((await getFinancialDataQuality()).error).toBe(" TEST denied ");
    });
  });
}

describe("complete financial quality pages", () => {
  it.each(invalidLists)("rejects a successful malformed $name list", async value => {
    replyAt("financial_data_quality_list", 0, { status: 200, body: value.body });
    const result = await getFinancialDataQuality();
    expect(result.rows).toEqual([]); expect(result.nextOffset).toBeNull();
    expect(result.error).toBe(value.name === "invalid JSON" ? "TEST invalid JSON" : "financial_data_quality_shape_invalid");
  });
  it("preserves successful[] and every zero summary field", async () => {
    rows = [];
    expect(await getFinancialDataQuality()).toEqual({ summary: zeroSummary, rows: [], nextOffset: null, error: null });
    expect(mocks.failure).not.toHaveBeenCalled();
  });
  it("allows a successful NULL summary with complete genuine rows", async () => {
    summary = null; rows = rows.slice(0, 2);
    expect(await getFinancialDataQuality()).toEqual({ summary: null, rows, nextOffset: null, error: null });
    expect(mocks.failure).not.toHaveBeenCalled();
  });
  it("collects all1251 rows and requests the summary only on the first page", async () => {
    expect(await collectFinancialQualityPages(offset => getFinancialDataQuality({ offset }))).toEqual(rows);
    expect(calls.filter(call => call.endpoint === "financial_data_quality_summary")).toEqual([
      { endpoint: "financial_data_quality_summary", offset: 0 },
    ]);
    expect(calls.filter(call => call.endpoint === "financial_data_quality_list").map(call => call.offset)).toEqual([0, 200, 400, 600, 800, 1000, 1200]);
  });
  it.each(failedBodies.slice(0, 6))("withholds earlier rows from a download consumer after late403 $name", async failure => {
    replyAt("financial_data_quality_list", 200, { status: 403, body: failure.body });
    const download = vi.fn();
    const exportComplete = async () => {
      const complete = await collectFinancialQualityPages(offset => getFinancialDataQuality({ offset }));
      download(complete);
    };
    await expect(exportComplete()).rejects.toThrow("financial_data_quality_failed");
    expect(download).not.toHaveBeenCalled();
    expect(calls.filter(call => call.endpoint === "financial_data_quality_list").map(call => call.offset)).toEqual([0, 200]);
  });
  it.each(invalidLists.slice(0, 5))("rejects a late successful malformed $name list without returning an earlier page", async value => {
    replyAt("financial_data_quality_list", 200, { status: 200, body: value.body });
    await expect(collectFinancialQualityPages(offset => getFinancialDataQuality({ offset }))).rejects.toThrow("financial_data_quality_shape_invalid");
    expect(calls.filter(call => call.endpoint === "financial_data_quality_list").map(call => call.offset)).toEqual([0, 200]);
  });
});
