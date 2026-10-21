export const STOCKTAKE_VARIANCE_TYPES = ["missing", "unexpected", "wrong_location"] as const;
export type StocktakeVarianceType = (typeof STOCKTAKE_VARIANCE_TYPES)[number];
export type StocktakeResolutionFilter = "all" | "unresolved" | "resolved";

export interface StocktakeReviewItemLike {
  id: string;
  classification: string | null;
  review_decision?: string | null;
}

export function stocktakeDecisionProgress(items: StocktakeReviewItemLike[]): {
  total: number;
  resolved: number;
  unresolved: number;
} {
  const variances = items.filter((item) => STOCKTAKE_VARIANCE_TYPES.includes(item.classification as StocktakeVarianceType));
  const resolved = variances.filter((item) => Boolean(item.review_decision)).length;
  return { total: variances.length, resolved, unresolved: variances.length - resolved };
}

export function filterStocktakeReviewItems<T extends StocktakeReviewItemLike>(
  items: T[],
  options: {
    variancesOnly: boolean;
    classification: StocktakeVarianceType | "all";
    resolution: StocktakeResolutionFilter;
  },
): T[] {
  return items.filter((item) => {
    const isVariance = STOCKTAKE_VARIANCE_TYPES.includes(item.classification as StocktakeVarianceType);
    if (options.variancesOnly && !isVariance) return false;
    if (options.classification !== "all" && item.classification !== options.classification) return false;
    if (options.resolution === "unresolved" && (!isVariance || item.review_decision)) return false;
    if (options.resolution === "resolved" && (!isVariance || !item.review_decision)) return false;
    return true;
  });
}
