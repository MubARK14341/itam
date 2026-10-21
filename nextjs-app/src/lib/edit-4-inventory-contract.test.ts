import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/20260806160000_edit_4_inventory_scope_and_discrepancy_review.sql"), "utf8");
const stocktakes = readFileSync(resolve(import.meta.dirname, "../app/(app)/stocktakes/page.tsx"), "utf8");

describe("EDIT 4 scoped inventory contract", () => {
  it("freezes full or category-scoped snapshots without archived assets", () => {
    expect(migration).toContain("scope_kind");
    expect(migration).toContain("scope_category_id");
    expect(migration).toContain("a.archived_at is null");
    expect(migration).toContain("p_scope_kind='partial'");
  });

  it("keeps duplicate evidence and manager-only discrepancy decisions", () => {
    expect(migration).toContain("duplicate_scan");
    expect(migration).toContain("stocktake_decide_item");
    expect(migration).toContain("approve_correction");
    expect(migration).toContain("keep_current");
    expect(migration).toContain("request_recheck");
    expect(migration).toContain("_stocktake_can_review");
  });

  it("exposes only full and partial physical inventory choices", () => {
    expect(stocktakes).toContain('startFieldStocktake("full")');
    expect(stocktakes).toContain('startFieldStocktake("partial")');
    expect(stocktakes).toContain("fullInventory");
    expect(stocktakes).toContain("partialInventory");
  });

  it("keeps a completed-session A4 print/PDF report with repeating table headers", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../app/globals.css"), "utf8");
    expect(stocktakes).toContain("print-stocktake-report");
    expect(stocktakes).toContain("printPhysicalReport");
    expect(css).toContain(".print-stocktake-report thead");
    expect(css).toContain("display: table-header-group");
  });
});
