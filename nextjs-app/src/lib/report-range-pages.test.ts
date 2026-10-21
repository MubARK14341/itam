import { describe, expect, it, vi } from "vitest";
import { collectReportRangePages, type ReportRangePage } from "./report-range-pages";

const records = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index).padStart(6, "0"), amount: index === 0 ? 0 : null }));
type Row = ReturnType<typeof records>[number];
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function pendingReader(expected: Row[]) {
  const pending = new Map<number, ReturnType<typeof deferred<ReportRangePage<Row>>>>();
  let active = 0, peak = 0;
  const read = vi.fn((from: number, to: number, exact: boolean) => {
    if (exact) return Promise.resolve({ data: expected.slice(from, to + 1), error: null, count: expected.length });
    const page = deferred<ReportRangePage<Row>>(); pending.set(from, page);
    peak = Math.max(peak, ++active);
    return page.promise.then((value) => { active--; return value; });
  });
  return { read, pending, active: () => active, peak: () => peak };
}

describe("complete concurrent report range pages", () => {
  it("keeps counted child pages serial when an outer reader controls batch concurrency", async () => {
    const expected = records(2251);
    let pending = 0, peak = 0;
    const read = vi.fn(async (from: number, to: number, exact: boolean) => {
      peak = Math.max(peak, ++pending);
      await Promise.resolve(); pending--;
      return { data: expected.slice(from, to + 1), error: null, count: exact ? expected.length : null };
    });
    expect(await collectReportRangePages(read, undefined, 1)).toEqual({ data: expected, error: null });
    expect(peak).toBe(1);
    expect(read.mock.calls).toEqual([[0, 499, true], [500, 999, false], [1000, 1499, false], [1500, 1999, false], [2000, 2250, false]]);
  });

  it.each([0, 5, 1.5, "1", null])("rejects invalid runtime concurrency %s before any read", async concurrency => {
    const read = vi.fn(async () => ({ data: [], error: null, count: 0 }));
    // Exercise callers outside TypeScript's literal constraint without a production cast.
    expect(await Reflect.apply(collectReportRangePages, undefined, [read, undefined, concurrency]))
      .toEqual({ data: [], error: { message: "report_range_invalid_concurrency" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns all 2251 rows in server page order when four concurrent responses finish in reverse order", async () => {
    const expected = records(2251), pending = new Map<number, (page: ReportRangePage<Row>) => void>();
    let inFlight = 0, peak = 0, groupReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { groupReady = resolve; });
    const read = vi.fn((from: number, to: number, exact: boolean): PromiseLike<ReportRangePage<Row>> => {
      peak = Math.max(peak, ++inFlight);
      if (exact) { inFlight--; return Promise.resolve({ data: expected.slice(from, to + 1), error: null, count: expected.length }); }
      return new Promise((resolve) => {
        pending.set(from, (page) => { inFlight--; resolve(page); });
        if (pending.size === 4) groupReady();
      });
    });
    const result = collectReportRangePages(read);
    await ready;
    for (const from of [2000, 1500, 1000, 500]) pending.get(from)!({ data: expected.slice(from, Math.min(from + 500, expected.length)), error: null });
    expect(await result).toEqual({ data: expected, error: null });
    expect(peak).toBe(4);
    expect(read.mock.calls).toEqual([[0, 499, true], [500, 999, false], [1000, 1499, false], [1500, 1999, false], [2000, 2250, false]]);
  });

  it.each([0, 500, 1000])("does not schedule a past-end sentinel for exactly %s records", async (count) => {
    const expected = records(count), read = vi.fn(async (from: number, to: number, exact: boolean) => ({
      data: expected.slice(from, to + 1), error: null, count: exact ? count : null,
    }));
    expect(await collectReportRangePages(read)).toEqual({ data: expected, error: null });
    expect(read).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 500)));
  });

  it.each(["TEST last report page failed", ""])("discards all earlier successes after a final failure '%s'", async (message) => {
    const expected = records(2751), read = vi.fn(async (from: number, to: number, exact: boolean): Promise<ReportRangePage<Row>> => from === 2500
      ? { data: null, error: { message } }
      : { data: expected.slice(from, to + 1), error: null, count: exact ? expected.length : undefined });
    expect(await collectReportRangePages(read)).toEqual({ data: [], error: { message: message || "report_range_read_failed" } });
    expect(read).toHaveBeenCalledTimes(6);
  });

  it.each([null, undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid initial count %s", async (count) => {
    const read = vi.fn(async () => ({ data: [] as Row[], error: null, count }));
    expect(await collectReportRangePages(read)).toEqual({ data: [], error: { message: "report_range_invalid_count" } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([0, 500])("rejects a short page beginning at %s and discards all its rows", async (shortFrom) => {
    const expected = records(1251), read = vi.fn(async (from: number, to: number, exact: boolean) => ({
      data: expected.slice(from, to + 1 - (from === shortFrom ? 1 : 0)), error: null, count: exact ? expected.length : undefined,
    }));
    expect(await collectReportRangePages(read)).toEqual({ data: [], error: { message: "report_range_incomplete" } });
  });

  it("rejects a changed count and does not schedule a later group", async () => {
    const expected = records(4501), { read, pending } = pendingReader(expected);
    const result = collectReportRangePages(read); await flush();
    pending.get(2000)!.settle({ data: expected.slice(2000, 2500), error: null, count: expected.length - 1 });
    await flush();
    expect(pending.has(2500)).toBe(false);
    for (const from of [500, 1000, 1500]) pending.get(from)!.settle({ data: expected.slice(from, from + 500), error: null });
    expect(await result).toEqual({ data: [], error: { message: "report_range_count_changed" } });
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("refills a completed slot while an earlier page remains pending and retains server offset order", async () => {
    const expected = records(3001), { read, pending, active, peak } = pendingReader(expected);
    const result = collectReportRangePages(read); await flush();
    expect([...pending.keys()]).toEqual([500, 1000, 1500, 2000]);
    pending.get(1000)!.settle({ data: expected.slice(1000, 1500), error: null }); await flush();
    expect(pending.has(2500)).toBe(true); expect(active()).toBe(4);
    pending.get(1500)!.settle({ data: expected.slice(1500, 2000), error: null }); await flush();
    expect(pending.has(3000)).toBe(true);
    for (const from of [3000, 2500, 2000, 500]) pending.get(from)!.settle({ data: expected.slice(from, Math.min(from + 500, expected.length)), error: null });
    expect(await result).toEqual({ data: expected, error: null }); expect(peak()).toBe(4);
    expect(read.mock.calls.filter(([, , exact]) => exact)).toHaveLength(1);
  });

  it("rejects cross-page duplicate IDs when the earlier requested page finishes later", async () => {
    const expected = records(4001), { read, pending } = pendingReader(expected);
    const result = collectReportRangePages(read); await flush();
    pending.get(1000)!.settle({ data: [expected[500], ...expected.slice(1001, 1500)], error: null }); await flush();
    expect(pending.has(2500)).toBe(true);
    pending.get(500)!.settle({ data: expected.slice(500, 1000), error: null }); await flush();
    expect(pending.has(3000)).toBe(false);
    for (const from of [1500, 2000, 2500]) pending.get(from)!.settle({ data: expected.slice(from, from + 500), error: null });
    expect(await result).toEqual({ data: [], error: { message: "report_range_duplicate_id" } });
    expect(read).toHaveBeenCalledTimes(6);
  });

  it.each(["failure", "short"])("stops refilling after an observed out-of-order %s and drains pending readers", async mode => {
    const expected = records(4001), { read, pending, active } = pendingReader(expected);
    const result = collectReportRangePages(read); await flush();
    pending.get(1000)!.settle(mode === "failure" ? { data: null, error: { message: "TEST later page failed" } }
      : { data: expected.slice(1000, 1499), error: null });
    await flush(); expect(pending.has(2500)).toBe(false);
    for (const from of [500, 1500, 2000]) pending.get(from)!.settle({ data: expected.slice(from, from + 500), error: null });
    expect(await result).toEqual({ data: [], error: { message: mode === "failure" ? "TEST later page failed" : "report_range_incomplete" } });
    expect(read).toHaveBeenCalledTimes(5); expect(active()).toBe(0);
  });

  it("drains four pending readers after caller abort without refilling any slot", async () => {
    const controller = new AbortController(), expected = records(4001), { read, pending, active } = pendingReader(expected);
    const result = collectReportRangePages(read, controller.signal); await flush();
    expect(active()).toBe(4); controller.abort();
    for (const [from, page] of pending) page.settle({ data: expected.slice(from, from + 500), error: null });
    expect(await result).toEqual({ data: [], error: { message: "read_aborted" } });
    expect(read).toHaveBeenCalledTimes(5); expect(active()).toBe(0);
  });

  it.each([0, 500])("rejects duplicate IDs at page %s even if counts and lengths match", async (duplicateFrom) => {
    const expected = records(1251), read = async (from: number, to: number, exact: boolean) => {
      const data = expected.slice(from, to + 1);
      if (from === duplicateFrom) data[from === 0 ? 1 : 0] = expected[0];
      return { data, error: null, count: exact ? expected.length : undefined };
    };
    expect(await collectReportRangePages(read)).toEqual({ data: [], error: { message: "report_range_duplicate_id" } });
  });

  it("rejects an absent row identity instead of reporting complete financial data", async () => {
    expect(await collectReportRangePages(async () => ({ data: [{ id: "" }], error: null, count: 1 })))
      .toEqual({ data: [], error: { message: "report_range_invalid_id" } });
  });

  it("converts a thrown transport failure to a controlled error with no rows", async () => {
    expect(await collectReportRangePages(async () => { throw new Error(""); }))
      .toEqual({ data: [], error: { message: "report_range_read_failed" } });
  });

  it("never starts a read when already aborted", async () => {
    const controller = new AbortController(); controller.abort();
    const read = vi.fn(async () => ({ data: [] as Row[], error: null, count: 0 }));
    expect(await collectReportRangePages(read, controller.signal)).toEqual({ data: [], error: { message: "read_aborted" } });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, 2000])("discards completed reads after abortion at page %s and never schedules the next group", async (abortFrom) => {
    const controller = new AbortController(), expected = records(4501);
    const read = vi.fn(async (from: number, to: number, exact: boolean) => {
      if (from === abortFrom) controller.abort();
      return { data: expected.slice(from, to + 1), error: null, count: exact ? expected.length : undefined };
    });
    expect(await collectReportRangePages(read, controller.signal)).toEqual({ data: [], error: { message: "read_aborted" } });
    expect(read.mock.calls.map(([from]) => from)).toEqual(abortFrom === 0 ? [0] : [0, 500, 1000, 1500, 2000]);
  });
});
