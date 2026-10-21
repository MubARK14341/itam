"use client";

import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import { Activity, ArrowUpLeft, Boxes, ClipboardList, MapPinOff, PackageSearch, Wrench, Clock3, PackageCheck, Undo2, CircleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDateTime } from "@/lib/format";
import type { DashboardKpi, DashboardKpiId, WidgetResult } from "@/lib/dashboard/dashboard-types";
import { DASHBOARD_META, DASHBOARD_SURFACE, LtrText, SEVERITY_VALUE_TEXT, SeverityBadge } from "@/components/dashboard-v6/dashboard-ui";
import { WidgetError, WidgetPartial } from "@/components/dashboard-v6/widget-state";

const KPI_ICONS: Record<DashboardKpiId, LucideIcon> = {
  actionableRequests: ClipboardList,
  overdueRequests: Clock3,
  maintenanceFollowup: Wrench,
  criticalConsumables: PackageSearch,
  availableAssets: Boxes,
  activeAssets: Boxes,
  inMaintenanceAssets: Wrench,
  preparationQueue: ClipboardList,
  readyDelivery: PackageCheck,
  returnsDue: Undo2,
  missingLocation: MapPinOff,
  assignedMaintenance: Wrench,
  assignedMaintenanceOverdue: CircleAlert,
  assignedRequests: Activity,
};

function actionLabel(kpiId: DashboardKpiId, copy: ReturnType<typeof useAppPreferences>["t"]["dashboard"]["v6"]) {
  if (["maintenanceFollowup", "assignedMaintenance", "assignedMaintenanceOverdue"].includes(kpiId)) return copy.priority.actions.reviewMaintenance;
  if (["overdueRequests", "returnsDue"].includes(kpiId)) return copy.priority.actions.reviewReturn;
  if (kpiId === "criticalConsumables") return copy.priority.actions.reviewInventory;
  if (["actionableRequests", "preparationQueue", "readyDelivery", "assignedRequests"].includes(kpiId)) return copy.priority.actions.openRequests;
  return copy.priority.actions.openAssets;
}

/** One Ledger band cell. The band's hairlines come from the 1px grid gap over `bg-line`. */
function KpiCard({ kpi }: { kpi: DashboardKpi }) {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const copy = t.dashboard.v6;
  const label = copy.kpis[kpi.id];
  const Icon = KPI_ICONS[kpi.id];
  const flagged = kpi.severity === "warning" || kpi.severity === "critical";
  return (
    <article className="ui-surface flex min-w-0 flex-col gap-1 break-inside-avoid px-5 py-4">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg-2">
          <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <span className="truncate">{label.label}</span>
        </h3>
        {flagged && <SeverityBadge severity={kpi.severity} size="sm" />}
      </div>
      <p className={`font-display text-[32px] font-semibold leading-tight tabular-nums ${SEVERITY_VALUE_TEXT[kpi.severity]}`}>
        <LtrText>{kpi.value}</LtrText>
      </p>
      <p className="line-clamp-2 text-[12.5px] leading-5 text-muted">{label.definition}</p>
      <p className="text-xs text-muted">
        {copy.meta.updated}: <LtrText>{formatDateTime(kpi.lastUpdatedAt, lang)}</LtrText>
      </p>
      {kpi.href && (
        <Link href={kpi.href} prefetch={false} {...prefetchIntentProps(kpi.href, router.prefetch)} className="dashboard-interactive mt-auto inline-flex min-h-11 items-center gap-1 self-start text-[13px] font-semibold text-brand-ink hover:underline">
          {actionLabel(kpi.id, copy)}<ArrowUpLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
        </Link>
      )}
    </article>
  );
}

export function KpiGrid({
  result,
  onRetry,
}: {
  result: WidgetResult<DashboardKpi[]>;
  onRetry: () => void;
}) {
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6;
  return (
    <section aria-labelledby="dashboard-kpi-title" className="min-w-0 break-inside-avoid">
      <div className="mb-3 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h2 id="dashboard-kpi-title" className="font-display text-[17px] font-semibold text-fg">{copy.sections.kpis.title}</h2>
        <p className={DASHBOARD_META}>{copy.sections.kpis.description}</p>
      </div>
      {result.status === "error" ? (
        <div className={`${DASHBOARD_SURFACE} p-4`}>
          <WidgetError sources={result.unavailableSources} onRetry={onRetry} />
        </div>
      ) : (
        <>
          <WidgetPartial result={result} />
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {result.data.slice(0, 4).map((kpi) => <KpiCard key={kpi.id} kpi={kpi} />)}
          </div>
        </>
      )}
    </section>
  );
}
