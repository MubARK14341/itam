import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient as createSdkClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ client: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: mocks.client }));
vi.mock("@/lib/observability", () => ({ reportOperationalFailure: mocks.failure }));
import { getReportData } from "./queries";

type Kind = "base" | "financial";
type Call = { kind: Kind; from: number; ids: string[]; select: string; signal?: AbortSignal | null;
  countExact: boolean; authorization: string | null; limit: number | null };
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
const row = (index: number) => ({ id: `TEST-asset-${String(index).padStart(5, "0")}`, asset_tag: `TEST-${index}`,
  name: `TEST asset ${index}`, status: "available", currency: "SAR", purchase_date: "2026-01-01",
  company_id: "TEST-company", category: { id: "TEST-category", name: "Laptop", name_ar: "حاسب" },
  location: null, department: null, company: null, serial_number: `TEST-serial-${index}`,
  special_attributes: { section: "laptops" }, holder: null, warranty_end: null, pool_id: null, model_id: null });
const jsonResponse = (data: unknown, count?: number) => new Response(JSON.stringify(data), { headers: {
  "content-type": "application/json", ...(count === undefined ? {} : { "content-range": Array.isArray(data)
    ? data.length ? `0-${data.length - 1}/${count}` : `*/${count}` : `0-999/${count}` }),
} });
const malformedJsonResponse = (count?: number) => new Response("[TEST invalid JSON", { headers: {
  "content-type": "application/json", ...(count === undefined ? {} : { "content-range": `0-999/${count}` }),
} });
const denied = (message: string) => new Response(JSON.stringify({ code: "TEST", message }), {
  status: 403, headers: { "content-type": "application/json" },
});

