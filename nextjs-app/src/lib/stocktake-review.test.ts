import { describe, expect, it } from "vitest";
import { filterStocktakeReviewItems, stocktakeDecisionProgress } from "./stocktake-review";

describe("stocktake high-volume review", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    classification: index < 50 ? "missing" : index < 80 ? "unexpected" : "matched",
    review_decision: index < 30 ? "keep_current" : null,
  }));

  it("derives authoritative progress only from real discrepancy classifications", () => {
    expect(stocktakeDecisionProgress(items)).toEqual({ total: 80, resolved: 30, unresolved: 50 });
  });

  it("focuses unresolved discrepancies without weakening per-item decisions", () => {
    expect(filterStocktakeReviewItems(items, { variancesOnly: true, classification: "all", resolution: "unresolved" })).toHaveLength(50);
    expect(filterStocktakeReviewItems(items, { variancesOnly: true, classification: "missing", resolution: "unresolved" })).toHaveLength(20);
    expect(filterStocktakeReviewItems(items, { variancesOnly: true, classification: "unexpected", resolution: "resolved" })).toHaveLength(0);
  });
});
