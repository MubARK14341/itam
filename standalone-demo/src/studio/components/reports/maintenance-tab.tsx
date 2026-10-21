"use client";

import Link from "next/link";
import { Info, Wrench } from "lucide-react";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { MAINT_STATUS_TONE, PRIORITY_TONE, STAGE_TONE } from "@/lib/tone";
import { formatDate, formatSAR, formatTimes } from "@/lib/format";
import {
  BarRows, FinTag, RankList, ReportCard, ReportEmpty, ReportKpiBand, TabToolbar, type ReportKpi,
} from "@/components/reports/report-ui";

type MaintSummary = {
  byType: [string, number][];
  byPriority: [string, number][];
  byProblemType: [string, number][];
  byStage: [string, number][];
  topCost: any[];
  topFreq: { tag: string; count: number; cost: number | null }[];
  critical: any[];
  recent: any[];
};

const toBars = (rows: [string, number][]) => rows.map(([label, n]) => ({ key: label, label, n }));

export function MaintenanceTab({ kpis, maint, fin }: { kpis: ReportKpi[]; maint: MaintSummary; fin: boolean }) {
  const { t, lang } = useAppPreferences();
  const rep = t.reports;
  const mh = t.maintenance.headers;
  const L = rep.ledger;
  const stageLabel = (r: { workflow_stage?: string; status: string }) =>
    t.stage[r.workflow_stage as keyof typeof t.stage] ?? t.maintStatus[r.status as keyof typeof t.maintStatus] ?? r.status;
  const tagLink = (asset: { id: string; asset_tag: string } | null | undefined) => asset
    ? <Link href={`/assets/${asset.id}`} prefetch={false} className="tag text-[13px] font-semibold text-brand-ink hover:text-brand-hover">{asset.asset_tag}</Link>
    : <span className="tag text-[13px] text-muted">—</span>;

  return (
    <div className="space-y-[18px]">
      <TabToolbar note={<span className="inline-flex items-center gap-1.5"><Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{L.scope.maintenance}</span>} />

      <ReportKpiBand items={kpis} label={L.kpiLabel} />

      <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2">
        <ReportCard id="rep-mnt-stage" title={rep.maintTab.byStage}>
          <BarRows rows={toBars(maint.byStage)} tone="warn" ariaLabel={rep.maintTab.byStage} emptyText={rep.maintTab.noData} />
        </ReportCard>
        <ReportCard id="rep-mnt-priority" title={rep.maintTab.byPriority}>
          <BarRows rows={toBars(maint.byPriority)} tone="bad" ariaLabel={rep.maintTab.byPriority} emptyText={rep.maintTab.noData} />
        </ReportCard>
        <ReportCard id="rep-mnt-problem" title={rep.maintTab.byProblem}>
          <BarRows rows={toBars(maint.byProblemType)} tone="warn" ariaLabel={rep.maintTab.byProblem} emptyText={rep.maintTab.noData} labelWidth="9rem" />
        </ReportCard>
        <ReportCard id="rep-mnt-type" title={rep.maintTab.byType}>
          <BarRows rows={toBars(maint.byType)} ariaLabel={rep.maintTab.byType} emptyText={rep.maintTab.noData} />
        </ReportCard>
      </div>

      <div className={`grid grid-cols-1 gap-[18px] ${fin ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        {fin && (
          <ReportCard id="rep-mnt-topcost" title={rep.maintTab.topCost} actions={<FinTag short />}>
            <RankList
              emptyText={rep.maintTab.noRecords}
              rows={maint.topCost.map((r) => ({ key: r.id, label: tagLink(r.asset), value: <span className="tabular-nums">{formatSAR(r.cost, lang)}</span> }))}
            />
          </ReportCard>
        )}
        <ReportCard id="rep-mnt-frequent" title={rep.maintTab.mostFrequent}>
          <RankList
            emptyText={rep.maintTab.noRecords}
            rows={maint.topFreq.map((r) => ({
              key: r.tag,
              label: <span className="tag text-[13px] text-brand-ink">{r.tag}</span>,
              value: <span className="text-xs font-normal tabular-nums text-fg-2">{formatTimes(r.count, lang)}{fin && r.cost != null ? ` · ${formatSAR(r.cost, lang)}` : ""}</span>,
            }))}
          />
        </ReportCard>
        <ReportCard id="rep-mnt-critical" title={rep.maintTab.critical}>
          <RankList
            emptyText={rep.maintTab.noRecords}
            rows={maint.critical.map((r) => ({
              key: r.id,
              label: tagLink(r.asset),
              value: r.priority
                ? <StatusChip size="sm" tone={PRIORITY_TONE[r.priority]}>{t.priority[r.priority as keyof typeof t.priority] ?? r.priority}</StatusChip>
                : "—",
            }))}
          />
        </ReportCard>
      </div>

      {/* أحدث سجلات الصيانة + روابط الإدارة (تفتح صفحة الصيانة / السجل المحدد) */}
      <ReportCard
        id="rep-mnt-recent"
        title={rep.maintTab.recent}
        flush
        actions={<Link href="/maintenance" prefetch={false} className="text-[13px] font-semibold text-brand-ink hover:text-brand-hover">{rep.maintTab.viewAll}</Link>}
      >
        {maint.recent.length === 0 ? <ReportEmpty icon={Wrench} title={rep.maintTab.noRecords} /> : (
          <div tabIndex={0} className="overflow-x-auto">
            <table className="ui-table">
              <caption className="sr-only">{rep.maintTab.recent}</caption>
              <thead>
                <tr>
                  <th scope="col">{rep.export.tag}</th>
                  <th scope="col">{mh.problem}</th>
                  <th scope="col">{mh.status}</th>
                  {fin && <th scope="col">{mh.cost}</th>}
                  <th scope="col">{mh.date}</th>
                </tr>
              </thead>
              <tbody>
                {maint.recent.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/maintenance?m=${r.id}`} prefetch={false} className="tag whitespace-nowrap text-[13px] font-medium text-brand-ink hover:text-brand-hover">{r.asset?.asset_tag ?? r.asset?.name ?? "—"}</Link>
                    </td>
                    <td className="max-w-[22rem] truncate text-fg-2" title={r.problem_description ?? undefined}>{r.problem_description ?? "—"}</td>
                    <td>
                      <StatusChip tone={(r.workflow_stage && STAGE_TONE[r.workflow_stage]) || MAINT_STATUS_TONE[r.status]}>{stageLabel(r)}</StatusChip>
                    </td>
                    {fin && (
                      <td className="whitespace-nowrap tabular-nums text-fg-2">
                        {r.cost_recorded === true && r.cost != null ? formatSAR(r.cost, lang) : "—"}
                      </td>
                    )}
                    <td className="whitespace-nowrap text-[12.5px] tabular-nums text-fg-2">{formatDate(r.reported_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ReportCard>
    </div>
  );
}
