import { describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";
import { collectReportRangePages } from "./report-range-pages";

type Row = { id: string };
const records = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `TEST-${String(index).padStart(5, "0")}` }));
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
function deferred<T>() {
  let settle!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, fail) => { settle = resolve; reject = fail; });
  return { promise, settle, reject };
}

describe("optional page projection preserves the report collector contract", () => {
  it("runs real installed SDK base/projection requests with the same linked signal and one shared slot", async () => {
    const source = records(1251), calls: string[] = [], signals: (AbortSignal | null | undefined)[] = [];
    let active = 0, peak = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const projection = url.pathname.endsWith("/assets_financial");
      const ids = projection ? (JSON.parse(String(init?.body)) as { p_ids: string[] }).p_ids : [];
      const from = projection ? Number(ids[0].slice(-5)) : Number(url.searchParams.get("offset"));
      calls.push(`${projection ? "projection" : "base"}:${from}`); signals.push(init?.signal);
      active++; peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        const data = projection ? ids.map(id => ({ id })) : source.slice(from, from + Number(url.searchParams.get("limit")));
        return new Response(JSON.stringify(data), { headers: { "content-type": "application/json",
          ...(new Headers(init?.headers).get("prefer")?.includes("count=exact") ? { "content-range": `0-499/${source.length}` } : {}) } });
      } finally { active--; }
    };
    const sb = createSdkClient("http://localhost:65421", "TEST-public", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport },
    });
    const result = await collectReportRangePages<Row>((from, to, exact, signal) => {
      if (!signal) throw new Error("TEST linked signal absent");
      return sb.from("assets").select("id", { count: exact ? "exact" : undefined }).order("id").range(from, to).abortSignal(signal);
    }, undefined, 1, { read: (page, signal) => sb.rpc("assets_financial", { p_ids: page.map(row => row.id) }).abortSignal(signal) });
    expect(result).toEqual({ data: source, error: null }); expect(peak).toBe(1); expect(active).toBe(0);
    expect(calls).toEqual(["base:0", "projection:0", "base:500", "projection:500", "base:1000", "projection:1000"]);
    expect(signals.every(signal => signal === signals[0] && signal instanceof AbortSignal)).toBe(true);
  });

  it.each(["missing", "extra", "duplicate", "foreign", "empty-error", "throw"])("rejects %s generic projection output", async mode => {
    const source = records(3);
    const result = await collectReportRangePages(async () => ({ data: source, error: null, count: 3 }), undefined, 4, {
      read: async () => {
        if (mode === "throw") throw new Error("");
        if (mode === "empty-error") return { data: null, error: { message: "" } };
        const data = [...source];
        if (mode === "missing") data.pop();
        if (mode === "extra") data.push({ id: "TEST-extra" });
        if (mode === "duplicate") data[2] = data[0];
        if (mode === "foreign") data[2] = { id: "TEST-foreign" };
        return { data, error: null };
      },
    });
    expect(result.data).toEqual([]); expect(result.error?.message).toMatch(/^report_range_projection_/);
  });

  it.each([null, undefined, NaN, Infinity, -1, 1.5])("does not project when the first exact count is %s", async count => {
    const read = vi.fn(async () => ({ data: records(1), error: null, count }));
    const projection = vi.fn(async () => ({ data: records(1), error: null }));
    const result = await collectReportRangePages(read, undefined, 4, { read: projection });
    expect(result).toEqual({ data: [], error: { message: "report_range_invalid_count" } });
    expect(read).toHaveBeenCalledOnce(); expect(projection).not.toHaveBeenCalled();
  });

  it("rejects first-page cardinality before starting finance or later base pages", async () => {
    const read = vi.fn(async () => ({ data: records(499), error: null, count: 1001 }));
    const projection = vi.fn(async () => ({ data: records(499), error: null }));
    expect(await collectReportRangePages(read, undefined, 4, { read: projection }))
      .toEqual({ data: [], error: { message: "report_range_incomplete" } });
    expect(read).toHaveBeenCalledOnce(); expect(projection).not.toHaveBeenCalled();
  });

  it("observes synchronous caller abort before constructing any later callback and drains the admitted projection", async () => {
    const source = records(2001), controller = new AbortController(), held = deferred<{ data: Row[]; error: null }>();
    const starts: string[] = [];
    const result = collectReportRangePages(async (from, to, exact) => {
      starts.push(`base:${from}`); if (from === 500) controller.abort();
      return { data: source.slice(from, to + 1), error: null, count: exact ? source.length : undefined };
    }, controller.signal, 4, { read: (page) => { starts.push(`projection:${page[0].id}`); return held.promise; } });
    await flush(); expect(starts).toEqual(["base:0", "projection:TEST-00000", "base:500"]);
    let settled = false; void result.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
    held.settle({ data: source.slice(0, 500), error: null });
    expect(await result).toEqual({ data: [], error: { message: "read_aborted" } });
    expect(starts).toHaveLength(3);
  });

  it("stops refill after count drift, drains sibling projections and keeps the count failure over abort replies", async () => {
    const source = records(2501), held = deferred<{ data: Row[] | null; error: { message: string } | null }>();
    const starts: string[] = [];
    const result = collectReportRangePages(async (from, to, exact) => {
      starts.push(`base:${from}`);
      return { data: source.slice(from, to + 1), error: null, count: exact ? source.length : from === 500 ? source.length + 1 : undefined };
    }, undefined, 4, { read: () => { starts.push("projection"); return held.promise; } });
    await flush(); const admitted = starts.length;
    expect(starts).not.toContain("base:2000");
    held.settle({ data: null, error: { message: "TEST sibling abort" } });
    expect(await result).toEqual({ data: [], error: { message: "report_range_count_changed" } });
    expect(starts).toHaveLength(admitted);
  });

  it("drains admitted callbacks after a late thrown projection and stops before refill", async () => {
    const source = records(3001), projection = deferred<{ data: Row[]; error: null }>();
    const pending = new Map<number, ReturnType<typeof deferred<{ data: Row[]; error: null }>>>();
    const starts: string[] = [], signals: AbortSignal[] = [];
    const result = collectReportRangePages(async (from, to, exact, signal) => {
      starts.push(`base:${from}`); if (signal) signals.push(signal);
      if (from === 0) return { data: source.slice(0, 500), error: null, count: source.length };
      const held = deferred<{ data: Row[]; error: null }>(); pending.set(from, held);
      return held.promise;
    }, undefined, 4, { read: (_page, signal) => { starts.push("projection"); signals.push(signal); return projection.promise; } });
    await flush(); expect(pending.size).toBe(3);
    projection.reject(new Error("TEST thrown projection")); await flush();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    const admitted = starts.length; let settled = false; void result.then(() => { settled = true; });
    await flush(); expect(settled).toBe(false);
    for (const [from, held] of pending) held.settle({ data: source.slice(from, from + 500), error: null });
    expect(await result).toEqual({ data: [], error: { message: "report_range_projection_failed" } });
    expect(starts).toHaveLength(admitted); expect(starts).not.toContain("base:2000");
  });

});
