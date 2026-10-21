import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ client: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.failure }));
import { getRequestsReport } from "./requests";

const parents = Array.from({ length: 5501 }, (_, index) => ({
  id: `22222222-2222-4222-8222-${String(5501 - index).padStart(12, "0")}`,
  request_number: `TEST-report-${index}`, created_at: "2026-10-09T08:00:00.000Z",
  portal_approval_status: "not_required", beneficiary_type: "customer", request_source: "internal",
  items: Array.from({ length: index === 0 ? 1000 : 1 }, () => ({ quantity: 1 })),
}));
const children = parents.flatMap((parent, parentIndex) => Array.from({ length: parentIndex === 0 ? 1105 : 1 }, (_, itemIndex) => ({
  id: `33333333-3333-4333-8333-${String(parentIndex * 2000 + itemIndex).padStart(12, "0")}`,
  request_id: parent.id,
  total_price: parentIndex === 1 ? null : parentIndex === 2 || itemIndex === 0 && parentIndex === 0 ? 0 : 2,
})));
const excludedParents = ["pending_project_manager", "rejected_by_project_manager"].map((status, index) => ({
  ...parents[0], id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
  request_number: `TEST-excluded-${index}`, portal_approval_status: status, items: [{ quantity: 1 }],
}));
const excludedChildren = excludedParents.map((parent, index) => ({
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`, request_id: parent.id, total_price: 2,
}));
type Failure = "base-final" | "child-final" | "child-short" | "finance-final" | "finance-short" | "finance-missing"
  | "finance-duplicate" | "finance-foreign" | "finance-swapped-id" | "finance-reparented"
  | "finance-empty" | "finance-string-zero" | "finance-undefined" | "finance-invalid" | "finance-nonfinite"
  | "abort-base" | "abort-child" | "abort-finance" | null;
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
type ChildRead = { from: number; size: number };
type ReportStage = "parent" | "child" | "financial";
type ReportRead = ChildRead & { stage: ReportStage; source: unknown[]; countExact: boolean };

describe("bounded complete report pipeline through the installed Data API client", () => {
  let reads: { path: string; params: URLSearchParams; body: unknown; prefer: string | null; signal?: AbortSignal | null; authorization: string | null; basePagesCompleted: number }[];
  let failure: Failure, controller: AbortController, maxPending: number;
  let childGate: ((read: ChildRead) => Promise<Response | undefined>) | undefined;
  let reportGate: ((read: ReportRead) => Promise<Response | undefined>) | undefined;
  let parentRows: typeof parents, itemRows: typeof children;

  beforeEach(() => {
    reads = []; failure = null; controller = new AbortController(); maxPending = 0; childGate = undefined; reportGate = undefined;
    parentRows = [...parents, ...excludedParents]; itemRows = [...children, ...excludedChildren];
    let pending = 0, basePagesCompleted = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      reads.push({ path: url.pathname, params: url.searchParams, body, prefer: headers.get("prefer"),
        signal: init?.signal, authorization: headers.get("authorization"), basePagesCompleted });
      pending++; maxPending = Math.max(maxPending, pending);
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        const from = Number(url.searchParams.get("offset") ?? 0), size = Number(url.searchParams.get("limit"));
        const parent = url.pathname.endsWith("/requests"), financial = url.pathname.endsWith("/request_items_financial");
        const fail = (message: string) => new Response(JSON.stringify({ code: "TEST", message }), {
          status: 400, headers: { "content-type": "application/json" },
        });
        if (Buffer.byteLength(`GET ${url.pathname}${url.search} HTTP/1.1\r\n`) > 8192) return fail("TEST oversized request line");
        if (failure === "abort-base" && parent || failure === "abort-child" && !parent && !financial
          || failure === "abort-finance" && financial) controller.abort();
        let source: unknown[];
        if (parent) {
          expect(url.searchParams.get("order")).toBe("created_at.desc,id.desc");
          expect(url.searchParams.get("portal_approval_status")).toBe("not.in.(pending_project_manager,rejected_by_project_manager)");
          expect(url.searchParams.get("select")).not.toMatch(/total_price|unit_price/);
          if (failure === "base-final" && from === 5000) return fail("TEST final parent page failed");
          source = parentRows.filter(row => !["pending_project_manager", "rejected_by_project_manager"].includes(row.portal_approval_status));
          basePagesCompleted++;
        } else if (financial) {
          const reportParents = parentRows.filter(row => !["pending_project_manager", "rejected_by_project_manager"].includes(row.portal_approval_status));
          expect(body).toEqual({ p_request_ids: reportParents.map(row => row.id) });
          expect(url.searchParams.get("order")).toBe("id.asc");
          if (failure === "finance-final" && from === 6000) return fail("TEST final financial page failed");
          const parentIds = new Set(reportParents.map(parent => parent.id));
          source = itemRows.filter(row => parentIds.has(row.request_id));
          if (failure === "finance-missing") source = source.slice(0, -1);
          if (failure === "finance-duplicate") source = source.map((row, index) => index === source.length - 1 ? source[0] : row);
          if (failure === "finance-foreign") source = source.map((row, index) => index === 0 ? { ...children[0], request_id: "TEST-foreign" } : row);
          if (failure === "finance-swapped-id") source = source.map((row, index) => index === source.length - 1 ? { ...children.at(-1), id: "TEST-unknown-child" } : row);
          if (failure === "finance-reparented") source = children.map((row, index) => index === 0
            ? { ...row, request_id: children.at(-1)!.request_id }
            : index === children.length - 1 ? { ...row, request_id: children[0].request_id } : row);
          if (["finance-empty", "finance-string-zero", "finance-undefined", "finance-invalid"].includes(failure ?? "")) {
            const value = failure === "finance-empty" ? "" : failure === "finance-string-zero" ? "0" : failure === "finance-invalid" ? "TEST-invalid" : undefined;
            source = source.map((row, index) => index === source.length - 1 ? { ...children.at(-1), total_price: value } : row);
          }
        } else {
          expect(url.pathname).toBe("/rest/v1/request_items");
          expect(url.searchParams.get("select")).toBe("id,request_id,request:requests!request_items_request_id_fkey!inner(id)");
          expect(url.searchParams.get("request.portal_approval_status")).toBe("not.in.(pending_project_manager,rejected_by_project_manager)");
          expect(url.searchParams.has("request_id")).toBe(false);
          expect(url.searchParams.get("order")).toBe("id.asc");
          const intercepted = await childGate?.({ from, size });
          if (intercepted) return intercepted;
          if (failure === "child-final" && from === 6000) return fail("TEST final child page failed");
          const allowedParents = new Set(parentRows.filter(row => !["pending_project_manager", "rejected_by_project_manager"].includes(row.portal_approval_status)).map(row => row.id));
          source = itemRows.filter(row => allowedParents.has(row.request_id))
            .map(({ id, request_id }) => ({ id, request_id, request: { id: request_id } }));
        }
        const intercepted = await reportGate?.({ stage: parent ? "parent" : financial ? "financial" : "child", from, size, source, countExact: headers.get("prefer")?.includes("count=exact") === true });
        if (intercepted) return intercepted;
        let page = source.slice(from, from + size);
        if (failure === "finance-short" && financial && from === 6000) page = page.slice(0, -1);
        if (failure === "child-short" && !parent && !financial && from === 1000) page = page.slice(0, -1);
        const json = JSON.stringify(page);
        // Valid JSON may contain a numeric magnitude outside JavaScript's finite range.
        const encoded = failure === "finance-nonfinite" && financial && from === 6000 ? json.replace('"total_price":2', '"total_price":1e400') : json;
        return new Response(encoded, { headers: { "content-type": "application/json",
          "content-range": page.length ? `${from}-${from + page.length - 1}/${source.length}` : `*/${source.length}` } });
      } finally { pending--; }
    };
    mocks.client.mockReturnValue(createSdkClient("http://localhost:65421", "TEST-public-placeholder", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport, headers: { Authorization: "Bearer TEST-visitor" } },
    }));
  });

  it("collects all5501 tied-time parents before bounded child hydration and preserves true zero/NULL", async () => {
    const result = await getRequestsReport(true, { signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.rows.map(row => row.id)).toEqual(parents.map(row => row.id));
    expect(result.rows[0]).toMatchObject({ item_count: 1105, total_value: 2208, financial_state: "available" });
    expect(result.rows[1]).toMatchObject({ item_count: 1, total_value: null, financial_state: "missing" });
    expect(result.rows[2]).toMatchObject({ item_count: 1, total_value: 0, financial_state: "available" });
    const base = reads.filter(read => read.path.endsWith("/requests"));
    expect(base.map(read => read.params.get("offset"))).toEqual(["0", "1000", "2000", "3000", "4000", "5000"]);
    expect(base[0].prefer).toContain("count=exact");
    expect(base.slice(1).every(read => !read.prefer?.includes("count=exact"))).toBe(true);
    expect(reads.filter(read => !read.path.endsWith("/requests")).every(read => read.basePagesCompleted === 6)).toBe(true);
    const financial = reads.filter(read => read.path.endsWith("/request_items_financial"));
    expect(financial).toHaveLength(7); expect(financial[0].prefer).toContain("count=exact");
    expect(financial.slice(1).every(read => !read.prefer?.includes("count=exact"))).toBe(true);
    expect(maxPending).toBe(4);
    expect(reads.every(read => read.signal === controller.signal && read.authorization === "Bearer TEST-visitor")).toBe(true);
  });

  it("keeps NOFIN item counts complete beyond1000 without any financial read", async () => {
    const result = await getRequestsReport(false);
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(5501);
    expect(result.rows[0]).toMatchObject({ item_count: 1105, total_value: null, financial_state: "forbidden" });
    expect(reads.every(read => !read.path.includes("/rpc/") && !/total_price|unit_price/.test(read.params.get("select") ?? ""))).toBe(true);
    expect(maxPending).toBe(4);
  });

  it("uses one exact child count and the same nonvacuous portal filter as the parent source", async () => {
    const result = await getRequestsReport(false);
    expect(result.error).toBeNull();
    expect(excludedParents).toHaveLength(2); expect(excludedChildren).toHaveLength(2);
    expect(result.rows.map(row => row.id)).toEqual(parents.map(row => row.id));
    const childReads = reads.filter(read => read.path.endsWith("/request_items"));
    expect(childReads).toHaveLength(7);
    expect(childReads.map(read => read.params.get("offset"))).toEqual(["0", "1000", "2000", "3000", "4000", "5000", "6000"]);
    expect(childReads.map(read => read.params.get("limit"))).toEqual(["1000", "1000", "1000", "1000", "1000", "1000", "605"]);
    expect(childReads[0].prefer).toContain("count=exact");
    expect(childReads.slice(1).every(read => !read.prefer?.includes("count=exact"))).toBe(true);
    expect(childReads.every(read => !read.params.has("request_id") && read.basePagesCompleted === 6)).toBe(true);
    expect(result.rows.reduce((sum, row) => sum + row.item_count, 0)).toBe(children.length);
  });

  it("skips all child and financial reads for an empty parent scope", async () => {
    parentRows = [];
    expect(await getRequestsReport(true)).toEqual({ rows: [], error: null });
    expect(reads).toHaveLength(1); expect(reads[0].path).toBe("/rest/v1/requests");
  });

  it("preserves a visible parent with no children", async () => {
    parentRows = [{ ...parents[0], items: [] }]; itemRows = [];
    const result = await getRequestsReport(false);
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: parents[0].id, item_count: 0, total_value: null, financial_state: "forbidden" });
    expect(reads.filter(read => read.path.endsWith("/request_items"))).toHaveLength(1);
    expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
  });

  function holdLaterChildPages() {
    const pending = new Map<number, ReturnType<typeof deferred<Response | undefined>>>();
    const started = new Map(Array.from({ length: 6 }, (_, index) => [(index + 1) * 1000, deferred<void>()]));
    childGate = async ({ from }) => {
      if (from === 0) return undefined;
      const page = deferred<Response | undefined>(); pending.set(from, page); started.get(from)!.settle();
      return page.promise;
    };
    return {
      pending,
      started: (from: number) => started.get(from)!.promise,
      release: (from: number, response?: Response) => pending.get(from)!.settle(response),
      cleanup: () => { childGate = undefined; for (const page of pending.values()) page.settle(undefined); },
    };
  }

  it("refills a completed NOFIN child page while an earlier page waits and preserves complete parent order", async () => {
    const held = holdLaterChildPages();
    const result = getRequestsReport(false, { signal: controller.signal });
    try {
      await Promise.all([1000, 2000, 3000, 4000].map(held.started));
      expect(reads.filter(read => read.path.endsWith("/request_items"))).toHaveLength(5);
      held.release(2000); await held.started(5000);
      held.release(3000); await held.started(6000);
      expect([...held.pending.keys()]).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
      expect(maxPending).toBe(4);
      // Finish later pages first; parent output retains the collected base order.
      for (const from of [6000, 5000, 4000, 1000]) held.release(from);
    } finally { held.cleanup(); await result; }
    const complete = await result;
    expect(complete.error).toBeNull();
    expect(complete.rows.map(row => row.id)).toEqual(parents.map(row => row.id));
    expect(complete.rows[0]).toMatchObject({ item_count: 1105, total_value: null, financial_state: "forbidden" });
    expect(complete.rows.slice(1).every(row => row.item_count === 1)).toBe(true);
    const childReads = reads.filter(read => read.path.endsWith("/request_items"));
    expect(childReads.map(read => read.params.get("offset"))).toEqual(["0", "1000", "2000", "3000", "4000", "5000", "6000"]);
    expect(childReads.filter(read => read.prefer?.includes("count=exact"))).toHaveLength(1);
    expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
    expect(maxPending).toBe(4);
  });

  it.each(["source-error", "foreign-parent", "wrong-joined-id", "missing-joined-parent", "null-joined-parent", "array-joined-parent", "duplicate-id", "short-page"] as const)(
    "stops new child pages after an observed %s failure and drains held siblings", async mode => {
      const held = holdLaterChildPages(); let settled = false;
      const result = getRequestsReport(true, { signal: controller.signal }).then(value => { settled = true; return value; });
      try {
        await Promise.all([1000, 2000, 3000, 4000].map(held.started));
        held.release(2000); await held.started(5000);
        const source: { id: string; request_id: string; request: unknown }[] = children.slice(5000, 6000)
          .map(({ id, request_id }) => ({ id, request_id, request: { id: request_id } }));
        if (mode === "foreign-parent") source[0] = { ...source[0], request_id: excludedParents[0].id, request: { id: excludedParents[0].id } };
        if (mode === "wrong-joined-id") source[0].request = { id: parents[0].id };
        if (mode === "missing-joined-parent") source[0].request = undefined;
        if (mode === "null-joined-parent") source[0].request = null;
        if (mode === "array-joined-parent") source[0].request = [{ id: source[0].request_id }];
        if (mode === "duplicate-id") source[0].id = children[0].id;
        if (mode === "short-page") source.pop();
        // A non-retryable source error isolates the queue's observed-failure contract.
        const failedResponse = mode === "source-error"
          ? new Response(JSON.stringify({ code: "TEST", message: "TEST later child page failed" }), { status: 400, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify(source), { headers: { "content-type": "application/json", "content-range": `5000-${5000 + source.length - 1}/${children.length}` } });
        const consumed = deferred<void>(), readBody = failedResponse.text.bind(failedResponse);
        failedResponse.text = async () => { const body = await readBody(); consumed.settle(); return body; };
        held.release(5000, failedResponse);
        await consumed.promise; await flush();
        expect([...held.pending.keys()]).toEqual([1000, 2000, 3000, 4000, 5000]);
        expect(settled).toBe(false);
        held.release(1000); await flush();
        expect(reads.filter(read => read.path.endsWith("/request_items")).map(read => read.params.get("offset")))
          .toEqual(["0", "1000", "2000", "3000", "4000", "5000"]);
        expect(settled).toBe(false);
      } finally { held.cleanup(); await result; }
      expect(await result).toEqual({ rows: [], error: mode === "source-error" ? "TEST later child page failed"
        : mode === "short-page" ? "report_range_incomplete" : mode === "duplicate-id" ? "report_range_duplicate_id" : "request_item_counts_incomplete" });
      expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
      expect(maxPending).toBe(4);
    },
  );

  it("drains four pending child pages after cancellation without refilling another slot", async () => {
    const held = holdLaterChildPages(); let settled = false;
    const result = getRequestsReport(false, { signal: controller.signal }).then(value => { settled = true; return value; });
    try {
      await Promise.all([1000, 2000, 3000, 4000].map(held.started));
      controller.abort(); held.release(2000); await flush();
      expect(settled).toBe(false); expect([...held.pending.keys()]).toEqual([1000, 2000, 3000, 4000]);
    } finally { held.cleanup(); await result; }
    expect(await result).toEqual({ rows: [], error: "read_aborted" });
    expect(reads.filter(read => read.path.endsWith("/request_items"))).toHaveLength(5);
    expect(reads.every(read => read.signal === controller.signal && !read.path.includes("/rpc/"))).toBe(true);
    expect(maxPending).toBe(4);
  });

  it.each(["base-final", "child-final", "finance-final", "finance-short", "finance-missing", "finance-duplicate", "finance-foreign", "finance-swapped-id", "finance-reparented", "finance-empty", "finance-string-zero", "finance-undefined", "finance-invalid", "finance-nonfinite"] as const)("discards the full report when %s fails", async stage => {
    failure = stage;
    const result = await getRequestsReport(true);
    expect(result.rows).toEqual([]); expect(result.error).toEqual(expect.any(String)); expect(result.error).not.toBe("");
    if (stage === "base-final") expect(reads.every(read => read.path.endsWith("/requests"))).toBe(true);
    if (stage === "child-final") expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
    expect(maxPending).toBeLessThanOrEqual(4);
  });

  it("rejects a short later operational child page for NOFIN even when the parent embed's1000 rows were all seen", async () => {
    failure = "child-short";
    expect(await getRequestsReport(false)).toEqual({ rows: [], error: "report_range_incomplete" });
    expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
    expect(reads.some(read => read.path.endsWith("/request_items") && read.params.get("offset") === "1000")).toBe(true);
    expect(maxPending).toBeLessThanOrEqual(4);
  });

  it.each(["abort-base", "abort-child", "abort-finance"] as const)("stops later read waves after %s", async stage => {
    failure = stage;
    expect(await getRequestsReport(true, { signal: controller.signal })).toEqual({ rows: [], error: "read_aborted" });
    if (stage === "abort-base") expect(reads).toHaveLength(1);
    if (stage === "abort-child") expect(reads.filter(read => read.path.endsWith("/request_items"))).toHaveLength(1);
    if (stage === "abort-finance") expect(reads.filter(read => read.path.endsWith("/request_items_financial"))).toHaveLength(1);
    expect(reads.every(read => read.signal === controller.signal)).toBe(true);
  });

  it("sends no reads for a pre-aborted caller", async () => {
    controller.abort();
    expect(await getRequestsReport(true, { signal: controller.signal })).toEqual({ rows: [], error: "read_aborted" });
    expect(reads).toEqual([]);
  });


  function pageResponse(data: unknown, from: number, count: number, countExact: boolean, status = 200) {
    const range = Array.isArray(data) && data.length ? `${from}-${from + data.length - 1}/${count}` : `*/${count}`;
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json",
      ...(countExact ? { "content-range": range } : {}) } });
  }
  const stagePath = (stage: ReportStage) => stage === "parent" ? "/rest/v1/requests"
    : stage === "child" ? "/rest/v1/request_items" : "/rest/v1/rpc/request_items_financial";

  for (const stage of ["parent", "child", "financial"] as const) {
    it.each(["first", "final"] as const)(`rejects HTTP200 ${stage} pages capped at500 at the %s1000 boundary`, async boundary => {
      let affected: ReportRead | undefined;
      reportGate = async read => {
        const last = Math.floor((read.source.length - 1) / 1000) * 1000;
        if (read.stage !== stage || read.from !== (boundary === "first" ? 0 : last)) return undefined;
        affected = read;
        return pageResponse(read.source.slice(read.from, read.from + 500), read.from, read.source.length, read.countExact);
      };
      expect(await getRequestsReport(true)).toEqual({ rows: [], error: "report_range_incomplete" });
      expect(affected).toBeDefined(); expect(affected!.size).toBeGreaterThan(500);
      expect(affected!.size).toBe(boundary === "first" ? 1000 : stage === "parent" ? 501 : 605);
      if (stage === "parent") expect(reads.every(read => read.path.endsWith("/requests"))).toBe(true);
      if (stage === "child") expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
      expect(maxPending).toBeLessThanOrEqual(4);
    });

    it.each(["null", "object", "invalid-json"] as const)(`rejects a successful malformed first ${stage} body (%s) without a later-stage read`, async shape => {
      reportGate = async read => read.stage !== stage || read.from !== 0 ? undefined
        : shape === "invalid-json" ? new Response("{", { headers: { "content-type": "application/json", "content-range": `0-999/${read.source.length}` } })
          : pageResponse(shape === "null" ? null : {}, read.from, read.source.length, true);
      const result = await getRequestsReport(true);
      expect(result.rows).toEqual([]); expect(result.error).toEqual(expect.any(String)); expect(result.error).not.toBe("");
      expect(reads.filter(read => read.path === stagePath(stage))).toHaveLength(1);
      if (stage === "parent") expect(reads.every(read => read.path.endsWith("/requests"))).toBe(true);
      if (stage === "child") expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
    });

    function holdStage() {
      const pending = new Map<number, ReturnType<typeof deferred<Response | undefined>>>();
      const started = new Map(Array.from({ length: 6 }, (_, index) => [(index + 1) * 1000, deferred<void>()]));
      reportGate = async read => {
        if (read.stage !== stage || read.from === 0) return undefined;
        const held = deferred<Response | undefined>(); pending.set(read.from, held); started.get(read.from)!.settle();
        return held.promise;
      };
      return { pending, started: (from: number) => started.get(from)!.promise,
        release: (from: number, response?: Response) => pending.get(from)!.settle(response),
        cleanup: () => { reportGate = undefined; for (const held of pending.values()) held.settle(undefined); } };
    }

    it.each(["provider-error", "empty-error", "null-body"] as const)(`discards all earlier ${stage} rows after a late fifth-page %s, drains held siblings and admits no later page`, async mode => {
      const held = holdStage(); let settled = false;
      const result = getRequestsReport(true, { signal: controller.signal }).then(value => { settled = true; return value; });
      try {
        await Promise.all([1000, 2000, 3000, 4000].map(held.started));
        held.release(2000); await held.started(5000);
        const response = mode === "null-body" ? pageResponse(null, 5000, stage === "parent" ? parents.length : children.length, false)
          : new Response(JSON.stringify({ code: "TEST", message: mode === "empty-error" ? "" : "TEST fifth report page failed" }),
            { status: 400, headers: { "content-type": "application/json" } });
        const consumed = deferred<void>(), readBody = response.text.bind(response);
        response.text = async () => { const body = await readBody(); consumed.settle(); return body; };
        held.release(5000, response); await consumed.promise; await flush();
        expect([...held.pending.keys()]).toEqual([1000, 2000, 3000, 4000, 5000]); expect(settled).toBe(false);
        held.release(1000); await flush(); expect(settled).toBe(false);
        expect(reads.filter(read => read.path === stagePath(stage)).map(read => read.params.get("offset")))
          .toEqual(["0", "1000", "2000", "3000", "4000", "5000"]);
      } finally { held.cleanup(); await result; }
      const failed = await result;
      expect(failed.rows).toEqual([]); expect(failed.error).toBe(mode === "provider-error" ? "TEST fifth report page failed"
        : mode === "empty-error" ? "report_range_read_failed" : "report_range_incomplete");
      if (stage === "parent") expect(reads.every(read => read.path.endsWith("/requests"))).toBe(true);
      if (stage === "child") expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
      expect(maxPending).toBe(4);
    });

    it(`cancels ${stage} after four admitted1000 pages, drains ignored-abort replies and never starts a later stage`, async () => {
      const held = holdStage(); let settled = false;
      const result = getRequestsReport(true, { signal: controller.signal }).then(value => { settled = true; return value; });
      try {
        await Promise.all([1000, 2000, 3000, 4000].map(held.started));
        controller.abort(); held.release(2000); await flush();
        expect(settled).toBe(false); expect([...held.pending.keys()]).toEqual([1000, 2000, 3000, 4000]);
      } finally { held.cleanup(); await result; }
      expect(await result).toEqual({ rows: [], error: "read_aborted" });
      expect(reads.filter(read => read.path === stagePath(stage))).toHaveLength(5);
      if (stage === "parent") expect(reads.every(read => read.path.endsWith("/requests"))).toBe(true);
      if (stage === "child") expect(reads.every(read => !read.path.includes("/rpc/"))).toBe(true);
      expect(reads.every(read => read.signal === controller.signal)).toBe(true); expect(maxPending).toBe(4);
    });
  }

  it("reads and validates genuine zero-count operational and financial sources for a visible empty request", async () => {
    parentRows = [{ ...parents[0], items: [] }]; itemRows = [];
    const result = await getRequestsReport(true);
    expect(result.error).toBeNull(); expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: parents[0].id, item_count: 0, total_value: null, financial_state: "missing",
      financial_used_records: 0, financial_excluded_records: 0, financial_coverage_pct: 0 });
    expect(reads.map(read => read.path)).toEqual(["/rest/v1/requests", "/rest/v1/request_items", "/rest/v1/rpc/request_items_financial"]);
    expect(reads.every(read => read.params.get("offset") === "0" && read.params.get("limit") === "1000")).toBe(true);
    expect(reads.every(read => read.prefer?.includes("count=exact"))).toBe(true);
  });

});
