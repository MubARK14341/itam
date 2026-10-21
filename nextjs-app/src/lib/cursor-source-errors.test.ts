import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ client: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.failure }));
import { listAssetsPage, listConsumablesPage, listMaintenancePage } from "./queries";
import { listRequestsPage } from "./requests";
import { listActionAlertsPage } from "./action-center";
import { collectCursorPages, type AscTextCursor, type DescTimeCursor, type CursorPage } from "./pagination";

type Resource = "assets" | "consumables" | "maintenance_records" | "requests" | "action_alert_instances";
type Cursor = AscTextCursor | DescTimeCursor;
const resources: Resource[] = ["assets", "consumables", "maintenance_records", "requests", "action_alert_instances"];
const malformed = [
  { name: "actual empty HTTP error body", body: "" },
  { name: "empty message", body: JSON.stringify({ message: "" }) },
  { name: "whitespace message", body: JSON.stringify({ message: " \t\n" }) },
  { name: "array message", body: JSON.stringify({ message: [] }) },
  { name: "object message", body: JSON.stringify({ message: {} }) },
  { name: "NULL message", body: JSON.stringify({ message: null }) },
  { name: "false message", body: JSON.stringify({ message: false }) },
  { name: "zero message", body: JSON.stringify({ message: 0 }) },
  { name: "missing message", body: JSON.stringify({ code: "42501" }) },
];
const representativeLate = [malformed[0], malformed[3]];
const topLevelErrors = [
  { name: "top-level false", body: "false" },
  { name: "top-level zero", body: "0" },
  { name: "top-level empty string", body: '""' },
  { name: "top-level NULL", body: "null" },
];
const shapeFallback = { maintenance_records: "maintenance_inventory_shape_invalid", requests: "request_list_shape_invalid", action_alert_instances: "action_alert_list_shape_invalid" };
const fallback: Record<Resource, string> = { assets: "asset_inventory_read_failed", consumables: "consumable_inventory_read_failed",
  maintenance_records: "maintenance_inventory_read_failed", requests: "request_report_failed", action_alert_instances: "action_alert_list_failed" };
