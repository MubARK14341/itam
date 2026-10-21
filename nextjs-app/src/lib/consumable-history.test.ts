import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.failure }));
import { getConsumableHistory } from "./queries";

const history = Array.from({ length: 1251 }, (_, index) => ({
  id: `TEST-${String(1250 - index).padStart(5, "0")}`, txn_type: index % 2 ? "out" : "in",
  quantity: 1, previous_quantity: 2, balance_after: 3, reason: `TEST movement ${index}`,
  created_at: "2026-10-09T00:00:00.000Z", performed_by: `TEST-actor-${index}`,
  supplier: null, employee: null, department: null, location: null,
}));

describe("complete consumable ledger through the installed Data API client", () => {
  let reads: { path: string; url: URL; ids: string[]; signal?: AbortSignal | null; authorization: string | null }[];
  let failure: "base-final" | "financial-final" | "labels-final" | "abort" | null;
  let labelResponse: "full" | "empty" | "null";
  let controller: AbortController;

  beforeEach(() => {
    reads = []; failure = null; labelResponse = "full"; controller = new AbortController();
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const ids = init?.body ? (JSON.parse(String(init.body)) as { p_ids: string[] }).p_ids : [];
      reads.push({ path: url.pathname, url, ids, signal: init?.signal, authorization: new Headers(init?.headers).get("authorization") });
      const response = (data: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });
      const rejected = (message: string) => new Response(JSON.stringify({ message, code: "TEST", details: null, hint: null }), { status: 400, headers: { "content-type": "application/json" } });
      if (url.pathname === "/rest/v1/consumable_transactions") {
        const from = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit"));
        if (failure === "base-final" && from === 1000) return rejected("TEST final ledger page failed");
        if (failure === "abort") controller.abort();
        const rows = history.slice(from, from + limit);
        return response(rows, { "content-range": `${from}-${from + rows.length - 1}/${history.length}` });
      }
      if (url.pathname === "/rest/v1/rpc/consumable_txn_financial_detail") {
        return response(ids.filter(id => failure !== "financial-final" || id !== history.at(-1)!.id).map(id => ({
          id, unit_cost: id === history[0].id ? 0 : null, total_cost: id === history[0].id ? 0 : null,
          invoice_number: null, invoice_date: null,
        })));
      }
      if (url.pathname === "/rest/v1/rpc/user_labels") {
        if (failure === "labels-final" && ids.includes(history.at(-1)!.performed_by)) return rejected("TEST final actor labels failed");
        return response(labelResponse === "empty" ? [] : ids.map(id => ({ id, label: labelResponse === "null" ? null : `TEST label ${id}` })));
      }
      throw new Error("Unexpected TEST ledger request");
    };
    mocks.createClient.mockReturnValue(createSupabaseClient("http://localhost:65421", "TEST-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport, headers: { Authorization: "Bearer TEST-visitor" } },
    }));
  });

  it("reads every row beyond1000 with tied timestamps, bounded label batches and the caller's identity/signal", async () => {
    const result = await getConsumableHistory("TEST-consumable", true, { signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(1251);
    expect(result.rows.map(row => row.id)).toEqual(history.map(row => row.id));
    expect(result.rows[0]).toMatchObject({ unit_cost: 0, total_cost: 0 });
    expect(result.rows[1]).toMatchObject({ unit_cost: null, total_cost: null });
    expect(result.rows.at(-1)?.actor).toBe(`TEST label ${history.at(-1)!.performed_by}`);
    const pages = reads.filter(read => read.path === "/rest/v1/consumable_transactions");
    expect(pages.map(read => read.url.searchParams.get("offset"))).toEqual(["0", "500", "1000"]);
    expect(pages.every(read => read.url.searchParams.get("order") === "created_at.desc,id.desc")).toBe(true);
    expect(pages.every(read => read.url.searchParams.get("consumable_id") === "eq.TEST-consumable")).toBe(true);
    expect(reads.filter(read => read.path.endsWith("user_labels")).map(read => read.ids.length)).toEqual([500, 500, 251]);
    expect(reads.every(read => read.signal === controller.signal && read.authorization === "Bearer TEST-visitor")).toBe(true);
  });

  it("does not select or request any financial column for NOFIN", async () => {
    const result = await getConsumableHistory("TEST-consumable", false);
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(1251);
    expect(result.rows[0]).not.toHaveProperty("unit_cost");
    expect(reads.some(read => read.path.includes("financial"))).toBe(false);
    expect(reads.filter(read => read.path.endsWith("consumable_transactions")).every(read =>
      !/unit_cost|total_cost|invoice/.test(read.url.searchParams.get("select") ?? ""))).toBe(true);
  });

  it.each(["empty", "null"] as const)("accepts %s actor labels for a NOFIN caller without losing ledger completeness", async (labels) => {
    labelResponse = labels;
    const result = await getConsumableHistory("TEST-consumable", false);
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(1251);
    expect(result.rows.every(row => row.actor === null)).toBe(true);
    expect(reads.some(read => read.path.includes("financial"))).toBe(false);
  });

  it.each(["base-final", "financial-final", "labels-final"] as const)("discards every row when %s fails", async (stage) => {
    failure = stage;
    const result = await getConsumableHistory("TEST-consumable", true);
    expect(result.rows).toEqual([]);
    expect(result.error).toBe(stage === "base-final" ? "TEST final ledger page failed"
      : stage === "financial-final" ? "financial_projection_incomplete" : "TEST final actor labels failed");
  });

  it("stops before all work when already aborted", async () => {
    controller.abort();
    expect(await getConsumableHistory("TEST-consumable", true, { signal: controller.signal })).toEqual({ rows: [], error: "read_aborted" });
    expect(reads).toEqual([]);
  });

  it("cancels after the first page without starting any following page or financial read", async () => {
    failure = "abort";
    expect(await getConsumableHistory("TEST-consumable", true, { signal: controller.signal })).toEqual({ rows: [], error: "read_aborted" });
    expect(reads).toHaveLength(1);
  });
});
