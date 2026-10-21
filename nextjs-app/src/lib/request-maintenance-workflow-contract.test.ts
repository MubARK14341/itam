import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "migrations/20260731210000_request_maintenance_workflow.sql"),
  "utf8",
);
const requests = readFileSync(resolve(root, "src/lib/requests.ts"), "utf8");
const queries = readFileSync(resolve(root, "src/lib/queries.ts"), "utf8");

describe("request and maintenance workflow contract", () => {
  it("blocks direct approved-scope edits and requires versioned reapproval", () => {
    expect(migration).toContain("approved_request_requires_amendment");
    expect(migration).toContain("approved_request_items_require_amendment");
    expect(migration).toContain("create table if not exists public.request_amendments");
    expect(migration).toContain("independent_review_required");
    expect(migration).toContain("status = 'under_review'");
    expect(migration).toContain("scope_version = scope_version + 1");
    expect(migration).toContain("public._request_release_reservations");
    expect(migration).toContain("v_amendment_reset boolean");
    expect(migration).toContain("new.prepared_by := null");
    expect(migration).toMatch(/v_request_status not in \([\s\S]*?'ready_for_pickup'/);
  });

  it("allows only trusted provisioning RPCs to materialize approved demand", () => {
    expect(migration).toContain("app.request_fulfillment_apply");
    expect(migration).toMatch(
      /create or replace function public\.request_approve[\s\S]*?_request_auto_provision/,
    );
    expect(migration).toMatch(
      /create or replace function public\.request_shortage_fulfill_available[\s\S]*?request_fulfillment_apply/,
    );
    expect(migration).not.toContain(
      "grant execute on function public._request_auto_provision(uuid) to authenticated",
    );
  });

  it("requires return evidence newer than the current checkout", () => {
    expect(migration).toMatch(
      /create or replace function public\.request_complete[\s\S]*?last_return_at >= a\.last_out_at/,
    );
    expect(migration).toContain("a.last_request_id = p_id");
  });

  it("serializes idempotency keys before executing business operations", () => {
    expect(migration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(migration).toContain("create or replace function public.request_operation_result_lookup");
    expect(requests).toContain('"request_create_idempotent"');
    expect(requests).toContain('"request_execute_idempotent"');
    expect(requests).toContain('"request_operation_result_lookup"');
  });

  it("requires maintenance evidence before closure and exposes work evidence interfaces", () => {
    expect(migration).toContain("maintenance_completion_evidence_required");
    expect(migration).toContain("maintenance_waiting_reason_required");
    expect(migration).toContain("create table if not exists public.maintenance_time_entries");
    expect(migration).toContain("create table if not exists public.maintenance_parts");
    expect(migration).toContain("create or replace function public.maintenance_add_time_entry");
    expect(migration).toContain("create or replace function public.maintenance_plan_part");
    expect(migration).toContain("create or replace function public._maintenance_sla_stamp");
    expect(migration).toContain("create or replace function public.maintenance_confirm_handoff");
    expect(migration).toContain("and sla_due_at < now()");
    expect(queries).toContain('"maintenance_update_safe"');
    expect(queries).toContain("technicianId?: string");
    expect(migration).toMatch(
      /grant select \([\s\S]*?functional_test_passed[\s\S]*?handoff_state[\s\S]*?\) on public\.maintenance_records to authenticated/,
    );
  });

  it("keeps maintenance evidence writes behind RPCs", () => {
    expect(migration).toContain(
      "revoke all on public.maintenance_time_entries from public, anon, authenticated",
    );
    expect(migration).toContain(
      "revoke all on public.maintenance_parts from public, anon, authenticated",
    );
    expect(migration).not.toContain(
      "grant insert on public.maintenance_time_entries to authenticated",
    );
    expect(migration).not.toContain(
      "grant insert on public.maintenance_parts to authenticated",
    );
  });
});
