"use client";

import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import { BriefcaseBusiness, ChevronLeft } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDate } from "@/lib/format";
import type { DashboardWorkItem, WidgetResult } from "@/lib/dashboard/dashboard-types";
import { DashboardSection, DASHBOARD_META, LtrText, SeverityBadge } from "@/components/dashboard-v6/dashboard-ui";
import { WidgetEmpty, WidgetError, WidgetPartial } from "@/components/dashboard-v6/widget-state";

export function MyWork({
  result,
  onRetry,
}: {
  result: WidgetResult<DashboardWorkItem[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const copy = t.dashboard.v6;
  const requestStatuses = t.requestStatus as Record<string, string>;
  const maintenanceStatuses = t.maintStatus as Record<string, string>;
  const assetStatuses = t.status as Record<string, string>;
  const statusLabel = (item: DashboardWorkItem) => {
    if (item.entityType === "request") return requestStatuses[item.status] || item.status;
    if (item.entityType === "maintenance") return maintenanceStatuses[item.status] || item.status;
    if (item.entityType === "asset") return assetStatuses[item.status] || item.status;
    if (item.status === "stockout") return t.consumables.profile.statusOut;
    if (item.status === "below_reorder") return t.consumables.profile.statusLow;
    return item.status;
  };
  return (
    <DashboardSection id="dashboard-work-title" title={copy.sections.myWork.title} description={copy.sections.myWork.description} icon={BriefcaseBusiness}>
      {result.status === "error" ? (
        <WidgetError sources={result.unavailableSources} onRetry={onRetry} />
      ) : (
        <>
          <WidgetPartial result={result} />
          {result.data.length === 0 ? (
            <WidgetEmpty />
          ) : (
            <ul className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
              {result.data.map((item) => (
                <li key={item.id} className="min-w-0">
                  <Link href={item.href} prefetch={false} {...prefetchIntentProps(item.href, router.prefetch)} className="dashboard-interactive flex min-h-24 min-w-0 items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={item.severity} />
                        <span className="text-xs text-slate-600 dark:text-slate-300">{copy.work.status}: {statusLabel(item)}</span>
                      </div>
                      <p className="mt-2 truncate text-sm font-semibold text-slate-950 dark:text-slate-50"><LtrText>{item.entityLabel}</LtrText></p>
                      <p className={`mt-1 truncate ${DASHBOARD_META}`}>
                        {copy.work.owner}: {item.owner || copy.priority.owners[item.ownerKind]} · {copy.work.due}: <LtrText>{formatDate(item.dueAt, lang)}</LtrText>
                      </p>
                    </div>
                    <span className="sr-only">{copy.work.open}</span>
                    <ChevronLeft className="h-5 w-5 shrink-0 text-slate-400 rtl:rotate-180" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </DashboardSection>
  );
}
