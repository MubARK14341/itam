import type { DashboardKpiId, DashboardRole } from "@/lib/dashboard/dashboard-types";

export interface DashboardKpiDefinition {
  id: DashboardKpiId;
  source: "dashboard_operational_summary" | "exact_table_count";
  period: "current" | "current_riyadh_day";
  positiveDirection: "up" | "down" | "neutral";
  roles: readonly DashboardRole[];
  allowedCapabilities: readonly string[];
  financial: false;
  href: string;
  calculationOwner: string;
}

const ALL_ROLES: readonly DashboardRole[] = [
  "admin",
  "it_manager",
  "technician",
  "warehouse_manager",
  "viewer",
  "auditor",
];

const MANAGERS: readonly DashboardRole[] = ["admin", "it_manager"];

export const DASHBOARD_KPI_DEFINITIONS: Record<DashboardKpiId, DashboardKpiDefinition> = {
  actionableRequests: {
    id: "actionableRequests",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "down",
    roles: ALL_ROLES,
    allowedCapabilities: [],
    financial: false,
    href: "/requests?view=pending_approval",
    calculationOwner: "dashboard_operational_summary.requests.actionable",
  },
  overdueRequests: {
    id: "overdueRequests",
    source: "dashboard_operational_summary",
    period: "current_riyadh_day",
    positiveDirection: "down",
    roles: MANAGERS,
    allowedCapabilities: [],
    financial: false,
    href: "/requests?view=overdue_return",
    calculationOwner: "dashboard_operational_summary.requests.overdue",
  },
  maintenanceFollowup: {
    id: "maintenanceFollowup",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "down",
    roles: ALL_ROLES,
    allowedCapabilities: [],
    financial: false,
    href: "/maintenance?view=followup",
    calculationOwner: "dashboard_operational_summary.maintenance.followup",
  },
  criticalConsumables: {
    id: "criticalConsumables",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "down",
    roles: ALL_ROLES,
    allowedCapabilities: [],
    financial: false,
    href: "/consumables?view=below_reorder",
    calculationOwner: "dashboard_operational_summary.consumables.at_risk",
  },
  availableAssets: {
    id: "availableAssets",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "up",
    roles: ALL_ROLES,
    allowedCapabilities: [],
    financial: false,
    href: "/assets?status=available",
    calculationOwner: "dashboard_operational_summary.assets.available",
  },
  activeAssets: {
    id: "activeAssets",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "neutral",
    roles: ALL_ROLES,
    allowedCapabilities: [],
    financial: false,
    href: "/assets",
    calculationOwner: "dashboard_operational_summary.assets.total",
  },
  inMaintenanceAssets: {
    id: "inMaintenanceAssets",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "down",
    roles: ALL_ROLES,
    allowedCapabilities: [],
    financial: false,
    href: "/assets?status=in_maintenance",
    calculationOwner: "dashboard_operational_summary.assets.in_maintenance",
  },
  preparationQueue: {
    id: "preparationQueue",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "down",
    roles: ["admin", "it_manager", "warehouse_manager"],
    allowedCapabilities: [],
    financial: false,
    href: "/requests?view=warehouse",
    calculationOwner: "dashboard_operational_summary.requests.preparation",
  },
  readyDelivery: {
    id: "readyDelivery",
    source: "dashboard_operational_summary",
    period: "current",
    positiveDirection: "neutral",
    roles: ["admin", "it_manager", "warehouse_manager"],
    allowedCapabilities: [],
    financial: false,
    href: "/requests?view=warehouse",
    calculationOwner: "dashboard_operational_summary.requests.ready_delivery",
  },
  returnsDue: {
    id: "returnsDue",
    source: "dashboard_operational_summary",
    period: "current_riyadh_day",
    positiveDirection: "down",
    roles: ["admin", "it_manager", "warehouse_manager"],
    allowedCapabilities: [],
    financial: false,
    href: "/requests?view=returns_due",
    calculationOwner: "dashboard_operational_summary.requests.returns_due",
  },
  missingLocation: {
    id: "missingLocation",
    source: "exact_table_count",
    period: "current",
    positiveDirection: "down",
    roles: ["admin", "it_manager", "auditor"],
    allowedCapabilities: [],
    financial: false,
    href: "/assets?view=missing_location",
    calculationOwner: "assets.is_active=true AND location_id IS NULL",
  },
  assignedMaintenance: {
    id: "assignedMaintenance",
    source: "exact_table_count",
    period: "current",
    positiveDirection: "neutral",
    roles: ["technician"],
    allowedCapabilities: [],
    financial: false,
    href: "/maintenance",
    calculationOwner: "maintenance_records assigned to auth.uid() and open/in_progress",
  },
  assignedMaintenanceOverdue: {
    id: "assignedMaintenanceOverdue",
    source: "exact_table_count",
    period: "current_riyadh_day",
    positiveDirection: "down",
    roles: ["technician"],
    allowedCapabilities: [],
    financial: false,
    href: "/maintenance?view=past_due",
    calculationOwner: "assigned maintenance_records with next_due_date before current Riyadh date",
  },
  assignedRequests: {
    id: "assignedRequests",
    source: "exact_table_count",
    period: "current",
    positiveDirection: "neutral",
    roles: ["technician"],
    allowedCapabilities: [],
    financial: false,
    href: "/requests",
    calculationOwner: "non-terminal requests assigned to auth.uid()",
  },
};

export function dashboardKpiDefinition(id: DashboardKpiId): DashboardKpiDefinition {
  return DASHBOARD_KPI_DEFINITIONS[id];
}
