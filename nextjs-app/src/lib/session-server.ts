import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getStaffAccessState } from "@/lib/auth-security";
import { resolveStaffAccess, type ApprovalStatus, type Role } from "@/lib/staff-access";
import { clampExposureLevel, SETTINGS_COLS, SETTINGS_ID, type FeatureExposureSettings } from "@/lib/feature-exposure-settings";
import { getVerifiedUser } from "@/lib/supabase/verified-user";

export type InitialSessionIdentity = {
  userId: string;
  email: string | null;
  role: Role;
  approvalStatus: ApprovalStatus;
  capabilities: string[];
  /** Rollout settings read in the same server wave (null = client falls back to its own read). */
  exposure: FeatureExposureSettings | null;
};

/**
 * Resolve the signed-in staff identity on the server (next to the database) so the browser does
 * not spend two cross-region round trips before the shell can render. Same checks as the client
 * provider: Auth-verified user, direct staff state, capabilities. Returns null on any doubt, and
 * the client provider then loads the identity itself exactly as before (fail-closed).
 */
export async function getInitialSessionIdentity(): Promise<InitialSessionIdentity | null> {
  try {
    const sb = await createClient();
    const { data: { user }, error } = await getVerifiedUser(() => sb.auth.getUser());
    if (error || !user) return null;
    const [staff, capabilitiesResult, exposureResult] = await Promise.all([
      getStaffAccessState(sb, user.id),
      sb.rpc("my_capabilities"),
      sb.from("feature_exposure_settings").select(SETTINGS_COLS).eq("id", SETTINGS_ID).maybeSingle(),
    ]);
    const identity = resolveStaffAccess(staff);
    if (!identity) return null;
    const capabilities = !capabilitiesResult.error && Array.isArray(capabilitiesResult.data)
      ? capabilitiesResult.data as string[]
      : [];
    const row = exposureResult.error ? null : exposureResult.data as { enabled?: boolean; level?: unknown } | null;
    const exposure: FeatureExposureSettings | null = exposureResult.error
      ? null
      : row ? { enabled: row.enabled !== false, level: clampExposureLevel(row.level) } : { enabled: true, level: null };
    return { userId: user.id, email: user.email ?? null, role: identity.role, approvalStatus: identity.approvalStatus, capabilities, exposure };
  } catch {
    return null;
  }
}
