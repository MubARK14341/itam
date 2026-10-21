import type { Dict } from "@/lib/i18n";
import {
  isAssetMaintenanceAttention,
  isMaintenanceLongOpen,
  isMaintenanceOpenNoAction,
} from "@/lib/alert-predicates";
import {
  buildConsumableRisk,
  buildMaintenanceTrend,
  type ConsumableRiskRow,
  type MaintenanceTrendRow,
  type MaintenanceWeekBucket,
} from "@/lib/dashboard-trends";

export type PeriodKey = "30d" | "90d" | "12m" | "all";

export interface DashboardFilters {
  period: PeriodKey;
  location: string;
  department: string;
  status: string;
  category: string;
}

export const DEFAULT_FILTERS: DashboardFilters = {
  period: "90d",
  location: "",
  department: "",
  status: "",
  category: "",
};

const PERIOD_DAYS: Record<PeriodKey, number | null> = {
  "30d": 30,
  "90d": 90,
  "12m": 365,
  all: null,
};

export interface DashboardAlert {
  key: string;
  title: string;
  desc: string;
  severity: "low" | "medium" | "high" | "critical";
  count: number;
  href: string;
}

interface CompletenessMetric {
  pct: number;
  missing: number;
  base: number;
  href: string;
}

export interface DashboardV2Data {
  kpis: {
    total: number;
    available: number;
    reserved: number;
    in_maintenance: number;
  };
  statusStrip: Array<{ key: string; count: number; pct: number; href: string }>;
  alerts: DashboardAlert[];
  maintenanceTrend: {
    weeks: MaintenanceWeekBucket[];
    medianCloseDays: number | null;
    unavailable: boolean;
    counts: { reported: number; completed: number };
  };
  consumableRisk: {
    rows: ConsumableRiskRow[];
    totalAtRisk: number;
    withoutThreshold: number;
  };
  dataQuality: {
    assetTag: CompletenessMetric;
    model: CompletenessMetric;
    company: CompletenessMetric;
  };
}

export interface DashboardV2Raw {
  assets: any[];
  consumables: any[];
  maintenance: any[];
  summary?: DashboardExactSummary | null;
  trendRows: MaintenanceTrendRow[];
  trendUnavailable: boolean;
  trendCounts: { reported: number; completed: number };
}

export interface DashboardExactSummary {
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

function completeness(missing: number, base: number, href = "/assets"): CompletenessMetric {
  return {
    pct: base ? Math.round(((base - missing) / base) * 100) : 100,
    missing,
    base,
    href,
  };
}

export function selectDashboardV2(
  raw: DashboardV2Raw,
  filters: DashboardFilters,
  t: Dict,
  now = Date.now(),
): DashboardV2Data {
  const assets = raw.assets.filter((asset) => {
    if (filters.category && asset.category?.id !== filters.category) return false;
    if (filters.location && asset.location?.id !== filters.location) return false;
    if (filters.department && asset.department?.id !== filters.department) return false;
    if (filters.status && asset.status !== filters.status) return false;
    return true;
  });
  const assetIds = new Set(assets.map((asset) => asset.id));
  const hasAssetFilters = Boolean(filters.category || filters.location || filters.department || filters.status);
  const useExactSummary = !hasAssetFilters && filters.period === "all" && raw.summary;
  const maintenance = raw.maintenance.filter((record) =>
    !hasAssetFilters || assetIds.has(record.asset?.id ?? record.asset_id));

  const byStatusFromRows = (status: string) => assets.filter((asset) => asset.status === status).length;
  const byStatus = (status: "available" | "reserved" | "in_maintenance") =>
    useExactSummary ? raw.summary!.assets[status] : byStatusFromRows(status);
  const total = useExactSummary ? raw.summary!.assets.total : assets.length;
  const percentage = (count: number) => total ? Math.round((count / total) * 100) : 0;
  const statusStrip = [
    { key: "available", count: byStatus("available"), pct: percentage(byStatus("available")), href: "/assets?status=available" },
    { key: "reserved", count: byStatus("reserved"), pct: percentage(byStatus("reserved")), href: "/assets?status=reserved" },
    { key: "in_maintenance", count: byStatus("in_maintenance"), pct: percentage(byStatus("in_maintenance")), href: "/assets?status=in_maintenance" },
  ];

  const periodDays = PERIOD_DAYS[filters.period];
  const periodCutoff = periodDays == null ? null : now - periodDays * 86_400_000;
  const maintenanceInPeriod = maintenance.filter((record) => {
    if (periodCutoff == null) return true;
    const timestamp = Date.parse(record.reported_at ?? record.created_at ?? "");
    return Number.isFinite(timestamp) && timestamp >= periodCutoff;
  });

  const maintenanceAttention = assets.filter(isAssetMaintenanceAttention);
  const longMaintenance = maintenance.filter((record) => isMaintenanceLongOpen(record, now));
  const openNoAction = maintenanceInPeriod.filter(isMaintenanceOpenNoAction);
  const labels = t.dashboard.alerts;
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const rawAlerts: DashboardAlert[] = [
    { key: "long_maint", title: labels.long_maint.title, desc: labels.long_maint.desc, severity: "high", count: useExactSummary ? raw.summary!.maintenance.long_open : longMaintenance.length, href: "/maintenance?view=long_maint" },
    { key: "maintenance_attention", title: labels.maintenance_attention.title, desc: labels.maintenance_attention.desc, severity: "high", count: useExactSummary ? raw.summary!.assets.in_maintenance : maintenanceAttention.length, href: "/assets?view=maintenance_attention" },
    { key: "open_no_action", title: labels.open_no_action.title, desc: labels.open_no_action.desc, severity: "medium", count: useExactSummary ? raw.summary!.maintenance.no_action : openNoAction.length, href: "/maintenance?view=no_action" },
  ];
  const alerts = rawAlerts.filter((alert) => alert.count > 0)
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.count - a.count);

  const tagMissing = assets.filter((asset) => !String(asset.asset_tag ?? "").trim()).length;
  const modelMissing = assets.filter((asset) => !asset.model_id && !asset.model?.id).length;
  const companyMissing = assets.filter((asset) => !asset.company_id && !asset.company?.id).length;
  const trend = buildMaintenanceTrend(raw.trendRows, now);

  const consumableRisk = buildConsumableRisk(raw.consumables);
  if (raw.summary) {
    consumableRisk.totalAtRisk = raw.summary.consumables.at_risk;
    consumableRisk.withoutThreshold = raw.summary.consumables.without_threshold;
  }

  return {
    kpis: {
      total,
      available: byStatus("available"),
      reserved: byStatus("reserved"),
      in_maintenance: byStatus("in_maintenance"),
    },
    statusStrip,
    alerts,
    maintenanceTrend: {
      ...trend,
      unavailable: raw.trendUnavailable,
      counts: raw.trendCounts,
    },
    consumableRisk,
    dataQuality: {
      assetTag: completeness(tagMissing, total),
      model: completeness(modelMissing, total),
      company: completeness(companyMissing, total),
    },
  };
}
