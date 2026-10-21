import type { CursorPage } from "@/lib/pagination";

export type InventoryItemType = "all" | "assets" | "consumables";

export function inventoryPaginationPlan(input: {
  reset: boolean;
  itemType: InventoryItemType;
  hasMoreAssets: boolean;
  hasMoreConsumables: boolean;
}) {
  const { reset, itemType, hasMoreAssets, hasMoreConsumables } = input;
  return {
    loadAssets: reset || (itemType !== "consumables" && hasMoreAssets),
    loadConsumables: reset || (itemType !== "assets" && hasMoreConsumables),
    hasMore: itemType === "assets"
      ? hasMoreAssets
      : itemType === "consumables"
        ? hasMoreConsumables
        : hasMoreAssets || hasMoreConsumables,
  };
}

export function skippedInventoryPage<T, C>(nextCursor: C | null): CursorPage<T, C> {
  return { rows: [], nextCursor, total: null, error: null };
}
