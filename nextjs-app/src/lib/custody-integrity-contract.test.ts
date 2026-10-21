import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "migrations/20260731110758_custody_integrity_and_reconciliation.sql",
  ),
  "utf8",
);
const exporter = readFileSync(
  resolve(process.cwd(), "scripts/audit/custody-reconciliation.mjs"),
  "utf8",
);
const statusAtomicityFix = readFileSync(
  resolve(process.cwd(), "migrations/20260902173000_fix_asset_status_custody_atomicity.sql"),
  "utf8",
);

describe("P0-03 custody integrity and reconciliation contract", () => {
  it("enforces the asset/assignment invariant in both directions at commit", () => {
    expect(migration).toContain("custody_asset_is_consistent");
    expect(migration).toContain("asset_custody_invariant_violation");
    expect(migration).toContain("trg_assets_custody_consistency");
    expect(migration).toContain("trg_assignments_custody_consistency");
    expect(migration.match(/deferrable initially deferred/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain("inactive_employee_has_active_custody");
    expect(migration).toContain("unique index if not exists uq_active_assignment");
  });

  it("removes browser-side direct assignment mutation", () => {
    expect(migration).toMatch(
      /revoke insert, update, delete on public\.asset_assignments[\s\S]*from anon, authenticated/,
    );
    expect(migration).toContain("current_user_has_capability('asset.assign')");
  });

  it("preserves return evidence in the final RPC definition", () => {
    expect(migration).toContain("last_return_condition = nullif(p_condition, '')");
    expect(migration).toContain("last_return_at = statement_timestamp()");
    expect(migration).toContain("from_employee_id");
  });

  it("keeps primary status changes atomic with active custody closure", () => {
    expect(statusAtomicityFix).toContain("public.custody_asset_is_consistent(p_asset_id)");
    expect(statusAtomicityFix).toMatch(
      /update public\.asset_assignments[\s\S]*status = 'returned'[\s\S]*returned_at = statement_timestamp\(\)/,
    );
    expect(statusAtomicityFix).toContain("and status = 'active'");
    expect(statusAtomicityFix).toContain("set search_path to 'public'");
  });

  it("keeps the legacy proofless delivery RPC closed to browser roles", () => {
    expect(statusAtomicityFix).toMatch(
      /revoke all on function public\.request_deliver\(uuid\)[\s\S]*from public, anon, authenticated/,
    );
    expect(statusAtomicityFix).toMatch(
      /grant execute on function public\.request_deliver\(uuid\)[\s\S]*to service_role/,
    );
  });

  it("creates cases without guessing or correcting source custody", () => {
    for (const anomaly of [
      "assigned_without_holder",
      "assigned_without_active",
      "multiple_active",
      "holder_mismatch",
      "active_on_nonassigned",
      "inactive_employee",
    ]) {
      expect(migration).toContain(`'${anomaly}'`);
    }
    expect(migration).toContain("custody_reconciliation_cases");
    expect(migration).toContain("resolution_evidence_required");
    expect(migration).toContain("select public._custody_reconciliation_refresh()");
    expect(migration).not.toMatch(
      /select public\._custody_reconciliation_refresh\(\);[\s\S]*update public\.(assets|asset_assignments)/,
    );
  });

  it("ships a read-only CSV worklist exporter", () => {
    expect(exporter).toContain("Read-only custody reconciliation CSV export");
    expect(exporter).toContain('from("custody_reconciliation_cases")');
    expect(exporter).not.toContain(".insert(");
    expect(exporter).not.toContain(".update(");
    expect(exporter).not.toContain(".delete(");
    expect(migration).toMatch(
      /grant select on public\.custody_reconciliation_cases\s+to service_role;/,
    );
  });
});
