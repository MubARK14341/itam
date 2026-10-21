import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../app/(app)/requests/[id]/page.tsx", import.meta.url),
  "utf8",
);
const client = readFileSync(new URL("./requests.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../migrations/20260803070509_edit_1_request_fulfillment_simplification.sql", import.meta.url),
  "utf8",
);
const employeeReturnMigration = readFileSync(
  new URL("../../migrations/20260803081719_edit_1_employee_request_return_lifecycle.sql", import.meta.url),
  "utf8",
);
const employeeRentalDeliveryMigration = readFileSync(
  new URL("../../migrations/20260803082104_edit_1_employee_rental_delivery_state.sql", import.meta.url),
  "utf8",
);
const returnAssignmentConditionMigration = readFileSync(
  new URL("../../migrations/20260803083930_edit_1_return_assignment_condition_mapping.sql", import.meta.url),
  "utf8",
);
const autoProvisionAllocationMigration = readFileSync(
  new URL("../../migrations/20260811210000_auto_provision_exact_allocation.sql", import.meta.url),
  "utf8",
);

describe("Edit 1 simplified request fulfillment contract", () => {
  it("removes technical delivery proof controls from the request UI", () => {
    expect(page).not.toContain("signatureReference");
    expect(page).not.toContain("deliveryMethod");
    expect(page).not.toContain("proofMethods");
    expect(page).not.toContain("otpIntegrationBlocked");
    expect(page).toContain("recipientPersonName");
    expect(page).not.toContain("deliveryAcknowledgement");
    expect(page).toContain("confirmDelivery");
  });

  it("uses the checklist only for pre-confirmation verification", () => {
    expect(page).toContain("confirmDelivery");
    expect(page).toContain('type="checkbox"');
    expect(page).toContain("verified_asset_ids: deliveryVerifiedAssetIds");
    expect(page).toContain("onClick={() => void submitDelivery()}");
  });

  it("creates acknowledgement evidence internally without a fake signature", () => {
    expect(client).toContain('method: "acknowledgement"');
    expect(client).toContain("signature_reference: null");
    expect(client).toContain("otp_challenge_id: null");
    expect(client).toContain("delivery_notes: proof.delivery_notes");
  });

  it("guards duplicate client actions and uses server idempotency", () => {
    expect(page).toContain("if (busyRef.current) return false");
    expect(page).toContain("busyRef.current = true");
    expect(client).toContain('requestIdempotent(id, "confirm_ready"');
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("request_operation_results");
  });

  it("records an exact allocation inside the trusted auto-provision transaction", () => {
    expect(autoProvisionAllocationMigration).toContain(
      "current_setting('app.request_fulfillment_apply', true) = 'on'",
    );
    expect(autoProvisionAllocationMigration).toContain(
      "new.item_kind = 'asset'",
    );
    expect(autoProvisionAllocationMigration).toContain(
      "insert into public.request_asset_allocations",
    );
    expect(autoProvisionAllocationMigration).toContain(
      "security definer",
    );
    expect(autoProvisionAllocationMigration).toContain(
      "set search_path to 'public'",
    );
    expect(autoProvisionAllocationMigration).toContain(
      "revoke all on function public.request_items_auto_provision_allocation() from public, anon, authenticated",
    );
  });

  it("changes reserved devices atomically and only for authorized roles", () => {
    expect(migration).toContain("request_change_reserved_asset");
    expect(migration).toContain("v_role not in ('admin', 'it_manager', 'warehouse_manager')");
    expect(migration).toMatch(/v_new\.status <> 'available'/);
    expect(migration).toMatch(/set status = 'available'[\s\S]*set status = 'reserved'[\s\S]*set asset_id = v_new\.id/);
  });

  it("keeps the return lifecycle at returned after inspection", () => {
    expect(migration).toContain("return_notes_required");
    expect(migration).toMatch(/set status = 'returned', returned_at = now\(\)/);
    expect(migration).not.toMatch(/request_inspect_return[\s\S]*set status = 'completed'/);
  });

  it("maps a trusted return condition to the assignment-grade constraint", () => {
    expect(returnAssignmentConditionMigration).toContain("v_assignment_grade := case v_cond");
    expect(returnAssignmentConditionMigration).toContain("when 'sound' then 'good'");
    expect(returnAssignmentConditionMigration).toContain("when 'needs_maintenance' then 'fair'");
    expect(returnAssignmentConditionMigration).toContain("return_condition = v_assignment_grade");
    expect(returnAssignmentConditionMigration).toContain("set search_path to 'public'");
    expect(returnAssignmentConditionMigration).toContain("revoke all on function public.request_inspect_return(uuid, jsonb) from public, anon");
  });

  it("requires a clear rejection reason on the server", () => {
    expect(migration).toMatch(/v_reason is null or length\(v_reason\) < 3/);
    expect(migration).toContain("'reason_required'");
  });

  it("keeps employee assignments protected while routing rental returns through inspection", () => {
    expect(employeeReturnMigration).toContain("security definer");
    expect(employeeReturnMigration).toContain("set search_path to ''");
    expect(employeeReturnMigration).toContain("v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager')");
    expect(employeeReturnMigration).toContain("public.request_deliver(p_id)");
    expect(employeeReturnMigration).toContain("v_request.beneficiary_type, 'customer') = 'employee'");
    expect(employeeReturnMigration).toContain("set status = 'delivered'");
    expect(employeeReturnMigration).toContain("revoke all on function public.request_deliver_with_proof(uuid, jsonb, uuid)");
    expect(employeeReturnMigration).toContain("to authenticated");
    expect(employeeRentalDeliveryMigration).toContain("v_target = 'assigned'");
    expect(employeeRentalDeliveryMigration).toContain("already_assigned");
    expect(employeeRentalDeliveryMigration).toContain("set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,");
    expect(employeeRentalDeliveryMigration).not.toContain("beneficiary_type,'customer') = 'employee' or v_req.request_type = 'sale'");
  });
});
