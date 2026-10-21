import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const migration = readFileSync(
  resolve(root, "migrations/20260731160000_employee_self_service.sql"),
  "utf8",
);

describe("employee self-service contract", () => {
  it("creates a real employee role with only self-service capabilities", () => {
    expect(migration).toContain("'employee'");
    for (const capability of [
      "request.self.create",
      "request.self.read",
      "request.self.reply",
      "custody.self.read",
      "maintenance.self.report",
      "custody.self.return_request",
    ]) {
      expect(migration).toContain(`'${capability}'`);
    }
  });

  it("requires an approved explicit employee link and never auto-creates one", () => {
    expect(migration).toContain("create or replace function public.current_employee_id()");
    expect(migration).toContain("u.approval_status = 'approved'");
    expect(migration).toContain("r.key = 'employee'");
    expect(migration).toContain("'employee_link_required'");
    expect(migration).not.toMatch(/insert into public\.employees/i);
    expect(migration).not.toMatch(/update public\.app_users\s+set employee_id/i);
  });

  it("replaces broad permissive reads with employee self policies", () => {
    for (const table of [
      "assets",
      "asset_assignments",
      "employees",
      "requests",
      "request_items",
      "request_events",
      "maintenance_records",
    ]) {
      expect(migration).toContain(`drop policy if exists sel_auth on public.${table}`);
      expect(migration).toContain(`sel_employee_self on public.${table}`);
    }
  });

  it("keeps inventory identifiers and financial fields out of employee creation", () => {
    for (const field of [
      "asset_id",
      "serial_number",
      "qr_token",
      "rfid_tag",
      "asset_tag",
      "consumable_id",
      "unit_price",
      "total_price",
      "beneficiary_employee_id",
    ]) {
      expect(migration).toContain(`'${field}'`);
    }
    expect(migration).toContain("'server_fields_forbidden'");
  });

  it("records return intent without invoking or updating custody", () => {
    const returnFunction = migration.slice(
      migration.indexOf("create or replace function public.employee_request_asset_return"),
      migration.indexOf("create or replace function public.employee_my_return_requests"),
    );
    expect(returnFunction).toContain("insert into public.employee_asset_return_requests");
    expect(returnFunction).not.toContain("public.asset_return");
    expect(returnFunction).not.toMatch(/update public\.assets/i);
    expect(returnFunction).not.toMatch(/update public\.asset_assignments/i);
  });
});
