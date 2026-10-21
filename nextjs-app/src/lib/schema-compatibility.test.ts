import { describe, expect, it } from "vitest";
import {
  EXPECTED_SCHEMA_COMPATIBILITY_VERSION,
  evaluateSchemaCompatibility,
} from "./schema-compatibility";

describe("schema compatibility preflight", () => {
  it("accepts only the exact compatible contract", () => {
    expect(evaluateSchemaCompatibility({
      contract: "itam_app",
      version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION,
      compatible: true,
      missing: [],
    })).toMatchObject({ ok: true, reason: null });
  });

  it("rejects an older schema version before application mutations", () => {
    expect(evaluateSchemaCompatibility({
      contract: "itam_app",
      version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION - 1,
      compatible: true,
      missing: [],
    })).toMatchObject({ ok: false, reason: "version_mismatch" });
  });

  it("rejects missing critical RPCs even at the expected version", () => {
    expect(evaluateSchemaCompatibility({
      contract: "itam_app",
      version: EXPECTED_SCHEMA_COMPATIBILITY_VERSION,
      compatible: false,
      missing: ["public.asset_create_atomic(jsonb)"],
    })).toMatchObject({
      ok: false,
      reason: "required_rpc_missing",
      missing: ["public.asset_create_atomic(jsonb)"],
    });
  });

  it("fails closed on malformed responses", () => {
    expect(evaluateSchemaCompatibility(null)).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
    expect(evaluateSchemaCompatibility({
      contract: "itam_app",
      version: "2026073101",
      compatible: true,
      missing: [],
    })).toMatchObject({ ok: false, reason: "invalid_response" });
  });
});
