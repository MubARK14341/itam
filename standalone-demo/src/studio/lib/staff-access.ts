// Staff identity resolution shared by the server layout and the client session provider.
import type { StaffAccessState } from "@/lib/auth-security";

export type Role = "admin" | "it_manager" | "technician" | "warehouse_manager" | "auditor" | "viewer" | "employee" | null;
export type ApprovalStatus = "pending" | "approved" | "rejected";

// عرض الأرقام المالية الحساسة/التجميعية: قيمة شراء الأصل، إجمالي قيمة الأصول،
// إجمالي تكلفة الصيانة، جداول «الأعلى تكلفة»، التقارير المالية التنفيذية.
export function canSeeFinancial(role: Role) {
  return role === "admin" || role === "it_manager";
}

// إدارة الإعدادات (الموردين + قواعد الاستهلاك). admin و it_manager فقط.
// مطابق لصلاحية settings.manage في قاعدة البيانات (مُنحت لـ it_manager).
export function canManageSettings(role: Role) {
  return role === "admin" || role === "it_manager";
}

const STAFF_ROLES = new Set<Exclude<Role, null>>([
  "admin",
  "it_manager",
  "technician",
  "warehouse_manager",
  "auditor",
  "viewer",
  "employee",
]);

export function resolveStaffAccess(state: StaffAccessState | null): {
  approvalStatus: ApprovalStatus;
  role: Role;
} | null {
  if (!state) return null;
  const role = state.role && STAFF_ROLES.has(state.role as Exclude<Role, null>)
    ? state.role as Exclude<Role, null>
    : null;
  if (state.approval_status === "approved" && (!state.is_active || !role)) return null;
  return {
    approvalStatus: state.approval_status,
    role: state.approval_status === "approved" ? role : null,
  };
}

