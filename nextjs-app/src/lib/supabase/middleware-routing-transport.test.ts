import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, createClient, type User } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
import { updateSession } from "./middleware";
import { decodeInitialContext, INITIAL_CONTEXT_HEADER } from "../initial-context-header";
import { EXPECTED_SCHEMA_COMPATIBILITY_VERSION, SCHEMA_CONTRACT_KEY } from "../schema-compatibility";

const user: User = { id: "TEST-user", email: "demo@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-09T00:00:00Z" };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const NO_SECURITY_OVERRIDE = Symbol("legacy security fixture");
const completeSecurity = {
  authenticated: true, subject_kind: "staff", approval_status: "approved", is_active: true,
  role: "admin", aal: "aal1", admin_mfa_required: false, needs_mfa: false,
  sensitive_reauth_required: false, reauth_recent: false, reauth_max_age_seconds: 900,
  session_idle_seconds: 1800, session_absolute_seconds: 28800,
};
const socketError = () => new TypeError("fetch failed", { cause: Object.assign(new Error("TEST socket"), { code: "UND_ERR_SOCKET" }) });

describe("middleware routing gates with the actual RPC SDK", () => {
  let failedPath: string, mode: "once" | "exhausted" | "denied", calls: Record<string, number>, active: boolean, mfa: boolean, verifiedId: string;
  let securityOverride: unknown, staffRole: string | null, approvalStatus: string;
  let client: ReturnType<typeof createClient>;
  let emptyStaffProfile: boolean;
  beforeEach(() => {
    securityOverride = NO_SECURITY_OVERRIDE; staffRole = "admin"; approvalStatus = "approved"; emptyStaffProfile = false;
    vi.useFakeTimers(); failedPath = "auth_security_state"; mode = "once"; calls = {}; active = true; mfa = false; verifiedId = user.id;
    const fetcher: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname.split("/").at(-1)!;
      calls[path] = (calls[path] ?? 0) + 1;
      if (path === failedPath) {
        if (mode === "exhausted" || (mode === "once" && calls[path] === 1)) throw socketError();
        if (mode === "denied") return response({ code: "42501", message: "TEST denied" }, 403);
      }
      if (path === "auth_security_state") return response(securityOverride === NO_SECURITY_OVERRIDE ? { subject_kind: "staff", needs_mfa: mfa } : securityOverride);
      if (path === "app_users") return response(emptyStaffProfile ? null : { approval_status: approvalStatus, is_active: active });
      if (path === "app_user_role") return response(staffRole);
      if (path === "portal_get_context") return response(null);
      if (path === "my_capabilities") return response(["reports.read"]);
      if (path === "app_schema_compatibility") return response({ contract: SCHEMA_CONTRACT_KEY, version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, compatible: true, missing: [] });
      if (path === "feature_exposure_settings") return response({ enabled: true, level: 100 });
      throw new Error("TEST unexpected path");
    };
    client = createClient("http://localhost:65421", "TEST-public-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    });
    vi.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: { access_token: "TEST-not-a-token", refresh_token: "TEST-not-a-token", expires_in: 3600, token_type: "bearer", user } }, error: null });
    vi.spyOn(client.auth, "getUser").mockImplementation(async () => ({ data: { user: { ...user, id: verifiedId } }, error: null }));
    mocks.createServerClient.mockReturnValue(client);
  });
  afterEach(() => vi.useRealTimers());
  async function request(path = "/reports") {
    const pending = updateSession(new NextRequest(`http://localhost:3110${path}`));
    await vi.runAllTimersAsync();
    return pending;
  }
  const handoff = `x-middleware-request-${INITIAL_CONTEXT_HEADER}`;
  function denied(result: Awaited<ReturnType<typeof request>>, route = "/login?reason=security_check_failed") {
    expect(result.headers.get("location")).toBe(`http://localhost:3110${route}`);
    expect(result.headers.get("x-middleware-next")).toBeNull();
    expect(result.headers.get(handoff)).toBeNull();
  }

  it.each(["auth_security_state", "app_user_role"])("renders only after recovered %s passes the verified routing gates", async (path) => {
    failedPath = path;
    const result = await request();
    expect(calls[path]).toBe(2);
    expect(result.headers.get("x-middleware-next")).toBe("1");
    expect(result.headers.get(handoff)).not.toBeNull();
  });
  it.each(["auth_security_state", "app_user_role"])("fails closed after three unavailable %s reads", async (path) => {
    failedPath = path; mode = "exhausted";
    denied(await request());
    expect(calls[path]).toBe(3);
  });
  it.each(["auth_security_state", "app_user_role"])("fails closed immediately on permanent %s authorization denial", async (path) => {
    failedPath = path; mode = "denied";
    denied(await request());
    expect(calls[path]).toBe(1);
  });
  it("never hands off a recovered routing read when Auth verifies a different user", async () => {
    verifiedId = "TEST-other-user";
    denied(await request());
    expect(calls.auth_security_state).toBe(2);
  });
  it("still redirects inactive staff after routing transport recovers", async () => {
    active = false;
    denied(await request(), "/pending-approval");
  });
  it("still requires MFA after routing transport recovers", async () => {
    mfa = true;
    denied(await request(), "/auth/mfa");
  });

  it.each(["admin", "it_manager", "technician", "warehouse_manager", "auditor", "viewer", "employee"])(
    "reuses a complete fresh approved %s contract without either direct staff read", async (role) => {
      failedPath = "app_user_role"; mode = "denied";
      securityOverride = { ...completeSecurity, role };
      const result = await request();
      expect(result.status).toBe(200);
      expect(decodeInitialContext(result.headers.get(handoff))?.session).toMatchObject({
        userId: user.id, role, approvalStatus: "approved",
      });
      expect(client.auth.getUser).toHaveBeenCalledTimes(1);
      expect(calls.auth_security_state).toBe(1);
      expect(calls.app_users).toBeUndefined();
      expect(calls.app_user_role).toBeUndefined();
    },
  );

  it("reverifies Auth and the fresh security RPC on every navigation without remembering staff state", async () => {
    failedPath = "TEST-no-failure"; securityOverride = { ...completeSecurity };
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(client.auth.getUser).toHaveBeenCalledTimes(2);
    expect(calls.auth_security_state).toBe(2);
    expect(calls.app_users).toBeUndefined();
    expect(calls.app_user_role).toBeUndefined();
  });

  it("does not use or fetch staff identity until Auth verifies the claimed cookie user", async () => {
    failedPath = "TEST-no-failure"; securityOverride = { ...completeSecurity };
    let release!: () => void;
    vi.mocked(client.auth.getUser).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ data: { user }, error: null }); }));
    let completed = false;
    const pending = updateSession(new NextRequest("http://localhost:3110/reports")).then((result) => { completed = true; return result; });
    await vi.runAllTimersAsync();
    expect(calls.auth_security_state).toBe(1);
    expect(completed).toBe(false);
    expect(calls.app_users).toBeUndefined();
    expect(calls.app_user_role).toBeUndefined();
    release();
    expect(decodeInitialContext((await pending).headers.get(handoff))?.session?.role).toBe("admin");
  });

  it("rejects a complete staff snapshot belonging to a mismatched verified identity before hand-off", async () => {
    failedPath = "TEST-no-failure"; securityOverride = { ...completeSecurity }; verifiedId = "TEST-other-user";
    denied(await request());
    expect(calls.auth_security_state).toBe(1);
    expect(calls.app_users).toBeUndefined();
    expect(calls.app_user_role).toBeUndefined();
  });

  it("does not rescue permanent Auth denial with a complete approved security snapshot", async () => {
    failedPath = "TEST-no-failure"; securityOverride = { ...completeSecurity };
    vi.mocked(client.auth.getUser).mockResolvedValueOnce({ data: { user: null }, error: new AuthApiError("TEST denied", 401, "invalid_jwt") });
    denied(await request());
    expect(client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(calls.app_users).toBeUndefined();
    expect(calls.app_user_role).toBeUndefined();
  });

  const incompleteContracts = [
    ...["authenticated", "subject_kind", "approval_status", "is_active", "role", "needs_mfa", "admin_mfa_required", "aal"].map((field) => {
      const state: Record<string, unknown> = { ...completeSecurity }; delete state[field];
      return { name: `missing ${field}`, state };
    }),
    ...[
      ["authenticated", false], ["authenticated", "true"],
      ["subject_kind", "unknown"], ["subject_kind", "portal"],
      ["approval_status", "pending"], ["approval_status", "rejected"],
      ["is_active", false], ["is_active", "true"],
      ["role", null], ["role", "unknown-role"], ["role", ["admin"]],
      ["needs_mfa", 0],
      ["admin_mfa_required", null], ["admin_mfa_required", "false"], ["admin_mfa_required", 0],
      ["aal", null], ["aal", "TEST-unknown-aal"], ["aal", 0], ["aal", ["aal2"]],
    ].map(([field, value]) => ({ name: `invalid ${String(field)} ${JSON.stringify(value)}`, state: { ...completeSecurity, [String(field)]: value } })),
    { name: "legacy partial object", state: { subject_kind: "staff", needs_mfa: false } },
    { name: "array", state: [] }, { name: "non-object", state: "TEST malformed" },
  ];
  it.each(incompleteContracts)("keeps the direct approved staff fallback for $name", async ({ state }) => {
    failedPath = "TEST-no-failure"; securityOverride = state;
    const result = await request();
    expect(decodeInitialContext(result.headers.get(handoff))?.session).toMatchObject({ role: "admin", approvalStatus: "approved" });
    expect(calls.app_users).toBe(1);
    expect(calls.app_user_role).toBe(1);
  });

  it.each([true, "false"])("preserves the MFA redirect for truthy needs_mfa %s after direct fallback", async (needsMfa) => {
    failedPath = "TEST-no-failure";
    securityOverride = { ...completeSecurity, needs_mfa: needsMfa };
    denied(await request(), "/auth/mfa");
    expect(calls.app_users).toBe(1);
    expect(calls.app_user_role).toBe(1);
  });

  it.each(["pending", "rejected"])("preserves direct %s staff routing and role-less approval-page hand-off", async (status) => {
    failedPath = "TEST-no-failure"; approvalStatus = status; active = false; staffRole = null;
    securityOverride = { ...completeSecurity, approval_status: status, is_active: false, role: null };
    denied(await request(), "/pending-approval");
    const result = await request("/pending-approval");
    expect(decodeInitialContext(result.headers.get(handoff))?.session).toMatchObject({ role: null, approvalStatus: status });
    expect(calls.app_users).toBe(2);
    expect(calls.app_user_role).toBe(2);
  });

  it("preserves inactive approved staff denial even though its security state reports rejected", async () => {
    failedPath = "TEST-no-failure"; active = false; staffRole = null;
    securityOverride = { ...completeSecurity, approval_status: "rejected", is_active: false, role: null };
    denied(await request(), "/pending-approval");
    expect(calls.app_users).toBe(1);
    expect(calls.app_user_role).toBe(1);
  });

  it("preserves the MFA redirect and role-less MFA page instead of using auth_security_state's pre-AAL2 role", async () => {
    failedPath = "TEST-no-failure"; staffRole = null;
    securityOverride = { ...completeSecurity, admin_mfa_required: true, needs_mfa: true };
    denied(await request(), "/auth/mfa");
    const mfaPage = await request("/auth/mfa");
    expect(mfaPage.status).toBe(200);
    expect(mfaPage.headers.get(handoff)).toBeNull();
    expect(calls.app_users).toBe(2);
    expect(calls.app_user_role).toBe(2);
  });

  it("keeps permanent direct-role denial fail-closed when the security contract is incomplete", async () => {
    failedPath = "app_user_role"; mode = "denied";
    securityOverride = { ...completeSecurity, authenticated: undefined };
    denied(await request());
    expect(calls.app_user_role).toBe(1);
  });

  it("retains the bounded fresh security transport retry on the approved fast path", async () => {
    securityOverride = { ...completeSecurity };
    const result = await request();
    expect(result.status).toBe(200);
    expect(calls.auth_security_state).toBe(2);
    expect(calls.app_users).toBeUndefined();
    expect(calls.app_user_role).toBeUndefined();
  });

  it("preserves staff-free portal redirect and portal routing through the existing fallback", async () => {
    failedPath = "TEST-no-failure"; emptyStaffProfile = true; staffRole = null;
    securityOverride = { ...completeSecurity, subject_kind: "portal", role: null };
    denied(await request(), "/client-portal");
    const result = await request("/client-portal");
    expect(result.status).toBe(200);
    expect(result.headers.get(handoff)).toBeNull();
    expect(calls.app_users).toBe(2);
    expect(calls.app_user_role).toBe(2);
    expect(calls.portal_get_context).toBe(1);
  });

  it("keeps the missing-policy viewer role absent even when SQL's false AND null leaves needs_mfa false", async () => {
    failedPath = "TEST-no-failure"; staffRole = null;
    securityOverride = { ...completeSecurity, role: "viewer", admin_mfa_required: null, needs_mfa: false };
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.headers.get(handoff)).toBeNull();
    expect(calls.app_users).toBe(1);
    expect(calls.app_user_role).toBe(1);
  });

  it("still reuses an approved admin after AAL2 clears an existing required-MFA policy", async () => {
    failedPath = "TEST-no-failure";
    securityOverride = { ...completeSecurity, admin_mfa_required: true, aal: "aal2", needs_mfa: false };
    const result = await request();
    expect(decodeInitialContext(result.headers.get(handoff))?.session?.role).toBe("admin");
    expect(calls.app_users).toBeUndefined();
    expect(calls.app_user_role).toBeUndefined();
  });

  it.each(["admin", "it_manager"])("does not hand off a contradictory MFA-clear %s at AAL1", async (role) => {
    failedPath = "TEST-no-failure"; staffRole = null;
    securityOverride = { ...completeSecurity, role, admin_mfa_required: true, aal: "aal1", needs_mfa: false };
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.headers.get(handoff)).toBeNull();
    expect(calls.app_users).toBe(1);
    expect(calls.app_user_role).toBe(1);
  });

  it("still reuses an approved IT manager after AAL2 clears the required-MFA policy", async () => {
    failedPath = "TEST-no-failure";
    securityOverride = { ...completeSecurity, role: "it_manager", admin_mfa_required: true, aal: "aal2", needs_mfa: false };
    const result = await request();
    expect(decodeInitialContext(result.headers.get(handoff))?.session?.role).toBe("it_manager");
    expect(calls.app_users).toBeUndefined();
    expect(calls.app_user_role).toBeUndefined();
  });

  it.each(["technician", "warehouse_manager", "auditor", "viewer", "employee"])(
    "does not unnecessarily require manager AAL2 for an approved %s", async (role) => {
      failedPath = "TEST-no-failure";
      securityOverride = { ...completeSecurity, role, admin_mfa_required: true, aal: "aal1", needs_mfa: false };
      const result = await request();
      expect(decodeInitialContext(result.headers.get(handoff))?.session?.role).toBe(role);
      expect(calls.app_users).toBeUndefined();
      expect(calls.app_user_role).toBeUndefined();
    },
  );
});
