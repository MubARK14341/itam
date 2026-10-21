"use client";

import Link from "next/link";
import { ClipboardList, Info } from "lucide-react";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { REQUEST_STATUS_TONE } from "@/lib/tone";
import { formatDate } from "@/lib/format";
import type { RequestListRow } from "@/lib/requests";
import {
  BarRows, ColumnBars, ReportCard, ReportEmpty, ReportKpiBand, SegToggle, TabToolbar,
  type BarRow, type ReportKpi,
} from "@/components/reports/report-ui";

export type RequestSource = "all" | "customer" | "employee";

export function RequestsTab({
  kpis, source, onSourceChange, sourceCounts, statusRows, trend, recent, partyName,
}: {
  kpis: ReportKpi[];
  source: RequestSource;
  onSourceChange: (source: RequestSource) => void;
  sourceCounts: Record<RequestSource, number>;
  statusRows: BarRow[];
  trend: [string, number][];
  recent: RequestListRow[];
  partyName: (r: RequestListRow) => string;
}) {
  const { t, lang } = useAppPreferences();
  const rep = t.reports;
  const rep2 = t.requests;
  const L = rep.ledger;
  const total = statusRows.reduce((sum, r) => sum + r.n, 0);

  return (
    <div className="space-y-[18px]">
      <TabToolbar note={<span className="inline-flex items-center gap-1.5"><Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{L.scope.requests}</span>}>
        <SegToggle<RequestSource>
          label={rep2.requesterParty}
          value={source}
          onChange={onSourceChange}
          options={[
            { key: "all", label: t.common.all, count: sourceCounts.all },
            { key: "customer", label: rep2.partyCustomer, count: sourceCounts.customer },
            { key: "employee", label: rep2.partyEmployee, count: sourceCounts.employee },
          ]}
        />
      </TabToolbar>

      <ReportKpiBand items={kpis} label={L.kpiLabel} />

      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <ReportCard
          id="rep-req-status"
          title={rep.requestsTab.statusDist}
          description={<><span className="tabular-nums">{total}</span> {L.requestsUnit} · {L.statusSub}</>}
        >
          <BarRows rows={statusRows} ariaLabel={rep.requestsTab.statusDist} emptyText={rep.maintTab.noData} labelWidth="7.5rem" />
        </ReportCard>
        <ReportCard id="rep-req-trend" title={rep.requestsTab.trend} description={L.trendSub}>
          <ColumnBars rows={trend} ariaLabel={rep.requestsTab.trend} emptyText={rep.maintTab.noData} />
        </ReportCard>
      </div>

      <ReportCard
        id="rep-req-recent"
        title={rep.requestsTab.recent}
        flush
        actions={<Link href="/requests" prefetch={false} className="text-[13px] font-semibold text-brand-ink hover:text-brand-hover">{rep.requestsTab.viewAll}</Link>}
      >
        {recent.length === 0 ? <ReportEmpty icon={ClipboardList} title={rep.requestsTab.noData} /> : (
          <div tabIndex={0} className="overflow-x-auto">
            <table className="ui-table">
              <caption className="sr-only">{rep.requestsTab.recent}</caption>
              <thead>
                <tr>
                  <th scope="col">{rep2.number}</th>
                  <th scope="col">{rep2.requesterParty}</th>
                  <th scope="col">{rep2.status}</th>
                  <th scope="col">{L.createdCol}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/requests/${r.id}`} prefetch={false} dir="ltr" className="whitespace-nowrap font-mono text-[13px] font-medium text-brand-ink [unicode-bidi:isolate] hover:text-brand-hover">{r.request_number}</Link>
                    </td>
                    <td className="max-w-[18rem] truncate text-fg-2">{partyName(r)}</td>
                    <td><StatusChip tone={REQUEST_STATUS_TONE[r.status]}>{t.requestStatus[r.status as keyof typeof t.requestStatus] ?? r.status}</StatusChip></td>
                    <td className="whitespace-nowrap text-[12.5px] tabular-nums text-fg-2">{formatDate(r.created_at, lang)}</td>
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
