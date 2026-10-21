import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const migration = readFileSync(
  resolve(root, "migrations/20260731150000_stocktake_mvp.sql"),
  "utf8",
);
const page = readFileSync(
  resolve(root, "src/app/(app)/stocktakes/page.tsx"),
  "utf8",
);
const data = readFileSync(resolve(root, "src/lib/stocktakes.ts"), "utf8");
const staleDecisionGuard = readFileSync(
  resolve(root, "migrations/20260811150000_prevent_stocktake_decision_overwrite.sql"),
  "utf8",
);

describe("stocktake MVP contracts", () => {
  it("uses a synchronous in-flight guard so rapid stocktake actions cannot race their reloads", () => {
    expect(page).toContain("const busyRef = useRef(false)");
    expect(page).toContain("if (busyRef.current) return false");
    expect(page).toContain("busyRef.current = true");
    expect(page).toContain("busyRef.current = false");
  });

  it("uses an immutable blind snapshot and an RPC-only write posture", () => {
    expect(migration).toContain("snapshot_at timestamptz");
    expect(migration).toContain("blind_count boolean not null default true");
    expect(migration).toContain(
      "revoke all on public.stocktakes, public.stocktake_items",
    );
    expect(migration).toContain("public.stocktake_operations");
    expect(migration).toContain("on conflict (operation_id) do nothing");
    expect(migration).toContain("v_hide_expected");
    expect(migration).toContain("and (not v_hide_expected or i.scanned)");
  });

  it("separates management, review, audit, and correction duties", () => {
    expect(migration).toContain(
      "public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager')",
    );
    expect(migration).toContain(
      "public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor')",
    );
    expect(migration).toContain("independent_reviewer_required");
    expect(migration).toContain("independent_adjuster_required");
    expect(migration).toContain("correction_of uuid references public.stocktakes(id)");
    expect(migration).toContain("completed_session_required");
  });

  it("never guesses missing assets and records every accepted adjustment", () => {
    expect(migration).toContain(
      "i.observation_status in ('unexpected', 'wrong_location')",
    );
    expect(migration).toContain("'missing_not_adjusted'");
    expect(migration).toContain("insert into public.asset_movements");
    expect(migration).toContain("insert into public.stocktake_events");
    expect(migration).toContain("count_round < 2");
    expect(migration).toContain("recount_and_reason_required");
  });

  it("rejects a distinct stale discrepancy decision while preserving operation-id replays", () => {
    expect(staleDecisionGuard).toContain("_stocktake_existing_operation(p_operation_id, 'decide_item')");
    expect(staleDecisionGuard).toContain("if v_item.review_decision is not null then");
    expect(staleDecisionGuard).toContain("raise exception 'discrepancy_already_decided'");
  });

  it("provides a mobile scan-first UI and non-financial export", () => {
    for (const rpc of [
      "stocktake_create",
      "stocktake_start",
      "stocktake_scan",
      "stocktake_submit",
      "stocktake_recount_item",
      "stocktake_set_variance_reason",
      "stocktake_review",
      "stocktake_apply_adjustments",
      "stocktake_list",
      "stocktake_detail",
    ]) {
      expect(data).toContain(`rpc("${rpc}"`);
    }
    expect(page).toContain("autoFocus");
    expect(page).toContain("scanRef.current?.focus()");
    expect(page).toContain("downloadCSV");
    expect(page).not.toMatch(/purchase_cost|unit_cost|total_price|invoice/i);
  });
});
