"use client";

import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/form";
import type { StocktakeItem } from "@/lib/stocktakes";
import type { Dict } from "@/lib/i18n";

export const STOCKTAKE_VARIANCE = new Set(["missing", "unexpected", "wrong_location"]);

export type StocktakeDecision = "approve_correction" | "keep_current" | "request_recheck";

/** Per-item variance reason + recount + manager decision controls (presentation; actions come from the page). */
export function StocktakeReviewControls({
  item, reason, setReason, busy, manage, canReview, reviewState, status,
  onSave, onStartRecount, onDecide, saveLabel, t,
}: {
  item: StocktakeItem;
  reason: string;
  setReason: (value: string) => void;
  busy: boolean;
  manage: boolean;
  canReview: boolean;
  reviewState: string;
  status: string;
  onSave: () => void;
  onStartRecount: () => void;
  onDecide: (decision: StocktakeDecision) => void;
  saveLabel: string;
  t: Dict["stocktakes"];
}) {
  const isVariance = STOCKTAKE_VARIANCE.has(item.classification ?? "");
  const editable = manage && isVariance && reviewState !== "approved" && status !== "completed";
  const decisions: Array<{ key: StocktakeDecision; label: string }> = [
    { key: "approve_correction", label: t.approve },
    { key: "keep_current", label: t.reject },
    { key: "request_recheck", label: t.requestRecheck },
  ];
  return (
    <>
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t.reason} aria-label={`${t.reason} — ${item.asset_tag}`}
            className={`${inputClass} min-w-0 flex-[1_1_12rem] !w-auto`} />
          <Button size="sm" variant="outline" disabled={busy} onClick={onSave}>{saveLabel}</Button>
          {reviewState === "submitted" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onStartRecount} className="text-warn">{t.startRecount}</Button>
          )}
        </div>
      ) : <span className="text-fg-2">{item.variance_reason ?? "—"}</span>}
      {canReview && isVariance && reviewState === "submitted" && (
        <div role="group" aria-label={item.asset_tag} className="ui-seg mt-2">
          {decisions.map((decision) => {
            const selected = item.review_decision === decision.key;
            return (
              <button key={decision.key} type="button" aria-pressed={selected} disabled={busy || selected}
                className="ui-seg-item disabled:cursor-not-allowed aria-[pressed=false]:disabled:opacity-60"
                onClick={() => onDecide(decision.key)}>
                {decision.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
