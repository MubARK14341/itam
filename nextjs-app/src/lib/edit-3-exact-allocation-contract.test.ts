import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../migrations/20260805120000_edit_3_account_and_exact_asset_traceability.sql", import.meta.url),
  "utf8",
);
const readyTransitionFix = readFileSync(
  new URL("../../migrations/20260808133000_fix_exact_ready_state_transition.sql", import.meta.url),
  "utf8",
);

describe("EDIT 3 exact-asset and account safety contract", () => {
  it("keeps one canonical exact allocation record with active uniqueness", () => {
    expect(migration).toContain("create table if not exists public.request_asset_allocations");
    expect(migration).toContain("unique (request_item_id, asset_id)");
    expect(migration).toContain("request_asset_allocations_one_active_asset");
    expect(migration).toContain("state in ('selected','prepared','delivered')");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("r.created_by=auth.uid()");
  });

  it("requires exact preparation before a request can become ready", () => {
    expect(migration).toContain("request_prepare_allocated_assets");
    expect(migration).toContain("exact_assets_required");
    expect(migration).toContain("request_exact_assets_ready_guard");
    expect(migration).toContain("exact_assets_required_before_ready");
    expect(migration).toContain("create or replace function public.request_confirm_ready");
    expect(migration).toContain("'exact_assets',true");
  });

  it("takes the legal intermediate transition before marking exact assets ready", () => {
    expect(readyTransitionFix).toContain("if v_req.status <> 'preparing' then");
    expect(readyTransitionFix).toContain("update public.requests set status = 'preparing' where id = p_id;");
    expect(readyTransitionFix).toContain("set status = 'ready_for_pickup'");
    expect(readyTransitionFix).toContain("set search_path to public");
    expect(readyTransitionFix).toContain("revoke all on function public.request_confirm_ready(uuid) from public, anon");
  });

  it("remediates legacy statuses by archiving without deleting assets or audit history", () => {
    expect(migration).toContain("archived_at");
    expect(migration).toContain("archive_note");
    expect(migration).toContain("edit_3_legacy_status_remediation_incomplete");
    expect(migration).not.toMatch(/drop\s+table|truncate|delete\s+from/i);
  });

  it("separates requester cancellation from manager rejection at the server boundary", () => {
    expect(migration).toContain("public.app_user_role() <> 'employee'");
    expect(migration).toContain("requester_cancelled");
    expect(migration).toContain("cannot_cancel_after_preparation");
  });

  it("keeps high-risk delivery separation of duties while requiring every exact asset", () => {
    expect(migration).toContain("all_prepared_assets_must_be_verified");
    expect(migration).toContain("second_approval_required");
    expect(migration).toContain("independent_deliverer_required");
    expect(migration).toContain("strong_proof_required");
    expect(migration).toContain("request_delivery_denied");
  });

  it("selects only available compatible durable assets and keeps custom request needs exact", () => {
    expect(migration).toContain("v_item.item_kind = 'custom' and v_item.requested_kind = 'existing_asset'");
    expect(migration).toContain("asset_category_mismatch");
    expect(migration).toContain("asset_company_mismatch");
    expect(migration).toContain("ri.item_kind='custom' and ri.requested_kind='existing_asset'");
  });

  it("limits return outcomes to sound or needs inspection", () => {
    expect(migration).toContain("v_result not in ('sound','needs_inspection')");
    expect(migration).toContain("p_condition not in ('sound','needs_inspection')");
  });
});