const timestamp = "2026-10-09T08:00:00.000Z";
function source(resource: Resource): Record<string, unknown>[] {
  return Array.from({ length: 5 }, (_, index) => {
    const ordered = resource === "assets" || resource === "consumables" ? index : 4 - index;
    const id = `TEST-${String(ordered).padStart(3, "0")}`;
    if (resource === "assets") return { id, asset_tag: id, qr_token: `TEST-QR-${ordered}`, name: id, serial_number: null, status: "available",
      category_id: "TEST-category", location_id: null, company_id: null, pool_id: null, last_return_condition: null,
      special_attributes: { zero: 0, falseValue: false, nullValue: null }, category: null, model: { brand: null, model_name: "TEST" }, location: null, holder: null, company: null, pool: null };
    if (resource === "consumables") return { id, name: id, brand: null, sku: id, rfid_tag: null, unit: "piece", quantity_on_hand: 0, reorder_level: 0,
      category_id: null, company_id: null, supplier_id: null, location_id: null, notes: null, category: null, company: null, location: null };
    if (resource === "maintenance_records") return { id, reported_at: timestamp, status: "open", type: "repair", currency: null, asset: null, asset_id: null };
    if (resource === "requests") return { id, request_number: id, created_at: timestamp, status: "draft", items: [], customer: null, beneficiary_employee: null };
    return { id, stable_key: id, alert_type: "request_pending", entity_type: "request", entity_id: null, severity: "low", status: "open",
      assigned_to: null, assigned_at: null, first_seen_at: timestamp, last_seen_at: timestamp, auto_resolved_at: null, occurrence_count: 0, last_action_at: null, metadata: null };
  });
}
function asc(cursor: Cursor | null): AscTextCursor | null {
  if (cursor !== null && !("value" in cursor)) throw new Error("Unexpected TEST cursor kind");
  return cursor;
}
function desc(cursor: Cursor | null): DescTimeCursor | null {
  if (cursor !== null && !("at" in cursor)) throw new Error("Unexpected TEST cursor kind");
  return cursor;
}
function readPage(resource: Resource, cursor: Cursor | null = null): Promise<CursorPage<{ id: string }, Cursor>> {
  if (resource === "assets") return listAssetsPage({ cursor: asc(cursor), pageSize: 2 });
  if (resource === "consumables") return listConsumablesPage({ cursor: asc(cursor), pageSize: 2, includeFinancial: false });
  if (resource === "maintenance_records") return listMaintenancePage({ cursor: desc(cursor), pageSize: 2, includeFinancial: false });
  if (resource === "requests") return listRequestsPage({ cursor: desc(cursor), pageSize: 2, includeFinancial: false });
  return listActionAlertsPage({ cursor: desc(cursor), pageSize: 2 });
}
let current: Resource, rows: Record<string, unknown>[], calls: { table: string; start: number; primary: boolean }[];
let failureBody: string | null, failPrimaryAt: number | null, detailFailure: string | null, childFailure: string | null, financialFailure: string | null;
let malformedSuccessBody: string | null, malformedSuccessAt: number | null, detailSuccessBody: string | null;
let childRows: Record<string, unknown>[], childFailureAt: number, childSuccessBody: string | null;
let financialRows: Record<string, unknown>[], financialSuccessBody: string | null;
let accessFailure: string | null, accessData: unknown;
beforeEach(() => {
  calls = []; current = "assets"; rows = source(current); failureBody = null; failPrimaryAt = null; detailFailure = null; childFailure = null; financialFailure = null;
  malformedSuccessBody = null; malformedSuccessAt = null; detailSuccessBody = null;
  childRows = []; childFailureAt = 1; childSuccessBody = null; financialRows = []; financialSuccessBody = null;
  accessFailure = null; accessData = false;
  const transport: typeof fetch = async input => {
    const address = new URL(input instanceof Request ? input.url : String(input));
    const table = address.pathname.replace("/rest/v1/", "");
    const primary = table === current || table === "maintenance_search_index";
    let start = 0;
    const afterTag = address.searchParams.get("asset_tag")?.slice(3);
    const cursorId = /id\.(?:gt|lt)\.(?:")?(TEST-\d+)/.exec(address.searchParams.getAll("or").join(","))?.[1];
    const after = afterTag ?? cursorId;
    if (after) start = rows.findIndex(row => row.id === after) + 1;
    calls.push({ table, start, primary });
    if (calls.length > 32) throw new Error("TEST cursor fixture read overflow");
    const errorResponse = (body: string) => new Response(body, { status: 403, headers: { "content-type": "application/json" } });
    if (table === "request_items") {
      if (childFailure !== null && calls.filter(call => call.table === "request_items").length === childFailureAt) return errorResponse(childFailure);
      const allowed = new Set((address.searchParams.get("request_id") ?? "").match(/TEST-\d+/g) ?? []);
      const scoped = childRows.filter(row => allowed.has(String(row.request_id)));
      const offset = Number(address.searchParams.get("offset") ?? 0), limit = Number(address.searchParams.get("limit") ?? 500);
      return new Response(childSuccessBody ?? JSON.stringify(scoped.slice(offset, offset + limit)), { headers: { "content-type": "application/json" } });
    }
    if (table === "rpc/request_items_financial") {
      if (financialFailure !== null) return errorResponse(financialFailure);
      return new Response(financialSuccessBody ?? JSON.stringify(financialRows), { headers: { "content-type": "application/json" } });
    }
    if (table === "rpc/is_financial_viewer") return accessFailure === null
      ? new Response(JSON.stringify(accessData), { headers: { "content-type": "application/json" } }) : errorResponse(accessFailure);
    if (table === "maintenance_records" && address.searchParams.has("id") && detailFailure !== null) return errorResponse(detailFailure);
    if (table === "maintenance_records" && address.searchParams.has("id") && detailSuccessBody !== null) {
      return new Response(detailSuccessBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (table === "maintenance_records" && address.searchParams.has("id")) {
      const wanted = new Set((address.searchParams.get("id") ?? "").match(/TEST-\d+/g) ?? []);
      return new Response(JSON.stringify(rows.filter(row => wanted.has(String(row.id)))), { headers: { "content-type": "application/json" } });
    }
    expect(primary).toBe(true);
    if (failureBody !== null && calls.filter(call => call.primary).length === failPrimaryAt) return errorResponse(failureBody);
    if (malformedSuccessBody !== null && calls.filter(call => call.primary).length === malformedSuccessAt) {
      return new Response(malformedSuccessBody, { status: 200, headers: { "content-type": "application/json", "content-range": "*/0" } });
    }
    const page = rows.slice(start, start + Number(address.searchParams.get("limit")));
    return new Response(JSON.stringify(page), { status: page.length ? 206 : 200, headers: { "content-type": "application/json",
      "content-range": page.length ? `0-${page.length - 1}/${rows.length}` : "*/0" } });
  };
  mocks.client.mockReturnValue(createSdkClient("http://localhost:65421", "TEST-public-placeholder", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport },
  }));
});

for (const resource of resources) describe(`${resource} cursor source failures through the installed SDK`, () => {
  beforeEach(() => { current = resource; rows = source(resource); });
  it.each(malformed)("normalizes initial403 $name to a nonempty resource error", async failure => {
    failureBody = failure.body; failPrimaryAt = 1;
    expect(await readPage(resource)).toEqual({ rows: [], nextCursor: null, total: null, error: fallback[resource] });
    expect(calls).toHaveLength(1);
  });
  it.each(representativeLate)("discards two genuine pages on late403 $name without refilling", async failure => {
    failureBody = failure.body; failPrimaryAt = 3;
    const result = await collectCursorPages<{ id: string }, Cursor>(cursor => readPage(resource, cursor));
    expect(result).toEqual({ rows: [], error: fallback[resource] });
    expect(calls.filter(call => call.primary).map(call => call.start)).toEqual([0, 2, 4]);
    expect(calls.at(-1)?.primary).toBe(true);
  });
  it("retains an existing nonempty provider message verbatim", async () => {
    failureBody = JSON.stringify({ message: " TEST denied ", code: "42501" }); failPrimaryAt = 1;
    expect((await readPage(resource)).error).toBe(" TEST denied "); expect(calls).toHaveLength(1);
  });
  it("keeps actual successful[]/count0 as an empty success", async () => {
    rows = [];
    expect(await readPage(resource)).toEqual({ rows: [], nextCursor: null, total: 0, error: null });
    expect(calls).toHaveLength(1);
  });
  it("preserves complete ordinary rows, true0/NULL and NOFIN without financial RPCs", async () => {
    const result = await collectCursorPages<{ id: string }, Cursor>(cursor => readPage(resource, cursor));
    expect(result.error).toBeNull(); expect(result.rows.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(calls.some(call => call.table.startsWith("rpc/"))).toBe(false);
    if (resource === "assets") expect(result.rows[0]).toMatchObject({ special_attributes: { zero: 0, falseValue: false, nullValue: null }, serial_number: null });
    if (resource === "consumables") expect(result.rows[0]).toMatchObject({ quantity_on_hand: 0, reorder_level: 0, location: null });
    if (resource === "maintenance_records") expect(result.rows[0]).toMatchObject({ currency: null, asset: null });
    if (resource === "requests") expect(result.rows[0]).toMatchObject({ item_count: 0, total_value: null, financial_state: "forbidden" });
    if (resource === "action_alert_instances") expect(result.rows[0]).toMatchObject({ occurrence_count: 0, metadata: null });
  });
});

describe("remaining cursor error exits", () => {
  it.each(representativeLate)("normalizes maintenance detail403 $name after a genuine search-index page", async failure => {
    current = "maintenance_records"; rows = source(current); detailFailure = failure.body;
    const result = await listMaintenancePage({ pageSize: 2, includeFinancial: false, filters: { q: "TEST" } });
    expect(result).toEqual({ rows: [], nextCursor: null, total: null, error: "maintenance_inventory_read_failed" });
    expect(calls.map(call => call.table)).toEqual(["maintenance_search_index", "maintenance_records"]);
  });
  it.each(representativeLate)("normalizes operational request child403 $name at the list boundary", async failure => {
    current = "requests"; rows = source(current); childFailure = failure.body;
    const result = await listRequestsPage({ pageSize: 2, includeFinancial: false });
    expect(result.rows).toEqual([]); expect(result.nextCursor).toBeNull(); expect(result.total).toBeNull();
    expect(typeof result.error).toBe("string"); expect(result.error?.trim()).not.toBe("");
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items"]);
  });
  it("preserves ordinaryFIN financial-RPC failure tolerance without claiming a full financial value", async () => {
    current = "requests"; rows = source(current); financialFailure = JSON.stringify({ message: [] });
    const result = await listRequestsPage({ pageSize: 2, includeFinancial: true, strictFinancial: false });
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => row.total_value === null && row.financial_state === "missing")).toBe(true);
    expect(calls.map(call => call.table)).toEqual(["requests", "rpc/request_items_financial"]);
  });
});

