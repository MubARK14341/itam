import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ client: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.failure }));
import { listRequestsPage } from "./requests";

const parents = [
  { id: "11111111-1111-4111-8111-111111111111", request_number: "TEST-ordinary-bulk", created_at: "2026-10-10T00:00:00Z",
    items: Array.from({ length: 1000 }, () => ({ quantity: 1 })) },
  { id: "22222222-2222-4222-8222-222222222222", request_number: "TEST-ordinary-missing", created_at: "2026-10-09T00:00:00Z", items: [{ quantity: 1 }] },
];
const children = parents.flatMap((parent, index) => Array.from({ length: index === 0 ? 1105 : 1 }, (_, ordinal) => ({
  id: `33333333-3333-4333-8333-${String(index * 2000 + ordinal).padStart(12, "0")}`,
  request_id: parent.id, total_price: index === 1 ? null : ordinal === 0 ? 0 : 2,
})));

describe("ordinary request reads retain the500 contract after report-only1000 opt-in", () => {
  beforeEach(() => { mocks.client.mockReset(); mocks.failure.mockReset(); });
  it.each([false, true])("preserves complete ordinary item counts and unchanged500 pages with financial=%s", async includeFinancial => {
    const calls: { path: string; from: number; limit: number; prefer: string | null; select: string | null }[] = [];
    const controller = new AbortController();
    const transport: typeof fetch = async (input, init) => {
      const address = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(init?.headers);
      const from = Number(address.searchParams.get("offset") ?? 0), limit = Number(address.searchParams.get("limit"));
      calls.push({ path: address.pathname, from, limit, prefer: headers.get("prefer"), select: address.searchParams.get("select") });
      expect(init?.signal).toBe(controller.signal); expect(headers.get("authorization")).toBe("Bearer TEST-visitor");
      let data: unknown[];
      if (address.pathname === "/rest/v1/requests") {
        expect(limit).toBe(3); expect(address.searchParams.get("order")).toBe("created_at.desc,id.desc");
        expect(address.searchParams.get("portal_approval_status")).toBe("not.in.(pending_project_manager,rejected_by_project_manager)");
        data = parents;
      } else if (address.pathname === "/rest/v1/request_items") {
        expect(address.searchParams.get("select")).toBe("id,request_id");
        expect(address.searchParams.get("request_id")).toContain(parents[0].id);
        expect(address.searchParams.get("request_id")).toContain(parents[1].id);
        expect(address.searchParams.get("order")).toBe("id.asc");
        data = children.slice(from, from + limit).map(({ id, request_id }) => ({ id, request_id }));
      } else {
        expect(address.pathname).toBe("/rest/v1/rpc/request_items_financial");
        expect(JSON.parse(String(init?.body))).toEqual({ p_request_ids: parents.map(row => row.id) });
        expect(address.searchParams.get("order")).toBe("id.asc");
        data = children.slice(from, from + limit);
      }
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json",
        ...(address.pathname === "/rest/v1/requests" ? { "content-range": "0-1/2" } : {}) } });
    };
    mocks.client.mockReturnValue(createSdkClient("http://localhost:65421", "TEST-public-placeholder", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport, headers: { Authorization: "Bearer TEST-visitor" } },
    }));
    const result = await listRequestsPage({ pageSize: 2, includeFinancial, strictFinancial: true, signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.total).toBe(2); expect(result.nextCursor).toBeNull();
    expect(result.rows.map(row => row.id)).toEqual(parents.map(row => row.id));
    expect(result.rows[0]).toMatchObject({ item_count: 1105, total_value: includeFinancial ? 2208 : null,
      financial_state: includeFinancial ? "available" : "forbidden" });
    expect(result.rows[1]).toMatchObject({ item_count: 1, total_value: null, financial_state: includeFinancial ? "missing" : "forbidden" });
    expect(calls.filter(call => call.path === "/rest/v1/request_items").map(call => [call.from, call.limit]))
      .toEqual([[0, 500], [500, 500], [1000, 500]]);
    expect(calls.filter(call => call.path.includes("/rpc/")).map(call => [call.from, call.limit]))
      .toEqual(includeFinancial ? [[0, 500], [500, 500], [1000, 500]] : []);
    expect(calls.slice(1).every(call => !call.prefer?.includes("count=exact"))).toBe(true);
  });
});
