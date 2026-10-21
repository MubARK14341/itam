import { describe, expect, it } from "vitest";
import {
  buildConsumableRisk,
  buildMaintenanceTrend,
  buildPageRanges,
  canFetchExactTrend,
  dedupeMaintenanceRows,
  maintenanceTrendSince,
  median,
  startOfRiyadhWeek,
} from "./dashboard-trends";

describe("dashboard maintenance trend", () => {
  it("fills a fixed 12-week window including empty weeks", () => {
    const result = buildMaintenanceTrend([], "2026-07-14T12:00:00Z");
    expect(result.weeks).toHaveLength(12);
    expect(result.weeks.every((week) => week.reported === 0 && week.completed === 0)).toBe(true);
    expect(result.weeks[0].start).toBe(maintenanceTrendSince("2026-07-14T12:00:00Z"));
  });

  it("uses Sunday midnight in Riyadh near the UTC boundary", () => {
    expect(startOfRiyadhWeek("2026-07-11T20:59:59Z").toISOString()).toBe("2026-07-04T21:00:00.000Z");
    expect(startOfRiyadhWeek("2026-07-11T21:00:00Z").toISOString()).toBe("2026-07-11T21:00:00.000Z");
  });

  it("counts reported and terminal completed rows and excludes invalid durations", () => {
    const result = buildMaintenanceTrend([
      { id: "a", reported_at: "2026-07-12T06:00:00Z", completed_at: "2026-07-14T06:00:00Z", status: "completed" },
      { id: "b", reported_at: "invalid", completed_at: "2026-07-14T06:00:00Z", status: "completed" },
      { id: "c", reported_at: "2026-07-15T06:00:00Z", completed_at: "2026-07-14T06:00:00Z", status: "completed" },
      { id: "d", reported_at: "2026-07-13T06:00:00Z", completed_at: "2026-07-14T06:00:00Z", status: "cancelled" },
    ], "2026-07-14T12:00:00Z");
    expect(result.weeks.at(-1)).toMatchObject({ reported: 3, completed: 3 });
    expect(result.medianCloseDays).toBe(2);
  });

  it("calculates a numeric median", () => {
    expect(median([10, 1, 4])).toBe(4);
    expect(median([10, 2, 4, 8])).toBe(6);
    expect(median([])).toBeNull();
  });

  it("deduplicates paginated rows by id", () => {
    expect(dedupeMaintenanceRows([
      { id: "1", reported_at: "2026-01-01", completed_at: null, status: "open" },
      { id: "1", reported_at: null, completed_at: "2026-01-02", status: "completed" },
    ])).toEqual([{ id: "1", reported_at: "2026-01-01", completed_at: "2026-01-02", status: "completed" }]);
  });
});

describe("dashboard exact-count gate", () => {
  it.each([0, 1, 500, 501, 1000])("allows %i rows", (count) => {
    expect(canFetchExactTrend(count)).toBe(true);
  });

  it.each([1001, -1, 1.5])("fails closed for %i rows", (count) => {
    expect(canFetchExactTrend(count)).toBe(false);
  });

  it("assembles deterministic 500-row ranges", () => {
    expect(buildPageRanges(0)).toEqual([]);
    expect(buildPageRanges(1)).toEqual([[0, 0]]);
    expect(buildPageRanges(500)).toEqual([[0, 499]]);
    expect(buildPageRanges(501)).toEqual([[0, 499], [500, 500]]);
    expect(buildPageRanges(1000)).toEqual([[0, 499], [500, 999]]);
    expect(buildPageRanges(1001)).toEqual([[0, 499], [500, 999], [1000, 1000]]);
  });
});

describe("dashboard consumable risk", () => {
  it("excludes zero/null thresholds and sorts worst first without losing zero", () => {
    const result = buildConsumableRisk([
      { id: "safe", name: "Safe", quantity_on_hand: 11, reorder_level: 10 },
      { id: "critical", name: "Critical", quantity_on_hand: 5, reorder_level: 10 },
      { id: "empty", name: "Empty", quantity_on_hand: 0, reorder_level: 10 },
      { id: "zero", name: "No threshold", quantity_on_hand: 1, reorder_level: 0 },
      { id: "null", name: "No threshold 2", quantity_on_hand: 1, reorder_level: null },
    ]);
    expect(result.rows.map((row) => row.id)).toEqual(["empty", "critical"]);
    expect(result.rows[0].ratioPercent).toBe(0);
    expect(result.totalAtRisk).toBe(2);
    expect(result.withoutThreshold).toBe(2);
  });
});