for (const resource of resources) describe(`${resource} top-level SDK403 failures`, () => {
  beforeEach(() => { current = resource; rows = source(resource); });
  it.each(topLevelErrors)("rejects initial403 $name even when the parsed SDK error is falsy", async failure => {
    failureBody = failure.body; failPrimaryAt = 1;
    expect(await readPage(resource)).toEqual({ rows: [], nextCursor: null, total: null, error: fallback[resource] });
    expect(calls).toHaveLength(1);
  });
  it.each(topLevelErrors)("discards two real pages on late403 $name and stops admission", async failure => {
    failureBody = failure.body; failPrimaryAt = 3;
    const result = await collectCursorPages<{ id: string }, Cursor>(cursor => readPage(resource, cursor));
    expect(result).toEqual({ rows: [], error: fallback[resource] });
    expect(calls.filter(call => call.primary).map(call => call.start)).toEqual([0, 2, 4]);
    expect(calls.at(-1)?.primary).toBe(true);
  });
});

for (const resource of ["maintenance_records", "requests", "action_alert_instances"] as const) describe(`${resource} successful transport with invalid NULL rows`, () => {
  beforeEach(() => { current = resource; rows = source(resource); });
  it("rejects initial HTTP200 JSONnull instead of accepting it as successful[]", async () => {
    malformedSuccessBody = "null"; malformedSuccessAt = 1;
    expect(await readPage(resource)).toEqual({ rows: [], nextCursor: null, total: null, error: shapeFallback[resource] });
    expect(calls).toHaveLength(1);
  });
  it("discards two valid pages on late HTTP200 JSONnull without a refill", async () => {
    malformedSuccessBody = "null"; malformedSuccessAt = 3;
    const result = await collectCursorPages<{ id: string }, Cursor>(cursor => readPage(resource, cursor));
    expect(result).toEqual({ rows: [], error: shapeFallback[resource] });
    expect(calls.filter(call => call.primary).map(call => call.start)).toEqual([0, 2, 4]);
    expect(calls.at(-1)?.primary).toBe(true);
  });
});

