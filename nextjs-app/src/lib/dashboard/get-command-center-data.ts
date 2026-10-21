import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStaffAccessState } from "@/lib/auth-security";
import { handedOffContext } from "@/lib/read-seeds/context";
import { getVerifiedUser } from "@/lib/supabase/verified-user";
import {
  DASHBOARD_STALE_AFTER_MINUTES,
  DASHBOARD_TREND_DAYS,
  dashboardAgeDays,
  dateKeyInDashboardTimeZone,
} from "@/lib/dashboard/dashboard-filters";
import { dashboardKpiDefinition } from "@/lib/dashboard/kpi-definitions";
import { selectDashboardPriorities, dashboardSlaStatus } from "@/lib/dashboard/priority-selector";
import { dashboardRoleConfig } from "@/lib/dashboard/role-dashboard-config";
import { createArrayWidgetResult, uniqueDashboardSources } from "@/lib/dashboard/widget-result";
import type {
  AssetStatusPoint,
  DashboardActivityItem,
  DashboardCommandCenterData,
  DashboardDataStatus,
  DashboardInventoryRisk,
  DashboardKpi,
  DashboardKpiId,
  DashboardMaintenancePreview,
  DashboardPriorityItem,
  DashboardRequestPreview,
  DashboardRole,
  DashboardSource,
  DashboardViewer,
  DashboardWorkItem,
  RequestTrendDay,
} from "@/lib/dashboard/dashboard-types";

const DETAIL_LIMIT = 40;
const PREVIEW_LIMIT = 5;
const TREND_SAFE_ROW_LIMIT = 1000;
const TERMINAL_REQUEST_STATUSES = ["completed", "cancelled", "rejected"];
const OPEN_MAINTENANCE_STATUSES = ["open", "in_progress"];
const WAREHOUSE_REQUEST_STATUSES = [
  "approved",
  "auto_provisioning",
  "provisioned",
  "stock_shortage",
  "preparing",
  "ready_for_pickup",
  "delivered",
  "partially_returned",
  "overdue",
  "returned",
];

interface OperationalSummary {
  assets: {
    total: number;
    available: number;
    reserved: number;
    in_maintenance: number;
  };
  consumables: {
    at_risk: number;
    stockout: number;
    without_threshold: number;
  };
  maintenance: {
    long_open: number;
    no_action: number;
    followup: number;
  };
  requests: {
    actionable: number;
    overdue: number;
    preparation: number;
    ready_delivery: number;
    returns_due: number;
    returned_inspection: number;
  };
}

interface EmbeddedName {
  name?: string | null;
  name_ar?: string | null;
  full_name?: string | null;
  full_name_ar?: string | null;
  code?: string | null;
}

interface RequestRow {
  id: string;
  request_number: string;
  request_source: string;
  customer_name_snapshot: string | null;
  project_name: string | null;
  project_city: string | null;
  status: string;
  responsible_employee_id: string | null;
  pickup_date: string | null;
  return_date: string | null;
  created_at: string;
  customer: EmbeddedName | EmbeddedName[] | null;
}

interface MaintenanceRow {
  id: string;
  asset_id: string;
  status: string;
  workflow_stage: string | null;
  priority: string | null;
  problem_description: string | null;
  reported_at: string;
  created_at: string;
  action_taken: string | null;
  technician_id: string | null;
  next_due_date: string | null;
  asset: {
    id?: string;
    asset_tag?: string | null;
    name?: string | null;
    location?: EmbeddedName | EmbeddedName[] | null;
    company?: EmbeddedName | EmbeddedName[] | null;
  } | Array<{
    id?: string;
    asset_tag?: string | null;
    name?: string | null;
    location?: EmbeddedName | EmbeddedName[] | null;
    company?: EmbeddedName | EmbeddedName[] | null;
  }> | null;
}

interface AssetExceptionRow {
  id: string;
  asset_tag: string | null;
  name: string | null;
  status: string;
  created_at: string;
  location_id: string | null;
  location: EmbeddedName | EmbeddedName[] | null;
  company: EmbeddedName | EmbeddedName[] | null;
  holder: EmbeddedName | EmbeddedName[] | null;
}

interface ConsumableRow {
  id: string;
  name: string;
  quantity_on_hand: number;
  reorder_level: number;
  created_at: string;
  location: EmbeddedName | EmbeddedName[] | null;
}

