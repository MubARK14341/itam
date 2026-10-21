import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const baseline = fs.readFileSync(
  path.join(
    process.cwd(),
    "migrations/_baseline/00_full_db_snapshot_20260707.sql",
  ),
  "utf8",
);
const authzBootstrap = fs.readFileSync(
  path.join(process.cwd(), "scripts/test/bootstrap-pre-remediation-authz.sql"),
  "utf8",
);

describe("schema baseline reproducibility", () => {
  it("defers generated function-body dependency checks only during restore", () => {
    const disable = baseline.indexOf("set check_function_bodies = false;");
    const firstFunction = baseline.indexOf("CREATE OR REPLACE FUNCTION");
    const restore = baseline.lastIndexOf("set check_function_bodies = true;");

    expect(disable).toBeGreaterThan(-1);
    expect(disable).toBeLessThan(firstFunction);
    expect(restore).toBeGreaterThan(firstFunction);
  });

  it("restores eager function-body validation at the end of the snapshot", () => {
    expect(baseline.trimEnd()).toMatch(/set check_function_bodies = true;$/);
  });

  it("keeps omitted authorization reference data in an explicit test-only bootstrap", () => {
    expect(authzBootstrap).toContain("TEST ONLY — never apply to production");
    for (const role of [
      "admin", "it_manager", "technician", "warehouse_manager", "viewer", "auditor",
    ]) {
      expect(authzBootstrap).toContain(`('${role}'`);
    }
    expect(authzBootstrap).toContain("unexpected pre-remediation role mapping count");
    expect(authzBootstrap).toContain("if v_count <> 63");
  });
});
