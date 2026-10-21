import { describe, expect, it } from "vitest";
import { requestSeriesPoints } from "./chart-geometry";

describe("emerald request chart geometry", () => {
  it("preserves dates in source order and uses a shared scale for both series", () => {
    const rows = [
      { date: "2026-10-01", created: 10, completed: 5 },
      { date: "2026-10-02", created: 0, completed: 10 },
    ];
    expect(requestSeriesPoints(rows, "created")).toBe("8,12 592,160");
    expect(requestSeriesPoints(rows, "completed")).toBe("8,86 592,12");
    expect(rows[0].created).toBe(10);
  });
  it("handles empty, single-day and all-zero data without invalid SVG coordinates", () => {
    expect(requestSeriesPoints([], "created")).toBe("");
    expect(requestSeriesPoints([{ date: "2026-10-01", created: 0, completed: 0 }], "created")).toBe("300,160");
  });
});
