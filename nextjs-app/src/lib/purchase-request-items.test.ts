import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ client: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.failure }));
import { getPurchaseRequestItems } from "./purchase-requests";

const items = Array.from({ length: 1251 }, (_, index) => ({
  id: `TEST-item-${String(index).padStart(5, "0")}`, purchase_request_id: "TEST-PR", consumable_id: index === 0 ? "TEST-consumable" : null,
  description: `TEST item ${index}`, requested_quantity: 2, received_quantity: 0,
  suggested_quantity: null, notes: null,
  consumable: index === 0 ? { name: "TEST consumable", unit: "piece", quantity_on_hand: 25, reorder_level: 2 } : null,
}));
type Failure = "base-final" | "foreign-parent" | "invalid-quantity" | "join-array" | "invalid-join" | "finance-final" | "missing" | "extra" | "duplicate" | "invalid-value" | "abort-base" | "abort-finance" | null;

describe("complete purchase request items through the installed Data API client", () => {
  let reads: { path: string; params: URLSearchParams; body: unknown; signal?: AbortSignal | null; authorization: string | null; prefer: string | null }[];
  let failure: Failure;
  let controller: AbortController;

  beforeEach(() => {
    reads = []; failure = null; controller = new AbortController();
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      reads.push({ path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : null,
        signal: init?.signal, authorization: headers.get("authorization"), prefer: headers.get("prefer") });
      const from = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit"));
      const financial = url.pathname.endsWith("purchase_request_items_financial");
      if ((failure === "base-final" && !financial || failure === "finance-final" && financial) && from === 1000) {
        return new Response(JSON.stringify({ code: "TEST", message: "TEST final source page failed" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      if (failure === "abort-base" && !financial || failure === "abort-finance" && financial) controller.abort();
      let source: unknown[] = items;
      if (!financial && (failure === "foreign-parent" || failure === "invalid-quantity")) {
        source = [...items];
        source[source.length - 1] = { ...items.at(-1), ...(failure === "foreign-parent" ? { purchase_request_id: "TEST-other-PR" } : { requested_quantity: null }) };
      }
      if (!financial && (failure === "join-array" || failure === "invalid-join")) {
        source = [...items];
        source[source.length - 1] = { ...items.at(-1), consumable: failure === "join-array"
          ? [items[0].consumable] : { ...items[0].consumable, quantity_on_hand: "25" } };
      }
      if (financial) {
        source = items.map((item, index) => ({ id: item.id, unit_cost: index === 0 ? 0 : index === 1 ? null : 2 }));
        if (failure === "missing") source = source.slice(0, -1);
        if (failure === "extra") source[source.length - 1] = { id: "TEST-other-PR-item", unit_cost: 2 };
        if (failure === "duplicate") source[source.length - 1] = source[0];
        if (failure === "invalid-value") source[source.length - 1] = { id: items.at(-1)!.id };
      }
      const page = source.slice(from, from + limit);
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json",
        "content-range": `${from}-${from + page.length - 1}/${source.length}` } });
    };
    mocks.client.mockReturnValue(createSupabaseClient("http://localhost:65421", "TEST-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport, headers: { Authorization: "Bearer TEST-visitor" } },
    }));
  });

  it("pages all1251 operational and financial rows with stable ordering, the same visitor and zero/NULL preserved", async () => {
    const result = await getPurchaseRequestItems("TEST-PR", true, { signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(1251);
    expect(result.rows.map(row => row.id)).toEqual(items.map(row => row.id));
    expect(result.rows[0].consumable).toEqual(items[0].consumable);
    expect(result.rows[1].consumable).toBeNull();
    expect(result.rows[0].unit_cost).toBe(0); expect(result.rows[1].unit_cost).toBeNull();
    expect(result.rows.at(-1)?.unit_cost).toBe(2);
    const base = reads.filter(read => read.path.endsWith("/purchase_request_items"));
    const financial = reads.filter(read => read.path.endsWith("/purchase_request_items_financial"));
    for (const pages of [base, financial]) {
      expect(pages.map(read => read.params.get("offset"))).toEqual(["0", "500", "1000"]);
      expect(pages[0].prefer).toContain("count=exact");
      expect(pages.slice(1).every(read => !read.prefer?.includes("count=exact"))).toBe(true);
    }
    expect(base.every(read => read.params.get("order") === "created_at.asc,id.asc" && read.params.get("purchase_request_id") === "eq.TEST-PR")).toBe(true);
    expect(financial.every(read => read.params.get("order") === "id.asc" && JSON.stringify(read.body) === JSON.stringify({ p_pr_ids: ["TEST-PR"] }))).toBe(true);
    expect(reads.every(read => read.signal === controller.signal && read.authorization === "Bearer TEST-visitor")).toBe(true);
  });

  it("keeps NOFIN rows complete without selecting or requesting any financial amount", async () => {
    const result = await getPurchaseRequestItems("TEST-PR", false);
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(1251);
    expect(result.rows.every(row => !("unit_cost" in row))).toBe(true);
    expect(reads).toHaveLength(3);
    expect(reads.every(read => !/financial|unit_cost/.test(read.path + read.params.get("select")))).toBe(true);
  });

  it.each(["base-final", "foreign-parent", "invalid-quantity", "join-array", "invalid-join", "finance-final", "missing", "extra", "duplicate", "invalid-value"] as const)("returns no partial rows when %s fails", async (stage) => {
    failure = stage;
    const result = await getPurchaseRequestItems("TEST-PR", true);
    expect(result.rows).toEqual([]); expect(result.error).toEqual(expect.any(String)); expect(result.error).not.toBe("");
    if (stage === "base-final" || stage === "finance-final") expect(result.error).toBe("TEST final source page failed");
    if (stage === "base-final") expect(reads.every(read => !read.path.includes("financial"))).toBe(true);
  });

  it.each(["abort-base", "abort-finance"] as const)("propagates %s cancellation before any later source wave", async (stage) => {
    failure = stage;
    expect(await getPurchaseRequestItems("TEST-PR", true, { signal: controller.signal })).toEqual({ rows: [], error: "read_aborted" });
    expect(reads.filter(read => read.path.includes("financial"))).toHaveLength(stage === "abort-finance" ? 1 : 0);
  });

  it("does not send any read for a pre-aborted caller", async () => {
    controller.abort();
    expect(await getPurchaseRequestItems("TEST-PR", true, { signal: controller.signal })).toEqual({ rows: [], error: "read_aborted" });
    expect(reads).toEqual([]);
  });
});