describe("maintenance search detail transport boundary", () => {
  it.each(topLevelErrors)("rejects detail403 $name after a valid search-index page", async failure => {
    current = "maintenance_records"; rows = source(current); detailFailure = failure.body;
    expect(await listMaintenancePage({ pageSize: 2, includeFinancial: false, filters: { q: "TEST" } }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "maintenance_inventory_read_failed" });
    expect(calls.map(call => call.table)).toEqual(["maintenance_search_index", "maintenance_records"]);
  });
  it("rejects detail HTTP200 JSONnull without replacing the search page with an empty success", async () => {
    current = "maintenance_records"; rows = source(current); detailSuccessBody = "null";
    expect(await listMaintenancePage({ pageSize: 2, includeFinancial: false, filters: { q: "TEST" } }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "maintenance_inventory_shape_invalid" });
    expect(calls.map(call => call.table)).toEqual(["maintenance_search_index", "maintenance_records"]);
  });
});

describe("ordinary request operational child transport boundary", () => {
  beforeEach(() => { current = "requests"; rows = source(current); });
  it.each(topLevelErrors)("rejects child403 $name before the legacy range collector can accept it", async failure => {
    childFailure = failure.body;
    expect(await listRequestsPage({ pageSize: 2, includeFinancial: false }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_item_counts_failed" });
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items"]);
  });
  it("rejects child HTTP200 JSONnull instead of accepting a zero-item count", async () => {
    childSuccessBody = "null";
    expect(await listRequestsPage({ pageSize: 2, includeFinancial: false }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_item_counts_failed" });
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items"]);
  });
  it.each([topLevelErrors[0], topLevelErrors[3]])("discards a valid500-child page on later403 $name without refilling", async failure => {
    childRows = Array.from({ length: 501 }, (_, index) => ({ id: `TEST-child-${index}`, request_id: "TEST-004" }));
    childFailure = failure.body; childFailureAt = 2;
    expect(await listRequestsPage({ pageSize: 2, includeFinancial: false }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_item_counts_failed" });
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items", "request_items"]);
  });
  it("preserves real per-parent operational counts and NOFIN without a financial read", async () => {
    childRows = [{ id: "TEST-child-1", request_id: "TEST-004" }, { id: "TEST-child-2", request_id: "TEST-004" }, { id: "TEST-child-3", request_id: "TEST-003" }];
    const result = await listRequestsPage({ pageSize: 2, includeFinancial: false });
    expect(result.error).toBeNull(); expect(result.rows.map(row => row.item_count)).toEqual([2, 1]);
    expect(result.rows.every(row => row.total_value === null && row.financial_state === "forbidden")).toBe(true);
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items"]);
  });
});

describe("ordinary request financial transport boundary", () => {
  beforeEach(() => { current = "requests"; rows = source(current); });
  it.each(topLevelErrors)("strictFIN rejects financial403 $name even for zero operational items", async failure => {
    financialFailure = failure.body;
    expect(await listRequestsPage({ pageSize: 2, includeFinancial: true, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_list_financial_projection_failed" });
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items", "rpc/request_items_financial"]);
  });
  it.each(topLevelErrors)("ordinaryFIN retains missing-value tolerance for financial403 $name", async failure => {
    financialFailure = failure.body;
    const result = await listRequestsPage({ pageSize: 2, includeFinancial: true, strictFinancial: false });
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => row.total_value === null && row.financial_state === "missing")).toBe(true);
    expect(calls.map(call => call.table)).toEqual(["requests", "rpc/request_items_financial"]);
  });
  it("strictFIN rejects financial HTTP200 JSONnull despite zero operational rows", async () => {
    financialSuccessBody = "null";
    expect(await listRequestsPage({ pageSize: 2, includeFinancial: true, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_list_financial_projection_failed" });
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items", "rpc/request_items_financial"]);
  });
  it("ordinaryFIN keeps existing missing-value tolerance for financial HTTP200 JSONnull", async () => {
    financialSuccessBody = "null";
    const result = await listRequestsPage({ pageSize: 2, includeFinancial: true, strictFinancial: false });
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => row.total_value === null && row.financial_state === "missing")).toBe(true);
    expect(calls.map(call => call.table)).toEqual(["requests", "rpc/request_items_financial"]);
  });
  it("keeps legitimate financial zero distinct from NULL after full operational reconciliation", async () => {
    childRows = [{ id: "TEST-child-1", request_id: "TEST-004" }, { id: "TEST-child-2", request_id: "TEST-004" }, { id: "TEST-child-3", request_id: "TEST-003" }];
    financialRows = [{ ...childRows[0], total_price: 0 }, { ...childRows[1], total_price: null }, { ...childRows[2], total_price: 0 }];
    const result = await listRequestsPage({ pageSize: 2, includeFinancial: true, strictFinancial: true });
    expect(result.error).toBeNull(); expect(result.rows.map(row => row.item_count)).toEqual([2, 1]);
    expect(result.rows.map(row => [row.total_value, row.financial_state])).toEqual([[null, "missing"], [0, "available"]]);
    expect(calls.map(call => call.table)).toEqual(["requests", "request_items", "rpc/request_items_financial"]);
  });
});

describe("ordinary request financial permission transport boundary", () => {
  beforeEach(() => { current = "requests"; rows = source(current); });
  it.each([topLevelErrors[0], topLevelErrors[3]])("strictFIN rejects permission403 $name rather than treating it as NOFIN", async failure => {
    accessFailure = failure.body;
    expect(await listRequestsPage({ pageSize: 2, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_list_financial_access_failed" });
    expect(calls.map(call => call.table)).toEqual(["requests", "rpc/is_financial_viewer"]);
  });
  it.each([topLevelErrors[0], topLevelErrors[3]])("ordinary permission403 $name retains NOFIN tolerance without financial values", async failure => {
    accessFailure = failure.body;
    const result = await listRequestsPage({ pageSize: 2, strictFinancial: false });
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => row.total_value === null && row.financial_state === "forbidden")).toBe(true);
    expect(calls.map(call => call.table)).toEqual(["requests", "rpc/is_financial_viewer", "request_items"]);
  });
  it("preserves a legitimate successful false permission without any financial projection", async () => {
    accessData = false;
    const result = await listRequestsPage({ pageSize: 2, strictFinancial: true });
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => row.total_value === null && row.financial_state === "forbidden")).toBe(true);
    expect(calls.map(call => call.table)).toEqual(["requests", "rpc/is_financial_viewer", "request_items"]);
  });
});

const malformedMaintenanceCursors = [
  { name: "NULL row", row: null },
  { name: "array row", row: [] },
  { name: "missing id", row: { reported_at: timestamp } },
  { name: "NULL id", row: { id: null, reported_at: timestamp } },
  { name: "numeric id", row: { id: 0, reported_at: timestamp } },
  { name: "missing reported_at", row: { id: "TEST-004" } },
  { name: "NULL reported_at", row: { id: "TEST-004", reported_at: null } },
  { name: "numeric reported_at", row: { id: "TEST-004", reported_at: 0 } },
];
for (const search of [false, true]) describe(`maintenance ${search ? "search-index" : "primary"} cursor fields`, () => {
  beforeEach(() => { current = "maintenance_records"; rows = source(current); });
  it.each(malformedMaintenanceCursors)("rejects initial successful200 $name before creating a cursor", async invalid => {
    malformedSuccessBody = JSON.stringify([invalid.row]); malformedSuccessAt = 1;
    expect(await listMaintenancePage({ pageSize: 2, includeFinancial: false, filters: search ? { q: "TEST" } : {} }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "maintenance_inventory_shape_invalid" });
    expect(calls.map(call => call.table)).toEqual([search ? "maintenance_search_index" : "maintenance_records"]);
  });
  it("discards two genuine pages when a later cursor field is missing and stops reads", async () => {
    malformedSuccessBody = JSON.stringify([{ id: "TEST-000" }]); malformedSuccessAt = search ? 5 : 3;
    const result = await collectCursorPages<{ id: string; reported_at: string }, DescTimeCursor>(cursor => listMaintenancePage({ cursor, pageSize: 2, includeFinancial: false, filters: search ? { q: "TEST" } : {} }));
    expect(result).toEqual({ rows: [], error: "maintenance_inventory_shape_invalid" });
    const primary = calls.filter(call => call.table === (search ? "maintenance_search_index" : "maintenance_records"));
    expect(primary.map(call => call.start)).toEqual([0, 2, 4]);
    expect(calls).toHaveLength(search ? 5 : 3);
  });
});

describe("maintenance search full-row cursor contract", () => {
  beforeEach(() => { current = "maintenance_records"; rows = source(current); });
  it.each(malformedMaintenanceCursors)("rejects successful detail200 $name instead of silently adopting it", async invalid => {
    detailSuccessBody = JSON.stringify([invalid.row]);
    expect(await listMaintenancePage({ pageSize: 2, includeFinancial: false, filters: { q: "TEST" } }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "maintenance_inventory_shape_invalid" });
    expect(calls.map(call => call.table)).toEqual(["maintenance_search_index", "maintenance_records"]);
  });
  it("retains full selected row fields, stable tied-time order and NULLs beyond the structural cursor type", async () => {
    const result = await collectCursorPages<{ id: string; reported_at: string }, DescTimeCursor>(cursor => listMaintenancePage({ cursor, pageSize: 2, includeFinancial: false, filters: { q: "TEST" } }));
    expect(result.error).toBeNull(); expect(result.rows).toEqual(rows);
    expect(result.rows[0]).toMatchObject({ id: "TEST-004", reported_at: timestamp, status: "open", type: "repair", currency: null, asset: null });
    expect(calls.map(call => call.table)).toEqual(["maintenance_search_index", "maintenance_records", "maintenance_search_index", "maintenance_records", "maintenance_search_index", "maintenance_records"]);
  });
});