interface RequestEventRow {
  id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface MovementActivityRow {
  id: string;
  movement_type: string;
  performed_by: string | null;
  created_at: string;
  asset_id: string;
  asset: { id?: string; asset_tag?: string | null; name?: string | null } | Array<{ id?: string; asset_tag?: string | null; name?: string | null }> | null;
}

interface MaintenanceActivityRow {
  id: string;
  asset_id: string;
  status: string;
  reported_at: string;
  completed_at: string | null;
  reported_by: string | null;
  asset: { id?: string; asset_tag?: string | null; name?: string | null } | Array<{ id?: string; asset_tag?: string | null; name?: string | null }> | null;
}

interface ConsumableActivityRow {
  id: string;
  consumable_id: string;
  txn_type: string;
  performed_by: string | null;
  created_at: string;
  consumable: { id?: string; name?: string | null } | Array<{ id?: string; name?: string | null }> | null;
}

interface UserLabelRow {
  id: string;
  label: string;
}

interface SupplementalCounts {
  missingLocation: number | null;
  assignedMaintenance: number | null;
  assignedMaintenanceOverdue: number | null;
  assignedRequests: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteCount(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseOperationalSummary(value: unknown): OperationalSummary | null {
  const root = record(value);
  const assets = record(root?.assets);
  const consumables = record(root?.consumables);
  const maintenance = record(root?.maintenance);
  const requests = record(root?.requests);
  if (!assets || !consumables || !maintenance || !requests) return null;

  const parsed: OperationalSummary = {
    assets: {
      total: finiteCount(assets.total) ?? -1,
      available: finiteCount(assets.available) ?? -1,
      reserved: finiteCount(assets.reserved) ?? -1,
      in_maintenance: finiteCount(assets.in_maintenance) ?? -1,
    },
    consumables: {
      at_risk: finiteCount(consumables.at_risk) ?? -1,
      stockout: finiteCount(consumables.stockout) ?? -1,
      without_threshold: finiteCount(consumables.without_threshold) ?? -1,
    },
    maintenance: {
      long_open: finiteCount(maintenance.long_open) ?? -1,
      no_action: finiteCount(maintenance.no_action) ?? -1,
      followup: finiteCount(maintenance.followup) ?? -1,
    },
    requests: {
      actionable: finiteCount(requests.actionable) ?? -1,
      overdue: finiteCount(requests.overdue) ?? -1,
      preparation: finiteCount(requests.preparation) ?? -1,
      ready_delivery: finiteCount(requests.ready_delivery) ?? -1,
      returns_due: finiteCount(requests.returns_due) ?? -1,
      returned_inspection: finiteCount(requests.returned_inspection) ?? -1,
    },
  };
  const values = [
    ...Object.values(parsed.assets),
    ...Object.values(parsed.consumables),
    ...Object.values(parsed.maintenance),
    ...Object.values(parsed.requests),
  ];
  return values.every((valueItem) => valueItem >= 0) ? parsed : null;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function displayName(value: EmbeddedName | EmbeddedName[] | null | undefined): string | null {
  const item = one(value);
  return item?.name_ar?.trim()
    || item?.name?.trim()
    || item?.full_name_ar?.trim()
    || item?.full_name?.trim()
    || item?.code?.trim()
    || null;
}

function entityLabel(tag: string | null | undefined, name: string | null | undefined, fallback: string): string {
  return tag?.trim() || name?.trim() || fallback;
}

export async function resolveDashboardViewer(): Promise<{
  viewer: DashboardViewer;
  supabase: Awaited<ReturnType<typeof createClient>>;
}> {
  const supabase = await createClient();
  // Middleware strips client-supplied headers and hands off only its freshly verified identity,
  // after approval, active-state and MFA checks. Reuse it within this request; RLS still checks
  // this client's own JWT for every widget read. Missing context retains the verified fallback.
  const initial = (await handedOffContext())?.session;
  const handedOff = initial && typeof initial.userId === "string" && initial.userId
    && initial.approvalStatus === "approved" ? initial : null;
  let userId = handedOff?.userId ?? "";
  let email = handedOff?.email ?? "";
  let role: string | null = handedOff?.role ?? null;
  if (!handedOff) {
    const { data: { user }, error } = await getVerifiedUser(() => supabase.auth.getUser());
    if (error || !user) redirect("/login");
    const staff = await getStaffAccessState(supabase, user.id);
    if (!staff || staff.approval_status !== "approved" || !staff.is_active) redirect("/pending-approval");
    userId = user.id;
    email = user.email ?? "";
    role = staff.role;
  }
  // The executive dashboard is intentionally manager-only. Operational and
  // read-only states have their own landings; do this server-side so a direct
  // URL never renders dashboard data before the client guard runs.
  if (role === "employee" || role === "technician" || role === "warehouse_manager") redirect("/my-tasks");
  if (role === "viewer" || role === "auditor") redirect("/overview");
  if (role !== "admin" && role !== "it_manager") redirect("/pending-approval");

  const [profileResult, capabilitiesResult] = await Promise.all([
    supabase.from("app_users").select("email,full_name").eq("id", userId).maybeSingle(),
    handedOff ? Promise.resolve(null) : supabase.rpc("my_capabilities"),
  ]);

  const profile = profileResult.error ? null : profileResult.data;

  const rawCapabilities = handedOff?.capabilities ?? (!capabilitiesResult?.error ? capabilitiesResult?.data : null);
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((item): item is string => typeof item === "string") : [];

  return {
    supabase,
    viewer: {
      id: userId,
      email: profile?.email || email,
      name: profile?.full_name?.trim() || profile?.email || email,
      role,
      capabilities,
    },
  };
}

function ownerFor(
  ownerId: string | null,
  viewer: DashboardViewer,
  labels: ReadonlyMap<string, string>,
): Pick<DashboardPriorityItem, "owner" | "ownerKind"> {
  if (!ownerId) return { owner: null, ownerKind: "unassigned" };
  if (ownerId === viewer.id) return { owner: viewer.name, ownerKind: "current_user" };
  const label = labels.get(ownerId);
  return label
    ? { owner: label, ownerKind: "named" }
    : { owner: null, ownerKind: "operations_queue" };
}

function buildRequestPriorities(
  rows: RequestRow[],
  viewer: DashboardViewer,
  labels: ReadonlyMap<string, string>,
  now: string,
): DashboardPriorityItem[] {
  const today = dateKeyInDashboardTimeZone(now);
  return rows.flatMap((row): DashboardPriorityItem[] => {
    const overdue = row.status === "overdue"
      || (
        (row.status === "delivered" || row.status === "partially_returned")
        && Boolean(row.return_date && row.return_date < today)
      );
    if (!overdue) return [];
    const owner = ownerFor(row.responsible_employee_id, viewer, labels);
    return [{
      id: `request-${row.id}`,
      kind: "overdue_request",
      severity: "critical",
      entityType: "request",
      entityId: row.id,
      entityLabel: row.request_number,
      createdAt: row.created_at,
      dueAt: row.return_date,
      overdueDays: dashboardAgeDays(row.return_date, now),
      ...owner,
      location: row.project_city,
      company: displayName(row.customer) || row.customer_name_snapshot,
      status: row.status,
      slaStatus: "overdue",
      impact: "custody",
      href: `/requests/${row.id}`,
      action: "review",
    }];
  });
}

function buildMaintenancePriorities(
  rows: MaintenanceRow[],
  viewer: DashboardViewer,
  labels: ReadonlyMap<string, string>,
  now: string,
): DashboardPriorityItem[] {
  const today = dateKeyInDashboardTimeZone(now);
  return rows.flatMap((row): DashboardPriorityItem[] => {
    if (!OPEN_MAINTENANCE_STATUSES.includes(row.status)) return [];
    const asset = one(row.asset);
    const age = dashboardAgeDays(row.reported_at || row.created_at, now);
    const overdue = Boolean(row.next_due_date && row.next_due_date < today);
    const unassigned = !row.technician_id && !row.action_taken?.trim();
    if (!overdue && !unassigned && age <= 14) return [];
    const owner = ownerFor(row.technician_id, viewer, labels);
    return [{
      id: `maintenance-${row.id}`,
      kind: overdue ? "overdue_maintenance" : "unassigned_maintenance",
      severity: overdue || row.priority === "critical" ? "critical" : "warning",
      entityType: "maintenance",
      entityId: row.id,
      entityLabel: entityLabel(asset?.asset_tag, asset?.name, row.id),
      createdAt: row.reported_at || row.created_at,
      dueAt: row.next_due_date,
      overdueDays: overdue ? dashboardAgeDays(row.next_due_date, now) : Math.max(0, age - 14),
      ...owner,
      location: displayName(asset?.location),
      company: displayName(asset?.company),
      status: row.status,
      slaStatus: overdue ? "overdue" : unassigned ? "at_risk" : dashboardSlaStatus(row.next_due_date, now),
      impact: "service",
      href: `/maintenance?m=${row.id}`,
      action: "open",
    }];
  });
}

function buildAssetRisks(rows: AssetExceptionRow[], now: string): DashboardPriorityItem[] {
  return rows.flatMap((row): DashboardPriorityItem[] => {
    const label = entityLabel(row.asset_tag, row.name, row.id);
    const common = {
      entityType: "asset" as const,
      entityId: row.id,
      entityLabel: label,
      createdAt: row.created_at,
      dueAt: null,
      overdueDays: dashboardAgeDays(row.created_at, now),
      owner: displayName(row.holder),
      ownerKind: displayName(row.holder) ? "named" as const : "operations_queue" as const,
      location: displayName(row.location),
      company: displayName(row.company),
      status: row.status,
      slaStatus: "not_applicable" as const,
      href: `/assets/${row.id}`,
      action: "review" as const,
    };
    const result: DashboardPriorityItem[] = [];
    if (row.status === "in_maintenance") {
      result.push({
        ...common,
        id: `asset-status-${row.id}`,
        kind: "maintenance_attention",
        severity: "warning",
        impact: "custody",
      });
    }
    if (!row.location_id) {
      result.push({
        ...common,
        id: `asset-location-${row.id}`,
        kind: "missing_location",
        severity: "info",
        impact: "data",
      });
    }
    return result;
  });
}

function buildInventoryRisks(rows: ConsumableRow[], now: string): DashboardPriorityItem[] {
  return rows
    .filter((row) => row.reorder_level > 0 && row.quantity_on_hand === 0)
    .map((row) => ({
      id: `consumable-${row.id}`,
      kind: "stockout",
      severity: "critical",
      entityType: "consumable",
      entityId: row.id,
      entityLabel: row.name,
      createdAt: row.created_at,
      dueAt: null,
      overdueDays: dashboardAgeDays(row.created_at, now),
      owner: null,
      ownerKind: "operations_queue",
      location: displayName(row.location),
      company: null,
      status: "stockout",
      slaStatus: "at_risk",
      impact: "inventory",
      href: `/consumables/${row.id}`,
      action: "prepare",
    } satisfies DashboardPriorityItem));
}

function summaryKpiValue(
  id: DashboardKpiId,
  summary: OperationalSummary | null,
  supplemental: SupplementalCounts,
): number | null {
  if (id === "missingLocation") return supplemental.missingLocation;
  if (id === "assignedMaintenance") return supplemental.assignedMaintenance;
  if (id === "assignedMaintenanceOverdue") return supplemental.assignedMaintenanceOverdue;
  if (id === "assignedRequests") return supplemental.assignedRequests;
  if (!summary) return null;
  switch (id) {
    case "actionableRequests": return summary.requests.actionable;
    case "overdueRequests": return summary.requests.overdue;
    case "maintenanceFollowup": return summary.maintenance.followup;
    case "criticalConsumables": return summary.consumables.at_risk;
    case "availableAssets": return summary.assets.available;
    case "activeAssets": return summary.assets.total;
    case "inMaintenanceAssets": return summary.assets.in_maintenance;
    case "preparationQueue": return summary.requests.preparation;
    case "readyDelivery": return summary.requests.ready_delivery;
    case "returnsDue": return summary.requests.returns_due;
    default: return null;
  }
}

function kpiSeverity(id: DashboardKpiId, value: number | null): DashboardKpi["severity"] {
  if (value == null || value === 0) return "neutral";
  if (
    id === "overdueRequests"
    || id === "criticalConsumables"
    || id === "assignedMaintenanceOverdue"
  ) return "critical";
  if (
    id === "actionableRequests"
    || id === "maintenanceFollowup"
    || id === "returnsDue"
    || id === "missingLocation"
  ) return "warning";
  return "info";
}

function buildKpis(
  viewer: DashboardViewer,
  summary: OperationalSummary | null,
  supplemental: SupplementalCounts,
  updatedAt: string,
): DashboardKpi[] {
  return dashboardRoleConfig(viewer.role).kpis.map((id) => {
    const definition = dashboardKpiDefinition(id);
    const value = summaryKpiValue(id, summary, supplemental);
    return {
      id,
      value: value ?? "—",
      unit: "count",
      severity: kpiSeverity(id, value),
      definitionId: id,
      source: definition.source,
      period: definition.period,
      lastUpdatedAt: value == null ? null : updatedAt,
      href: definition.href,
      isPartial: value == null,
      financial: false,
    };
  });
}

function requestPreview(
  rows: RequestRow[],
  viewer: DashboardViewer,
  labels: ReadonlyMap<string, string>,
): DashboardRequestPreview[] {
  return rows
    .filter((row) => !TERMINAL_REQUEST_STATUSES.includes(row.status))
    .slice(0, PREVIEW_LIMIT)
    .map((row) => {
      const owner = ownerFor(row.responsible_employee_id, viewer, labels);
      const dueAt = row.return_date || row.pickup_date;
      return {
        id: row.id,
        requestNumber: row.request_number,
        source: row.request_source,
        requester: displayName(row.customer) || row.customer_name_snapshot || row.project_name,
        status: row.status,
        ...owner,
        createdAt: row.created_at,
        dueAt,
        slaStatus: dashboardSlaStatus(dueAt),
        href: `/requests/${row.id}`,
      };
    });
}

function maintenancePreview(
  rows: MaintenanceRow[],
  viewer: DashboardViewer,
  labels: ReadonlyMap<string, string>,
): DashboardMaintenancePreview[] {
  return rows
    .filter((row) => OPEN_MAINTENANCE_STATUSES.includes(row.status))
    .slice(0, PREVIEW_LIMIT)
    .map((row) => {
      const asset = one(row.asset);
      return {
        id: row.id,
        assetId: row.asset_id,
        assetLabel: entityLabel(asset?.asset_tag, asset?.name, row.asset_id),
        problem: row.problem_description,
        status: row.status,
        ...ownerFor(row.technician_id, viewer, labels),
        createdAt: row.reported_at || row.created_at,
        dueAt: row.next_due_date,
        slaStatus: dashboardSlaStatus(row.next_due_date),
        href: `/maintenance?m=${row.id}`,
      };
    });
}

function inventoryPreview(rows: ConsumableRow[]): DashboardInventoryRisk[] {
  return rows
    .filter((row) => row.reorder_level > 0 && row.quantity_on_hand <= row.reorder_level)
    .sort((a, b) => {
      const aRatio = a.quantity_on_hand / a.reorder_level;
      const bRatio = b.quantity_on_hand / b.reorder_level;
      return aRatio - bRatio || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    })
    .slice(0, PREVIEW_LIMIT)
    .map((row) => ({
      id: row.id,
      name: row.name,
      quantity: row.quantity_on_hand,
      reorderLevel: row.reorder_level,
      createdAt: row.created_at,
      location: displayName(row.location),
      href: `/consumables/${row.id}`,
    }));
}

function requestTrend(rows: RequestEventRow[], now: string): RequestTrendDay[] {
  const today = dateKeyInDashboardTimeZone(now);
  const end = new Date(`${today}T12:00:00.000Z`);
  const days = Array.from({ length: DASHBOARD_TREND_DAYS }, (_, index): RequestTrendDay => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() + index - (DASHBOARD_TREND_DAYS - 1));
    return { date: date.toISOString().slice(0, 10), created: 0, completed: 0 };
  });
  const byDate = new Map(days.map((day) => [day.date, day]));
  for (const row of rows) {
    const day = byDate.get(dateKeyInDashboardTimeZone(row.created_at));
    if (!day) continue;
    if (row.event_type === "submitted") day.created += 1;
    if (
      row.event_type === "status_changed"
      && typeof row.metadata?.to === "string"
      && row.metadata.to === "completed"
    ) day.completed += 1;
  }
  return days;
}

function assetStatus(summary: OperationalSummary): AssetStatusPoint[] {
  const total = summary.assets.total;
  const point = (
    status: AssetStatusPoint["status"],
    count: number,
    href: string,
  ): AssetStatusPoint => ({
    status,
    count,
    percentage: total ? Math.round((count / total) * 100) : 0,
    href,
  });
  return [
    point("available", summary.assets.available, "/assets?status=available"),
    point("reserved", summary.assets.reserved, "/assets?status=reserved"),
    point("in_maintenance", summary.assets.in_maintenance, "/assets?status=in_maintenance"),
  ];
}

function workItems(
  viewer: DashboardViewer,
  priorities: DashboardPriorityItem[],
  requestRows: RequestRow[],
  maintenanceRows: MaintenanceRow[],
  inventoryRows: ConsumableRow[],
  labels: ReadonlyMap<string, string>,
): DashboardWorkItem[] {
  const fromPriority = (item: DashboardPriorityItem): DashboardWorkItem => ({
    id: item.id,
    entityType: item.entityType,
    entityId: item.entityId,
    entityLabel: item.entityLabel,
    status: item.status,
    severity: item.severity,
    owner: item.owner,
    ownerKind: item.ownerKind,
    dueAt: item.dueAt,
    createdAt: item.createdAt,
    location: item.location,
    href: item.href,
    action: item.action,
    canMutate: false,
  });

  if (viewer.role === "technician") {
    return maintenanceRows
      .filter((row) => row.technician_id === viewer.id && OPEN_MAINTENANCE_STATUSES.includes(row.status))
      .map((row) => {
        const asset = one(row.asset);
        return {
          id: `work-maintenance-${row.id}`,
          entityType: "maintenance",
          entityId: row.id,
          entityLabel: entityLabel(asset?.asset_tag, asset?.name, row.asset_id),
          status: row.status,
          severity: dashboardSlaStatus(row.next_due_date) === "overdue" ? "critical" : "info",
          owner: viewer.name,
          ownerKind: "current_user",
          dueAt: row.next_due_date,
          createdAt: row.reported_at || row.created_at,
          location: displayName(asset?.location),
          href: `/maintenance?m=${row.id}`,
          action: "open",
          canMutate: false,
        } satisfies DashboardWorkItem;
      })
      .slice(0, PREVIEW_LIMIT);
  }

  if (viewer.role === "warehouse_manager") {
    const requestWork = requestRows
      .filter((row) => WAREHOUSE_REQUEST_STATUSES.includes(row.status))
      .map((row) => ({
        id: `work-request-${row.id}`,
        entityType: "request" as const,
        entityId: row.id,
        entityLabel: row.request_number,
        status: row.status,
        severity: row.status === "overdue" ? "critical" as const : "info" as const,
        ...ownerFor(row.responsible_employee_id, viewer, labels),
        dueAt: row.return_date || row.pickup_date,
        createdAt: row.created_at,
        location: row.project_city,
        href: `/requests/${row.id}`,
        action: "prepare" as const,
        canMutate: false as const,
      }));
    const stockWork = inventoryPreview(inventoryRows).map((row) => ({
      id: `work-consumable-${row.id}`,
      entityType: "consumable" as const,
      entityId: row.id,
      entityLabel: row.name,
      status: row.quantity === 0 ? "stockout" : "below_reorder",
      severity: row.quantity === 0 ? "critical" as const : "warning" as const,
      owner: null,
      ownerKind: "operations_queue" as const,
      dueAt: null,
      createdAt: row.createdAt,
      location: row.location,
      href: row.href,
      action: "prepare" as const,
      canMutate: false as const,
    }));
    return [...requestWork, ...stockWork].slice(0, PREVIEW_LIMIT);
  }

  return priorities.slice(0, PREVIEW_LIMIT).map(fromPriority);
}

function activityItems(
  movements: MovementActivityRow[],
  maintenanceRows: MaintenanceActivityRow[],
  consumables: ConsumableActivityRow[],
  viewer: DashboardViewer,
  labels: ReadonlyMap<string, string>,
): DashboardActivityItem[] {
  const showActor = dashboardRoleConfig(viewer.role).showActor;
  const rows: DashboardActivityItem[] = [];
  for (const row of movements) {
    const asset = one(row.asset);
    rows.push({
      id: `movement-${row.id}`,
      action: row.movement_type,
      entityType: "asset",
      entityId: asset?.id || row.asset_id,
      entityLabel: entityLabel(asset?.asset_tag, asset?.name, row.asset_id),
      actor: showActor && row.performed_by ? labels.get(row.performed_by) ?? null : null,
      actorVisible: showActor,
      occurredAt: row.created_at,
      href: `/assets/${asset?.id || row.asset_id}`,
    });
  }
  for (const row of maintenanceRows) {
    const asset = one(row.asset);
    rows.push({
      id: `maintenance-open-${row.id}`,
      action: "maint_open",
      entityType: "maintenance",
      entityId: row.id,
      entityLabel: entityLabel(asset?.asset_tag, asset?.name, row.asset_id),
      actor: showActor && row.reported_by ? labels.get(row.reported_by) ?? null : null,
      actorVisible: showActor,
      occurredAt: row.reported_at,
      href: `/maintenance?m=${row.id}`,
    });
    if (row.completed_at) {
      rows.push({
        id: `maintenance-complete-${row.id}`,
        action: "maint_done",
        entityType: "maintenance",
        entityId: row.id,
        entityLabel: entityLabel(asset?.asset_tag, asset?.name, row.asset_id),
        actor: null,
        actorVisible: showActor,
        occurredAt: row.completed_at,
        href: `/maintenance?m=${row.id}`,
      });
    }
  }
  for (const row of consumables) {
    const item = one(row.consumable);
    rows.push({
      id: `consumable-${row.id}`,
      action: `cons_${row.txn_type}`,
      entityType: "consumable",
      entityId: item?.id || row.consumable_id,
      entityLabel: item?.name?.trim() || row.consumable_id,
      actor: showActor && row.performed_by ? labels.get(row.performed_by) ?? null : null,
      actorVisible: showActor,
      occurredAt: row.created_at,
      href: `/consumables/${item?.id || row.consumable_id}`,
    });
  }
  return rows
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id))
    .slice(0, 8);
}

