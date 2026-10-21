import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";

export const EXPECTED_SCHEMA_COMPATIBILITY_VERSION = 2026073110;
export const SCHEMA_CONTRACT_KEY = "itam_app";

export type SchemaCompatibilityResult = {
  ok: boolean;
  expectedVersion: number;
  actualVersion: number | null;
  missing: string[];
  reason:
    | null
    | "preflight_unavailable"
    | "invalid_response"
    | "contract_mismatch"
    | "version_mismatch"
    | "required_rpc_missing";
};

type CompatibilityPayload = {
  contract: string;
  version: number;
  compatible: boolean;
  missing: string[];
};

function isCompatibilityPayload(value: unknown): value is CompatibilityPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.contract === "string"
    && typeof payload.version === "number"
    && Number.isSafeInteger(payload.version)
    && typeof payload.compatible === "boolean"
    && Array.isArray(payload.missing)
    && payload.missing.every((item) => typeof item === "string")
  );
}

export function evaluateSchemaCompatibility(
  payload: unknown,
): SchemaCompatibilityResult {
  const base = {
    expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION,
    actualVersion: null,
    missing: [] as string[],
  };
  if (!isCompatibilityPayload(payload)) {
    return { ...base, ok: false, reason: "invalid_response" };
  }
  const result = {
    ...base,
    actualVersion: payload.version,
    missing: payload.missing,
  };
  if (payload.contract !== SCHEMA_CONTRACT_KEY) {
    return { ...result, ok: false, reason: "contract_mismatch" };
  }
  if (payload.version !== EXPECTED_SCHEMA_COMPATIBILITY_VERSION) {
    return { ...result, ok: false, reason: "version_mismatch" };
  }
  if (!payload.compatible || payload.missing.length > 0) {
    return { ...result, ok: false, reason: "required_rpc_missing" };
  }
  return { ...result, ok: true, reason: null };
}

export async function checkSchemaCompatibility(
  supabase: SupabaseClient<Database>,
): Promise<SchemaCompatibilityResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { data, error, status } = await supabase.rpc("app_schema_compatibility");
      if (!error) return evaluateSchemaCompatibility(data);
      // This RPC only reads the schema contract. Retry transport failures, never
      // a denied/missing RPC or an actual incompatible/malformed contract.
      const permanent = ["42501", "42883", "PGRST202"].includes(error.code);
      const transient = !permanent && (status === 0 || (status >= 500 && status < 600));
      if (transient && attempt < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      return {
        ok: false,
        expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION,
        actualVersion: null,
        missing: [],
        reason: "preflight_unavailable",
      };
    } catch {
      return {
        ok: false,
        expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION,
        actualVersion: null,
        missing: [],
        reason: "preflight_unavailable",
      };
    }
  }
}
