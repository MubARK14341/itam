import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn(), security: vi.fn(), staff: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("@/lib/auth-security", () => ({ getAuthSecurityState: mocks.security, getStaffAccessState: mocks.staff }));

import { updateSession } from "./middleware";
import { decodeInitialContext, INITIAL_CONTEXT_HEADER } from "../initial-context-header";

describe("middleware Auth verification and protected routing", () => {
  let readUser: ReturnType<typeof vi.fn>, readSession: ReturnType<typeof vi.fn>;
  const approved = { approval_status: "approved", is_active: true, role: "admin" };
  const verified = { data: { user: { id: "test-user", email: "demo@example.invalid" } }, error: null };
  const handoff = `x-middleware-request-${INITIAL_CONTEXT_HEADER}`;
  const request = () => new NextRequest("http://localhost:3110/reports");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    readUser = vi.fn().mockResolvedValue(verified);
    readSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: "test-user" } } }, error: null });
    mocks.security.mockResolvedValue({ subject_kind: "staff", needs_mfa: false });
    mocks.staff.mockResolvedValue(approved);
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { enabled: true, level: 100 }, error: null }) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
    mocks.createServerClient.mockReturnValue({ auth: { getSession: readSession, getUser: readUser },
      rpc: vi.fn().mockResolvedValue({ data: ["reports.read"], error: null }), from: vi.fn().mockReturnValue(query) });
  });
  afterEach(() => vi.useRealTimers());

  it("passes a recovered Auth verification through the existing staff and hydration gates", async () => {
    readUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError("TEST transport", 0) });
    const result = updateSession(request());
    await vi.runAllTimersAsync();
    const response = await result;
    expect(readUser).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    expect(decodeInitialContext(response.headers.get(handoff))?.session).toMatchObject({ userId: "test-user", role: "admin", approvalStatus: "approved" });
  });

  it("exhausts the bounded transport retries without rendering or handing off cookie identity", async () => {
    readUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError("TEST unavailable", 503) });
    const result = updateSession(request());
    await vi.runAllTimersAsync();
    const response = await result;
    expect(readUser).toHaveBeenCalledTimes(3);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3110/login?reason=security_check_failed");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get(handoff)).toBeNull();
  });

  it.each([401, 403])("rejects permanent Auth denial%s without retry or a hydration identity", async (status) => {
    readUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError("TEST invalid", status, "invalid_jwt") });
    const response = await updateSession(request());
    expect(readUser).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toBe("http://localhost:3110/login?reason=security_check_failed");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get(handoff)).toBeNull();
  });

  it("preserves normal logged-out routing and makes no staff/security reads without a cookie identity", async () => {
    readSession.mockResolvedValue({ data: { session: null }, error: null });
    readUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    const response = await updateSession(request());
    expect(readUser).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toBe("http://localhost:3110/login");
    expect(response.headers.get(handoff)).toBeNull();
    expect(mocks.security).not.toHaveBeenCalled();
    expect(mocks.staff).not.toHaveBeenCalled();
  });

  it("rejects a verified identity that does not match the cookie identity even after recovery", async () => {
    readUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError("TEST transport", 500) })
      .mockResolvedValueOnce({ data: { user: { id: "another-user" } }, error: null });
    const result = updateSession(request());
    await vi.runAllTimersAsync();
    const response = await result;
    expect(readUser).toHaveBeenCalledTimes(2);
    expect(response.headers.get("location")).toBe("http://localhost:3110/login?reason=security_check_failed");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get(handoff)).toBeNull();
  });

  it("keeps inactive staff out of the requested protected report after transport recovery", async () => {
    readUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError("TEST transport", 0) });
    mocks.staff.mockResolvedValue({ ...approved, is_active: false });
    const result = updateSession(request());
    await vi.runAllTimersAsync();
    const response = await result;
    expect(response.headers.get("location")).toBe("http://localhost:3110/pending-approval");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get(handoff)).toBeNull();
  });

  it("keeps MFA-required staff out of the protected report after transport recovery", async () => {
    readUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError("TEST transport", 0) });
    mocks.security.mockResolvedValue({ subject_kind: "staff", needs_mfa: true });
    const result = updateSession(request());
    await vi.runAllTimersAsync();
    const response = await result;
    expect(response.headers.get("location")).toBe("http://localhost:3110/auth/mfa");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get(handoff)).toBeNull();
  });

  it("does not use a recovered Auth user when the security state read failed", async () => {
    readUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError("TEST transport", 0) });
    mocks.security.mockResolvedValue(null);
    const result = updateSession(request());
    await vi.runAllTimersAsync();
    const response = await result;
    expect(response.headers.get("location")).toBe("http://localhost:3110/login?reason=security_check_failed");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get(handoff)).toBeNull();
  });

  it("does not use a recovered Auth user when its staff state read failed", async () => {
    readUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthRetryableFetchError("TEST transport", 0) });
    mocks.staff.mockResolvedValue(null);
    const result = updateSession(request());
    await vi.runAllTimersAsync();
    const response = await result;
    expect(response.headers.get("location")).toBe("http://localhost:3110/login?reason=security_check_failed");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get(handoff)).toBeNull();
  });
});
