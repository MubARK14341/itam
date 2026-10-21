import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: supabaseMock.createClient,
}));

import {
  createInvite,
  setInviteActive,
  updateInvite,
  updateRegistrationSettings,
  type InviteInput,
  type RegistrationSettingsRow,
} from "./queries";

const root = resolve(import.meta.dirname, "../..");
const migration = readFileSync(
  resolve(root, "migrations/20260817204500_registration_admission_rpc_boundary.sql"),
  "utf8",
);
const compatibilityMigration = readFileSync(
  resolve(root, "migrations/20260817221500_registration_trusted_provisioning_compatibility.sql"),
  "utf8",
);
const queries = readFileSync(resolve(root, "src/lib/queries.ts"), "utf8");

const settings: RegistrationSettingsRow = {
  mode: "invite_only",
  require_email_verification: false,
  remaining_slots: 0,
  default_requested_role: "viewer",
  message_ar: null,
  message_en: null,
};
const invite: InviteInput = {
  label: "Temporary access",
  default_role: "employee",
  max_uses: 1,
  expires_at: "2027-01-01T00:00:00.000Z",
  is_active: true,
};

describe("registration admission and administration boundary", () => {
  beforeEach(() => {
    supabaseMock.createClient.mockReset();
  });

  it("routes every browser mutation through narrow RPCs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(updateRegistrationSettings(settings)).resolves.toBeNull();
    await expect(createInvite(invite)).resolves.toBeNull();
    await expect(updateInvite("invite-1", invite)).resolves.toBeNull();
    await expect(setInviteActive("invite-1", false)).resolves.toBeNull();

    expect(rpc).toHaveBeenNthCalledWith(1, "registration_settings_update_atomic", {
      p_input: settings,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "registration_invite_create_atomic", {
      p_input: {
        label: invite.label,
        default_role: invite.default_role,
        max_uses: invite.max_uses,
        expires_at: invite.expires_at,
        is_active: invite.is_active,
      },
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "registration_invite_update_atomic", {
      p_invite_id: "invite-1",
      p_input: {
        label: invite.label,
        default_role: invite.default_role,
        max_uses: invite.max_uses,
        expires_at: invite.expires_at,
        is_active: invite.is_active,
      },
    });
    expect(rpc).toHaveBeenNthCalledWith(4, "registration_invite_set_active", {
      p_invite_id: "invite-1",
      p_is_active: false,
    });
    expect(rpc.mock.calls[1]?.[1]?.p_input).not.toHaveProperty("code");
    expect(rpc.mock.calls[2]?.[1]?.p_input).not.toHaveProperty("code");
    expect(queries).not.toMatch(
      /from\(["']registration_(settings|invites|invite_uses)["']\)[\s\S]{0,180}\.(insert|update|delete)\(/,
    );
  });

  it("preserves RPC and transport failures", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: false, error: "not_authorized" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "network_failed" } });
    supabaseMock.createClient.mockReturnValue({ rpc });

    await expect(updateRegistrationSettings(settings)).resolves.toBe("not_authorized");
    await expect(createInvite(invite)).resolves.toBe("network_failed");
  });

  it("fails closed for every staff admission mode and ignores metadata roles", () => {
    for (const error of [
      "staff_registration_configuration_missing",
      "staff_registration_closed",
      "staff_registration_configuration_invalid",
      "staff_registration_domain_not_allowed",
      "staff_registration_invite_required",
      "staff_registration_capacity_exhausted",
      "staff_registration_invite_invalid",
    ]) {
      expect(migration).toContain(`raise exception '${error}'`);
    }
    expect(migration).toContain("for update;");
    expect(migration).toContain("set remaining_slots = remaining_slots - 1");
    expect(migration).toContain("set used_count = used_count + 1");
    expect(migration).toContain("requested_role in user metadata is intentionally ignored");
    expect(migration).toContain(
      "v_requested_role := public._registration_staff_claim(new.id, new.email, v_code)",
    );
    expect(migration).not.toContain("meta->>'requested_role'");
  });

  it("removes browser DML and self-authorizes validated administration", () => {
    expect(migration).toContain("current_user_has_capability('settings.manage')");
    expect(migration).toMatch(
      /revoke insert, update, delete on[\s\S]*public\.registration_settings,[\s\S]*public\.registration_invites,[\s\S]*public\.registration_invite_uses[\s\S]*from public, anon, authenticated;/,
    );
    for (const table of [
      "registration_settings",
      "registration_invites",
      "registration_invite_uses",
    ]) {
      for (const policy of ["ins_mgr", "upd_mgr", "del_mgr"]) {
        expect(migration).toContain(`drop policy if exists ${policy} on public.${table};`);
      }
    }
    expect(migration).toContain("or p_input ? 'code'");
    expect(migration).toContain("v_code := upper(replace(gen_random_uuid()::text, '-', ''))");
    expect(migration).toContain("registration_invites_code_lower_uniq");
  });

  it("keeps portal invitation claims atomic and audit logs secret-free", () => {
    expect(migration).toMatch(
      /from public\.customer_portal_invites[\s\S]{0,320}limit 1[\s\S]{0,40}for update;/,
    );
    expect(migration).toContain("(^code$|secret|token|password");
    for (const table of [
      "registration_settings",
      "registration_invites",
      "registration_invite_uses",
    ]) {
      expect(migration).toContain(`after insert or update or delete on public.${table}`);
    }
  });

  it("preserves trusted provisioning without trusting a requested role", () => {
    expect(compatibilityMigration).toContain("if auth.role() = 'service_role' then");
    expect(compatibilityMigration).toContain("return 'viewer'");
    expect(compatibilityMigration).not.toContain("meta->>'requested_role'");
    expect(compatibilityMigration).toMatch(
      /revoke all on function public\._registration_staff_claim\(uuid, text, text\)[\s\S]*from public, anon, authenticated, service_role;/,
    );
  });
});
