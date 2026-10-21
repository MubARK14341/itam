import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(resolve(root, "migrations/20260716000000_rc2_restrict_invoice_metadata_and_direct_mutations.sql"), "utf8");
const queries = readFileSync(resolve(root, "src/lib/queries.ts"), "utf8");

describe("RC2 financial invoice isolation contract", () => {
  it("removes direct authenticated invoice reads and restores them only through self-gated RPCs", () => {
    expect(migration).toContain("REVOKE SELECT (invoice_number, invoice_date) ON public.consumable_transactions FROM authenticated;");
    expect(migration).toContain("REVOKE SELECT (invoice_number, invoice_date) ON public.maintenance_records FROM authenticated;");
    expect(migration).toContain("public.consumable_txn_financial_detail");
    expect(migration).toContain("public.maintenance_financial_detail");
    expect(migration).toContain("public.is_financial_viewer()");
  });

  it("keeps invoice fields out of direct PostgREST selects", () => {
    expect(queries).not.toContain("workflow_stage,invoice_number");
    expect(queries).not.toContain("balance_after,invoice_number,reason");
    expect(queries).not.toContain("balance_after,invoice_number,invoice_date,reason");
    expect(queries).toContain("maintenance_financial_truth");
    expect(queries).toContain("consumable_txn_financial_detail");
  });

  it("blocks technician direct mutations while retaining the operational stock RPC", () => {
    expect(migration).toContain("DROP POLICY IF EXISTS upd_ops ON public.assets;");
    expect(migration).toContain("DROP POLICY IF EXISTS upd_ops ON public.consumables;");
    expect(migration).toContain("DROP POLICY IF EXISTS upd_ops ON public.asset_assignments;");
    expect(migration).toContain("financial_fields_forbidden");
    expect(migration).toContain("public.consumable_stock_move");
  });
});
