import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "migrations/20260727144004_harden_staff_request_creation.sql"),
  "utf8",
);
const requestsClient = readFileSync(resolve(root, "src/lib/requests.ts"), "utf8");

describe("F-001 staff request creation security contract", () => {
  it("routes staff creation through one server transaction", () => {
    expect(requestsClient).toContain('.rpc("request_create_idempotent"');
    expect(requestsClient).not.toMatch(/from\(["']requests["']\)\.insert/);
    expect(requestsClient).not.toMatch(/from\(["']request_items["']\)\.insert/);
    expect(migration).toContain("begin;");
    expect(migration).toContain("commit;");
    expect(migration).toContain("Validate the complete payload before inserting the header");
  });

  it("derives actor and protected workflow fields on the server", () => {
    expect(migration).toContain("v_uid uuid := auth.uid()");
    expect(migration).toContain("'internal'");
    expect(migration).toContain("'not_required'");
    expect(migration).toMatch(/submitted_by,[\s\S]*created_by,[\s\S]*request_source/);
    expect(migration).toContain("'server_fields_forbidden'");
    for (const protectedField of [
      "unit_price",
      "total_price",
      "approved_quantity",
      "delivered_quantity",
      "returned_quantity",
      "needs_purchase",
      "asset_id",
    ]) {
      expect(migration).toContain(`'${protectedField}'`);
    }
  });

  it("allows operational creators but denies read-only and external roles", () => {
    for (const allowedRole of [
      "admin",
      "it_manager",
      "technician",
      "warehouse_manager",
    ]) {
      expect(migration).toContain(`'${allowedRole}'`);
    }
    expect(migration).not.toMatch(
      /v_role\s+not\s+in\s*\([^)]*'(viewer|auditor|client|pending|rejected)'/,
    );
    expect(migration).toContain("'not_authorized'");
    expect(migration).toContain(
      "create or replace function public.request_create_employee_self(",
    );
    expect(migration).not.toContain("greatest(1");
  });

  it("removes direct mutation privileges and public function execution", () => {
    expect(migration).toContain(
      "revoke insert, update, delete, truncate, references, trigger\n  on public.requests from authenticated;",
    );
    expect(migration).toContain(
      "revoke insert, update, delete, truncate, references, trigger\n  on public.request_items from authenticated;",
    );
    expect(migration).toMatch(
      /revoke all on function public\.request_create_staff\([\s\S]*\) from public, anon;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.request_create_staff\([\s\S]*\) to authenticated;/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.request_create_employee_self\([\s\S]*\) from public, anon;/,
    );
  });

  it("rejects unsafe quantities, physical identifiers, and invalid references", () => {
    expect(migration).toContain("v_quantity <= 0");
    expect(migration).toContain("v_quantity > 1000000");
    expect(migration).toContain("v_quantity <> trunc(v_quantity)");
    expect(migration).toContain("'invalid_item_kind'");
    expect(migration).toContain("'consumable_not_found'");
    expect(migration).toContain("'company_not_found'");
    expect(migration).toContain("'insufficient_stock'");
  });
});
