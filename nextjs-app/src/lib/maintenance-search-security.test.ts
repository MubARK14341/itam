import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../../migrations/20260816213510_maintenance_search_index.sql"),
  "utf8",
);
const queries = readFileSync(resolve(import.meta.dirname, "queries.ts"), "utf8");
const maintenancePage = readFileSync(
  resolve(import.meta.dirname, "../app/(app)/maintenance/page-client.tsx"),
  "utf8",
);
const maintenanceQuery = queries.slice(
  queries.indexOf("export async function listMaintenancePage"),
  queries.indexOf("export async function listMaintenance()"),
);

describe("maintenance search security contract", () => {
  it("uses a security-invoker, non-financial projection with explicit grants", () => {
    expect(migration).toMatch(
      /create or replace view public\.maintenance_search_index\s+with \(security_invoker = true\)/,
    );
    const definition = migration.slice(
      migration.indexOf("create or replace view"),
      migration.indexOf("revoke all"),
    );
    expect(definition).not.toMatch(/\bcost\b|cost_recorded|invoice_|\bfinancial\b/i);
    expect(migration).toContain("revoke all on public.maintenance_search_index from public;");
    expect(migration).toContain("revoke all on public.maintenance_search_index from anon;");
    expect(migration).toContain("revoke all on public.maintenance_search_index from authenticated;");
    expect(migration).toContain("grant select on public.maintenance_search_index to authenticated;");
  });

  it("searches the flattened view and hydrates only the selected page", () => {
    expect(maintenanceQuery).toContain('sb.from("maintenance_search_index")');
    expect(maintenanceQuery).toContain('select("id,reported_at"');
    expect(maintenanceQuery).toContain("asset_serial_number.ilike.");
    expect(maintenanceQuery).toContain('.from("maintenance_records")');
    expect(maintenanceQuery).toContain('.in("id", page.rows.map((row) => row.id))');
    expect(maintenanceQuery).not.toContain('sb.from("assets")');
    expect(maintenanceQuery).not.toContain(".limit(100)");
  });

  it("does not discard server matches on asset name or serial number", () => {
    expect(maintenancePage).toContain("r.asset?.name");
    expect(maintenancePage).toContain("r.asset?.serial_number");
  });
});
