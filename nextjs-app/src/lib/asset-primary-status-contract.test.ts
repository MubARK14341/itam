import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATUS_AR } from "./format";

const migration = readFileSync(
  new URL("../../migrations/20260812150000_asset_primary_status_simplification.sql", import.meta.url),
  "utf8",
);

describe("asset primary status contract", () => {
  it("exposes exactly the three canonical primary states", () => {
    expect(Object.keys(STATUS_AR).sort()).toEqual([
      "available", "in_maintenance", "reserved",
    ]);
  });

  it("enforces canonical active rows and preserves legacy values only in history", () => {
    expect(migration).toContain("check (status in ('available','reserved','in_maintenance'))");
    expect(migration).toContain("where status in ('assigned','rented')");
    expect(migration).toContain("where status in ('sold','disposed','lost','retired')");
    expect(migration).toContain("reserved_asset_requires_active_relationship");
    expect(migration).toContain("asset_movements");
  });
});
