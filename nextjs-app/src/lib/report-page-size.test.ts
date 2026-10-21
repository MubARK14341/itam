import { describe, expect, it, vi } from "vitest";
import { collectReportRangePages, type ReportRangePage } from "./report-range-pages";

const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `TEST-${String(index).padStart(6, "0")}`, amount: index === 0 ? 0 : null,
}));
type Row = ReturnType<typeof rows>[number];
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function heldReader(expected: Row[]) {
  const pending = new Map<number, ReturnType<typeof deferred<ReportRangePage<Row>>>>();
  let active = 0, peak = 0;
  const read = vi.fn((from: number, to: number, exact: boolean) => {
    if (exact) return Promise.resolve({ data: expected.slice(from, to + 1), error: null, count: expected.length });
    const gate = deferred<ReportRangePage<Row>>(); pending.set(from, gate);
    peak = Math.max(peak, ++active);
    return gate.promise.then(page => { active--; return page; });
  });
  const release = (from: number, page: ReportRangePage<Row> = { data: expected.slice(from, from + 1000), error: null }) => pending.get(from)!.settle(page);
  return { read, pending, release, active: () => active, peak: () => peak };
}

describe("explicit report page size without cap inference or fallback", () => {
  it.each([0, 499, 999, 1001, "1000", null, NaN, Infinity])("rejects invalid runtime page size %s before any callback", async pageSize => {
    const read = vi.fn(async () => ({ data: [] as Row[], error: null, count: 0 }));
    expect(await Reflect.apply(collectReportRangePages, undefined, [read, undefined, 4, undefined, pageSize]))
      .toEqual({ data: [], error: { message: "report_range_invalid_page_size" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves the omitted and explicit500 contracts byte-for-byte at the callback boundary", async () => {
    const expected = rows(1001);
    const makeRead = () => vi.fn(async (from: number, to: number, exact: boolean) => ({
      data: expected.slice(from, to + 1), error: null, count: exact ? expected.length : undefined,
    }));
    const omitted = makeRead(), explicit = makeRead();
    expect(await collectReportRangePages(omitted)).toEqual({ data: expected, error: null });
    expect(await collectReportRangePages(explicit, undefined, 4, undefined, 500)).toEqual({ data: expected, error: null });
    expect(omitted.mock.calls).toEqual([[0, 499, true], [500, 999, false], [1000, 1000, false]]);
    expect(explicit.mock.calls).toEqual(omitted.mock.calls);
  });

  it.each([0, 1000, 1001, 5501])("returns all %s rows including legitimate zero/null with exact1000 offsets and no sentinel", async count => {
    const expected = rows(count), read = vi.fn(async (from: number, to: number, exact: boolean) => ({
      data: expected.slice(from, to + 1), error: null, count: exact ? count : undefined,
    }));
    expect(await collectReportRangePages(read, undefined, 4, undefined, 1000)).toEqual({ data: expected, error: null });
    const ranges = Array.from({ length: Math.max(1, Math.ceil(count / 1000)) }, (_, index) => [
      index * 1000, index === 0 ? 999 : Math.min(index * 1000 + 999, count - 1), index === 0,
    ]);
    expect(read.mock.calls).toEqual(ranges);
  });

  for (const from of [0, 5000]) {
    it.each(["null", "short500", "extra"] as const)(`rejects %s cardinality at1000 offset${from} without publishing any earlier rows`, async shape => {
      const expected = rows(5501);
      const read = vi.fn(async (start: number, to: number, exact: boolean): Promise<ReportRangePage<Row>> => ({
        data: start !== from ? expected.slice(start, to + 1) : shape === "null" ? null
          : shape === "short500" ? expected.slice(start, start + 500)
            : [...expected.slice(start, to + 1), { id: "TEST-extra", amount: null }],
        error: null, count: exact ? expected.length : undefined,
      }));
      expect(await collectReportRangePages(read, undefined, 4, undefined, 1000))
        .toEqual({ data: [], error: { message: "report_range_incomplete" } });
      expect(read.mock.calls.some(([start]) => start === from)).toBe(true);
      if (from === 0) expect(read).toHaveBeenCalledTimes(1);
    });
  }

  it("rejects a changed continuation count rather than silently using the first count", async () => {
    const expected = rows(5501), read = async (from: number, to: number, exact: boolean) => ({
      data: expected.slice(from, to + 1), error: null, count: exact ? expected.length : from === 1000 ? expected.length - 1 : undefined,
    });
    expect(await collectReportRangePages(read, undefined, 4, undefined, 1000))
      .toEqual({ data: [], error: { message: "report_range_count_changed" } });
  });

  it("restores1000 server-offset order when later pages refill before earlier pages complete", async () => {
    const expected = rows(6001), held = heldReader(expected);
    const result = collectReportRangePages(held.read, undefined, 4, undefined, 1000); await flush();
    expect([...held.pending.keys()]).toEqual([1000, 2000, 3000, 4000]); expect(held.active()).toBe(4);
    held.release(2000); await flush(); expect(held.pending.has(5000)).toBe(true); expect(held.active()).toBe(4);
    held.release(5000); await flush(); expect(held.pending.has(6000)).toBe(true); expect(held.active()).toBe(4);
    for (const from of [6000, 4000, 3000, 1000]) held.release(from);
    expect(await result).toEqual({ data: expected, error: null }); expect(held.peak()).toBe(4); expect(held.active()).toBe(0);
  });

  it("detects global ID duplication after an earlier requested page completes later and drains before returning", async () => {
    const expected = rows(7001), held = heldReader(expected);
    const result = collectReportRangePages(held.read, undefined, 4, undefined, 1000); await flush();
    held.release(2000, { data: [expected[1000], ...expected.slice(2001, 3000)], error: null }); await flush();
    expect(held.pending.has(5000)).toBe(true);
    held.release(1000); await flush(); expect(held.pending.has(6000)).toBe(false);
    let settled = false; void result.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
    for (const from of [3000, 4000, 5000]) held.release(from);
    expect(await result).toEqual({ data: [], error: { message: "report_range_duplicate_id" } });
    expect(held.read).toHaveBeenCalledTimes(6); expect(held.active()).toBe(0);
  });

  it("stops1000-page admissions on caller abort and waits for the four already-started ignored-abort reads", async () => {
    const expected = rows(7001), held = heldReader(expected), controller = new AbortController();
    const result = collectReportRangePages(held.read, controller.signal, 4, undefined, 1000); await flush();
    expect(held.active()).toBe(4); controller.abort();
    let settled = false; void result.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
    for (const from of [1000, 2000, 3000, 4000]) held.release(from);
    expect(await result).toEqual({ data: [], error: { message: "read_aborted" } });
    expect(held.read).toHaveBeenCalledTimes(5); expect(held.active()).toBe(0); expect(held.pending.has(5000)).toBe(false);
  });
});
