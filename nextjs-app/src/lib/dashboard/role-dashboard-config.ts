import type { DashboardKpiId, DashboardRole } from "@/lib/dashboard/dashboard-types";

export interface RoleDashboardConfig {
  kpis: readonly DashboardKpiId[];
  primaryAction: "/alerts" | "/maintenance" | "/requests?view=warehouse" | "/reports";
  secondaryAction: "/scan" | null;
  readOnly: boolean;
  showActor: boolean;
}

export const ROLE_DASHBOARD_CONFIG: Record<DashboardRole, RoleDashboardConfig> = {
  admin: {
    kpis: ["actionableRequests", "overdueRequests", "maintenanceFollowup", "criticalConsumables"],
    primaryAction: "/alerts",
    secondaryAction: "/scan",
    readOnly: false,
    showActor: true,
  },
  it_manager: {
    kpis: ["actionableRequests", "overdueRequests", "maintenanceFollowup", "criticalConsumables"],
    primaryAction: "/alerts",
    secondaryAction: "/scan",
    readOnly: false,
    showActor: true,
  },
  technician: {
    kpis: ["assignedMaintenance", "assignedMaintenanceOverdue", "assignedRequests", "maintenanceFollowup"],
    primaryAction: "/maintenance",
    secondaryAction: "/scan",
    readOnly: false,
    showActor: false,
  },
  warehouse_manager: {
    kpis: ["preparationQueue", "readyDelivery", "returnsDue", "criticalConsumables"],
    primaryAction: "/requests?view=warehouse",
    secondaryAction: "/scan",
    readOnly: false,
    showActor: false,
  },
  viewer: {
    kpis: ["activeAssets", "availableAssets", "inMaintenanceAssets", "actionableRequests"],
    primaryAction: "/reports",
    secondaryAction: null,
    readOnly: true,
    showActor: false,
  },
  auditor: {
    kpis: ["missingLocation", "activeAssets", "maintenanceFollowup", "criticalConsumables"],
    primaryAction: "/alerts",
    secondaryAction: null,
    readOnly: true,
    showActor: false,
  },
};

export function dashboardRoleConfig(role: DashboardRole): RoleDashboardConfig {
  return ROLE_DASHBOARD_CONFIG[role];
}
