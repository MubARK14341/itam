import type { Role } from "@/lib/session";

export type DashboardRole = Exclude<Exclude<Role, null>, "employee">;
export type DashboardSeverity = "neutral" | "info" | "success" | "warning" | "critical";
export type DashboardDataStatus = "complete" | "partial" | "stale";
export type DashboardSource =
  | "summary"
  | "requests"
  | "maintenance"
  | "assets"
  | "inventory"
  | "request_events"
  | "activity";

export type WidgetResult<T> =
  | {
      status: "success";
      data: T;
      updatedAt: string;
      isPartial?: boolean;
      unavailableSources?: DashboardSource[];
    }
  | {
      status: "empty";
      data: T;
      updatedAt: string;
      isPartial?: boolean;
      unavailableSources?: DashboardSource[];
    }
  | {
      status: "error";
      message: "unavailable";
      retryable: boolean;
      unavailableSources: DashboardSource[];
    };

export type DashboardKpiId =
  | "actionableRequests"
  | "overdueRequests"
  | "maintenanceFollowup"
  | "criticalConsumables"
  | "availableAssets"
  | "activeAssets"
  | "inMaintenanceAssets"
  | "preparationQueue"
  | "readyDelivery"
  | "returnsDue"
  | "missingLocation"
  | "assignedMaintenance"
  | "assignedMaintenanceOverdue"
  | "assignedRequests";

export interface DashboardKpi {
  id: DashboardKpiId;
  value: number | string;
  unit?: "count" | "percent";
  severity: DashboardSeverity;
  definitionId: DashboardKpiId;
  source: "dashboard_operational_summary" | "exact_table_count";
  period: "current" | "current_riyadh_day";
  lastUpdatedAt: string | null;
  target?: number | string;
  variance?: number | string;
  comparison?: {
    value: number;
    direction: "up" | "down" | "flat";
    interpretation: "good" | "bad" | "neutral";
  };
  href?: string;
  isPartial?: boolean;
  financial: false;
}

export type DashboardEntityType = "request" | "maintenance" | "asset" | "consumable";
export type DashboardSlaStatus = "overdue" | "due_today" | "at_risk" | "on_track" | "not_applicable";

export interface DashboardPriorityItem {
  id: string;
  kind:
    | "overdue_request"
    | "unassigned_maintenance"
    | "overdue_maintenance"
    | "maintenance_attention"
    | "stockout"
    | "missing_location";
  severity: Exclude<DashboardSeverity, "success">;
  entityType: DashboardEntityType;
  entityId: string;
  entityLabel: string;
  createdAt: string;
  dueAt: string | null;
  overdueDays: number;
  owner: string | null;
  ownerKind: "named" | "current_user" | "unassigned" | "operations_queue";
  location: string | null;
  company: string | null;
  status: string;
  slaStatus: DashboardSlaStatus;
  impact: "service" | "custody" | "inventory" | "data";
  href: string;
  action: "open" | "review" | "prepare" | "scan";
}

export interface DashboardWorkItem {
  id: string;
  entityType: DashboardEntityType;
  entityId: string;
  entityLabel: string;
  status: string;
  severity: Exclude<DashboardSeverity, "success">;
  owner: string | null;
  ownerKind: DashboardPriorityItem["ownerKind"];
  dueAt: string | null;
  createdAt: string;
  location: string | null;
  href: string;
  action: "open" | "review" | "prepare" | "scan";
  canMutate: false;
}

export interface DashboardRiskItem extends DashboardPriorityItem {
  category: "actionable" | "historical" | "data_quality";
}

export interface RequestTrendDay {
  date: string;
  created: number;
  completed: number;
}

export interface AssetStatusPoint {
  status: "available" | "reserved" | "in_maintenance";
  count: number;
  percentage: number;
  href: string;
}

export interface DashboardRequestPreview {
  id: string;
  requestNumber: string;
  source: string;
  requester: string | null;
  status: string;
  owner: string | null;
  ownerKind: DashboardPriorityItem["ownerKind"];
  createdAt: string;
  dueAt: string | null;
  slaStatus: DashboardSlaStatus;
  href: string;
}

export interface DashboardMaintenancePreview {
  id: string;
  assetId: string;
  assetLabel: string;
  problem: string | null;
  status: string;
  owner: string | null;
  ownerKind: DashboardPriorityItem["ownerKind"];
  createdAt: string;
  dueAt: string | null;
  slaStatus: DashboardSlaStatus;
  href: string;
}

export interface DashboardInventoryRisk {
  id: string;
  name: string;
  quantity: number;
  reorderLevel: number;
  createdAt: string;
  location: string | null;
  href: string;
}

export interface DashboardActivityItem {
  id: string;
  action: string;
  entityType: DashboardEntityType;
  entityId: string;
  entityLabel: string;
  actor: string | null;
  actorVisible: boolean;
  occurredAt: string;
  href: string;
}

export interface DashboardViewer {
  id: string;
  email: string;
  name: string;
  role: DashboardRole;
  capabilities: string[];
}

export interface DashboardMetadata {
  status: DashboardDataStatus;
  scope: "authorized_organization";
  period: "current_and_30_days";
  updatedAt: string;
  generatedAt: string;
  staleAfterMinutes: number;
  referenceId: string;
  unavailableSources: DashboardSource[];
}

export interface DashboardCommandCenterData {
  viewer: DashboardViewer;
  metadata: DashboardMetadata;
  kpis: WidgetResult<DashboardKpi[]>;
  priorities: WidgetResult<DashboardPriorityItem[]>;
  myWork: WidgetResult<DashboardWorkItem[]>;
  requestTrend: WidgetResult<RequestTrendDay[]>;
  assetStatus: WidgetResult<AssetStatusPoint[]>;
  inventory: WidgetResult<DashboardInventoryRisk[]>;
  activity: WidgetResult<DashboardActivityItem[]>;
}
