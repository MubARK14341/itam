import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "migrations/20260715043000_harden_security_definer_anon_grants.sql"), "utf8");

const internalFunctions = [
  "app_user_role()",
  "approve_customer(uuid, boolean)",
  "request_auto_provision(p_id uuid)",
  "request_create_employee_self(p_status text, p_project_name text, p_pickup_date date, p_return_date date, p_notes text, p_items jsonb)",
  "request_inspect_return(p_id uuid, p_lines jsonb)",
  "request_shortage_fulfill_available(p_id uuid)",
  "user_label(uid uuid)",
];

describe("SECURITY DEFINER anonymous grant hardening", () => {
  it("removes PUBLIC and anon execution while preserving authenticated and service-role callers", () => {
    for (const signature of internalFunctions) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated, service_role;`);
    }
  });

  it("does not alter the intentionally public QR and registration entry points", () => {
    expect(migration).not.toMatch(/public_asset_by_token|registration_status|validate_portal_invite|validate_registration_invite/);
  });
});
