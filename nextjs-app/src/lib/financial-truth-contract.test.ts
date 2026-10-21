import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "migrations/20260731123640_financial_truthfulness.sql",
  ),
  "utf8",
);
const queries = readFileSync(
  resolve(process.cwd(), "src/lib/queries.ts"),
  "utf8",
);

describe("P0-04 database financial truth contract", () => {
  it("makes missing maintenance cost representable without rewriting amounts", () => {
    expect(migration).toContain("alter column cost drop not null");
    expect(migration).toContain("alter column cost drop default");
    expect(migration).toContain("cost_recorded boolean not null default false");
    expect(migration).toContain("new.cost := null");
    expect(migration).toContain("maintenance_create_atomic");
    expect(migration).not.toContain("coalesce(v_cost, 0)");
    expect(migration).not.toMatch(/update\s+public\.maintenance_records/i);
  });

  it("keeps maintenance zero distinct through explicit provenance", () => {
    expect(migration).toContain("new.cost_recorded := new.cost is not null");
    expect(migration).toContain("maintenance_financial_truth");
    expect(queries).toContain("maintenance_financial_truth");
    expect(queries).toContain('"cost_recorded"');
  });

  it("ships a finance-only queue without exposing amounts", () => {
    expect(migration).toContain("financial_asset_data_quality");
    expect(migration).toContain("financial_data_quality_summary");
    expect(migration).toContain("financial_data_quality_list");
    expect(migration).toContain("financial_fields_forbidden");
    expect(migration).toContain("'purchase_cost'");
    expect(migration).toContain("'purchase_date'");
    expect(migration).toContain("'warranty_end'");
    expect(migration).toContain("'manufacturer'");
    expect(migration).toContain("'model'");

    const view = migration.match(
      /create or replace view public\.financial_asset_data_quality[\s\S]*?revoke all on public\.financial_asset_data_quality/,
    )?.[0] ?? "";
    expect(view).not.toMatch(/select[\s\S]*a\.purchase_cost\s*(,|\n)/i);
  });
});
