import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
import { listConsumablesPage } from "./queries";
import { buildUnifiedRows, unifiedLocationFallback } from "@/components/assets/unified-inventory-table";
import { quickViewFromUnified } from "@/components/assets/inventory-quick-view";
import type { ConsumableRow, LocationRow } from "./types";

const location = { name: "TEST office", name_ar: "TEST مكتب", code: "TEST-ROOM" };
function consumable(overrides: Partial<ConsumableRow> = {}): ConsumableRow {
  return { id: "TEST-consumable", name: "TEST supplies", sku: "TEST-LOC", brand: null, unit: "piece",
    quantity_on_hand: 6, reorder_level: 2, category_id: "TEST-category", company_id: "TEST-company",
    location_id: "TEST-location", category: { name: "TEST category", name_ar: null }, company: { name: "TEST company" },
    location, ...overrides };
}
const staleLocation: LocationRow = { id: "TEST-location", name: "TEST stale", name_ar: null, code: "TEST-STALE" };

describe("operational consumable location mini through the installed SDK", () => {
  let payload: unknown, status: number, calls: { path: string; select: string | null; limit: string | null; signal: AbortSignal | null | undefined }[];
  let controller: AbortController;
  beforeEach(() => {
    calls = []; payload = [consumable()]; status = 200; controller = new AbortController();
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ path: url.pathname, select: url.searchParams.get("select"), limit: url.searchParams.get("limit"), signal: init?.signal });
      expect(url.pathname).toBe("/rest/v1/consumables");
      expect(url.searchParams.get("select")).toContain("location:location_id(name,name_ar,code)");
      expect(url.searchParams.get("select")).not.toMatch(/unit_cost|total_cost|invoice/);
      expect(url.searchParams.get("order")).toBe("name.asc,id.asc");
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json",
        ...(status === 200 ? { "content-range": Array.isArray(payload) && payload.length ? `0-${payload.length - 1}/${payload.length}` : "*/0" } : {}) } });
    };
    mocks.client.mockReturnValue(createSdkClient("http://localhost:65421", "TEST-public-placeholder", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport, headers: { Authorization: "Bearer TEST-visitor" } },
    }));
  });
  it.each([location, { ...location, name_ar: null }])("keeps an RLS-returned location mini without reference rows: %j", async mini => {
    payload = [consumable({ location: mini })];
    const page = await listConsumablesPage({ includeFinancial: false, signal: controller.signal });
    expect(page.error).toBeNull(); expect(page.rows[0].location).toEqual(mini);
    expect(buildUnifiedRows([], page.rows, [])[0].location).toBe(mini.name_ar ?? mini.name);
    expect(calls).toHaveLength(1);
  });
  it.each([undefined, [], {}, { name: 1, name_ar: null, code: null },
    { name: "TEST", name_ar: 1, code: null }, { name: "TEST", name_ar: null, code: 1 },
    { name: "TEST", code: null }])("rejects a malformed joined mini instead of exporting a partial label: %j", async mini => {
    payload = [{ ...consumable(), location: mini }];
    expect(await listConsumablesPage({ includeFinancial: false, signal: controller.signal }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "consumable_inventory_location_invalid" });
    expect(calls).toHaveLength(1);
  });
  it("rejects HTTP200 JSONnull collection body", async () => {
    payload = null;
    const page = await listConsumablesPage({ includeFinancial: false, signal: controller.signal });
    expect(page.rows).toEqual([]); expect(page.error).toBe("consumable_inventory_location_invalid");
    expect(calls).toHaveLength(1);
  });
  it("preserves genuine empty collection success", async () => {
    payload = [];
    expect(await listConsumablesPage({ includeFinancial: false, signal: controller.signal }))
      .toEqual({ rows: [], nextCursor: null, total: 0, error: null });
  });
  it("keeps the existing cursor, count and limit while the joined mini survives", async () => {
    payload = [consumable(), consumable({ id: "TEST-next", name: "TEST z-next" })];
    const page = await listConsumablesPage({ pageSize: 1, includeFinancial: false, signal: controller.signal });
    expect(page.error).toBeNull(); expect(page.total).toBe(2); expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toEqual({ value: "TEST supplies", id: "TEST-consumable" });
    expect(calls[0].limit).toBe("2"); expect(page.rows[0].location).toEqual(location);
  });
  it("keeps a denied source error instead of producing fallback labels", async () => {
    status = 403; payload = { message: "TEST denied", code: "42501" };
    expect(await listConsumablesPage({ includeFinancial: false, signal: controller.signal }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "TEST denied" });
  });
});

describe("joined and legacy consumable location presentation", () => {
  const cases: { name: string; row: ConsumableRow; refs: LocationRow[]; label: string }[] = [
    { name: "Arabic preference is independent of stale references", row: consumable(), refs: [staleLocation], label: "TEST مكتب" },
    { name: "English fallback works before any options arrive", row: consumable({ location: { ...location, name_ar: null } }), refs: [], label: "TEST office" },
    { name: "RLS NULL cannot be replaced by an old reference label", row: consumable({ location: null }), refs: [staleLocation], label: "—" },
    { name: "BR1 hidden code stays hidden with unrelated names", row: consumable({ location: { ...location, code: "BR1" } }), refs: [staleLocation], label: "—" },
    { name: "hidden branch-name policy stays hidden", row: consumable({ location: { ...location, name: "Branch 2", name_ar: null } }), refs: [], label: "—" },
    { name: "legacy absent mini keeps its reference fallback", row: consumable({ location: undefined }), refs: [staleLocation], label: "TEST stale" },
    { name: "legacy absent mini without references keeps placeholder", row: consumable({ location: undefined }), refs: [], label: "—" },
  ];
  it.each(cases)("$name", ({ row, refs, label }) => {
    const unified = buildUnifiedRows([], [row], refs)[0];
    expect(unified.location).toBe(label); expect(quickViewFromUnified(unified).location).toBe(label);
    expect(unified.holderOrQty).toBe("6 piece"); expect(unified.location_id).toBe(row.location_id);
  });
});


describe("inventory location reference invalidation", () => {
  it("keeps joined location rows independent of asynchronously refreshed filter options", () => {
    const rows = [consumable(), consumable({ location: null })];
    const before = unifiedLocationFallback(rows, []);
    const after = unifiedLocationFallback(rows, [staleLocation]);
    expect(after).toBe(before);
    expect(buildUnifiedRows([], rows, after).map(row => row.location)).toEqual([location.name_ar, "—"]);
  });
  it("keeps genuine unjoined rows responsive to loaded and updated location references", () => {
    const rows = [consumable({ location: undefined })];
    const first = [staleLocation];
    const updated = [{ ...staleLocation, name: "TEST changed" }];
    expect(unifiedLocationFallback(rows, first)).toBe(first);
    expect(unifiedLocationFallback(rows, updated)).toBe(updated);
    expect(buildUnifiedRows([], rows, first)[0].location).toBe("TEST stale");
    expect(buildUnifiedRows([], rows, updated)[0].location).toBe("TEST changed");
  });
});
