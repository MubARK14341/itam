import type { ApprovalStatus, Role } from "@/lib/staff-access";
import type { FeatureExposureSettings } from "@/lib/feature-exposure-settings";
import type { PortalContext } from "@/lib/portal";
import { EXPECTED_SCHEMA_COMPATIBILITY_VERSION, type SchemaCompatibilityResult } from "@/lib/schema-compatibility";

/**
 * Internal request header through which the middleware hands the identity it has just verified to
 * the server layouts, so they don't repeat the same database round trips. The middleware deletes
 * any incoming copy on every request, so a browser can never supply it. UI hydration only —
 * authorization stays in RLS/RPCs.
 */
export const INITIAL_CONTEXT_HEADER = "x-itam-initial-context";

export type InitialContext = {
  session?: {
    userId: string;
    email: string | null;
    role: Role;
    approvalStatus: ApprovalStatus;
    capabilities: string[];
    exposure: FeatureExposureSettings | null;
  };
  portal?: PortalContext;
  schemaCompatibility?: { userId: string; result: SchemaCompatibilityResult };
};

export function encodeInitialContext(value: InitialContext): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeInitialContext(raw: string | null | undefined): InitialContext | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return value && typeof value === "object" ? value as InitialContext : null;
  } catch {
    return null;
  }
}

/** Only the request-private, identity-matched result may replace the gate's RPC. */
export function schemaCompatibilityFromInitialContext(
  context: InitialContext | null,
): SchemaCompatibilityResult | null {
  const session: unknown = context?.session;
  const handoff: unknown = context?.schemaCompatibility;
  if (!session || typeof session !== "object" || Array.isArray(session)
    || !("userId" in session) || typeof session.userId !== "string" || !session.userId
    || !("approvalStatus" in session) || session.approvalStatus !== "approved"
    || !handoff || typeof handoff !== "object" || Array.isArray(handoff)
    || Object.keys(handoff).length !== 2 || !("userId" in handoff)
    || handoff.userId !== session.userId || !("result" in handoff)) return null;
  const result: unknown = handoff.result;
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).length !== 5 || !("ok" in result) || typeof result.ok !== "boolean"
    || !("expectedVersion" in result) || result.expectedVersion !== EXPECTED_SCHEMA_COMPATIBILITY_VERSION
    || !("actualVersion" in result)
    || (result.actualVersion !== null && (typeof result.actualVersion !== "number" || !Number.isSafeInteger(result.actualVersion)))
    || !("missing" in result) || !Array.isArray(result.missing)
    || !result.missing.every((item): item is string => typeof item === "string")
    || !("reason" in result)) return null;

  const { ok, actualVersion, missing, reason } = result;
  let validatedReason: SchemaCompatibilityResult["reason"];
  if (ok) {
    if (reason !== null || actualVersion !== EXPECTED_SCHEMA_COMPATIBILITY_VERSION || missing.length !== 0) return null;
    validatedReason = null;
  } else {
    switch (reason) {
      case "preflight_unavailable":
      case "invalid_response":
        if (actualVersion !== null || missing.length !== 0) return null;
        validatedReason = reason;
        break;
      case "contract_mismatch":
        if (actualVersion === null) return null;
        validatedReason = reason;
        break;
      case "version_mismatch":
        if (actualVersion === null || actualVersion === EXPECTED_SCHEMA_COMPATIBILITY_VERSION) return null;
        validatedReason = reason;
        break;
      case "required_rpc_missing":
        if (actualVersion !== EXPECTED_SCHEMA_COMPATIBILITY_VERSION) return null;
        validatedReason = reason;
        break;
      default:
        return null;
    }
  }
  return { ok, expectedVersion: EXPECTED_SCHEMA_COMPATIBILITY_VERSION, actualVersion, missing: [...missing], reason: validatedReason };
}
