// Ledger tones for stocktake sessions and item classifications (presentation only).
import type { Tone } from "@/lib/tone";
import type { StocktakeItem, StocktakeSession } from "@/lib/stocktakes";

export const STOCKTAKE_REVIEW_TONE: Record<StocktakeSession["review_state"], Tone> = {
  counting: "info",
  recount: "warn",
  submitted: "res",
  approved: "ok",
  rejected: "bad",
};

/** Session chip tone: lifecycle status first (draft/completed/cancelled), then the review state. */
export function stocktakeSessionTone(session: Pick<StocktakeSession, "status" | "review_state">): Tone {
  if (session.status === "completed") return "ok";
  if (session.status === "draft" || session.status === "cancelled") return "neu";
  return STOCKTAKE_REVIEW_TONE[session.review_state] ?? "neu";
}

export const STOCKTAKE_CLASSIFICATION_TONE: Record<NonNullable<StocktakeItem["classification"]>, Tone> = {
  found: "ok",
  missing: "bad",
  unexpected: "warn",
  wrong_location: "info",
};

export function stocktakeProgress(session: Pick<StocktakeSession, "expected_count" | "observed_count">): number {
  if (!session.expected_count) return 0;
  return Math.min(100, Math.round((session.observed_count / session.expected_count) * 100));
}
