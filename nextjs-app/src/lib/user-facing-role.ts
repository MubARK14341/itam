import type { Role } from "@/lib/session";

export type UserFacingRole = "manager" | "office_employee" | "warehouse_employee" | "viewer";
export type AssignableTechnicalRole = "it_manager" | "employee" | "warehouse_manager" | "viewer";

/** The only role choices presented in internal account-management screens. */
export const ASSIGNABLE_TECHNICAL_ROLES: AssignableTechnicalRole[] = [
  "it_manager",
  "employee",
  "warehouse_manager",
  "viewer",
];

/**
 * Presentation-only vocabulary.  Database roles and capabilities remain the
 * authorization boundary; this prevents technical role names leaking into the
 * ordinary staff interface.
 */
export function userFacingRole(role: Role): UserFacingRole | null {
  if (role === "admin" || role === "it_manager") return "manager";
  if (role === "technician" || role === "warehouse_manager") return "warehouse_employee";
  if (role === "employee") return "office_employee";
  if (role === "viewer" || role === "auditor") return "viewer";
  return null;
}

export function defaultInternalLanding(role: Role): "/dashboard" | "/my-tasks" | "/overview" | "/pending-approval" {
  switch (userFacingRole(role)) {
    case "manager": return "/dashboard";
    case "office_employee":
    case "warehouse_employee": return "/my-tasks";
    case "viewer": return "/overview";
    default: return "/pending-approval";
  }
}

/**
 * Keeps existing database roles compatible while preventing account managers
 * from presenting or assigning legacy technical variants as separate choices.
 */
export function assignableTechnicalRole(role: Role): AssignableTechnicalRole {
  switch (userFacingRole(role)) {
    case "manager": return "it_manager";
    case "office_employee": return "employee";
    case "warehouse_employee": return "warehouse_manager";
    case "viewer":
    default: return "viewer";
  }
}

export function canAccessInternalPath(role: Role, pathname: string): boolean {
  const state = userFacingRole(role);
  if (!state) return false;
  if (state === "manager") return true;
  if (state === "office_employee") return pathname.startsWith("/my-tasks") || pathname.startsWith("/my-requests") || pathname.startsWith("/my-assets");
  if (state === "warehouse_employee") return pathname.startsWith("/my-tasks") || pathname.startsWith("/requests") || pathname.startsWith("/scan") || pathname.startsWith("/stocktakes") || pathname.startsWith("/assets") || pathname.startsWith("/maintenance") || pathname.startsWith("/consumables");
  return pathname.startsWith("/overview") || pathname.startsWith("/assets") || pathname.startsWith("/reports") || pathname.startsWith("/activity") || pathname.startsWith("/scan");
}
