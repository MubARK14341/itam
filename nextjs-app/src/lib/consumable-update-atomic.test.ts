import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import { updateConsumable } from "./queries";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/20260817180018_consumable_update_atomic_boundary.sql",
  ),
  "utf8",
);
const enforcementMigration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/20260817180526_consumable_quantity_stocktake_enforcement.sql",
  ),
  "utf8",
);
const queries = readFileSync(resolve(import.meta.dirname, "queries.ts"), "utf8");
const dialogs = readFileSync(
  resolve(import.meta.dirname, "../components/consumables/consumable-dialogs.tsx"),
  "utf8",
);

const input = {
  category_id: "category-1",
  name: "Printer Paper",
  sku: "PAPER-A4",
  brand: "Example",
  unit: "ream",
  reorder_level: 10,
  notes: "Office stock",
  company_id: null,
  supplier_id: "supplier-1",
  location_id: "location-1",
  rfid_tag: null,
};

describe("atomic consumable update boundary", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("routes the complete metadata profile through one RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, quantity_on_hand: 42 }, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(updateConsumable("consumable-1", input)).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("consumable_update_atomic", {
      p_consumable_id: "consumable-1",
      p_input: input,
    });
    expect(queries).not.toMatch(/from\(["']consumables["']\)\.update\(/);
  });

  it("preserves RPC and transport failures without a second write", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: false, error: "not_authorized" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "network_failed" } });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(updateConsumable("consumable-1", input)).resolves.toBe("not_authorized");
    await expect(updateConsumable("consumable-1", input)).resolves.toBe("network_failed");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("locks before updating metadata and never writes a balance or ledger row", () => {
    const lockAt = enforcementMigration.indexOf("for update;");
    const updateAt = enforcementMigration.indexOf("update public.consumables", lockAt);
    expect(lockAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(lockAt);
    expect(enforcementMigration).not.toContain("insert into public.consumable_transactions");
    expect(enforcementMigration).not.toMatch(/set[\s\S]*quantity_on_hand\s*=/);
  });

  it("rejects every quantity-bearing RPC payload and removes quantity from the UI request", () => {
    expect(enforcementMigration).toContain("if p_input ? 'quantity_on_hand' then");
    expect(enforcementMigration).toContain("'quantity_requires_stocktake'");
    expect(dialogs).toMatch(/value=\{f\.quantity_on_hand\} readOnly aria-readonly="true"/);
    expect(dialogs).not.toMatch(/quantity_on_hand:\s*quantity\.value/);
    expect(queries).not.toMatch(/type:\s*"in"\s*\|\s*"out"\s*\|\s*"adjust"/);
  });

  it("self-authorizes and removes browser writes from inventory and ledger", () => {
    expect(migration).toContain("current_user_has_capability('consumable.manage')");
    expect(migration).toMatch(/revoke all on function public\.consumable_update_atomic/);
    expect(migration).toMatch(/grant execute on function public\.consumable_update_atomic/);
    expect(migration).toMatch(
      /revoke insert, update, delete\s+on public\.consumables, public\.consumable_transactions\s+from anon, authenticated;/,
    );
    for (const table of ["consumables", "consumable_transactions"]) {
      expect(migration).toContain(`drop policy if exists upd_managers on public.${table};`);
      expect(migration).toContain(`drop policy if exists del_admin on public.${table};`);
    }
  });
});
