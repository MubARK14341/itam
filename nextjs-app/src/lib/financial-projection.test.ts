import { describe, expect, it, vi } from "vitest";
import { readFinancialBatches, type ProjectionResult } from "./financial-projection";

const records = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index).padStart(6, "0"), amount: index === 0 ? 0 : null }));
type Row = ReturnType<typeof records>[number];
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function pendingReader() {
  const pending = new Map<string, ReturnType<typeof deferred<ProjectionResult<Row>>>>();
  let active = 0, peak = 0;
  const read = vi.fn((ids: string[]) => {
    const batch = deferred<ProjectionResult<Row>>(); pending.set(ids[0], batch);
    peak = Math.max(peak, ++active);
    return batch.promise.then((value) => { active--; return value; });
  });
  return { read, pending, active: () => active, peak: () => peak };
}

describe("complete bounded financial projections", () => {
  it("covers more than 1000 identities without exceeding the RPC row ceiling", async () => {
    const ids = Array.from({ length: 1251 }, (_, index) => String(index).padStart(5, "0")).reverse();
    let inFlight = 0, peak = 0;
    const read = vi.fn(async (batch: string[]) => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return { data: batch.map(id => ({ id, amount: id === "00000" ? 0 : null })), error: null };
    });
    const result = await readFinancialBatches([...ids, ids[0]], read);
    expect(result.error).toBeNull();
    expect(result.data?.map(row => row.id)).toEqual([...ids].sort());
    expect(result.data?.[0].amount).toBe(0);
    expect(result.data?.[1].amount).toBeNull();
    expect(read.mock.calls.every(([batch]) => batch.length <= 500)).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("discards previous successes when a final batch fails", async () => {
    const read = vi.fn(async (ids: string[]) => ids.includes("1000")
      ? { data: null, error: { message: "TEST last batch failed" } }
      : { data: ids.map(id => ({ id })), error: null });
    const result = await readFinancialBatches(Array.from({ length: 1100 }, (_, i) => String(i).padStart(4, "0")), read);
    expect(result).toEqual({ data: null, error: { message: "TEST last batch failed" } });
  });

  it("stops scheduling more batches after cancellation", async () => {
    const controller = new AbortController();
    const read = vi.fn(async (ids: string[]) => {
      controller.abort();
      return { data: ids.map(id => ({ id })), error: null };
    });
    expect(await readFinancialBatches(Array.from({ length: 2501 }, (_, i) => String(i)), read, controller.signal))
      .toEqual({ data: null, error: { message: "read_aborted" } });
    // A synchronous cancellation prevents even the remaining initial slots from starting.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refills an early slot while the first batch is blocked, preserving sorted IDs and 0/NULL", async () => {
    const expected = records(2501), { read, pending, active, peak } = pendingReader();
    const result = readFinancialBatches([...expected.map(row => row.id).reverse(), expected[0].id], read); await flush();
    pending.get("000500")!.settle({ data: expected.slice(500, 1000), error: null }); await flush();
    expect(pending.has("002000")).toBe(true); expect(active()).toBe(4);
    pending.get("001000")!.settle({ data: expected.slice(1000, 1500), error: null }); await flush();
    expect(pending.has("002500")).toBe(true);
    for (const from of [2500, 2000, 1500, 0]) pending.get(String(from).padStart(6, "0"))!.settle({ data: expected.slice(from, Math.min(from + 500, expected.length)), error: null });
    expect(await result).toEqual({ data: expected, error: null }); expect(peak()).toBe(4);
    expect(read.mock.calls.every(([ids]) => ids.length <= 500)).toBe(true);
  });

  it("stops refilling after an out-of-order financial error and drains all pending readers", async () => {
    const expected = records(3501), { read, pending, active } = pendingReader();
    const result = readFinancialBatches(expected.map(row => row.id), read); await flush();
    pending.get("000500")!.settle({ data: null, error: { message: "TEST later financial batch failed" } }); await flush();
    expect(pending.has("002000")).toBe(false);
    for (const from of [0, 1000, 1500]) pending.get(String(from).padStart(6, "0"))!.settle({ data: expected.slice(from, from + 500), error: null });
    expect(await result).toEqual({ data: null, error: { message: "TEST later financial batch failed" } });
    expect(read).toHaveBeenCalledTimes(4); expect(active()).toBe(0);
  });

  it("drains pending batches after caller abort and never starts the next one", async () => {
    const controller = new AbortController(), expected = records(3501), { read, pending, active } = pendingReader();
    const result = readFinancialBatches(expected.map(row => row.id), read, controller.signal); await flush();
    expect(active()).toBe(4); controller.abort();
    for (const from of [0, 500, 1000, 1500]) pending.get(String(from).padStart(6, "0"))!.settle({ data: expected.slice(from, from + 500), error: null });
    expect(await result).toEqual({ data: null, error: { message: "read_aborted" } });
    expect(read).toHaveBeenCalledTimes(4); expect(active()).toBe(0);
  });

  it("preserves the thrown financial transport error and stops later scheduling", async () => {
    const exception = new Error("TEST transport failed"), pending = deferred<ProjectionResult<Row>>();
    const read = vi.fn((ids: string[]) => ids[0] === "000500" ? Promise.reject(exception) : pending.promise);
    const result = readFinancialBatches(records(3501).map(row => row.id), read);
    const rejected = expect(result).rejects.toBe(exception); await flush();
    expect(read).toHaveBeenCalledTimes(4);
    pending.settle({ data: [], error: null }); await rejected;
  });

  it("never reads when already aborted and performs no read for empty identities", async () => {
    const controller = new AbortController(); controller.abort();
    const read = vi.fn(async () => ({ data: [], error: null }));
    expect(await readFinancialBatches(["TEST"], read, controller.signal)).toEqual({ data: null, error: { message: "read_aborted" } });
    expect(await readFinancialBatches([], read)).toEqual({ data: [], error: null });
    expect(read).not.toHaveBeenCalled();
  });
});
