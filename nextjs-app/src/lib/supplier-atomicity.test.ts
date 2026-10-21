import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import {
  createSupplierFull,
  setSupplierActive,
  updateSupplierFull,
  type SupplierInput,
} from "./queries";

const migration = readFileSync(
  resolve(import.meta.dirname, "../../migrations/20260817164103_supplier_atomic_writes.sql"),
  "utf8",
);
const indexMigration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/20260817165350_index_supplier_categories_category.sql",
  ),
  "utf8",
);
const queries = readFileSync(resolve(import.meta.dirname, "queries.ts"), "utf8");
const supplierMutations = queries.slice(
  queries.indexOf("function supplierInputPayload"),
  queries.indexOf("// ======================= Settings: Depreciation rules"),
);

const input: SupplierInput = {
  name: "  Example Supplier  ",
  name_ar: "  مورد تجريبي  ",
  contact_person: "Owner",
  phone: "+966500000000",
  email: "demo@example.invalid",
  address: "Riyadh",
  notes: "Preferred",
  is_active: true,
  category_ids: [
    "11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ],
};

describe("supplier atomic mutation boundary", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("creates and updates supplier metadata with category links through one RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(createSupplierFull(input)).resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(1, "supplier_save_atomic", {
      p_supplier_id: null,
      p_input: expect.objectContaining({
        name: "Example Supplier",
        name_ar: "مورد تجريبي",
        category_ids: [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ],
      }),
    });

    await expect(updateSupplierFull("33333333-3333-4333-8333-333333333333", input))
      .resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(2, "supplier_save_atomic", expect.objectContaining({
      p_supplier_id: "33333333-3333-4333-8333-333333333333",
    }));
  });

  it("routes activation through the role-gated RPC and preserves failures", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: false, error: "not_authorized" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "network_failed" } });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(setSupplierActive("33333333-3333-4333-8333-333333333333", false))
      .resolves.toBe("not_authorized");
    await expect(createSupplierFull(input)).resolves.toBe("network_failed");
    expect(rpc).toHaveBeenNthCalledWith(1, "supplier_set_active", {
      p_supplier_id: "33333333-3333-4333-8333-333333333333",
      p_is_active: false,
    });
  });

  it("keeps authorization, validation, locking, and link replacement inside the transaction", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public");
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("public.app_user_role() not in ('admin', 'it_manager')");
    expect(migration).toContain("for update;");
    expect(migration).toContain("delete from public.supplier_categories");
    expect(migration).toContain("insert into public.supplier_categories");
    expect(migration).toContain("after insert or update or delete on public.suppliers");
    expect(migration).toContain("after insert or update or delete on public.supplier_categories");
    expect(migration.indexOf("invalid_category")).toBeLessThan(
      migration.indexOf("insert into public.suppliers"),
    );
  });

  it("removes direct browser DML and exposes only the checked RPCs", () => {
    expect(migration).toContain("drop policy if exists ins_ops on public.suppliers;");
    expect(migration).toContain("drop policy if exists ins_mgr on public.supplier_categories;");
    expect(migration).toMatch(
      /revoke insert, update, delete on table public\.suppliers\s+from public, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /revoke insert, update, delete on table public\.supplier_categories\s+from public, anon, authenticated;/,
    );
    expect(migration).toContain(
      "grant execute on function public.supplier_save_atomic(uuid, jsonb)",
    );
    expect(migration).toContain(
      "grant execute on function public.supplier_set_active(uuid, boolean)",
    );
    expect(supplierMutations).not.toMatch(
      /\.from\("suppliers"\)[\s\S]*\.(insert|update|delete)/,
    );
    expect(supplierMutations).not.toMatch(/\.from\("supplier_categories"\)/);
  });

  it("covers category-first foreign-key checks without duplicating the supplier-first key", () => {
    expect(indexMigration).toContain(
      "on public.supplier_categories (category_id, supplier_id)",
    );
  });
});
