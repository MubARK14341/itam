import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), reportFailure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.reportFailure }));

import { listRequestsPage, type RequestListRow } from "./requests";
import { collectCursorPages, type DescTimeCursor } from "./pagination";

type RequestFixture = { id: string; request_number: string; created_at: string; items: { quantity: number }[] };
type QueryResult = { data: RequestFixture[]; error: null; count: number };
type Query = Record<"select" | "not" | "in" | "eq" | "is" | "or" | "order", (...args: unknown[]) => Query>
  & { limit: (size: number) => Promise<QueryResult>; abortSignal: (signal: AbortSignal) => Query };
function request(id = "request-a", itemCount = 1): RequestFixture {
  return { id, request_number: `TEST-${id}`, created_at: "2026-10-09T08:00:00.000Z", items: Array.from({ length: itemCount }, () => ({ quantity: 1 })) };
}
function query(data = [request()]): Query {
  const chain: Query = {
    select: vi.fn(() => chain), not: vi.fn(() => chain), in: vi.fn(() => chain),
    eq: vi.fn(() => chain), is: vi.fn(() => chain), or: vi.fn(() => chain), order: vi.fn(() => chain),
    abortSignal: vi.fn(() => chain),
    limit: vi.fn(async () => ({ data, error: null, count: data.length })),
  };
  return chain;
}
type FinancialRow = { id?: string; request_id: string; total_price?: number | null };
function projection(result: { data: FinancialRow[] | null; error: { message: string } | null }, failFrom?: number) {
  let start = 0, end = 499;
  let parentIds: string[] | null = null;
  const data = result.data?.map((row, index) => ({ id: `item-${String(index).padStart(6, "0")}`, ...row })) ?? null;
  const chain = {
    select: vi.fn(() => chain), in: vi.fn((column: string, ids: string[]) => { if (column === "request_id") parentIds = ids; return chain; }),
    order: vi.fn(() => chain),
    range: vi.fn((from: number, to: number) => { start = from; end = to; return chain; }),
    abortSignal: vi.fn(() => chain),
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(
      failFrom !== undefined && start >= failFrom
        ? { data: null, error: { message: "TEST last financial page failed" } }
        : { data: data?.filter(row => parentIds === null || parentIds.includes(row.request_id)).slice(start, end + 1) ?? null, error: result.error }
    ).then(resolve, reject),
  };
  return chain;
}
function fixture(data = [request()], operationalItems?: FinancialRow[], operationalError: { message: string } | null = null) {
  const requestQuery = query(data), rpc = vi.fn().mockReturnValue(projection({ data: null, error: null }));
  let itemIndex = 0;
  const itemQuery = projection({ data: operationalItems ?? data.flatMap(row => row.items.map(() => ({ id: `item-${String(itemIndex++).padStart(6, "0")}`, request_id: row.id }))), error: operationalError });
  const from = vi.fn((table: string) => table === "request_items" ? itemQuery : requestQuery);
  mocks.createClient.mockReturnValue({ from, rpc });
  return { requestQuery, rpc, itemQuery, from };
}

type OperationalItem = { id: string; request_id: string };
function operationalSdkFixture(options: {
  failLastBatch?: boolean;
  transform?: (parentIds: string[], rows: OperationalItem[], parents: RequestFixture[], all: OperationalItem[]) => OperationalItem[];
  abortDuringRead?: AbortController;
} = {}) {
  const parents = Array.from({ length: 250 }, (_, index) => request(
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, index === 0 ? 1000 : 1,
  ));
  let itemIndex = 0;
  const children: OperationalItem[] = parents.flatMap((parent, index) => Array.from({ length: index === 0 ? 1105 : 1 }, () => ({
    id: `11111111-1111-4111-8111-${String(++itemIndex).padStart(12, "0")}`, request_id: parent.id,
  })));
  const respond = (data: unknown, status = 200, count?: number) => new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Retry-After": "0", ...(count === undefined ? {} : { "Content-Range": `0-${count - 1}/${count}` }) },
  });
  // Real installed SDK builds every URL, while this transport remains entirely
  // in memory. The independent gateway limit rejects the previous 250-ID GET.
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (Buffer.byteLength(`GET ${url.pathname}${url.search} HTTP/1.1\r\n`) > 8192) {
      return respond({ code: "TEST", message: "TEST gateway request URI too large" }, 414);
    }
    if (init?.signal?.aborted) return respond({ code: "TEST", message: "TEST read aborted" }, 503);
    if (url.pathname === "/rest/v1/requests") return respond(parents, 200, parents.length);
    expect(url.pathname).toBe("/rest/v1/request_items");
    expect(url.searchParams.get("select")).toBe("id,request_id");
    expect(url.searchParams.get("order")).toBe("id.asc");
    const ids = url.searchParams.get("request_id")!.slice(4, -1).split(",");
    if (options.failLastBatch && ids.includes(parents[200].id)) {
      return respond({ code: "TEST", message: "TEST final operational batch failed" }, 503);
    }
    const from = Number(url.searchParams.get("offset") ?? 0), size = Number(url.searchParams.get("limit"));
    const rows = children.filter((child) => ids.includes(child.request_id)).slice(from, from + size);
    options.abortDuringRead?.abort();
    return respond(options.transform ? options.transform(ids, rows, parents, children) : rows);
  });
  mocks.createClient.mockReturnValue(createSdkClient("http://127.0.0.1:65421", "TEST-static-public-placeholder", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
  }));
  return { parents, fetcher };
}

