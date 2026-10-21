"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { AlertTriangle, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { ASSET_STATUS_TONE } from "@/lib/tone";
import type { FinancialMetric } from "@/lib/financial-truth";
import {
  BarRows, ReportCard, ReportEmpty, ReportKpiBand, StackedRows, StatusLegend,
  stackRowOf, statusCounts, type AssetGroup, type ReportKpi,
} from "@/components/reports/report-ui";

export function ExecutiveTab({
  kpis, financialKpis, financialNotice, assets, byCategory, byLocation, risks, onClearFilters,
}: {
  kpis: ReportKpi[];
  /** Only passed for financial roles. */
  financialKpis?: ReportKpi[];
  /** Only passed for financial roles when a metric is incomplete. */
  financialNotice?: FinancialMetric | null;
  assets: any[];
  byCategory: AssetGroup[];
  byLocation: AssetGroup[];
  risks: { key: string; label: string; n: number }[];
  onClearFilters: () => void;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const rep = t.reports;
  const L = rep.ledger;
  const statusLabel = (s: keyof typeof t.status) => t.status[s];
  const total = assets.length;
  const statusRows = statusCounts(assets).map(([s, n]) => ({
    key: s, label: t.status[s], n, tone: ASSET_STATUS_TONE[s],
    display: <>{n} <span className="text-xs font-normal text-muted">· {total ? Math.round((n / total) * 100) : 0}%</span></>,
  }));

  return (
    <div className="space-y-6">
      <ReportKpiBand items={kpis} label={L.kpiLabel} />

      {financialNotice && (
        <div role="note" className="flex items-start gap-2.5 rounded-control border border-warn/20 bg-warn-soft p-4 text-warn">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{rep.financialTruth.incomplete}</p>
            <p className="mt-1 text-xs leading-relaxed tabular-nums">
              {rep.financialTruth.coverage}: {financialNotice.coveragePct}% ·
              {" "}{rep.financialTruth.used}: {financialNotice.usedRecords} ·
              {" "}{rep.financialTruth.excluded}: {financialNotice.excludedRecords}.
            </p>
            <Link href="/reports?tab=inventory#financial-data-quality" prefetch={false} {...prefetchIntentProps("/reports?tab=inventory#financial-data-quality", router.prefetch)} className="mt-2 inline-flex text-xs font-semibold text-warn underline underline-offset-2">
              {rep.financialTruth.openQueue}
            </Link>
          </div>
        </div>
      )}

      {financialKpis && <ReportKpiBand items={financialKpis} label={L.financialKpiLabel} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ReportCard
          id="rep-exec-category"
          title={rep.assetsTab.byCategory}
          description={<>{L.byCategorySub} · <span className="tabular-nums">{total}</span> {L.assetsUnit}</>}
          actions={<StatusLegend statusLabel={statusLabel} />}
        >
          {total === 0 ? (
            <ReportEmpty
              icon={SearchX}
              title={L.noAssetsMatch}
              description={L.noAssetsHint}
              action={<Button variant="outline" size="sm" onClick={onClearFilters}>{L.clearFilters}</Button>}
            />
          ) : (
            <StackedRows
              rows={byCategory.map((g) => stackRowOf(g, statusLabel))}
              grandTotal={total}
              ariaLabel={rep.assetsTab.byCategory}
              emptyText={rep.maintTab.noData}
            />
          )}
        </ReportCard>

        <ReportCard
          id="rep-exec-location"
          title={rep.assetsTab.byLocation}
          description={<>{L.byLocationSub} · <span className="tabular-nums">{byLocation.length}</span> {L.locationsUnit}</>}
        >
          <BarRows
            rows={byLocation.map((g) => ({ key: g.label, label: g.label, n: g.items.length }))}
            ariaLabel={rep.assetsTab.byLocation}
            emptyText={rep.maintTab.noData}
            labelWidth="9rem"
          />
        </ReportCard>
      </div>

      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <ReportCard id="rep-exec-status" title={rep.exec.statusDist} description={L.statusDistSub}>
          <BarRows rows={statusRows} ariaLabel={rep.exec.statusDist} emptyText={rep.maintTab.noData} />
        </ReportCard>

        <ReportCard id="rep-exec-risks" title={rep.exec.topRisks} description={rep.exec.topRisksHint}>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {risks.map((r) => (
              <li key={r.key} className={`rounded-control px-3.5 py-3 ${r.n > 0 ? "bg-bad-soft" : "bg-sunk"}`}>
                <p className={`font-display text-2xl font-semibold tabular-nums ${r.n > 0 ? "text-bad" : "text-muted"}`}>{r.n}</p>
                <p className="mt-0.5 text-xs text-fg-2">{r.label}</p>
              </li>
            ))}
          </ul>
        </ReportCard>
      </div>
    </div>
  );
}
