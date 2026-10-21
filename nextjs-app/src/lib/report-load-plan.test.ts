import { describe, expect, it, vi } from "vitest";
import {
  collectFinancialQualityPages, reportLoadPlan, resolveReportTab, visibleReportTabs,
  type FinancialQualityPage,
} from "./report-load-plan";

describe("selected report dependencies", () => {
  it("keeps request reports independent of inventory and financial quality reads", () => {
    const plan = reportLoadPlan("requests");
    expect(plan.datasets).toEqual([]);
    expect(plan.requests).toBe(true);
    expect(plan.financialQuality).toBe(false);
    expect(plan.decisionCounts).toBe(false);
    expect(plan.depreciationRules).toBe(false);
  });

  it("resolves a hidden or obsolete URL tab to a permitted report", () => {
    expect(resolveReportTab("inventory", ["requests", "maintenance"])).toBe("requests");
    expect(resolveReportTab("activity", ["maintenance", "custody"])).toBe("maintenance");
    expect(resolveReportTab("custody", ["maintenance", "custody"])).toBe("custody");
  });

  it("requires the customer report capability when employee reports are hidden", () => {
    const visible = (key: string) => key === "reports.customerRequests";
    expect(visibleReportTabs(visible, false)).toEqual([]);
    expect(visibleReportTabs(visible, true)).toEqual(["requests"]);
    expect(visibleReportTabs((key) => key === "reports.requests", false)).toEqual(["requests"]);
  });
});

describe("complete financial quality export", () => {
  it("collects all 450 rows beyond both 200-row display boundaries", async () => {
    const expected = Array.from({ length: 450 }, (_, i) => ({ asset_tag: `TEST-${i + 1}` }));
    const fetchPage = vi.fn(async (offset: number) => ({
      rows: expected.slice(offset, offset + 200), nextOffset: offset + 200 < expected.length ? offset + 200 : null, error: null,
    }));
    expect(await collectFinancialQualityPages(fetchPage)).toEqual(expected);
    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 200, 400]);
  });

  it("rejects a failed later page without returning the first 200 rows", async () => {
    const fetchPage = vi.fn(async (offset: number): Promise<FinancialQualityPage<number>> => offset === 0
      ? { rows: Array.from({ length: 200 }, (_, i) => i), nextOffset: 200, error: null }
      : { rows: [], nextOffset: null, error: "not_authorized" });
    await expect(collectFinancialQualityPages(fetchPage)).rejects.toThrow("not_authorized");
    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 200]);
  });

  it("rejects even an empty error instead of treating a failure as an empty queue", async () => {
    await expect(collectFinancialQualityPages(async () => ({ rows: [], nextOffset: null, error: "" })))
      .rejects.toThrow("financial_data_quality_failed");
    await expect(collectFinancialQualityPages(async () => ({ rows: [], nextOffset: null, error: null }))).resolves.toEqual([]);
  });

  it.each([0, -1, 0.5, NaN, Infinity])("rejects an invalid continuation %s", async (nextOffset) => {
    const fetchPage = vi.fn(async () => ({ rows: [1], nextOffset, error: null }));
    await expect(collectFinancialQualityPages(fetchPage)).rejects.toThrow("financial_data_quality_invalid_continuation");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops before the next page after its session is aborted", async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn(async () => {
      controller.abort();
      return { rows: [1], nextOffset: 200, error: null };
    });
    await expect(collectFinancialQualityPages(fetchPage, controller.signal)).rejects.toThrow();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