describe("shared-four financial asset pipeline through the installed ordinary SDK", () => {
  let calls: Call[], source: ReturnType<typeof row>[], controller: AbortController, active: number, peak: number;
  let intercept: ((call: Call) => Promise<Response | undefined>) | undefined;
  let firstCount: number | undefined;
  let expectedPageSize: number;
  beforeEach(() => {
    calls = []; source = Array.from({ length: 1251 }, (_, index) => row(index));
    controller = new AbortController(); active = 0; peak = 0; intercept = undefined; firstCount = undefined; expectedPageSize = 1000;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(init?.headers);
      const kind: Kind = url.pathname === "/rest/v1/assets" ? "base" : "financial";
      if (kind === "financial") expect(url.pathname).toBe("/rest/v1/rpc/assets_financial");
      const ids = kind === "financial" ? (JSON.parse(String(init?.body)) as { p_ids: string[] }).p_ids : [];
      const from = kind === "base" ? Number(url.searchParams.get("offset") ?? 0) : Number(ids[0]?.slice(-5));
      const call: Call = { kind, from, ids, select: url.searchParams.get("select") ?? "", signal: init?.signal,
        countExact: headers.get("prefer")?.includes("count=exact") ?? false, authorization: headers.get("authorization"),
        limit: kind === "base" ? Number(url.searchParams.get("limit")) : null };
      calls.push(call); active++; peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        const intercepted = await intercept?.(call);
        if (intercepted) return intercepted;
        if (kind === "base") {
          expect(url.searchParams.get("is_active")).toBe("eq.true");
          expect(url.searchParams.get("order")).toBe("id.asc");
          expect(call.select).not.toContain("purchase_cost");
          const size = Number(url.searchParams.get("limit"));
          expect(size).toBe(Math.min(expectedPageSize, from === 0 ? expectedPageSize : source.length - from));
          const page = source.slice(from, from + size).map(asset => Object.fromEntries(
            Object.entries(asset).filter(([key]) => call.select.includes(key))));
          return jsonResponse(page, call.countExact ? firstCount ?? source.length : undefined);
        }
        expect(ids.length).toBeGreaterThan(0); expect(ids.length).toBeLessThanOrEqual(expectedPageSize);
        return jsonResponse([...ids].reverse().map(id => ({ id, purchase_cost: id === source[0]?.id ? 0 : id === source[1]?.id ? null : 2 })));
      } finally { active--; }
    };
    mocks.client.mockReturnValue(createSdkClient("http://localhost:65421", "TEST-public-placeholder", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport, headers: { Authorization: "Bearer TEST-ordinary-visitor" } },
    }));
  });
  const load = () => getReportData(true, { datasets: ["assets"], assetProjection: "inventory", signal: controller.signal });
  function holdContinuation() {
    const pending = new Map<string, ReturnType<typeof deferred<Response | undefined>>>();
    intercept = call => {
      if (call.kind === "base" && call.from === 0) return Promise.resolve(undefined);
      const hold = deferred<Response | undefined>(); pending.set(`${call.kind}:${call.from}`, hold); return hold.promise;
    };
    return { pending, release: (key: string, response?: Response) => pending.get(key)!.settle(response),
      drain: () => { intercept = undefined; for (const gate of pending.values()) gate.settle(undefined); } };
  }

  it.each([0, 500, 1000, 1001, 1251, 5014, 5501])("returns exactly %s ordered financial rows without sentinel reads or duplicate projection", async count => {
    source = Array.from({ length: count }, (_, index) => row(index));
    const result = await load();
    expect(result.error).toBeNull(); expect(result.assets.map(asset => asset.id)).toEqual(source.map(asset => asset.id));
    if (count) expect(result.assets[0].purchase_cost).toBe(0);
    if (count > 1) expect(result.assets[1].purchase_cost).toBeNull();
    const base = calls.filter(call => call.kind === "base"), financial = calls.filter(call => call.kind === "financial");
    expect(base).toHaveLength(Math.max(1, Math.ceil(count / 1000))); expect(financial).toHaveLength(Math.ceil(count / 1000));
    expect(base.filter(call => call.countExact)).toHaveLength(1);
    expect(base.slice(1).every(call => !call.countExact)).toBe(true);
    expect(financial.flatMap(call => call.ids).sort()).toEqual(source.map(asset => asset.id));
    expect(peak).toBeLessThanOrEqual(4); expect(active).toBe(0);
    expect(calls.every(call => call.authorization === "Bearer TEST-ordinary-visitor")).toBe(true);
    expect(calls.every(call => call.signal === calls[0].signal)).toBe(true);
    expect(calls[0].signal).not.toBe(controller.signal);
  });

  it("projects a completed later page while an earlier base page is pending and refills one shared slot", async () => {
    source = Array.from({ length: 7001 }, (_, index) => row(index));
    const gates = holdContinuation(), result = load();
    try {
      await flush(); expect(calls.map(call => `${call.kind}:${call.from}`)).toEqual([
        "base:0", "financial:0", "base:1000", "base:2000", "base:3000",
      ]); expect(active).toBe(4);
      gates.release("base:2000"); await flush();
      expect(gates.pending.has("financial:2000")).toBe(true);
      expect(gates.pending.has("base:4000")).toBe(false); expect(active).toBe(4);
      gates.release("financial:2000"); await flush(); expect(gates.pending.has("base:4000")).toBe(true);
      expect(gates.pending.get("base:1000")).toBeDefined(); expect(active).toBe(4);
    } finally { gates.drain(); }
    const completed = await result;
    expect(completed.error).toBeNull(); expect(completed.assets.map(asset => asset.id)).toEqual(source.map(asset => asset.id));
    expect(peak).toBe(4); expect(active).toBe(0);
  });

  it.each(["base", "financial"] as const)("closes admissions on an observed %s failure, aborts both families and drains ignored aborts", async kind => {
    source = Array.from({ length: 7001 }, (_, index) => row(index));
    const gates = holdContinuation(), result = load();
    await flush(); const before = calls.length;
    gates.release(`${kind}:${kind === "base" ? 2000 : 0}`, denied("TEST original failure")); await flush();
    expect(calls).toHaveLength(before); expect(active).toBe(3);
    expect(calls.every(call => call.signal?.aborted)).toBe(true);
    let settled = false; void result.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
    gates.drain(); const completed = await result;
    expect(completed.assets).toEqual([]); expect(completed.error).toBe("TEST original failure");
    expect(active).toBe(0); expect(calls).toHaveLength(before);
  });

  for (const kind of ["base", "financial"] as const) {
    it.each(["null", "object", "string", "number"] as const)(
      `rejects an initial HTTP-success ${kind} %s JSON body without publishing rows`, async shape => {
        intercept = async call => {
          if (call.kind !== kind || call.from !== 0) return undefined;
          const body: unknown = shape === "null" ? null : shape === "object" ? {} : shape === "string" ? "TEST body" : 7;
          return jsonResponse(body, kind === "base" ? source.length : undefined);
        };
        const result = await load();
        expect(result.assets).toEqual([]);
        expect(result.error).toBe(kind === "base" ? "report_range_incomplete" : "financial_projection_incomplete");
        if (kind === "base") expect(calls.map(call => `${call.kind}:${call.from}`)).toEqual(["base:0"]);
        expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
      });

    it(`rejects initial ${kind} unparseable HTTP-success JSON through the installed SDK`, async () => {
      intercept = async call => call.kind === kind && call.from === 0
        ? malformedJsonResponse(kind === "base" ? source.length : undefined) : undefined;
      const result = await load();
      expect(result.assets).toEqual([]); expect(result.error).toEqual(expect.any(String)); expect(result.error).not.toBe("");
      if (kind === "base") expect(calls.map(call => `${call.kind}:${call.from}`)).toEqual(["base:0"]);
      expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
    });

    it.each(["null", "object", "empty-error", "unparseable"] as const)(
      `aborts and drains held siblings before any refill after late ${kind} %s data`, async shape => {
        source = Array.from({ length: 7001 }, (_, index) => row(index));
        const gates = holdContinuation(), result = load();
        let admitted = 0;
        try {
          await flush();
          expect(calls.map(call => `${call.kind}:${call.from}`)).toEqual([
            "base:0", "financial:0", "base:1000", "base:2000", "base:3000",
          ]);
          // Financial page2000 can start only after its full base page has validated;
          // keep first-page finance and other base siblings genuinely pending.
          if (kind === "financial") {
            gates.release("base:2000"); await flush();
            expect(gates.pending.has("financial:2000")).toBe(true);
            expect(gates.pending.has("base:4000")).toBe(false);
          }
          expect(active).toBe(4); admitted = calls.length;
          const response = shape === "empty-error" ? denied("")
            : shape === "unparseable" ? malformedJsonResponse()
              : jsonResponse(shape === "null" ? null : {});
          gates.release(`${kind}:2000`, response); await flush();
          expect(calls).toHaveLength(admitted); expect(active).toBe(3);
          expect(calls.every(call => call.signal?.aborted)).toBe(true);
          let settled = false; void result.then(() => { settled = true; });
          await flush(); expect(settled).toBe(false);
          expect(gates.pending.has("base:4000")).toBe(false);
          expect(gates.pending.has("financial:1000")).toBe(false);
          expect(gates.pending.has("financial:3000")).toBe(false);
        } finally { gates.drain(); }
        const completed = await result;
        expect(completed.assets).toEqual([]);
        if (shape === "unparseable") {
          expect(completed.error).toEqual(expect.any(String)); expect(completed.error).not.toBe("");
        } else {
          expect(completed.error).toBe(shape === "empty-error"
            ? kind === "base" ? "report_range_read_failed" : "financial_projection_failed"
            : kind === "base" ? "report_range_incomplete" : "financial_projection_incomplete");
        }
        expect(calls).toHaveLength(admitted); expect(active).toBe(0); expect(peak).toBe(4);
      });
  }

  it("does not interpret a null first body with exact count0 as a genuine empty report", async () => {
    source = [];
    intercept = async call => call.kind === "base" ? jsonResponse(null, 0) : undefined;
    const result = await load();
    expect(result.error).toBe("report_range_incomplete"); expect(result.assets).toEqual([]);
    expect(calls.map(call => `${call.kind}:${call.from}`)).toEqual(["base:0"]);
    expect(active).toBe(0);
  });

  it("normalizes an empty first base error before any projection is admitted", async () => {
    intercept = async call => call.kind === "base" ? denied("") : undefined;
    const result = await load();
    expect(result.error).toBe("report_range_read_failed"); expect(result.assets).toEqual([]);
    expect(calls.map(call => `${call.kind}:${call.from}`)).toEqual(["base:0"]);
    expect(active).toBe(0);
  });

  it("forwards caller cancellation to one shared signal without scheduling or publishing late success", async () => {
    source = Array.from({ length: 7001 }, (_, index) => row(index));
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const gates = holdContinuation(), result = load(); await flush(); const before = calls.length;
    controller.abort(); expect(calls.every(call => call.signal?.aborted)).toBe(true);
    gates.drain(); const completed = await result;
    expect(completed.error).toBe("read_aborted"); expect(completed.assets).toEqual([]);
    expect(calls).toHaveLength(before); expect(active).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("never invokes the SDK for an already-aborted caller", async () => {
    controller.abort(); const result = await load();
    expect(result.error).toBe("read_aborted"); expect(result.assets).toEqual([]); expect(calls).toEqual([]);
  });

  it("stops before any continuation when the first count or cardinality is invalid", async () => {
    firstCount = -1;
    const result = await load(); expect(result.error).toBe("report_range_invalid_count");
    expect(result.assets).toEqual([]); expect(calls.map(call => call.kind)).toEqual(["base"]);
  });

  it("rejects a late duplicate base ID before any refill and preserves the first failure", async () => {
    source = Array.from({ length: 7001 }, (_, index) => row(index));
    const gates = holdContinuation(), result = load(); await flush(); const before = calls.length;
    gates.release("base:2000", jsonResponse([source[0], ...source.slice(2001, 3000)])); await flush();
    expect(calls).toHaveLength(before); gates.drain(); const completed = await result;
    expect(completed.error).toBe("report_range_duplicate_id"); expect(completed.assets).toEqual([]);
  });

  it.each(["missing", "extra", "duplicate", "foreign", "swapped", "undefined", "empty", "string-zero", "boolean", "nonfinite"])(
    "rejects %s financial rows instead of publishing a partial or coerced amount", async mode => {
      source = [row(0), row(1)];
      intercept = async call => {
        if (call.kind !== "financial") return undefined;
        const financial: Record<string, unknown>[] = call.ids.map(id => ({ id, purchase_cost: 0 }));
        if (mode === "missing") financial.pop();
        if (mode === "extra") financial.push({ id: "TEST-extra", purchase_cost: 0 });
        if (mode === "duplicate") financial[1] = financial[0];
        if (mode === "foreign" || mode === "swapped") financial[1] = { id: "TEST-unknown", purchase_cost: 0 };
        if (mode === "undefined") delete financial[1].purchase_cost;
        if (mode === "empty") financial[1].purchase_cost = "";
        if (mode === "string-zero") financial[1].purchase_cost = "0";
        if (mode === "boolean") financial[1].purchase_cost = false;
        if (mode === "nonfinite") return new Response(JSON.stringify(financial).replace('"purchase_cost":0', '"purchase_cost":1e400'), {
          headers: { "content-type": "application/json" },
        });
        return jsonResponse(financial);
      };
      const result = await load(); expect(result.error).toBe("financial_projection_incomplete"); expect(result.assets).toEqual([]);
    });

  it("normalizes an empty financial error and never starts an unrelated table", async () => {
    intercept = async call => call.kind === "financial" ? denied("") : undefined;
    const result = await load(); expect(result.error).toBe("financial_projection_failed"); expect(result.assets).toEqual([]);
    expect(calls.every(call => call.kind === "base" || call.kind === "financial")).toBe(true);
  });

  it.each(["inventory", "executive"] as const)("uses the strict 1000 page contract for the mounted %s FIN projection", async assetProjection => {
    source = Array.from({ length: 1001 }, (_, index) => row(index));
    const result = await getReportData(true, { datasets: ["assets"], assetProjection, signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.assets.map(asset => asset.id)).toEqual(source.map(asset => asset.id));
    expect(calls.filter(call => call.kind === "base").map(call => [call.from, call.limit])).toEqual([[0, 1000], [1000, 1]]);
    expect(calls.filter(call => call.kind === "financial").map(call => call.ids.length).sort((a, b) => a - b)).toEqual([1, 1000]);
    expect(result.assets[0].purchase_cost).toBe(0); expect(result.assets[1].purchase_cost).toBeNull();
    expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
  });

  it.each(["full", undefined] as const)("keeps the single-asset %s projection at the existing 500 contract", async assetProjection => {
    expectedPageSize = 500;
    const result = await getReportData(true, { datasets: ["assets"], assetProjection, signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.assets.map(asset => asset.id)).toEqual(source.map(asset => asset.id));
    expect(calls.filter(call => call.kind === "base").map(call => [call.from, call.limit])).toEqual([[0, 500], [500, 500], [1000, 251]]);
    expect(calls.filter(call => call.kind === "financial").every(call => call.ids.length <= 500)).toBe(true);
    expect(result.assets[0].purchase_cost).toBe(0); expect(result.assets[1].purchase_cost).toBeNull();
  });

  for (const kind of ["base", "financial"] as const) {
    it.each([0, 5000])(`rejects a valid HTTP200 ${kind} response capped at 500 at offset %s instead of accepting incomplete CSV input`, async from => {
      source = Array.from({ length: 5501 }, (_, index) => row(index));
      intercept = async call => {
        if (call.kind !== kind || call.from !== from) return undefined;
        return kind === "base"
          ? jsonResponse(source.slice(from, from + 500), call.countExact ? source.length : undefined)
          : jsonResponse(call.ids.slice(0, 500).map(id => ({ id, purchase_cost: 0 })));
      };
      const result = await load(), affected = calls.find(call => call.kind === kind && call.from === from);
      expect(affected).toBeDefined();
      expect(kind === "base" ? affected!.limit : affected!.ids.length).toBe(from === 0 ? 1000 : 501);
      expect(result.error).toBe(kind === "base" ? "report_range_incomplete" : "financial_projection_incomplete");
      expect(result.assets).toEqual([]); expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
      if (kind === "base" && from === 0) expect(calls.map(call => `${call.kind}:${call.from}`)).toEqual(["base:0"]);
      if (from === 5000) expect(calls.some(call => call.kind === kind && call.from < from)).toBe(true);
    });

    it(`discards all earlier 1000-row pages after a final ${kind} transport failure`, async () => {
      source = Array.from({ length: 5501 }, (_, index) => row(index));
      intercept = async call => call.kind === kind && call.from === 5000 ? denied("TEST final page failed") : undefined;
      const result = await load();
      expect(calls.some(call => call.kind === kind && call.from === 5000)).toBe(true);
      expect(result.error).toBe("TEST final page failed"); expect(result.assets).toEqual([]);
      expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
    });
  }

  it("rejects a final-page nonnumeric amount after earlier pages preserve legitimate zero and null", async () => {
    source = Array.from({ length: 5501 }, (_, index) => row(index));
    intercept = async call => call.kind === "financial" && call.from === 5000
      ? jsonResponse(call.ids.map((id, index) => ({ id, purchase_cost: index === 0 ? "0" : null }))) : undefined;
    const result = await load();
    expect(calls.some(call => call.kind === "financial" && call.from === 5000)).toBe(true);
    expect(result.error).toBe("financial_projection_incomplete"); expect(result.assets).toEqual([]);
    expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
  });

  it("keeps NOFIN and legacy multi-resource reads outside the linked mixed scheduler", async () => {
    const noFin = await getReportData(false, { datasets: ["assets"], assetProjection: "inventory", signal: controller.signal });
    expect(noFin.error).toBeNull(); expect(calls.every(call => call.kind === "base" && call.signal === controller.signal)).toBe(true);
    expect(noFin.assets[0]).not.toHaveProperty("purchase_cost");
    calls = []; expectedPageSize = 500;
    const legacy = await getReportData(true, { datasets: ["assets", "assets"], signal: controller.signal });
    expect(legacy.error).toBeNull(); expect(calls.every(call => call.signal === controller.signal)).toBe(true);
    expect(calls.findIndex(call => call.kind === "financial")).toBe(3);
    expect(legacy.assets[0].purchase_cost).toBe(0); expect(legacy.assets[1].purchase_cost).toBeNull();
  });

  for (const assetProjection of ["inventory", "executive"] as const) {
    it.each([0, 1000, 1001, 5014, 5501])(`returns every NOFIN ${assetProjection} row in strict1000 pages without any financial request for count%s`, async count => {
      source = Array.from({ length: count }, (_, index) => row(index));
      const result = await getReportData(false, { datasets: ["assets"], assetProjection, signal: controller.signal });
      expect(result.error).toBeNull(); expect(result.assets.map(asset => asset.id)).toEqual(source.map(asset => asset.id));
      expect(calls).toHaveLength(Math.max(1, Math.ceil(count / 1000)));
      expect(calls.every(call => call.kind === "base" && call.signal === controller.signal)).toBe(true);
      expect(calls.filter(call => call.countExact)).toHaveLength(1);
      for (const asset of result.assets) {
        expect(asset).not.toHaveProperty("purchase_cost"); expect(asset).not.toHaveProperty("special_attributes");
        expect(asset).not.toHaveProperty("serial_number");
      }
      expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
    });

    for (const from of [0, 5000]) {
      it.each(["short500", "null", "unparseable", "transport"] as const)(`discards every NOFIN ${assetProjection} row after %s at offset${from}`, async shape => {
        source = Array.from({ length: 5501 }, (_, index) => row(index));
        intercept = async call => call.kind !== "base" || call.from !== from ? undefined
          : shape === "short500" ? jsonResponse(source.slice(from, from + 500), call.countExact ? source.length : undefined)
            : shape === "null" ? jsonResponse(null, call.countExact ? source.length : undefined)
              : shape === "unparseable" ? malformedJsonResponse(call.countExact ? source.length : undefined)
                : denied("TEST NOFIN source failed");
        const result = await getReportData(false, { datasets: ["assets"], assetProjection, signal: controller.signal });
        expect(result.assets).toEqual([]); expect(result.error).toEqual(expect.any(String)); expect(result.error).not.toBe("");
        expect(calls.every(call => call.kind === "base" && call.signal === controller.signal)).toBe(true);
        expect(calls.find(call => call.from === from)?.limit).toBe(from === 0 ? 1000 : 501);
        if (from === 0) expect(calls).toHaveLength(1);
        else expect(calls.some(call => call.from < from)).toBe(true);
        expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(4);
      });
    }

    it(`stops NOFIN ${assetProjection} admissions on abort and drains the already-started ordinary reads`, async () => {
      source = Array.from({ length: 7001 }, (_, index) => row(index));
      const gates = holdContinuation();
      const result = getReportData(false, { datasets: ["assets"], assetProjection, signal: controller.signal });
      await flush(); expect([...gates.pending.keys()]).toEqual(["base:1000", "base:2000", "base:3000", "base:4000"]);
      const admitted = calls.length; controller.abort();
      expect(calls.every(call => call.kind === "base" && call.signal === controller.signal && call.signal.aborted)).toBe(true);
      let settled = false; void result.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
      gates.drain(); const completed = await result;
      expect(completed.assets).toEqual([]); expect(completed.error).toBe("read_aborted");
      expect(calls).toHaveLength(admitted); expect(gates.pending.has("base:5000")).toBe(false);
      expect(active).toBe(0); expect(peak).toBe(4);
    });
  }

  it.each(["full", undefined] as const)("preserves500 and full operational fields for the NOFIN %s caller", async assetProjection => {
    expectedPageSize = 500;
    const result = await getReportData(false, { datasets: ["assets"], assetProjection, signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.assets.map(asset => asset.id)).toEqual(source.map(asset => asset.id));
    expect(calls.map(call => [call.from, call.limit])).toEqual([[0, 500], [500, 500], [1000, 251]]);
    expect(calls.every(call => call.kind === "base" && call.signal === controller.signal)).toBe(true);
    expect(result.assets[0].special_attributes).toEqual(source[0].special_attributes);
    expect(result.assets[0].serial_number).toBe(source[0].serial_number);
    expect(result.assets[0]).not.toHaveProperty("purchase_cost");
  });

  it("preserves500 and the existing executive shape for explicit combined NOFIN resources", async () => {
    expectedPageSize = 500;
    const result = await getReportData(false, { datasets: ["assets", "assets"], assetProjection: "executive", signal: controller.signal });
    expect(result.error).toBeNull(); expect(result.assets.map(asset => asset.id)).toEqual(source.map(asset => asset.id));
    expect(calls.map(call => [call.from, call.limit])).toEqual([[0, 500], [500, 500], [1000, 251]]);
    expect(calls.every(call => call.kind === "base" && call.signal === controller.signal)).toBe(true);
    expect(result.assets[0].special_attributes).toEqual(source[0].special_attributes);
    expect(result.assets[0].serial_number).toBe(source[0].serial_number);
    expect(result.assets[0]).not.toHaveProperty("purchase_cost");
  });
});
