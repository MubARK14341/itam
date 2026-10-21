import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import {
  createCustomer,
  setCustomerActive,
  updateCustomer,
  type CustomerInput,
} from "./requests";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/20260817170623_customer_portal_activity_gate.sql",
  ),
  "utf8",
);
const requestsSource = readFileSync(resolve(import.meta.dirname, "requests.ts"), "utf8");
const customerMutations = requestsSource.slice(
  requestsSource.indexOf("function customerInputPayload"),
  requestsSource.indexOf("// =========================================================================\n// بيانات نموذج إنشاء الطلب"),
);

const input: CustomerInput = {
  name: "  Example Customer  ",
  contact_person: "  Owner  ",
  phone: "  +966500000000  ",
  email: "  demo@example.invalid  ",
  city: "  Riyadh  ",
  address: "  Main Street  ",
  notes: "  Preferred  ",
  is_active: true,
};

describe("customer and portal activity boundary", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("routes create, update, and activation through role-gated RPCs", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: true, id: "customer-1" }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, id: "customer-1" }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, id: "customer-1" }, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(createCustomer(input)).resolves.toEqual({
      error: null,
      id: "customer-1",
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "customer_save_atomic", {
      p_customer_id: null,
      p_input: {
        name: "Example Customer",
        contact_person: "Owner",
        phone: "+966500000000",
        email: "demo@example.invalid",
        city: "Riyadh",
        address: "Main Street",
        notes: "Preferred",
        is_active: true,
      },
    });

    await expect(updateCustomer("customer-1", input)).resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(2, "customer_save_atomic", {
      p_customer_id: "customer-1",
      p_input: expect.objectContaining({ name: "Example Customer" }),
    });

    await expect(setCustomerActive("customer-1", false)).resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(3, "customer_set_active", {
      p_customer_id: "customer-1",
      p_is_active: false,
    });
  });

  it("preserves RPC and transport failures without falling back to direct DML", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: false, error: "not_authorized" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "network_failed" } })
      .mockResolvedValueOnce({ data: { ok: false, error: "not_found" }, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(createCustomer(input)).resolves.toEqual({
      error: "not_authorized",
      id: null,
    });
    await expect(updateCustomer("customer-1", input)).resolves.toBe("network_failed");
    await expect(setCustomerActive("customer-1", false)).resolves.toBe("not_found");
    expect(customerMutations).not.toMatch(
      /\.from\("customers"\)[\s\S]*\.(insert|update|delete)/,
    );
  });

  it("separates disabled-account context from operational portal identity", () => {
    expect(migration).toContain("function public.portal_account_customer_id()");
    expect(migration).toMatch(
      /function public\.portal_customer_id\(\)[\s\S]*c\.is_active = true[\s\S]*approval_status[\s\S]*s\.portal_enabled = true/,
    );
    expect(migration).toMatch(
      /function public\.portal_get_context\(\)[\s\S]*public\.portal_account_customer_id\(\)/,
    );
    expect(migration).toMatch(
      /function public\.is_portal_user\(\)[\s\S]*public\.portal_customer_id\(\) is not null/,
    );
    expect(migration).toMatch(
      /function public\._portal_settings\(p_customer_id uuid\)[\s\S]*c\.is_active = true/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.portal_account_customer_id\(\)[\s\S]*from public, anon, authenticated, service_role/,
    );
  });

  it("keeps authorization, validation, and row locking inside customer mutations", () => {
    expect(migration).toContain("function public.customer_save_atomic(");
    expect(migration).toContain("function public.customer_set_active(");
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("public.app_user_role() not in ('admin', 'it_manager')");
    expect(migration).toContain("jsonb_typeof(p_input) <> 'object'");
    expect(migration).toContain("for update;");
    expect(migration).toContain("'approved',\n      v_actor");
    expect(migration).toMatch(
      /function public\.approve_customer\([\s\S]*approval_status = 'rejected',[\s\S]*is_active = false/,
    );
  });

  it("removes direct customer writes while preserving only checked RPC entry points", () => {
    expect(migration).toContain("drop policy if exists ins_mgr on public.customers;");
    expect(migration).toContain("drop policy if exists upd_mgr on public.customers;");
    expect(migration).toContain("drop policy if exists del_admin on public.customers;");
    expect(migration).toMatch(
      /revoke insert, update, delete on table public\.customers\s+from public, anon, authenticated;/,
    );
    expect(migration).toContain(
      "grant execute on function public.customer_save_atomic(uuid, jsonb) to authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.customer_set_active(uuid, boolean) to authenticated;",
    );
  });
});