describe("request CSV strict financial retrieval", () => {
  beforeEach(() => { mocks.createClient.mockReset(); mocks.reportFailure.mockReset(); });

  it("keeps recorded zero, sums complete values and preserves genuinely missing prices", async () => {
    const { requestQuery, rpc } = fixture([request("zero"), request("complete", 2), request("missing", 2)]);
    rpc.mockReturnValue(projection({ data: [
      { request_id: "zero", total_price: 0 },
      { request_id: "complete", total_price: 12.5 }, { request_id: "complete", total_price: 5 },
      { request_id: "missing", total_price: 9 }, { request_id: "missing", total_price: null },
    ], error: null }));
    const page = await listRequestsPage({ includeFinancial: true, strictFinancial: true });
    expect(page.error).toBeNull();
    expect(page.rows.map(row => ({ id: row.id, total: row.total_value, state: row.financial_state, coverage: row.financial_coverage_pct })))
      .toEqual([{ id: "zero", total: 0, state: "available", coverage: 100 }, { id: "complete", total: 17.5, state: "available", coverage: 100 }, { id: "missing", total: null, state: "missing", coverage: 50 }]);
    expect(rpc).toHaveBeenCalledWith("request_items_financial", { p_request_ids: ["zero", "complete", "missing"] });
    expect(requestQuery.select).toHaveBeenCalledWith(expect.not.stringContaining("total_price"), { count: "exact" });
  });

  it("rejects a failed projection without returning operational rows or a continuation cursor", async () => {
    const { rpc } = fixture([request(), request("request-b")]);
    rpc.mockReturnValue(projection({ data: null, error: { message: "TEST financial read failed" } }));
    expect(await listRequestsPage({ pageSize: 1, includeFinancial: true, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "TEST financial read failed" });
    expect(mocks.reportFailure).toHaveBeenCalledWith("request_list_financial_projection_failed", { message: "TEST financial read failed" });
  });

  it("still rejects a projection error whose provider message is empty", async () => {
    const { rpc } = fixture();
    rpc.mockReturnValue(projection({ data: null, error: { message: "" } }));
    expect(await listRequestsPage({ includeFinancial: true, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_list_financial_projection_failed" });
  });

  it("retains ordinary list tolerance with missing totals after a projection failure", async () => {
    const { rpc } = fixture();
    rpc.mockReturnValue(projection({ data: null, error: { message: "TEST financial read failed" } }));
    const page = await listRequestsPage({ includeFinancial: true });
    expect(page.error).toBeNull(); expect(page.total).toBe(1); expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ id: "request-a", item_count: 1, total_value: null, financial_state: "missing", financial_used_records: 0 });
  });

  it("rejects an unsuccessful financial access probe before requesting amounts", async () => {
    const { rpc } = fixture();
    rpc.mockResolvedValue({ data: null, error: { message: "TEST access probe failed" } });
    expect(await listRequestsPage({ strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "TEST access probe failed" });
    expect(rpc.mock.calls).toEqual([["is_financial_viewer"]]);
  });

  it("retains ordinary list tolerance and forbidden totals after an access probe failure", async () => {
    const { rpc } = fixture();
    rpc.mockResolvedValue({ data: null, error: { message: "TEST access probe failed" } });
    const page = await listRequestsPage();
    expect(page.error).toBeNull(); expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ total_value: null, financial_state: "forbidden", financial_used_records: 0 });
    expect(rpc.mock.calls).toEqual([["is_financial_viewer"]]);
  });

  it("never fetches financial data for an explicit nonfinancial caller even in strict mode", async () => {
    const { rpc } = fixture();
    const page = await listRequestsPage({ includeFinancial: false, strictFinancial: true });
    expect(page.error).toBeNull(); expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ total_value: null, financial_state: "forbidden", financial_coverage_pct: 0, financial_used_records: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("counts all operational items when the parent embed ends at 1000, without selecting prices", async () => {
    const children = Array.from({ length: 1251 }, (_, index) => ({ id: `item-${index}`, request_id: "bulk" }));
    const { rpc, itemQuery } = fixture([request("bulk", 1000)], children);
    const page = await listRequestsPage({ includeFinancial: false, strictFinancial: true });
    expect(page.error).toBeNull();
    expect(page.rows[0]).toMatchObject({ item_count: 1251, financial_excluded_records: 1251, total_value: null });
    expect(itemQuery.select).toHaveBeenCalledWith("id,request_id");
    expect(itemQuery.order).toHaveBeenCalledWith("id");
    expect(itemQuery.range.mock.calls).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("blocks a nonfinancial export when its operational item count cannot be read", async () => {
    fixture([request()], undefined, { message: "" });
    expect(await listRequestsPage({ includeFinancial: false, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_item_counts_failed" });
  });

  it("uses valid SDK request lines for 250 UUID parents while counting every child of a 1105-item request", async () => {
    const { parents, fetcher } = operationalSdkFixture();
    const page = await listRequestsPage({ pageSize: 250, includeFinancial: false, strictFinancial: true });
    expect(page.error).toBeNull();
    expect(page.rows).toHaveLength(250);
    expect(page.rows[0]).toMatchObject({ id: parents[0].id, item_count: 1105, financial_excluded_records: 1105, total_value: null });
    expect(page.rows.slice(1).every((row) => row.item_count === 1 && row.financial_state === "forbidden")).toBe(true);
    const urls = fetcher.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)));
    expect(urls.every((url) => Buffer.byteLength(`GET ${url.pathname}${url.search} HTTP/1.1\r\n`) < 8192)).toBe(true);
    expect(urls.filter((url) => url.pathname === "/rest/v1/request_items" && url.searchParams.get("offset") === "1000")).toHaveLength(1);
    expect(urls.some((url) => url.pathname.includes("/rpc/"))).toBe(false);
  });

  it("discards every parent and earlier child batch when the final parent batch fails", async () => {
    operationalSdkFixture({ failLastBatch: true });
    expect(await listRequestsPage({ pageSize: 250, includeFinancial: false, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "TEST final operational batch failed" });
  });

  it.each(["duplicate", "foreign_parent", "below_embed"] as const)("rejects a %s operational batch even when other batches are complete", async (kind) => {
    operationalSdkFixture({ transform: (ids, rows, parents, all) => {
      if (!ids.includes(parents[100].id)) return rows;
      if (kind === "duplicate") return rows.map((row, index) => index === 0 ? { ...row, id: all[0].id } : row);
      if (kind === "foreign_parent") return rows.map((row, index) => index === 0 ? { ...row, request_id: parents[0].id } : row);
      return rows.slice(1);
    } });
    expect(await listRequestsPage({ pageSize: 250, includeFinancial: false, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "request_item_counts_incomplete" });
  });

  it("discards operational batches when cancelled during their reads", async () => {
    const controller = new AbortController();
    const { fetcher } = operationalSdkFixture({ abortDuringRead: controller });
    expect(await listRequestsPage({ pageSize: 250, includeFinancial: false, strictFinancial: true, signal: controller.signal }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "read_aborted" });
    expect(fetcher.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
  });

  it("does not fabricate amounts when the database returns no authorized financial rows", async () => {
    const { rpc } = fixture();
    rpc.mockReturnValue(projection({ data: [], error: null }));
    const page = await listRequestsPage({ includeFinancial: true, strictFinancial: true });
    expect(page.error).toBe("financial_projection_incomplete"); expect(page.rows).toEqual([]);
    expect(rpc.mock.calls).toEqual([["request_items_financial", { p_request_ids: ["request-a"] }]]);
  });

  it("discards the first successful export page if the next financial projection fails", async () => {
    const first = query([request(), request("request-b")]), second = query([request("request-b")]);
    let requestPage = 0;
    const from = vi.fn((table: string) => table === "request_items"
      ? projection({ data: [{ id: `item-${requestPage}`, request_id: requestPage === 1 ? "request-a" : "request-b" }], error: null })
      : ++requestPage === 1 ? first : second);
    const rpc = vi.fn().mockReturnValueOnce(projection({ data: [{ id: "item-1", request_id: "request-a", total_price: 10 }], error: null }))
      .mockReturnValueOnce(projection({ data: null, error: { message: "TEST second financial page failed" } }));
    mocks.createClient.mockReturnValue({ from, rpc });
    const result = await collectCursorPages<RequestListRow, DescTimeCursor>(cursor => listRequestsPage({ cursor, pageSize: 1, includeFinancial: true, strictFinancial: true }));
    expect(result).toEqual({ rows: [], error: "TEST second financial page failed" });
    expect(rpc.mock.calls).toEqual([["request_items_financial", { p_request_ids: ["request-a"] }], ["request_items_financial", { p_request_ids: ["request-b"] }]]);
    expect(second.or).toHaveBeenCalledWith(expect.stringContaining("id.lt.request-a"));
  });

  it("reads every financial item of one large request beyond the embedded-item limit", async () => {
    const { rpc } = fixture([request("large", 1000)], Array.from({ length: 1251 }, (_, index) => ({ id: `item-${String(index).padStart(6, "0")}`, request_id: "large" })));
    const financialQuery = projection({
      data: Array.from({ length: 1251 }, (_, index) => ({ request_id: "large", total_price: index === 0 ? 0 : 2 })),
      error: null,
    });
    rpc.mockReturnValue(financialQuery);
    const page = await listRequestsPage({ includeFinancial: true, strictFinancial: true });
    expect(page.error).toBeNull();
    expect(page.rows[0]).toMatchObject({ item_count: 1251, total_value: 2500, financial_state: "available", financial_used_records: 1251, financial_coverage_pct: 100 });
    expect(financialQuery.range.mock.calls).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(financialQuery.order).toHaveBeenCalledTimes(3);
  });

  it("rejects an export when its third financial page fails", async () => {
    const { rpc } = fixture([request("large", 1000)]);
    rpc.mockReturnValue(projection({
      data: Array.from({ length: 1251 }, () => ({ request_id: "large", total_price: 2 })), error: null,
    }, 1000));
    expect(await listRequestsPage({ includeFinancial: true, strictFinancial: true }))
      .toEqual({ rows: [], nextCursor: null, total: null, error: "TEST last financial page failed" });
  });

  it("rejects financial rows omitted beyond the truncated parent embed", async () => {
    const { rpc } = fixture([request("large", 1000)], Array.from({ length: 1251 }, (_, index) => ({ id: `item-${String(index).padStart(6, "0")}`, request_id: "large" })));
    rpc.mockReturnValue(projection({ data: Array.from({ length: 1250 }, () => ({ request_id: "large", total_price: 2 })), error: null }));
    expect((await listRequestsPage({ includeFinancial: true, strictFinancial: true })).error).toBe("financial_projection_incomplete");
  });

  it("rejects duplicated financial items instead of overstating the CSV amount", async () => {
    const { rpc } = fixture([request("duplicate", 2)], [{ id: "same", request_id: "duplicate" }, { id: "different", request_id: "duplicate" }]);
    rpc.mockReturnValue(projection({ data: [
      { id: "same", request_id: "duplicate", total_price: 5 },
      { id: "same", request_id: "duplicate", total_price: 5 },
    ], error: null }));
    expect((await listRequestsPage({ includeFinancial: true, strictFinancial: true })).error).toBe("financial_projection_incomplete");
  });

  it("distinguishes an omitted financial item from a returned item with missing price", async () => {
    const { rpc } = fixture([request("partial", 2)]);
    rpc.mockReturnValue(projection({ data: [{ request_id: "partial", total_price: 5 }], error: null }));
    expect((await listRequestsPage({ includeFinancial: true, strictFinancial: true })).error).toBe("financial_projection_incomplete");
    rpc.mockReturnValue(projection({ data: [{ request_id: "partial", total_price: 5 }, { request_id: "partial", total_price: null }], error: null }));
    const missing = await listRequestsPage({ includeFinancial: true, strictFinancial: true });
    expect(missing.error).toBeNull();
    expect(missing.rows[0]).toMatchObject({ total_value: null, financial_state: "missing", financial_used_records: 1 });
  });
});
