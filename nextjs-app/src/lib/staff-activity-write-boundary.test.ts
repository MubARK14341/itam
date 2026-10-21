import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import {
  assignMaintenanceTechnician,
  setAssetSerialExempt,
  updateAssetSerial,
} from "./queries";

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/20260817174126_staff_activity_and_operational_write_boundary.sql",
  ),
  "utf8",
);
const authStateMigration = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/20260817174845_inactive_staff_auth_state.sql",
  ),
  "utf8",
);
const queries = readFileSync(resolve(import.meta.dirname, "queries.ts"), "utf8");
const middleware = readFileSync(resolve(import.meta.dirname, "supabase/middleware.ts"), "utf8");

describe("staff activity and operational write boundary", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("routes serial and technician changes only through protected RPCs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(updateAssetSerial("asset-1", "  SN-42  ")).resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(1, "asset_set_serial", {
      p_asset_id: "asset-1",
      p_serial: "SN-42",
    });

    await expect(setAssetSerialExempt("asset-1", true, "  legacy device  ")).resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(2, "asset_set_serial_exempt", {
      p_asset_id: "asset-1",
      p_exempt: true,
      p_reason: "legacy device",
    });

    await expect(assignMaintenanceTechnician("maintenance-1", "user-1")).resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(3, "maintenance_assign_technician", {
      p_id: "maintenance-1",
      p_technician_id: "user-1",
    });

    expect(queries).not.toMatch(/from\(["']assets["']\)\.update\(/);
    expect(queries).not.toMatch(/from\(["']maintenance_records["']\)\.update\(/);
  });

  it("keeps empty serials fail-closed before making a database call", async () => {
    const rpc = vi.fn();
    supabaseMock.createClient.mockReturnValue({ rpc });
    await expect(updateAssetSerial("asset-1", "   ")).resolves.toBe("empty");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires active staff in both canonical authorization resolvers", () => {
    expect(migration).toMatch(
      /function public\.is_approved\(\)[\s\S]*u\.id = auth\.uid\(\)[\s\S]*and u\.is_active[\s\S]*and u\.approval_status = 'approved'/,
    );
    expect(migration).toMatch(
      /function public\.has_capability\(p_user uuid, p_key text\)[\s\S]*u\.id = p_user[\s\S]*and u\.is_active[\s\S]*and u\.approval_status = 'approved'/,
    );
    expect(migration).toContain("function public.app_users_enforce_access_state()");
    expect(migration).toContain("new.is_active := false;");
    expect(migration).toContain("new.is_active := true;");
  });

  it("keeps inactive staff out of approved middleware routing", () => {
    expect(authStateMigration).toContain("function public.auth_security_state()");
    expect(authStateMigration).toContain("u.is_active");
    expect(authStateMigration).toMatch(
      /when v_user_id is not null and not coalesce\(v_active, false\) then 'rejected'/,
    );
    expect(authStateMigration).toMatch(
      /when coalesce\(v_active, false\) and v_status = 'approved' then v_role/,
    );
    expect(authStateMigration).toContain("'is_active'");
    // Staff state is loaded for the cookie identity in parallel with Auth verification and only
    // honoured when the verified user is that same identity.
    expect(middleware).toContain("getStaffAccessState(supabase, claimedUserId)");
    expect(middleware).toContain("supabase.auth.getUser()");
    expect(middleware).toContain("user.id !== claimedUserId");
    expect(middleware).toContain("!staff.is_active");
  });

  it("self-authorizes, locks rows, and rejects terminal or invalid targets", () => {
    for (const name of [
      "asset_set_serial",
      "asset_set_serial_exempt",
      "maintenance_assign_technician",
    ]) {
      expect(migration).toContain(`function public.${name}(`);
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${name}`));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${name}`));
    }
    expect(migration).toContain("current_user_has_capability('asset.update')");
    expect(migration).toContain("current_user_has_capability('maintenance.manage')");
    expect(migration).toContain("public.has_capability(v_technician, 'maintenance.manage')");
    expect(migration.match(/for update;/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain("'maintenance_closed'");
  });

  it("removes direct browser mutation grants and write policies", () => {
    expect(migration).toMatch(
      /revoke insert, update, delete on public\.assets, public\.maintenance_records\s+from anon, authenticated;/,
    );
    for (const table of ["assets", "maintenance_records"]) {
      expect(migration).toContain(`drop policy if exists upd_capability on public.${table};`);
      expect(migration).toContain(`drop policy if exists del_admin on public.${table};`);
    }
  });
});
