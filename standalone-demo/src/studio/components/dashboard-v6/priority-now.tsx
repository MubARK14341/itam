"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import { ArrowUpLeft, ShieldAlert } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDate, formatRelative } from "@/lib/format";
import { interpolate } from "@/lib/i18n";
import type { DashboardPriorityItem, DashboardSlaStatus, WidgetResult } from "@/lib/dashboard/dashboard-types";
import { DashboardSection, LtrText, SeverityBadge } from "@/components/dashboard-v6/dashboard-ui";
import { WidgetEmpty, WidgetError, WidgetPartial } from "@/components/dashboard-v6/widget-state";

type Severity = DashboardPriorityItem["severity"];
type SeverityFilter = "all" | Severity;

const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info", "neutral"];
const VISIBLE_LIMIT = 6;

const SLA_TEXT: Record<DashboardSlaStatus, string> = {
  overdue: "text-bad",
  due_today: "text-warn",
  at_risk: "text-warn",
  on_track: "text-ok",
  not_applicable: "text-muted",
};

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-bad",
  warning: "bg-warn",
  info: "bg-brand",
  neutral: "bg-muted",
};

function actionLabel(item: DashboardPriorityItem, copy: ReturnType<typeof useAppPreferences>["t"]["dashboard"]["v6"]) {
  if (item.kind === "maintenance_attention" || item.kind === "overdue_maintenance" || item.kind === "unassigned_maintenance") return copy.priority.actions.reviewMaintenance;
  if (item.kind === "overdue_request") return copy.priority.actions.reviewReturn;
  if (item.kind === "stockout") return copy.priority.actions.reviewInventory;
  return copy.priority.actions.openAsset;
}

export function PriorityNow({
  result,
  onRetry,
}: {
  result: WidgetResult<DashboardPriorityItem[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const copy = t.dashboard.v6;
  const ledger = t.dashboard.ledger;
  const [filter, setFilter] = useState<SeverityFilter>("all");

  const items = useMemo(() => (result.status === "error" ? [] : result.data), [result]);
  const referenceMs = result.status === "error" ? NaN : Date.parse(result.updatedAt);
  const counts = useMemo(() => {
    const byKey: Record<SeverityFilter, number> = { all: items.length, critical: 0, warning: 0, info: 0, neutral: 0 };
    for (const item of items) byKey[item.severity] += 1;
    return byKey;
  }, [items]);
  const filters: SeverityFilter[] = ["all", ...SEVERITY_ORDER.filter((severity) => counts[severity] > 0)];
  const activeFilter: SeverityFilter = filter === "all" || counts[filter] > 0 ? filter : "all";
  const filtered = activeFilter === "all" ? items : items.filter((item) => item.severity === activeFilter);
  const visible = filtered.slice(0, VISIBLE_LIMIT);
  const remaining = filtered.length - visible.length;

  const severityFilter = items.length > 1 && filters.length > 2 ? (
    <div role="group" aria-label={ledger.severityFilter} className="ui-seg print:hidden">
      {filters.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={activeFilter === key}
          onClick={() => setFilter(key)}
          className="dashboard-interactive ui-seg-item"
        >
          {key !== "all" && <span aria-hidden="true" className={`h-2 w-2 rounded-full ${SEVERITY_DOT[key]}`} />}
          {key === "all" ? ledger.all : copy.priority.severity[key]}
          <span className="text-[11.5px] tabular-nums text-muted">{counts[key]}</span>
        </button>
      ))}
    </div>
  ) : undefined;

  return (
    <DashboardSection
      id="dashboard-priority-title"
      title={copy.sections.priority.title}
      description={copy.sections.priority.description}
      icon={ShieldAlert}
      action={severityFilter}
      className="dashboard-priority"
      bodyClassName="px-5 pb-4"
    >
      {result.status === "error" ? (
        <div className="px-5 pb-5"><WidgetError sources={result.unavailableSources} onRetry={onRetry} /></div>
      ) : (
        <>
          <div className="px-5"><WidgetPartial result={result} priority /></div>
          {items.length === 0 ? (
            <div className="px-5 pb-5"><WidgetEmpty priority /></div>
          ) : (
            <>
              <div className="dashboard-priority-list md:grid-cols-2 xl:grid-cols-3">
                {visible.length === 0 && (
                  <p className="border-t border-line px-5 py-6 text-center text-[13px] text-muted">{ledger.noneForSeverity}</p>
                )}
                {visible.map((item) => {
                  const owner = item.ownerKind === "named" ? item.owner : copy.priority.owners[item.ownerKind];
                  return (
                    <article
                      key={item.id}
                      className="dashboard-priority-item gap-3 bg-surface-2 p-4"
                    >
                      <div><SeverityBadge severity={item.severity} /></div>
                      <div className="min-w-0">
                        <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-semibold text-fg">
                          <span>{copy.priority.kinds[item.kind]}</span>
                          <LtrText className="min-w-0 break-words font-mono text-[13px] font-medium text-fg-2">{item.entityLabel}</LtrText>
                        </h3>
                        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-muted">
                          <span>{item.dueAt ? copy.priority.due : copy.priority.since}: <LtrText>{item.dueAt ? formatDate(item.dueAt, lang) : formatRelative(item.createdAt, lang, referenceMs)}</LtrText></span>
                          {item.location && <span>{copy.priority.location}: {item.location}</span>}
                          {owner && <span className="text-fg-2">{copy.priority.owner}: {owner}</span>}
                          {item.slaStatus !== "not_applicable" && (
                            <span className={`font-semibold ${SLA_TEXT[item.slaStatus]}`}>{copy.priority.slaStatus[item.slaStatus]}</span>
                          )}
                        </p>
                      </div>
                      <Link href={item.href} prefetch={false} {...prefetchIntentProps(item.href, router.prefetch)} className="dashboard-interactive ui-button ui-button-outline ui-button-sm mt-auto min-h-11 w-full sm:min-h-9">
                        {actionLabel(item, copy)}
                        <ArrowUpLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
                      </Link>
                    </article>
                  );
                })}
              </div>
              <div className="mt-3 border-t border-line pt-1 print:hidden">
                <Link href="/alerts" prefetch={false} {...prefetchIntentProps("/alerts", router.prefetch)} className="dashboard-interactive inline-flex min-h-11 items-center text-[13px] font-semibold text-brand-ink hover:underline">
                  {remaining > 0 ? interpolate(copy.priority.more, { count: remaining }) : ledger.openActionCenter}
                </Link>
              </div>
            </>
          )}
        </>
      )}
    </DashboardSection>
  );
}
