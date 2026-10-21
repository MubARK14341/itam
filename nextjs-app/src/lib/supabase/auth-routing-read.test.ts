import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { readAuthRoutingRpc } from "./auth-routing-read";
import { getAuthSecurityState, getStaffAccessState } from "../auth-security";

const security = { authenticated: true, subject_kind: "staff", approval_status: "approved", is_active: true, role: "admin", needs_mfa: false };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const client = (fetcher: typeof fetch) => createClient("http://localhost:65421", "TEST-public-anon", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
});
const socketError = () => new TypeError("fetch failed", { cause: Object.assign(new Error("TEST socket closed"), { code: "UND_ERR_SOCKET" }) });

describe("read-only Auth routing RPC transport recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["auth_security_state", "app_user_role"] as const)("rereads %s after the SDK's real socket failure", async (name) => {
    const payload = name === "app_user_role" ? "admin" : security;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(socketError()).mockImplementation(async () => response(payload));
    const pending = readAuthRoutingRpc(client(fetcher), name);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ data: payload, error: null, status: 200 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).pathname).toBe(`/rest/v1/rpc/${name}`);
      expect(init?.method).toBe("POST");
    }
  });

  it.each([500, 503, 504])("recovers only after an actual verified response from unavailable status %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ code: "PGRST003", message: "TEST connection unavailable" }, status))
      .mockImplementation(async () => response(security));
    const pending = getAuthSecurityState(client(fetcher));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual(security);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["socket", "service"])("fails closed after exactly three %s failures", async (kind) => {
    const fetcher = vi.fn<typeof fetch>();
    if (kind === "socket") fetcher.mockRejectedValue(socketError());
    else fetcher.mockImplementation(async () => response({ code: "PGRST003", message: "TEST unavailable" }, 503));
    const pending = getAuthSecurityState(client(fetcher));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[401, "PGRST301"], [403, "42501"], [404, "PGRST202"], [500, "42501"], [503, "PGRST202"], [500, "42883"], [500, "P0001"]])("does not retry authorization/schema/SQL failure %s/%s", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ code, message: "TEST denied" }, Number(status)));
    await expect(getAuthSecurityState(client(fetcher))).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn a successful null role into an approved identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => response(String(url).includes("app_users") ? { approval_status: "approved", is_active: true } : null));
    await expect(getStaffAccessState(client(fetcher), "TEST-user")).resolves.toEqual({ approval_status: "approved", is_active: true, role: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries the failed role read without repeating the successful staff profile read", async () => {
    let roleCalls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes("app_users")) return response({ approval_status: "approved", is_active: true });
      if (++roleCalls === 1) throw socketError();
      return response("admin");
    });
    const pending = getStaffAccessState(client(fetcher), "TEST-user");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ approval_status: "approved", is_active: true, role: "admin" });
    expect(roleCalls).toBe(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("app_users"))).toHaveLength(1);
  });

  it.each([new DOMException("TEST cancelled", "AbortError"), new SyntaxError("TEST malformed JSON")])("does not retry a cancellation or malformed response error", async (error) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(getAuthSecurityState(client(fetcher))).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry an arbitrary programming error represented by the SDK as status0", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("TEST invalid option"));
    await expect(getAuthSecurityState(client(fetcher))).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
