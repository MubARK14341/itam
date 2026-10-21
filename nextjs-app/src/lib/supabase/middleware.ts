import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath } from "@/lib/public-routes";
import { getAuthSecurityState, getStaffAccessState, type StaffAccessState } from "@/lib/auth-security";
import { resolveStaffAccess } from "@/lib/staff-access";
import { clampExposureLevel, SETTINGS_COLS, SETTINGS_ID } from "@/lib/feature-exposure-settings";
import { parsePortalContext } from "@/lib/portal";
import { encodeInitialContext, INITIAL_CONTEXT_HEADER, type InitialContext } from "@/lib/initial-context-header";
import { getVerifiedUser } from "@/lib/supabase/verified-user";
import { checkSchemaCompatibility } from "@/lib/schema-compatibility";

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function updateSession(request: NextRequest, requestHeaders = new Headers(request.headers)) {
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const diagnose = process.env.STUDIO_AUTH_DIAGNOSTICS === "true"
    && ["localhost", "127.0.0.1"].includes(request.nextUrl.hostname)
    && /^http:\/\/(?:localhost|127\.0\.0\.1):65421\/?$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const reads: Record<string, { attempts: number; status: number; cause: string | null; errorCode: string | null }> = {};
  const readPaths: Record<string, string> = {
    "/auth/v1/user": "auth-user",
    "/rest/v1/rpc/auth_security_state": "security-state",
    "/rest/v1/app_users": "staff-profile",
    "/rest/v1/rpc/app_user_role": "staff-role",
  };
  const diagnosticFetch: typeof fetch = async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = readPaths[new URL(address).pathname];
    const entry = key ? (reads[key] ??= { attempts: 0, status: 0, cause: null, errorCode: null }) : null;
    if (entry) entry.attempts += 1;
    try {
      const result = await fetch(input, init);
      if (entry) {
        entry.status = result.status; entry.cause = null; entry.errorCode = null;
        if (result.status >= 400) {
          const payload: unknown = await result.clone().json().catch(() => null);
          const code = payload && typeof payload === "object" && "code" in payload ? payload.code : null;
          entry.errorCode = typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : null;
        }
      }
      return result;
    } catch (error) {
      if (entry) {
        entry.status = 0;
        const cause = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : null;
        entry.cause = typeof cause === "string" && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(cause) ? cause : "unknown_transport";
      }
      throw error;
    }
  };
  function rejectSecurity(branch: "auth-error" | "identity-mismatch" | "security-state" | "staff-state") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("reason", "security_check_failed");
    const denied = NextResponse.redirect(url);
    if (diagnose) {
      denied.headers.set("x-itam-security-branch", branch);
      denied.headers.set("x-itam-security-reads", JSON.stringify(reads));
    }
    return denied;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(diagnose ? { global: { fetch: diagnosticFetch } } : {}),
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          requestHeaders.set("cookie", request.cookies.toString());
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // One network wave instead of two: read the (possibly refreshed) cookie session locally, then
  // verify the user with Auth and load the fresh security state in parallel. Results are only used
  // when the verified user matches the cookie identity, so nothing is trusted from the cookie alone.
  const { data: { session } } = await supabase.auth.getSession();
  const claimedUserId = session?.user.id ?? null;
  const portalPath = request.nextUrl.pathname.startsWith("/client-portal");
  // Only internal pages render this gate; API, MFA, pending and portal routes keep their current reads.
  const schemaGatePath = !portalPath && !request.nextUrl.pathname.startsWith("/api/")
    && !request.nextUrl.pathname.startsWith("/auth/") && request.nextUrl.pathname !== "/pending-approval";
  // The UI hydration data (capabilities, rollout settings, portal context) rides the same wave so
  // the server layouts don't repeat these round trips; it is only handed on after the checks pass.
  const [{ data: { user }, error: authError }, security, capabilitiesResult, exposureResult, portalResult, schemaResult] = await Promise.all([
    getVerifiedUser(() => supabase.auth.getUser()),
    claimedUserId ? getAuthSecurityState(supabase) : Promise.resolve(null),
    claimedUserId && !portalPath ? supabase.rpc("my_capabilities") : Promise.resolve(null),
    claimedUserId && !portalPath
      ? supabase.from("feature_exposure_settings").select(SETTINGS_COLS).eq("id", SETTINGS_ID).maybeSingle()
      : Promise.resolve(null),
    claimedUserId && portalPath ? supabase.rpc("portal_get_context") : Promise.resolve(null),
    claimedUserId && schemaGatePath ? checkSchemaCompatibility(supabase) : Promise.resolve(null),
  ]);

  if (authError && claimedUserId) {
    return rejectSecurity("auth-error");
  }
  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user) {
    if (user.id !== claimedUserId) {
      return rejectSecurity("identity-mismatch");
    }
    if (!security) {
      return rejectSecurity("security-state");
    }
    // The fresh security RPC reads this same auth.uid() staff row and role. Reuse only
    // its complete approved/active contract after Auth has verified the cookie identity.
    // app_user_role() additionally gates MFA, so every missing or required MFA state
    // keeps the existing direct lookup (including the role-less /auth/mfa hand-off).
    // The non-null policy boolean proves the singleton exists; AAL must also agree with
    // its manager-MFA policy so malformed needs_mfa=false cannot create a staff hand-off.
    const approvedSecurityStaff: StaffAccessState | null = security.authenticated === true
      && security.subject_kind === "staff"
      && security.approval_status === "approved"
      && security.is_active === true
      && security.needs_mfa === false
      && typeof security.admin_mfa_required === "boolean"
      && typeof security.role === "string"
      && (security.aal === "aal1" || security.aal === "aal2")
      && (security.admin_mfa_required === false
        || (security.role !== "admin" && security.role !== "it_manager")
        || security.aal === "aal2")
      ? { approval_status: "approved", is_active: true, role: security.role }
      : null;
    const staff = approvedSecurityStaff && resolveStaffAccess(approvedSecurityStaff)
      ? approvedSecurityStaff
      : await getStaffAccessState(supabase, claimedUserId);
    if (!staff && security.subject_kind === "staff") {
      return rejectSecurity("staff-state");
    }
    if (
      staff
      && (staff.approval_status !== "approved" || !staff.is_active)
      && request.nextUrl.pathname !== "/pending-approval"
    ) {
      const url = request.nextUrl.clone();
      url.pathname = "/pending-approval";
      return NextResponse.redirect(url);
    }
    if (security.needs_mfa && request.nextUrl.pathname !== "/auth/mfa") {
      const url = request.nextUrl.clone();
      url.pathname = "/auth/mfa";
      return NextResponse.redirect(url);
    }
    // Portal identities have no internal app profile. Redirect before the app
    // shell is rendered so direct internal URLs neither flash nor wait on a
    // client-side portal-context lookup.
    if (
      !staff
      && security.subject_kind === "portal"
      && !request.nextUrl.pathname.startsWith("/client-portal")
    ) {
      const url = request.nextUrl.clone();
      url.pathname = "/client-portal";
      return NextResponse.redirect(url);
    }

    const context: InitialContext = {};
    const identity = resolveStaffAccess(staff);
    if (identity && capabilitiesResult && !capabilitiesResult.error) {
      const row = exposureResult && !exposureResult.error
        ? exposureResult.data as { enabled?: boolean; level?: unknown } | null
        : undefined;
      context.session = {
        userId: user.id,
        email: user.email ?? null,
        role: identity.role,
        approvalStatus: identity.approvalStatus,
        capabilities: Array.isArray(capabilitiesResult.data) ? capabilitiesResult.data as string[] : [],
        exposure: row === undefined
          ? null
          : row ? { enabled: row.enabled !== false, level: clampExposureLevel(row.level) } : { enabled: true, level: null },
      };
    }
    if (context.session && schemaResult) {
      context.schemaCompatibility = { userId: user.id, result: schemaResult };
    }
    const portal = portalResult && !portalResult.error ? parsePortalContext(portalResult.data) : null;
    if (portal) context.portal = portal;
    if (context.session || context.portal) {
      requestHeaders.set(INITIAL_CONTEXT_HEADER, encodeInitialContext(context));
      const handedOff = NextResponse.next({ request: { headers: requestHeaders } });
      response.cookies.getAll().forEach((cookie) => handedOff.cookies.set(cookie));
      return handedOff;
    }
  }
  return response;
}
