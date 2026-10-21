import type { SupabaseClient } from "@supabase/supabase-js";
import { forgetPrefetchShapes } from "@/lib/supabase/read-prefetch";
import { readAuthRoutingRpc } from "@/lib/supabase/auth-routing-read";

export interface AuthSecurityState {
  authenticated: boolean;
  subject_kind: "staff" | "portal" | "unknown";
  approval_status: "pending" | "approved" | "rejected";
  is_active: boolean;
  role: string | null;
  aal: "aal1" | "aal2";
  admin_mfa_required: boolean;
  needs_mfa: boolean;
  sensitive_reauth_required: boolean;
  reauth_recent: boolean;
  reauth_max_age_seconds: number;
  session_idle_seconds: number;
  session_absolute_seconds: number;
}

export interface StaffAccessState {
  approval_status: "pending" | "approved" | "rejected";
  is_active: boolean;
  role: string | null;
}

export const DEFAULT_IDLE_SECONDS = 1800;
export const DEFAULT_ABSOLUTE_SECONDS = 28800;

export function sessionExpiryAt(input: {
  nowMs: number;
  lastActivityMs: number;
  signedInAtMs: number;
  idleSeconds?: number | null;
  absoluteSeconds?: number | null;
}): number {
  const idle = Math.max(300, input.idleSeconds ?? DEFAULT_IDLE_SECONDS) * 1000;
  const absolute = Math.max(900, input.absoluteSeconds ?? DEFAULT_ABSOLUTE_SECONDS) * 1000;
  return Math.min(input.lastActivityMs + idle, input.signedInAtMs + absolute);
}

export async function getAuthSecurityState(
  client: SupabaseClient,
): Promise<AuthSecurityState | null> {
  const { data, error } = await readAuthRoutingRpc(client, "auth_security_state");
  return error ? null : data as AuthSecurityState;
}

/**
 * Resolve the signed-in staff row without embedding the protected roles table.
 * This is the routing identity used by middleware, server pages, and the client
 * session so an RLS-filtered relationship cannot produce conflicting redirects.
 */
export async function getStaffAccessState(
  client: SupabaseClient,
  userId: string,
): Promise<StaffAccessState | null> {
  const [profileResult, roleResult] = await Promise.all([
    client
      .from("app_users")
      .select("approval_status,is_active")
      .eq("id", userId)
      .maybeSingle(),
    readAuthRoutingRpc(client, "app_user_role"),
  ]);
  if (profileResult.error || !profileResult.data || roleResult.error) return null;
  const profile = profileResult.data as {
    approval_status?: string | null;
    is_active?: boolean | null;
  };
  if (!profile.approval_status || !["pending", "approved", "rejected"].includes(profile.approval_status)) return null;
  return {
    approval_status: profile.approval_status as StaffAccessState["approval_status"],
    is_active: profile.is_active === true,
    role: typeof roleResult.data === "string" ? roleResult.data : null,
  };
}

export async function recordAuthSecurityEvent(
  client: SupabaseClient,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.rpc("record_auth_security_event", {
    p_event_type: eventType,
    p_metadata: metadata,
  });
}

export async function secureSignOut(
  client: SupabaseClient,
  eventType: "logout_requested" | "session_expired" = "logout_requested",
): Promise<void> {
  try {
    await recordAuthSecurityEvent(client, eventType);
  } finally {
    // Drop prefetched reads and remembered request shapes before the session ends.
    forgetPrefetchShapes();
    const { error } = await client.auth.signOut({ scope: "global" });
    if (error) await client.auth.signOut({ scope: "local" });
  }
}
