import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const migration = fs.readFileSync(
  path.join(root, "migrations/20260727152018_atomic_business_operations.sql"),
  "utf8",
);
const queries = fs.readFileSync(path.join(root, "src/lib/queries.ts"), "utf8");
const purchasing = fs.readFileSync(path.join(root, "src/lib/purchase-requests.ts"), "utf8");

describe("atomic business operation contracts", () => {
  it.each([
    "asset_create_atomic",
    "asset_move_atomic",
    "asset_update_atomic",
    "maintenance_create_atomic",
    "maintenance_update_atomic",
    "consumable_create_with_opening_stock",
    "purchase_requests_create_from_shortages",
  ])("defines and protects %s", (name) => {
    expect(migration).toContain(`function public.${name}`);
    expect(migration).toMatch(new RegExp(`revoke all on function public\\.${name}`));
    expect(migration).toMatch(new RegExp(`grant execute on function public\\.${name}`));
  });

  it("routes every former browser multi-write through an RPC", () => {
    expect(queries).toContain('.rpc("asset_create_atomic"');
    expect(queries).toContain('assetRpc("asset_move_atomic"');
    expect(queries).toContain('assetRpc("asset_update_atomic"');
    expect(queries).toContain('.rpc("maintenance_create_atomic"');
    expect(queries).toContain('assetRpc("maintenance_update_safe"');
    expect(queries.match(/\.rpc\("consumable_create_with_opening_stock"/g)).toHaveLength(2);
    expect(purchasing).toContain('.rpc("purchase_requests_create_from_shortages"');
  });

  it("removes direct authenticated inserts for the protected aggregates", () => {
    expect(migration).toMatch(
      /revoke insert on public\.assets,[\s\S]*public\.purchase_request_items[\s\S]*from authenticated;/,
    );
  });

  it("validates a complete shortage batch before creating the first header", () => {
    const validateAt = migration.indexOf("-- Validate the complete payload");
    const insertAt = migration.indexOf("insert into public.purchase_requests", validateAt);
    expect(validateAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(validateAt);
    expect(migration).toContain("'duplicate_item'");
  });
});
