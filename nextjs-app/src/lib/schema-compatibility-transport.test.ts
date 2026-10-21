import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";
import { checkSchemaCompatibility, EXPECTED_SCHEMA_COMPATIBILITY_VERSION } from "./schema-compatibility";

const compatible = { contract: "itam_app", version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, compatible: true, missing: [] };
function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
function client(fetcher: typeof fetch) {
  // Exercise the installed SDK's status0/error parsing without any real network.
  return createClient<Database>("http://localhost:65421", "TEST-public-anon", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetcher },
  });
}

describe("schema preflight transport recovery without a compatibility bypass", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads the exact schema RPC once when the contract is compatible", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(compatible));
    await expect(checkSchemaCompatibility(client(fetcher))).resolves.toMatchObject({ ok: true, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/rest/v1/rpc/app_schema_compatibility");
    expect(init?.method).toBe("POST");
  });

  it("recovers from the SDK's real status0 transport result only after a verified contract response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("TEST fetch failed"))
      .mockResolvedValueOnce(response(compatible));
    const pending = checkSchemaCompatibility(client(fetcher));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ ok: true, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([500, 503, 504])("recovers from transient status%s without trusting the failed response", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ code: "PGRST003", message: "TEST connection unavailable" }, status))
      .mockResolvedValueOnce(response(compatible));
    const pending = checkSchemaCompatibility(client(fetcher));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ ok: true, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["transport", "service"])('fails closed after exactly three unavailable "%s" reads', async (kind) => {
    const fetcher = vi.fn<typeof fetch>();
    if (kind === "transport") fetcher.mockRejectedValue(new TypeError("TEST fetch failed"));
    else fetcher.mockImplementation(async () => response({ code: "PGRST003", message: "TEST unavailable" }, 503));
    const pending = checkSchemaCompatibility(client(fetcher));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: false, actualVersion: null, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, missing: [], reason: "preflight_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [401, "PGRST301"], [403, "42501"], [404, "PGRST202"],
    [500, "42501"], [503, "PGRST202"], [500, "42883"],
  ])("never retries a denied or missing schema RPC status%s code%s", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ code, message: "TEST denied/missing RPC" }, Number(status)));
    await expect(checkSchemaCompatibility(client(fetcher))).resolves.toMatchObject({ ok: false, reason: "preflight_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ ...compatible, version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1 }, "version_mismatch"],
    [{ ...compatible, compatible: false, missing: ["public.asset_create_atomic(jsonb)"] }, "required_rpc_missing"],
    [{ ...compatible, contract: "another_contract" }, "contract_mismatch"],
    [{ ...compatible, version: "2026073110" }, "invalid_response"],
    [null, "invalid_response"],
  ])("does not retry or accept an actual incompatible/malformed contract%j", async (payload, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload));
    await expect(checkSchemaCompatibility(client(fetcher))).resolves.toMatchObject({ ok: false, reason });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a real version mismatch blocked after a recovered transport read", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("TEST network"))
      .mockResolvedValueOnce(response({ ...compatible, version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1 }));
    const pending = checkSchemaCompatibility(client(fetcher));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "version_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
