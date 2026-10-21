import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeInitialContext, encodeInitialContext, INITIAL_CONTEXT_HEADER, schemaCompatibilityFromInitialContext } from "./initial-context-header";

import { evaluateSchemaCompatibility, EXPECTED_SCHEMA_COMPATIBILITY_VERSION } from "./schema-compatibility";

const middleware = readFileSync(resolve(__dirname, "../middleware.ts"), "utf8");
const updateSession = readFileSync(resolve(__dirname, "supabase/middleware.ts"), "utf8");

describe("middleware identity hand-off", () => {
  it("strips any incoming hand-off header before any other handling", () => {
    const strip = middleware.indexOf("requestHeaders.delete(INITIAL_CONTEXT_HEADER)");
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(middleware.indexOf("isPublicPath(request.nextUrl.pathname)"));
    expect(strip).toBeLessThan(middleware.indexOf("updateSession("));
  });

  it("only hands identity on after the verified-user and redirect checks", () => {
    const handOff = updateSession.indexOf("requestHeaders.set(INITIAL_CONTEXT_HEADER");
    expect(handOff).toBeGreaterThan(updateSession.indexOf("user.id !== claimedUserId"));
    expect(handOff).toBeGreaterThan(updateSession.indexOf('url.pathname = "/pending-approval"'));
    expect(handOff).toBeGreaterThan(updateSession.indexOf('url.pathname = "/auth/mfa"'));
    expect(handOff).toBeGreaterThan(updateSession.indexOf("resolveStaffAccess(staff)"));
  });

  it("round-trips the context and rejects garbage", () => {
    const value = {
      session: { userId: "test-user", email: "demo@example.invalid", role: "viewer" as const, approvalStatus: "approved" as const, capabilities: ["x"], exposure: { enabled: true, level: null } },
    };
    expect(decodeInitialContext(encodeInitialContext(value))).toEqual(value);
    expect(decodeInitialContext("not-base64-json")).toBeNull();
    expect(decodeInitialContext(null)).toBeNull();
    expect(INITIAL_CONTEXT_HEADER).toMatch(/^x-itam-/);
  });
});


describe("request-scoped schema result validation", () => {
  const compatible = { contract: "itam_app", version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, compatible: true, missing: [] };
  const session = { userId: "TEST-user", email: null, role: "viewer" as const, approvalStatus: "approved" as const, capabilities: [], exposure: null };
  function read(result: unknown, userId = session.userId, identity: unknown = session) {
    const raw = Buffer.from(JSON.stringify({ session: identity, schemaCompatibility: { userId, result } }), "utf8").toString("base64url");
    return schemaCompatibilityFromInitialContext(decodeInitialContext(raw));
  }
  it("accepts only the evaluated compatible result bound to this session", () => {
    const result = evaluateSchemaCompatibility(compatible);
    expect(read(result)).toEqual(result);
    expect(read(result, "TEST-other-user")).toBeNull();
    expect(read(result, session.userId, { ...session, approvalStatus: "pending" })).toBeNull();
    expect(read(result, session.userId, null)).toBeNull();
  });
  it.each([
    { ...compatible, contract: "TEST-other-contract" },
    { ...compatible, version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1 },
    { ...compatible, compatible: false, missing: [] },
    { ...compatible, missing: ["public.TEST_missing_rpc()"] },
    null,
  ])("preserves every valid evaluated negative result %j", (payload) => {
    const result = evaluateSchemaCompatibility(payload);
    expect(result.ok).toBe(false);
    expect(read(result)).toEqual(result);
  });
  it("preserves the denied/unavailable result without converting it into compatibility", () => {
    const result = { ok: false, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: null, missing: [], reason: "preflight_unavailable" };
    expect(read(result)).toEqual(result);
  });
  it.each([
    null, [], {},
    { ok: true, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, missing: [], reason: "invalid_response" },
    { ok: true, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1, missing: [], reason: null },
    { ok: true, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, missing: ["TEST_missing"], reason: null },
    { ok: true, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, missing: [], reason: null },
    { ok: false, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, missing: [], reason: null },
    { ok: false, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: null, missing: [], reason: "TEST_unknown" },
    { ok: false, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, missing: [], reason: "version_mismatch" },
    { ok: false, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion: null, missing: [42], reason: "invalid_response" },
  ])("rejects malformed or internally inconsistent transport %j", (result) => {
    expect(read(result)).toBeNull();
  });
  it("falls back when the schema result is absent or raw context is malformed", () => {
    expect(schemaCompatibilityFromInitialContext({ session })).toBeNull();
    expect(schemaCompatibilityFromInitialContext(decodeInitialContext("TEST-not-json"))).toBeNull();
    expect(schemaCompatibilityFromInitialContext(null)).toBeNull();
  });
});
