import { describe, it, expect } from "vitest";
import { collectCursorPages } from "./pagination";

describe("complete cursor exports", () => {
  it("continues when a valid cursor is zero", async () => {
    const result = await collectCursorPages<number, number>(async cursor => cursor === null
      ? { rows: [1], nextCursor: 0, total: 2, error: null }
      : { rows: [2], nextCursor: null, total: 2, error: null });
    expect(result).toEqual({ rows: [1, 2], error: null });
  });
  it("continues beyond the rendered first page and preserves every row in order", async () => {
    const source = Array.from({ length: 1201 }, (_, id) => ({ id }));
    const { rows, error } = await collectCursorPages<{ id: number }, number>(async cursor => {
      const from = cursor === null ? 0 : cursor + 1;
      return { rows: source.slice(from, from + 250), nextCursor: from + 250 < source.length ? from + 249 : null, total: source.length, error: null };
    });
    expect(error).toBeNull();
    expect(rows).toEqual(source);
  });
  it("does not present a partial CSV as successful when a later page fails", async () => {
    const result = await collectCursorPages<{ id: number }, number>(async cursor => cursor === null
      ? { rows: [{ id: 1 }], nextCursor: 1, total: 2, error: null }
      : { rows: [], nextCursor: null, total: null, error: "TEST second page denied" });
    expect(result).toEqual({ rows: [], error: "TEST second page denied" });
  });

  it.each(["", " \t\n"])("rejects a blank initial cursor error (%j) without accepting any rows", async error => {
    let reads = 0;
    const result = await collectCursorPages<number, number>(async () => {
      reads++; return { rows: [0], nextCursor: 0, total: 2, error };
    });
    expect(result).toEqual({ rows: [], error: "cursor_read_failed" }); expect(reads).toBe(1);
  });
  it.each(["", " \t\n"])("discards earlier cursor rows for a blank late error (%j) and does not refill", async error => {
    let reads = 0;
    const result = await collectCursorPages<number | null, number>(async cursor => {
      reads++;
      return cursor === null ? { rows: [0, null], nextCursor: 0, total: 3, error: null }
        : { rows: [2], nextCursor: 1, total: 3, error };
    });
    expect(result).toEqual({ rows: [], error: "cursor_read_failed" }); expect(reads).toBe(2);
  });
});
