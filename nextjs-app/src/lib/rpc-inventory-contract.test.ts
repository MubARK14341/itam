import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const inventory = () => readFileSync(
  resolve(root, "docs/audit-remediation/RPC_INVENTORY.md"),
  "utf8",
);

describe("application RPC inventory contract", () => {
  it("keeps the generated inventory synchronized with source and migrations", () => {
    expect(() => execFileSync(
      process.execPath,
      ["scripts/audit/generate-rpc-inventory.mjs", "--check"],
      { cwd: root, stdio: "pipe" },
    )).not.toThrow();
  });

  it("documents migrations for every critical release RPC", () => {
    const document = inventory();
    for (const name of [
      "asset_create_atomic",
      "consumable_create_with_opening_stock",
      "maintenance_create_atomic",
      "request_create_idempotent",
      "procurement_record_external_document",
      "dashboard_operational_summary",
      "app_schema_compatibility",
    ]) {
      expect(document).toContain(`\`${name}\``);
    }
    expect(document).toContain("Missing definitions: none.");
  });
});