export async function getDashboardCommandCenterData(): Promise<DashboardCommandCenterData> {
  const { viewer, supabase } = await resolveDashboardViewer();
  const generatedAt = new Date().toISOString();
  const today = dateKeyInDashboardTimeZone(generatedAt);
  const trendSince = new Date(Date.now() - (DASHBOARD_TREND_DAYS + 1) * 86_400_000).toISOString();
  const longMaintenanceBefore = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const requestSelect = "id,request_number,request_source,customer_name_snapshot,project_name,project_city,status,"
    + "responsible_employee_id,pickup_date,return_date,created_at,customer:customer_id(name)";
  const maintenanceSelect = "id,asset_id,status,workflow_stage,priority,problem_description,reported_at,created_at,action_taken,"
    + "technician_id,next_due_date,asset:asset_id(id,asset_tag,name,location:location_id(name,name_ar,code),company:company_id(name))";

  let requestQuery = supabase
    .from("requests")
    .select(requestSelect)
    .not("portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)")
    .not("status", "in", `(${TERMINAL_REQUEST_STATUSES.join(",")})`)
    .order("created_at", { ascending: true })
    .limit(DETAIL_LIMIT);
  if (viewer.role === "technician") requestQuery = requestQuery.eq("responsible_employee_id", viewer.id);
  if (viewer.role === "warehouse_manager") requestQuery = requestQuery.in("status", WAREHOUSE_REQUEST_STATUSES);

  let priorityRequestQuery = supabase
    .from("requests")
    .select(requestSelect)
    .not("portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)")
    .or(`status.eq.overdue,and(status.in.(delivered,partially_returned),return_date.lt.${today})`)
    .order("return_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(DETAIL_LIMIT);
  if (viewer.role === "technician") {
    priorityRequestQuery = priorityRequestQuery.eq("responsible_employee_id", viewer.id);
  }

  let maintenanceQuery = supabase
    .from("maintenance_records")
    .select(maintenanceSelect)
    .in("status", OPEN_MAINTENANCE_STATUSES)
    .order("reported_at", { ascending: true })
    .limit(DETAIL_LIMIT);
  if (viewer.role === "technician") maintenanceQuery = maintenanceQuery.eq("technician_id", viewer.id);

  let priorityMaintenanceQuery = supabase
    .from("maintenance_records")
    .select(maintenanceSelect)
    .in("status", OPEN_MAINTENANCE_STATUSES)
    .or(`next_due_date.lt.${today},technician_id.is.null,reported_at.lt.${longMaintenanceBefore}`)
    .order("next_due_date", { ascending: true, nullsFirst: false })
    .order("reported_at", { ascending: true })
    .limit(DETAIL_LIMIT);
  if (viewer.role === "technician") {
    priorityMaintenanceQuery = priorityMaintenanceQuery.eq("technician_id", viewer.id);
  }

  const technicianOnly = viewer.role === "technician";
  const [
    summaryResult,
    requestsResult,
    maintenanceResult,
    priorityRequestsResult,
    priorityMaintenanceResult,
    assetResult,
    inventoryResult,
    missingLocationResult,
    assignedMaintenanceResult,
    assignedMaintenanceOverdueResult,
    assignedRequestsResult,
    requestEventsResult,
    movementActivityResult,
    maintenanceActivityResult,
    consumableActivityResult,
  ] = await Promise.all([
    supabase.rpc("dashboard_operational_summary"),
    requestQuery,
    maintenanceQuery,
    priorityRequestQuery,
    priorityMaintenanceQuery,
    supabase
      .from("assets")
      .select(
        "id,asset_tag,name,status,created_at,location_id,location:location_id(name,name_ar,code),"
        + "company:company_id(name),holder:assigned_to_employee_id(full_name,full_name_ar)",
      )
      .eq("is_active", true)
      .or("status.eq.in_maintenance,location_id.is.null")
      .order("created_at", { ascending: true })
      .limit(DETAIL_LIMIT),
    supabase
      .from("consumables")
      .select("id,name,quantity_on_hand,reorder_level,created_at,location:location_id(name,name_ar,code)")
      .eq("is_active", true)
      .gt("reorder_level", 0)
      .order("quantity_on_hand", { ascending: true })
      .order("id", { ascending: true })
      .limit(DETAIL_LIMIT),
    supabase.from("assets").select("id", { count: "exact", head: true }).eq("is_active", true).is("location_id", null),
    technicianOnly
      ? supabase.from("maintenance_records").select("id", { count: "exact", head: true }).eq("technician_id", viewer.id).in("status", OPEN_MAINTENANCE_STATUSES)
      : Promise.resolve({ count: null, error: null }),
    technicianOnly
      ? supabase.from("maintenance_records").select("id", { count: "exact", head: true }).eq("technician_id", viewer.id).in("status", OPEN_MAINTENANCE_STATUSES).lt("next_due_date", today)
      : Promise.resolve({ count: null, error: null }),
    technicianOnly
      ? supabase.from("requests").select("id", { count: "exact", head: true }).eq("responsible_employee_id", viewer.id).not("status", "in", `(${TERMINAL_REQUEST_STATUSES.join(",")})`)
      : Promise.resolve({ count: null, error: null }),
    supabase
      .from("request_events")
      .select("id,event_type,metadata,created_at", { count: "exact" })
      .in("event_type", ["submitted", "status_changed"])
      .gte("created_at", trendSince)
      .order("created_at", { ascending: true })
      .limit(TREND_SAFE_ROW_LIMIT + 1),
    supabase
      .from("asset_movements")
      .select("id,movement_type,performed_by,created_at,asset_id,asset:asset_id(id,asset_tag,name)")
      .neq("movement_type", "create")
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("maintenance_records")
      .select("id,asset_id,status,reported_at,completed_at,reported_by,asset:asset_id(id,asset_tag,name)")
      .order("reported_at", { ascending: false })
      .limit(12),
    supabase
      .from("consumable_transactions")
      .select("id,consumable_id,txn_type,performed_by,created_at,consumable:consumable_id(id,name)")
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  const summary = summaryResult.error ? null : parseOperationalSummary(summaryResult.data);
  const requestRows = (requestsResult.data ?? []) as unknown as RequestRow[];
  const maintenanceRows = (maintenanceResult.data ?? []) as unknown as MaintenanceRow[];
  const priorityRequestRows = (priorityRequestsResult.data ?? []) as unknown as RequestRow[];
  const priorityMaintenanceRows = (priorityMaintenanceResult.data ?? []) as unknown as MaintenanceRow[];
  const assetRows = (assetResult.data ?? []) as unknown as AssetExceptionRow[];
  const inventoryRows = (inventoryResult.data ?? []) as unknown as ConsumableRow[];
  const movementRows = (movementActivityResult.data ?? []) as unknown as MovementActivityRow[];
  const maintenanceActivityRows = (maintenanceActivityResult.data ?? []) as unknown as MaintenanceActivityRow[];
  const consumableActivityRows = (consumableActivityResult.data ?? []) as unknown as ConsumableActivityRow[];

  const labelIds = new Set<string>();
  for (const row of requestRows) if (row.responsible_employee_id) labelIds.add(row.responsible_employee_id);
  for (const row of maintenanceRows) if (row.technician_id) labelIds.add(row.technician_id);
  for (const row of priorityRequestRows) if (row.responsible_employee_id) labelIds.add(row.responsible_employee_id);
  for (const row of priorityMaintenanceRows) if (row.technician_id) labelIds.add(row.technician_id);
  for (const row of movementRows) if (row.performed_by) labelIds.add(row.performed_by);
  for (const row of maintenanceActivityRows) if (row.reported_by) labelIds.add(row.reported_by);
  for (const row of consumableActivityRows) if (row.performed_by) labelIds.add(row.performed_by);

  const canReadActorLabels = viewer.role === "admin" || viewer.role === "it_manager";
  const labelResult = canReadActorLabels && labelIds.size
    ? await supabase.rpc("user_labels", { p_ids: [...labelIds] })
    : { data: [], error: null };
  const labels = new Map<string, string>(
    ((labelResult.data ?? []) as unknown as UserLabelRow[])
      .filter((row) => typeof row.id === "string" && typeof row.label === "string")
      .map((row) => [row.id, row.label]),
  );

  const priorityUnavailable: DashboardSource[] = [];
  if (priorityRequestsResult.error) priorityUnavailable.push("requests");
  if (priorityMaintenanceResult.error) priorityUnavailable.push("maintenance");
  if (assetResult.error) priorityUnavailable.push("assets");
  if (inventoryResult.error) priorityUnavailable.push("inventory");

  const priorityCandidates = [
    ...buildRequestPriorities(priorityRequestRows, viewer, labels, generatedAt),
    ...buildMaintenancePriorities(priorityMaintenanceRows, viewer, labels, generatedAt),
    ...buildAssetRisks(assetRows, generatedAt),
    ...buildInventoryRisks(inventoryRows, generatedAt),
  ];
  const priorities = selectDashboardPriorities(priorityCandidates);

  const supplemental: SupplementalCounts = {
    missingLocation: missingLocationResult.error ? null : missingLocationResult.count ?? 0,
    assignedMaintenance: technicianOnly
      ? assignedMaintenanceResult.error ? null : assignedMaintenanceResult.count ?? 0
      : null,
    assignedMaintenanceOverdue: technicianOnly
      ? assignedMaintenanceOverdueResult.error ? null : assignedMaintenanceOverdueResult.count ?? 0
      : null,
    assignedRequests: technicianOnly
      ? assignedRequestsResult.error ? null : assignedRequestsResult.count ?? 0
      : null,
  };
  const kpiRows = buildKpis(viewer, summary, supplemental, generatedAt);
  const kpiUnavailable: DashboardSource[] = [];
  if (!summary) kpiUnavailable.push("summary");
  if (missingLocationResult.error && viewer.role === "auditor") kpiUnavailable.push("assets");
  if (
    technicianOnly
    && (
      assignedMaintenanceResult.error
      || assignedMaintenanceOverdueResult.error
      || assignedRequestsResult.error
    )
  ) {
    kpiUnavailable.push("maintenance", "requests");
  }
  const allKpisUnavailable = kpiRows.every((row) => row.value === "—");

  const myWorkRows = workItems(viewer, priorities, requestRows, maintenanceRows, inventoryRows, labels);
  const myWorkUnavailable: DashboardSource[] = viewer.role === "technician"
    ? maintenanceResult.error ? ["maintenance"] : []
    : viewer.role === "warehouse_manager"
      ? [
          ...(requestsResult.error ? ["requests" as const] : []),
          ...(inventoryResult.error ? ["inventory" as const] : []),
        ]
      : priorityUnavailable;

  const trendTooLarge = (requestEventsResult.count ?? 0) > TREND_SAFE_ROW_LIMIT;
  const trendFailed = Boolean(requestEventsResult.error) || trendTooLarge;
  const trendRows = trendFailed
    ? []
    : requestTrend((requestEventsResult.data ?? []) as unknown as RequestEventRow[], generatedAt);
  const trendTotal = trendRows.reduce((sum, day) => sum + day.created + day.completed, 0);

  const activityUnavailable: DashboardSource[] = [];
  if (
    movementActivityResult.error
    || maintenanceActivityResult.error
    || consumableActivityResult.error
    || (canReadActorLabels && labelResult.error)
  ) {
    activityUnavailable.push("activity");
  }
  const recentActivity = activityItems(
    movementRows,
    maintenanceActivityRows,
    consumableActivityRows,
    viewer,
    labels,
  );

  const unavailableSources = uniqueDashboardSources([
    ...kpiUnavailable,
    ...priorityUnavailable,
    ...(requestsResult.error ? ["requests" as const] : []),
    ...(maintenanceResult.error ? ["maintenance" as const] : []),
    ...(trendFailed ? ["request_events" as const] : []),
    ...activityUnavailable,
  ]);
  const dataStatus: DashboardDataStatus = unavailableSources.length ? "partial" : "complete";

  return {
    viewer,
    metadata: {
      status: dataStatus,
      scope: "authorized_organization",
      period: "current_and_30_days",
      updatedAt: generatedAt,
      generatedAt,
      staleAfterMinutes: DASHBOARD_STALE_AFTER_MINUTES,
      referenceId: `DASH-${generatedAt.replace(/\D/g, "").slice(0, 14)}-${viewer.id.slice(0, 8)}`,
      unavailableSources,
    },
    kpis: allKpisUnavailable
      ? { status: "error", message: "unavailable", retryable: true, unavailableSources: uniqueDashboardSources(kpiUnavailable) }
      : createArrayWidgetResult(kpiRows, generatedAt, kpiUnavailable),
    priorities: createArrayWidgetResult(
      priorities,
      generatedAt,
      priorityUnavailable,
      priorityUnavailable.length === 4,
    ),
    myWork: createArrayWidgetResult(
      myWorkRows,
      generatedAt,
      myWorkUnavailable,
      myWorkUnavailable.length > 0 && myWorkRows.length === 0,
    ),
    requestTrend: trendFailed
      ? { status: "error", message: "unavailable", retryable: true, unavailableSources: ["request_events"] }
      : trendTotal === 0
        ? { status: "empty", data: trendRows, updatedAt: generatedAt }
        : { status: "success", data: trendRows, updatedAt: generatedAt },
    assetStatus: !summary
      ? { status: "error", message: "unavailable", retryable: true, unavailableSources: ["summary"] }
      : summary.assets.total === 0
        ? { status: "empty", data: assetStatus(summary), updatedAt: generatedAt }
        : { status: "success", data: assetStatus(summary), updatedAt: generatedAt },
    inventory: createArrayWidgetResult(
      inventoryPreview(inventoryRows),
      generatedAt,
      inventoryResult.error ? ["inventory"] : [],
      Boolean(inventoryResult.error),
    ),
    activity: createArrayWidgetResult(
      recentActivity,
      generatedAt,
      activityUnavailable,
      Boolean(movementActivityResult.error && maintenanceActivityResult.error && consumableActivityResult.error),
    ),
  };
}
