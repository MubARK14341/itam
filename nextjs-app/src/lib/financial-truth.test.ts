import { describe, expect, it } from "vitest";
import {
  FINANCIAL_COVERAGE_THRESHOLD_PCT,
  formatFinancialMetricValue,
  summarizeFinancialMetric,
} from "@/lib/financial-truth";

const asOf = new Date("2026-07-31T09:00:00.000Z");

describe("P0-04 financial truth contract", () => {
  it("keeps a real zero available instead of treating it as missing", () => {
    const metric = summarizeFinancialMetric({
      authorized: true,
      rows: [{ value: 0, currency: "SAR" }],
      valueOf: (row) => row.value,
      currencyOf: (row) => row.currency,
      asOf,
    });

    expect(metric).toMatchObject({
      state: "available",
      value: 0,
      coveragePct: 100,
      usedRecords: 1,
      excludedRecords: 0,
      currency: "SAR",
      thresholdPct: FINANCIAL_COVERAGE_THRESHOLD_PCT,
    });
  });

  it("never exposes a partial total below the threshold", () => {
    const metric = summarizeFinancialMetric({
      authorized: true,
      rows: [
        { value: 120, currency: "SAR" },
        { value: null, currency: "SAR" },
      ],
      valueOf: (row) => row.value,
      currencyOf: (row) => row.currency,
      asOf,
    });

    expect(metric).toMatchObject({
      state: "missing",
      value: null,
      coveragePct: 50,
      usedRecords: 1,
      excludedRecords: 1,
      reason: "below_threshold",
    });
  });

  it("does not combine different currencies into one number", () => {
    const metric = summarizeFinancialMetric({
      authorized: true,
      rows: [
        { value: 1, currency: "SAR" },
        { value: 1, currency: "USD" },
      ],
      valueOf: (row) => row.value,
      currencyOf: (row) => row.currency,
      asOf,
    });

    expect(metric).toMatchObject({
      state: "missing",
      value: null,
      currency: null,
      reason: "mixed_currency",
    });
  });

  it("returns no value or currency when access is forbidden", () => {
    const metric = summarizeFinancialMetric({
      authorized: false,
      rows: [{ value: 900, currency: "SAR" }],
      valueOf: (row) => row.value,
      currencyOf: (row) => row.currency,
      asOf,
    });

    expect(metric).toMatchObject({
      state: "forbidden",
      value: null,
      currency: null,
      usedRecords: 0,
    });
    expect(formatFinancialMetricValue(metric, String, "missing", "forbidden"))
      .toBe("forbidden");
  });
});
