import { describe, expect, it } from "vitest";
import {
  boundedPageSize,
  collectRangePages,
  escapePostgrestValue,
  postgrestIlikeContains,
  takeCursorPage,
} from "./pagination";

describe("cursor pagination helpers", () => {
  it("bounds client-controlled page sizes", () => {
    expect(boundedPageSize()).toBe(100);
    expect(boundedPageSize(0)).toBe(1);
    expect(boundedPageSize(9999)).toBe(250);
  });

  it("uses the extra row only to prove a next cursor", () => {
    const page = takeCursorPage(
      [{ id: "3" }, { id: "2" }, { id: "1" }],
      2,
      (row) => row.id,
    );
    expect(page).toEqual({
      rows: [{ id: "3" }, { id: "2" }],
      nextCursor: "2",
    });
  });

  it("quotes PostgREST cursor values", () => {
    expect(escapePostgrestValue('a"b')).toBe('"a\\"b"');
  });

  it("keeps special search characters inside a quoted ilike operand", () => {
    expect(postgrestIlikeContains('  tag,_(A) "quoted"  ')).toBe(
      String.raw`"%tag,\\_(A) \"quoted\"%"`,
    );
    expect(postgrestIlikeContains("100%\\path")).toBe(
      String.raw`"%100\\%\\\\path%"`,
    );
  });

  it("collects explicit server pages until a short page", async () => {
    const source = Array.from({ length: 7 }, (_, id) => ({ id }));
    const result = await collectRangePages(async (from, to) => ({
      data: source.slice(from, to + 1),
      error: null,
    }), 3);
    expect(result.data).toEqual(source);
  });
});
