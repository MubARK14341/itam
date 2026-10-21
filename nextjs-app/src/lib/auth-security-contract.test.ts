import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "migrations/20260731200000_auth_session_security.sql"),
  "utf8",
);

describe("auth and session security contract", () => {
  it("restores the registration settings singleton on clean replay", () => {
    expect(migration).toContain("insert into public.registration_settings (id, mode)");
    expect(migration).toContain("on conflict (id) do nothing");
    expect(migration).toContain(
      "grant execute on function public.registration_status() to anon, authenticated",
    );
    expect(migration).toContain("create trigger on_auth_user_created");
    expect(migration).toContain("after insert on auth.users");
    expect(migration).toContain("execute function public.handle_new_user()");
  });

  it("centralizes approval and optional AAL2 enforcement", () => {
    expect(migration).toContain("create or replace function public.is_approved()");
    expect(migration).toContain("admin_mfa_required");
    expect(migration).toContain("public._auth_current_aal() = 'aal2'");
    expect(migration).toContain("public.is_approved()");
  });

  it("gates sensitive capabilities on recent AAL2 when enabled", () => {
    expect(migration).toContain("sensitive_reauth_required");
    expect(migration).toContain("public.auth_recent_reauthentication");
    expect(migration).toContain("p_key = any(policy.sensitive_capabilities)");
  });

  it("keeps policy mutation outside browser roles", () => {
    expect(migration).toContain(
      "revoke all on public.auth_security_policy from public, anon, authenticated",
    );
    expect(migration).not.toContain(
      "grant update on public.auth_security_policy to authenticated",
    );
    expect(migration).toContain(
      "grant select, update on public.auth_security_policy to service_role",
    );
  });

  it("does not branch login or signup UI on account existence", () => {
    const login = readFileSync(resolve(root, "src/app/login/page.tsx"), "utf8");
    const registration = readFileSync(resolve(root, "src/app/register/page.tsx"), "utf8");
    expect(login).not.toContain("emailNotConfirmed");
    expect(registration).not.toContain('error === "email_exists"');
  });
});
