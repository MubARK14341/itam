import { describe, expect, it } from "vitest";
import { inventoryPaginationPlan, skippedInventoryPage } from "./inventory-pagination";

describe("unified inventory pagination", () => {
  it("loads both sources for a reset so switching tabs has initial data", () => {
    expect(inventoryPaginationPlan({
      reset: true,
      itemType: "assets",
      hasMoreAssets: false,
      hasMoreConsumables: false,
    })).toEqual({ loadAssets: true, loadConsumables: true, hasMore: false });
  });

  it("does not restart an exhausted source in the combined list", () => {
    expect(inventoryPaginationPlan({
      reset: false,
      itemType: "all",
      hasMoreAssets: true,
      hasMoreConsumables: false,
    })).toEqual({ loadAssets: true, loadConsumables: false, hasMore: true });
    expect(inventoryPaginationPlan({
      reset: false,
      itemType: "all",
      hasMoreAssets: false,
      hasMoreConsumables: true,
    })).toEqual({ loadAssets: false, loadConsumables: true, hasMore: true });
  });

  it("advances only the source visible in a single-type tab", () => {
    expect(inventoryPaginationPlan({
      reset: false,
      itemType: "assets",
      hasMoreAssets: true,
      hasMoreConsumables: true,
    })).toEqual({ loadAssets: true, loadConsumables: false, hasMore: true });
    expect(inventoryPaginationPlan({
      reset: false,
      itemType: "consumables",
      hasMoreAssets: true,
      hasMoreConsumables: true,
    })).toEqual({ loadAssets: false, loadConsumables: true, hasMore: true });
    expect(inventoryPaginationPlan({
      reset: false,
      itemType: "assets",
      hasMoreAssets: false,
      hasMoreConsumables: true,
    })).toEqual({ loadAssets: false, loadConsumables: false, hasMore: false });
  });

  it("preserves a skipped source cursor without appending rows", () => {
    expect(skippedInventoryPage<{ id: string }, string>("next-page")).toEqual({
      rows: [],
      nextCursor: "next-page",
      total: null,
      error: null,
    });
  });
});
