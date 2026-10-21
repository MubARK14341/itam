"use client";

import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import { Boxes, ClipboardList, ExternalLink, PackageSearch, Wrench } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { dashboardAgeDays } from "@/lib/dashboard/dashboard-filters";
import { formatDate } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import type {
  AssetStatusPoint,
  DashboardInventoryRisk,
  DashboardMaintenancePreview,
  DashboardRequestPreview,
  WidgetResult,
} from "@/lib/dashboard/dashboard-types";
import { DashboardSection, DASHBOARD_META, DASHBOARD_SURFACE, LtrText } from "@/components/dashboard-v6/dashboard-ui";
import { WidgetEmpty, WidgetError, WidgetPartial } from "@/components/dashboard-v6/widget-state";

function RequestList({
  result,
  onRetry,
}: {
  result: WidgetResult<DashboardRequestPreview[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const copy = t.dashboard.v6.operations.request;
  const statuses = t.requestStatus as Record<string, string>;
  const sources = t.requests.sourceLabel as Record<string, string>;
  if (result.status === "error") return <WidgetError sources={result.unavailableSources} onRetry={onRetry} />;
  if (result.status === "empty") return <WidgetEmpty />;
  return (
    <>
      <WidgetPartial result={result} />
      <ul className="space-y-2">
        {result.data.map((row) => (
          <li key={row.id} className="min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-950 dark:text-slate-50"><LtrText>{row.requestNumber}</LtrText></p>
                <p className={`mt-1 truncate ${DASHBOARD_META}`}>{row.requester || "—"} · {sources[row.source] || "—"}</p>
              </div>
              <span className="shrink-0 rounded-full border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 dark:border-slate-600 dark:text-slate-200">{statuses[row.status] || row.status}</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div><dt className={DASHBOARD_META}>{copy.owner}</dt><dd>{row.owner || t.dashboard.v6.priority.owners[row.ownerKind]}</dd></div>
              <div><dt className={DASHBOARD_META}>{copy.age}</dt><dd><LtrText>{interpolate(t.dashboard.v6.priority.days, { days: dashboardAgeDays(row.createdAt) })}</LtrText></dd></div>
              <div><dt className={DASHBOARD_META}>{copy.sla}</dt><dd>{t.dashboard.v6.priority.slaStatus[row.slaStatus]}</dd></div>
              <div><dt className={DASHBOARD_META}>{t.dashboard.v6.priority.due}</dt><dd><LtrText>{formatDate(row.dueAt, lang)}</LtrText></dd></div>
            </dl>
            <Link href={row.href} prefetch={false} {...prefetchIntentProps(row.href, router.prefetch)} className="dashboard-interactive mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-secondary hover:underline">
              {copy.next}<ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function MaintenanceList({
  result,
  onRetry,
}: {
  result: WidgetResult<DashboardMaintenancePreview[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const copy = t.dashboard.v6.operations.maintenance;
  const statuses = t.maintStatus as Record<string, string>;
  if (result.status === "error") return <WidgetError sources={result.unavailableSources} onRetry={onRetry} />;
  if (result.status === "empty") return <WidgetEmpty />;
  return (
    <>
      <WidgetPartial result={result} />
      <ul className="space-y-2">
        {result.data.map((row) => (
          <li key={row.id} className="min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-950 dark:text-slate-50"><LtrText>{row.assetLabel}</LtrText></p>
                <p className={`mt-1 line-clamp-2 ${DASHBOARD_META}`}>{row.problem || "—"}</p>
              </div>
              <span className="shrink-0 rounded-full border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 dark:border-slate-600 dark:text-slate-200">{statuses[row.status] || row.status}</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div><dt className={DASHBOARD_META}>{copy.owner}</dt><dd>{row.owner || t.dashboard.v6.priority.owners[row.ownerKind]}</dd></div>
              <div><dt className={DASHBOARD_META}>{copy.age}</dt><dd><LtrText>{interpolate(t.dashboard.v6.priority.days, { days: dashboardAgeDays(row.createdAt) })}</LtrText></dd></div>
              <div><dt className={DASHBOARD_META}>{copy.sla}</dt><dd>{t.dashboard.v6.priority.slaStatus[row.slaStatus]}</dd></div>
              <div><dt className={DASHBOARD_META}>{t.dashboard.v6.priority.due}</dt><dd><LtrText>{formatDate(row.dueAt, lang)}</LtrText></dd></div>
            </dl>
            <Link href={row.href} prefetch={false} {...prefetchIntentProps(row.href, router.prefetch)} className="dashboard-interactive mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-secondary hover:underline">
              {copy.next}<ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function RequestsMaintenance({
  requests,
  maintenance,
  onRetry,
}: {
  requests: WidgetResult<DashboardRequestPreview[]>;
  maintenance: WidgetResult<DashboardMaintenancePreview[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6;
  return (
    <DashboardSection id="dashboard-requests-maintenance-title" title={copy.sections.requestsMaintenance.title} description={copy.sections.requestsMaintenance.description} icon={ClipboardList}>
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <article className={`${DASHBOARD_SURFACE} min-w-0 p-4`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950 dark:text-slate-50"><ClipboardList className="h-4 w-4" aria-hidden="true" />{copy.operations.requestsTitle}</h3>
            <Link href="/requests" prefetch={false} {...prefetchIntentProps("/requests", router.prefetch)} className="dashboard-interactive inline-flex min-h-11 min-w-11 items-center text-xs font-semibold text-secondary hover:underline">{copy.operations.viewAll}</Link>
          </div>
          <RequestList result={requests} onRetry={onRetry} />
        </article>
        <article className={`${DASHBOARD_SURFACE} min-w-0 p-4`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950 dark:text-slate-50"><Wrench className="h-4 w-4" aria-hidden="true" />{copy.operations.maintenanceTitle}</h3>
            <Link href="/maintenance" prefetch={false} {...prefetchIntentProps("/maintenance", router.prefetch)} className="dashboard-interactive inline-flex min-h-11 min-w-11 items-center text-xs font-semibold text-secondary hover:underline">{copy.operations.viewAll}</Link>
          </div>
          <MaintenanceList result={maintenance} onRetry={onRetry} />
        </article>
      </div>
    </DashboardSection>
  );
}

function InventoryList({
  result,
  onRetry,
}: {
  result: WidgetResult<DashboardInventoryRisk[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6.operations.inventory;
  if (result.status === "error") return <WidgetError sources={result.unavailableSources} onRetry={onRetry} />;
  if (result.status === "empty") return <WidgetEmpty />;
  return (
    <>
      <WidgetPartial result={result} />
      <ul className="space-y-2">
        {result.data.map((row) => (
          <li key={row.id}>
            <Link href={row.href} prefetch={false} {...prefetchIntentProps(row.href, router.prefetch)} className="dashboard-interactive flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-950 dark:text-slate-50">{row.name}</p>
                <p className={`mt-1 ${DASHBOARD_META}`}>{copy.location}: {row.location || "—"}</p>
              </div>
              <span className="shrink-0 text-end text-xs text-slate-700 dark:text-slate-200">
                <span className="block font-semibold text-rose-700 dark:text-rose-300"><LtrText>{row.quantity}</LtrText></span>
                <span>{copy.threshold}: <LtrText>{row.reorderLevel}</LtrText></span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function AssetSummary({
  result,
  onRetry,
}: {
  result: WidgetResult<AssetStatusPoint[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6.charts.assets;
  if (result.status === "error") return <WidgetError sources={result.unavailableSources} onRetry={onRetry} />;
  if (result.status === "empty") return <WidgetEmpty />;
  return (
    <ul className="grid grid-cols-2 gap-2">
      {result.data.map((point) => (
        <li key={point.status}>
          <Link href={point.href} prefetch={false} {...prefetchIntentProps(point.href, router.prefetch)} className="dashboard-interactive block min-h-20 rounded-xl border border-slate-200 p-3 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60">
            <span className={DASHBOARD_META}>{copy.statuses[point.status]}</span>
            <span className="mt-1 block text-xl font-semibold text-slate-950 dark:text-slate-50"><LtrText>{point.count}</LtrText></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function AssetsInventory({
  assetStatus,
  inventory,
  onRetry,
}: {
  assetStatus: WidgetResult<AssetStatusPoint[]>;
  inventory: WidgetResult<DashboardInventoryRisk[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6;
  return (
    <DashboardSection id="dashboard-assets-inventory-title" title={copy.sections.assetsInventory.title} description={copy.sections.assetsInventory.description} icon={Boxes}>
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <article className={`${DASHBOARD_SURFACE} min-w-0 p-4`}>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-950 dark:text-slate-50"><Boxes className="h-4 w-4" aria-hidden="true" />{copy.charts.assets.title}</h3>
          <AssetSummary result={assetStatus} onRetry={onRetry} />
        </article>
        <article className={`${DASHBOARD_SURFACE} min-w-0 p-4`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950 dark:text-slate-50"><PackageSearch className="h-4 w-4" aria-hidden="true" />{copy.operations.inventoryTitle}</h3>
            <Link href="/consumables" prefetch={false} {...prefetchIntentProps("/consumables", router.prefetch)} className="dashboard-interactive inline-flex min-h-11 min-w-11 items-center text-xs font-semibold text-secondary hover:underline">{copy.operations.viewAll}</Link>
          </div>
          <InventoryList result={inventory} onRetry={onRetry} />
        </article>
      </div>
    </DashboardSection>
  );
}
