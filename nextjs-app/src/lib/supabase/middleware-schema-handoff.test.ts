import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSessionMissingError, createClient, type User } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { evaluateSchemaCompatibility, EXPECTED_SCHEMA_COMPATIBILITY_VERSION } from "@/lib/schema-compatibility";
import { decodeInitialContext, encodeInitialContext, INITIAL_CONTEXT_HEADER, schemaCompatibilityFromInitialContext } from "@/lib/initial-context-header";

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
import { middleware } from "@/middleware";

const user: User = { id: "TEST-user", email: "demo@example.invalid", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-10T00:00:00Z" };
const compatible = { contract: "itam_app", version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, compatible: true, missing: [] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() {
  let resolve: (value: T) => void = (_value: T) => { throw new Error("TEST deferred is not initialized"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("schema handoff is produced only by verified middleware", () => {
  let calls: Record<string, number>, schemaPayload: unknown, schemaStatus: number;
  let client: ReturnType<typeof createClient>;
  let schemaStarted: ReturnType<typeof deferred<void>>;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); calls = {}; schemaPayload = compatible; schemaStatus = 200; schemaStarted = deferred<void>();
    const fetcher: typeof fetch = async input => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname.split("/").at(-1)!;
      calls[path] = (calls[path] ?? 0) + 1;
      if (path === "app_schema_compatibility") { schemaStarted.resolve(undefined); return response(schemaPayload, schemaStatus); }
      if (path === "auth_security_state") return response({ authenticated: true, subject_kind: "staff", approval_status: "approved", is_active: true, role: "admin", needs_mfa: false, admin_mfa_required: false, aal: "aal1" });
      if (path === "app_users") return response({ approval_status: "approved", is_active: true });
      if (path === "app_user_role") return response("admin");
      if (path === "my_capabilities") return response(["reports.read"]);
      if (path === "feature_exposure_settings") return response({ enabled: true, level: 100 });
      if (path === "portal_get_context") return response(null);
      throw new Error("TEST unexpected path");
    };
    client = createClient("http://localhost:65421", "TEST-public-anon", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    });
    vi.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: { access_token: "TEST-not-a-token", refresh_token: "TEST-not-a-token", expires_in: 3600, token_type: "bearer", user } }, error: null });
    vi.spyOn(client.auth, "getUser").mockResolvedValue({ data: { user }, error: null });
    mocks.createServerClient.mockReturnValue(client);
  });
  afterEach(() => vi.useRealTimers());
  const handoff = `x-middleware-request-${INITIAL_CONTEXT_HEADER}`;
  const request = (path = "/assets", headers?: HeadersInit) => new NextRequest(`http://localhost:3110${path}`, { headers });
  it("starts the unchanged schema RPC in the existing wave before Auth verification completes", async () => {
    const verified = deferred<{ data: { user: User }; error: null }>();
    vi.mocked(client.auth.getUser).mockImplementation(() => verified.promise);
    const pending = middleware(request());
    await schemaStarted.promise;
    expect(calls.app_schema_compatibility).toBe(1);
    verified.resolve({ data: { user }, error: null });
    const result = await pending;
    const context = decodeInitialContext(result.headers.get(handoff));
    expect(context?.session?.userId).toBe(user.id);
    expect(context?.schemaCompatibility?.userId).toBe(user.id);
    expect(schemaCompatibilityFromInitialContext(context)).toEqual(evaluateSchemaCompatibility(compatible));
  });
  it.each([
    { ...compatible, version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1 },
    { ...compatible, missing: ["public.TEST_missing_rpc()"] }, null,
  ])("hands on the negative evaluated result unchanged %j", async payload => {
    schemaPayload = payload;
    const result = await middleware(request("/reports"));
    expect(schemaCompatibilityFromInitialContext(decodeInitialContext(result.headers.get(handoff)))).toEqual(evaluateSchemaCompatibility(payload));
    expect(calls.app_schema_compatibility).toBe(1);
  });
  it("preserves permanent schema denial without retry or a compatible substitute", async () => {
    schemaPayload = { code: "42501", message: "TEST denied" }; schemaStatus = 403;
    const result = await middleware(request());
    expect(schemaCompatibilityFromInitialContext(decodeInitialContext(result.headers.get(handoff)))).toMatchObject({ ok: false, reason: "preflight_unavailable" });
    expect(calls.app_schema_compatibility).toBe(1);
  });
  it("removes an externally supplied compatible header and uses the actual negative result", async () => {
    schemaPayload = { ...compatible, version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1 };
    const external = encodeInitialContext({ session: { userId: user.id, email: null, role: "admin", approvalStatus: "approved", capabilities: [], exposure: null }, schemaCompatibility: { userId: user.id, result: evaluateSchemaCompatibility(compatible) } });
    const result = await middleware(request("/assets", { [INITIAL_CONTEXT_HEADER]: external }));
    expect(schemaCompatibilityFromInitialContext(decodeInitialContext(result.headers.get(handoff)))).toMatchObject({ ok: false, reason: "version_mismatch" });
  });
  it("does not pass any schema result when Auth verifies a different identity", async () => {
    vi.mocked(client.auth.getUser).mockResolvedValue({ data: { user: { ...user, id: "TEST-other-user" } }, error: null });
    const result = await middleware(request());
    expect(result.headers.get("location")).toBe("http://localhost:3110/login?reason=security_check_failed");
    expect(result.headers.get(handoff)).toBeNull();
  });
  it("does not read schema without a cookie identity", async () => {
    vi.mocked(client.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    vi.mocked(client.auth.getUser).mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    expect((await middleware(request())).headers.get("location")).toBe("http://localhost:3110/login");
    expect(calls.app_schema_compatibility).toBeUndefined();
  });
  it.each(["/client-portal", "/api/private-test", "/auth/mfa", "/pending-approval"])("does not add schema reads to the non-app route %s", async path => {
    await middleware(request(path));
    expect(calls.app_schema_compatibility).toBeUndefined();
  });
  it("strips an external header even on the public path with no Auth/schema work", async () => {
    const result = await middleware(request("/login", { [INITIAL_CONTEXT_HEADER]: "TEST-forged" }));
    expect(result.headers.get(handoff)).toBeNull();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(calls.app_schema_compatibility).toBeUndefined();
  });
});
