"use client";

// Alerts and activity stay implemented for their canonical routes but are not selectable from the
// Reports tab bar (Reports has exactly five primary areas). Kept here, restyled, with no logic change.

import Link from "next/link";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { StatusChip } from "@/components/ui/status-chip";
import { formatDate, formatDateTime } from "@/lib/format";
import type { ActivityEvent } from "@/lib/queries";
import { RankList, ReportCard, ReportKpiBand } from "@/components/reports/report-ui";

type OperationalAlert = { id: string; severity: "critical" | "warning" | "info"; title: string; description: string; href?: string | null };

export function AlertsTab({ counts, alerts, inAppEnabled }: {
  counts: { key: string; label: string; n: number }[];
  alerts: OperationalAlert[];
  inAppEnabled: boolean;
}) {
  const { t } = useAppPreferences();
  const tnf = t.notifications;
  return (
    <div className="space-y-[18px]">
      <ReportKpiBand label={t.reports.ledger.kpiLabel} items={counts.map((c) => ({ key: c.key, label: c.label, value: c.n, tone: c.n > 0 ? "bad" : undefined }))} />
      <ReportCard
        id="rep-alerts"
        title={<span className="inline-flex items-center gap-2">{tnf.operationalAlerts}{alerts.length > 0 && <span className="ui-count ui-count-hot">{alerts.length}</span>}</span>}
        description={tnf.operationalSubtitle}
      >
        {!inAppEnabled && <p className="mb-3 rounded-control bg-sunk px-4 py-3 text-sm text-fg-2">{tnf.disabledInApp}</p>}
        {alerts.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">{tnf.table.none}</p> : (
          <ul className="-my-2 divide-y divide-line">
            {alerts.map((alert) => (
              <li key={alert.id}>
                <Link href={alert.href || "/alerts"} className="flex items-start gap-3 py-3 hover:bg-surface-2">
                  <StatusChip size="sm" tone={alert.severity === "critical" ? "bad" : alert.severity === "warning" ? "warn" : "neu"}>{tnf.sev[alert.severity]}</StatusChip>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-fg">{alert.title}</span>
                    <span className="block text-xs text-muted">{alert.description}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ReportCard>
    </div>
  );
}

export function ActivityTab({ activity, insights }: {
  activity: ActivityEvent[];
  insights: { mostEdited: [string, number][]; recentMaint: ActivityEvent[]; recentCustody: ActivityEvent[] };
}) {
  const { t, lang } = useAppPreferences();
  const rep = t.reports;
  const ops = t.activity.ops as Record<string, string>;
  const eventRows = (events: ActivityEvent[]) => events.map((e) => ({
    key: e.id,
    label: <>{e.entityLabel ?? "—"} <span className="text-[11px] text-muted">· {ops[e.op] ?? e.op}</span></>,
    value: <span className="text-[11px] font-normal tabular-nums text-muted">{formatDate(e.at, lang)}</span>,
  }));
  return (
    <div className="space-y-[18px]">
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-3">
        <ReportCard id="rep-act-edited" title={rep.activityTab.mostEdited}>
          <RankList
            emptyText={rep.activityTab.noEdits}
            rows={insights.mostEdited.map(([tag, n]) => ({ key: tag, label: <span className="tag text-[13px] text-brand-ink">{tag}</span>, value: <span className="text-xs font-normal text-fg-2">{n} {rep.activityTab.edits}</span> }))}
          />
        </ReportCard>
        <ReportCard id="rep-act-maint" title={rep.activityTab.recentMaint}>
          <RankList emptyText={rep.activityTab.none} rows={eventRows(insights.recentMaint)} />
        </ReportCard>
        <ReportCard id="rep-act-custody" title={rep.activityTab.recentCustody}>
          <RankList emptyText={rep.activityTab.none} rows={eventRows(insights.recentCustody)} />
        </ReportCard>
      </div>
      <ReportCard
        id="rep-act-recent"
        title={rep.activityTab.systemRecent}
        actions={<Link href="/activity" className="text-[13px] font-semibold text-brand-ink hover:text-brand-hover">{rep.activityTab.viewAll}</Link>}
      >
        {activity.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">{rep.activityTab.empty}</p> : (
          <ul className="-my-2 divide-y divide-line">
            {activity.slice(0, 12).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <StatusChip size="sm" tone="neu" dot={false}>{ops[e.op] ?? e.op}</StatusChip>
                  {e.href
                    ? <Link href={e.href} className="font-medium text-brand-ink hover:text-brand-hover">{e.entityLabel ?? "—"}</Link>
                    : <span className="text-fg">{e.entityLabel ?? "—"}</span>}
                  {e.actor && <span className="text-xs text-muted">· {rep.activityTab.by} {e.actor}</span>}
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatDateTime(e.at, lang)}</span>
              </li>
            ))}
          </ul>
        )}
      </ReportCard>
    </div>
  );
}
