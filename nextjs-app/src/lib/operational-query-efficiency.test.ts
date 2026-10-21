import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import { listMaintenancePage } from "./queries";
import { listRequestsPage } from "./requests";

function queryBuilder(result: { data: any[]; error: any; count?: number | null }) {
  const builder: Record<string, any> = {};
  for (const method of ["select", "not", "in", "eq", "is", "ilike", "or", "order", "limit", "returns"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) => (
    Promise.resolve(result).then(resolve, reject)
  );
  return builder;
}

describe("operational query efficiency", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("finds maintenance by visible asset identifiers without loading financial data", async () => {
    const assetId = "11111111-1111-4111-8111-111111111111";
    const reportedAt = "2026-08-16T09:00:00.000Z";
    const searchQuery = queryBuilder({
      data: [{ id: "22222222-2222-4222-8222-222222222222", reported_at: reportedAt }],
      error: null,
      count: 1,
    });
    const maintenanceQuery = queryBuilder({
      data: [{
        id: "22222222-2222-4222-8222-222222222222",
        asset_id: assetId,
        reported_at: reportedAt,
        problem_description: "Battery failure",
      }],
      error: null,
    });
    const rpc = vi.fn();
    const from = vi.fn((table: string) => (
      table === "maintenance_search_index" ? searchQuery : maintenanceQuery
    ));
    supabaseMock.createClient.mockReturnValue({
      from,
      rpc,
    });

    const page = await listMaintenancePage({
      includeFinancial: false,
      filters: { q: "DM26-TAB-0025" },
    });

    expect(page.error).toBeNull();
    expect(page.rows).toHaveLength(1);
    expect(searchQuery.or).toHaveBeenCalledWith(expect.stringContaining("asset_tag.ilike."));
    expect(searchQuery.or).toHaveBeenCalledWith(expect.stringContaining("problem_description.ilike."));
    expect(maintenanceQuery.in).toHaveBeenCalledWith(
      "id",
      ["22222222-2222-4222-8222-222222222222"],
    );
    expect(from).not.toHaveBeenCalledWith("assets");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses PostgREST or-filter grammar for problem-only maintenance search", async () => {
    const searchQuery = queryBuilder({
      data: [{
        id: "55555555-5555-4555-8555-555555555555",
        reported_at: "2026-08-16T09:00:00.000Z",
      }],
      error: null,
      count: 1,
    });
    const maintenanceQuery = queryBuilder({
      data: [{
        id: "55555555-5555-4555-8555-555555555555",
        reported_at: "2026-08-16T09:00:00.000Z",
        problem_description: "Battery, (main) failure",
      }],
      error: null,
      count: 1,
    });
    supabaseMock.createClient.mockReturnValue({
      from: vi.fn((table: string) => (
        table === "maintenance_search_index" ? searchQuery : maintenanceQuery
      )),
      rpc: vi.fn(),
    });

    const page = await listMaintenancePage({
      includeFinancial: false,
      filters: { q: "Battery, (main)" },
    });

    expect(page.error).toBeNull();
    expect(page.rows).toHaveLength(1);
    expect(searchQuery.or).toHaveBeenCalledWith(
      String.raw`problem_description.ilike."%Battery, (main)%",asset_tag.ilike."%Battery, (main)%",asset_name.ilike."%Battery, (main)%",asset_serial_number.ilike."%Battery, (main)%"`,
    );
    expect(searchQuery.ilike).not.toHaveBeenCalled();
  });

  it("paginates beyond 100 maintenance matches instead of truncating asset search", async () => {
    const indexRows = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      reported_at: new Date(Date.UTC(2026, 7, 16, 9, 0, 0, 100 - index)).toISOString(),
    }));
    const searchQuery = queryBuilder({ data: indexRows, error: null, count: 101 });
    const maintenanceQuery = queryBuilder({
      data: indexRows.slice(0, 100).map((row) => ({ ...row, problem_description: "Shared model" })),
      error: null,
    });
    const from = vi.fn((table: string) => (
      table === "maintenance_search_index" ? searchQuery : maintenanceQuery
    ));
    supabaseMock.createClient.mockReturnValue({ from, rpc: vi.fn() });

    const page = await listMaintenancePage({
      pageSize: 100,
      includeFinancial: false,
      filters: { q: "Shared model" },
    });

    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(101);
    expect(page.nextCursor).toEqual({
      at: indexRows[99].reported_at,
      id: indexRows[99].id,
    });
    expect(searchQuery.limit).toHaveBeenCalledWith(101);
    expect(maintenanceQuery.in).toHaveBeenCalledWith(
      "id",
      indexRows.slice(0, 100).map((row) => row.id),
    );
    expect(from).not.toHaveBeenCalledWith("assets");
  });

  it("uses the caller's non-financial context without a capability probe", async () => {
    const requestQuery = queryBuilder({
      data: [{
        id: "33333333-3333-4333-8333-333333333333",
        request_number: "REQ-1",
        created_at: "2026-08-16T09:00:00.000Z",
        items: [{ quantity: 1 }],
      }],
      error: null,
      count: 1,
    });
    const rpc = vi.fn();
    const itemQuery = {
      select: vi.fn(() => itemQuery), in: vi.fn(() => itemQuery), order: vi.fn(() => itemQuery),
      range: vi.fn(async () => ({ data: [{ id: "item-1", request_id: "33333333-3333-4333-8333-333333333333" }], error: null })),
    };
    supabaseMock.createClient.mockReturnValue({
      from: vi.fn((table: string) => table === "request_items" ? itemQuery : requestQuery),
      rpc,
    });

    const page = await listRequestsPage({ includeFinancial: false });

    expect(page.rows[0].financial_state).toBe("forbidden");
    expect(page.rows[0].total_value).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps database authorization authoritative for financial callers", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const requestQuery = queryBuilder({
      data: [{
        id: requestId,
        request_number: "REQ-2",
        created_at: "2026-08-16T09:00:00.000Z",
        items: [{ quantity: 1 }],
      }],
      error: null,
      count: 1,
    });
    const financialQuery = {
      order: vi.fn(() => financialQuery),
      range: vi.fn(async () => ({
        data: [{ id: "item-1", request_id: requestId, total_price: 125 }],
        error: null,
      })),
    };
    const rpc = vi.fn(() => financialQuery);
    supabaseMock.createClient.mockReturnValue({
      from: vi.fn(() => requestQuery),
      rpc,
    });

    const page = await listRequestsPage({ includeFinancial: true });

    expect(page.rows[0]).toMatchObject({
      financial_state: "available",
      total_value: 125,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("request_items_financial", { p_request_ids: [requestId] });
    expect(financialQuery.order).toHaveBeenCalledWith("id");
    expect(financialQuery.range).toHaveBeenCalledWith(0, 499);
  });
});
