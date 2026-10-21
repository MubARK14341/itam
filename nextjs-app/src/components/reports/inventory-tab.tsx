"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Info, PackageOpen } from "lucide-react";
import { StatusChip } from "@/components/ui/status-chip";
import { FilterChip } from "@/components/ui/filter-chip";
import { Button } from "@/components/ui/button";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { ASSET_STATUS_TONE } from "@/lib/tone";
import { formatDate, formatSAR } from "@/lib/format";
import type { FinancialMetric } from "@/lib/financial-truth";
import type { FinancialDataQualityRow, FinancialDataQualitySummary } from "@/lib/queries";
import {
  BarRows, FinTag, RankList, ReportCard, ReportEmpty, ReportKpiBand, SegToggle, TabToolbar,
  financialTableValue, statusCounts, type AssetGroup,
} from "@/components/reports/report-ui";

export type InventoryKind = "all" | "asset" | "consumable";

type Consumables = {
  all: any[];
  mostDispensed: [string, number][];
  recent: any[];
  byCompany: [string, number][];
  recentReplenishment: any[];
  recentUsage: any[];
  costBySupplier: [string, number][];
};

export function InventoryTab({
  kind, onKindChange, filters, fin, kpi, assets, byCategory, byLocation, byDepartment, byCompany,
  assetMetricFor, financialQuality, cons, qualityLoaded, qualityLoading, qualityError,
  qualityExporting, qualityExportAllowed, onLoadMoreQuality, onRetryQuality, onExportQuality, lowOnly, onLowOnlyChange,
}: {
  kind: InventoryKind;
  onKindChange: (kind: InventoryKind) => void;
  lowOnly: boolean;
  onLowOnlyChange: (value: boolean) => void;
  /** Asset filter bar (only when the page shows it: assets-only view). */
  filters?: ReactNode;
  fin: boolean;
  kpi: { total: number; available: number; reserved: number; maint: number };
  assets: AssetGroup["items"];
  byCategory: AssetGroup[];
  byLocation: AssetGroup[];
  byDepartment: AssetGroup[];
  byCompany: AssetGroup[];
  assetMetricFor: (rows: AssetGroup["items"]) => FinancialMetric;
  financialQuality: { summary: FinancialDataQualitySummary | null; rows: FinancialDataQualityRow[]; nextOffset: number | null };
  qualityLoaded: boolean;
  qualityLoading: boolean;
  qualityError: string | null;
  qualityExporting: boolean;
  qualityExportAllowed: boolean;
  onLoadMoreQuality: () => void;
  onRetryQuality: () => void;
  onExportQuality: () => void;
  cons: Consumables;
}) {
  const { t, lang } = useAppPreferences();
  const rep = t.reports;
  const L = rep.ledger;
  const isLow = (c: { quantity_on_hand: number; reorder_level: number }) => c.quantity_on_hand <= c.reorder_level;
  const lowCount = cons.all.filter(isLow).length;
  const stockRows = lowOnly ? cons.all.filter(isLow) : cons.all;
  const maxCategory = Math.max(1, ...byCategory.map((g) => g.items.length));
  const pct = (n: number) => (kpi.total ? Math.round((n / kpi.total) * 100) : 0);

  return (
    <div className="space-y-[18px]">
      <TabToolbar note={<span className="inline-flex items-center gap-1.5"><Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{L.scope.inventory}</span>}>
        <SegToggle<InventoryKind>
          label={L.inventoryKind}
          value={kind}
          onChange={onKindChange}
          options={[
            { key: "all", label: t.common.all },
            { key: "asset", label: t.assetForm.typeAsset },
            { key: "consumable", label: t.assetForm.typeConsumable },
          ]}
        />
      </TabToolbar>

      {filters}

      {/* ---------------- INVENTORY: ASSETS ---------------- */}
      {kind !== "consumable" && (
        <>
          <ReportKpiBand
            label={L.kpiLabel}
            items={[
              { key: "total", label: rep.kpi.totalAssets, value: kpi.total, hint: L.withinFilters },
              { key: "available", label: rep.kpi.available, value: kpi.available, tone: "ok", hint: <><span className="tabular-nums">{pct(kpi.available)}%</span> {L.ofTotal}</> },
              { key: "reserved", label: rep.kpi.reserved, value: kpi.reserved, tone: "res", hint: L.reservedHint },
              { key: "maint", label: rep.risksLabels.inMaintenance, value: kpi.maint, tone: "warn", hint: L.maintHint },
            ]}
          />

          <ReportCard id="rep-inv-category" title={rep.assetsTab.byCategory} description={<><span className="tabular-nums">{kpi.total}</span> {L.assetsUnit}</>} flush>
            {byCategory.length === 0 ? <ReportEmpty title={rep.maintTab.noData} /> : (
              <div tabIndex={0} className="overflow-x-auto">
                <table className="ui-table">
                  <caption className="sr-only">{rep.assetsTab.byCategory}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{rep.assetsTab.category}</th>
                      <th scope="col">{rep.assetsTab.count}</th>
                      {fin && <th scope="col"><span className="inline-flex items-center gap-2">{rep.assetsTab.value}<FinTag short /></span></th>}
                      <th scope="col">{rep.assetsTab.statusBreakdown}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCategory.map((g) => (
                      <tr key={g.label}>
                        <td className="font-medium text-fg">{g.label}</td>
                        <td>
                          <span className="flex min-w-[8rem] items-center gap-2.5">
                            <span className="w-8 font-semibold tabular-nums">{g.items.length}</span>
                            <span aria-hidden="true" className="block h-2 flex-1 overflow-hidden rounded-full bg-sunk">
                              <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round((g.items.length / maxCategory) * 100)}%` }} />
                            </span>
                          </span>
                        </td>
                        {fin && (
                          <td className="whitespace-nowrap tabular-nums text-fg-2">
                            {financialTableValue(assetMetricFor(g.items), rep.financialTruth.incomplete, lang)}
                          </td>
                        )}
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {statusCounts(g.items).map(([s, n]) => (
                              <StatusChip key={s} size="sm" tone={ASSET_STATUS_TONE[s]}>{t.status[s]} <span className="tabular-nums">{n}</span></StatusChip>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportCard>

          <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-3">
            <ReportCard id="rep-inv-status" title={rep.assetsTab.byStatus}>
              <BarRows
                rows={statusCounts(assets).map(([s, n]) => ({ key: s, label: t.status[s], n, tone: ASSET_STATUS_TONE[s] }))}
                ariaLabel={rep.assetsTab.byStatus}
                emptyText={rep.maintTab.noData}
              />
            </ReportCard>
            <ReportCard id="rep-inv-location" title={rep.assetsTab.byLocation}>
              <BarRows rows={byLocation.map((g) => ({ key: g.label, label: g.label, n: g.items.length }))} ariaLabel={rep.assetsTab.byLocation} emptyText={rep.maintTab.noData} />
            </ReportCard>
            <ReportCard id="rep-inv-department" title={rep.assetsTab.byDepartment}>
              <BarRows rows={byDepartment.map((g) => ({ key: g.label, label: g.label, n: g.items.length }))} ariaLabel={rep.assetsTab.byDepartment} emptyText={rep.maintTab.noData} />
            </ReportCard>
          </div>

          {/* تحليل حسب الشركة/العلامة — العدد للجميع، والقيمة للمخوّلين ماليًا فقط */}
          <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">
            <ReportCard id="rep-inv-company" title={rep.assetsTab.assetsByCompany}>
              <BarRows rows={byCompany.map((g) => ({ key: g.label, label: g.label, n: g.items.length }))} ariaLabel={rep.assetsTab.assetsByCompany} emptyText={rep.maintTab.noData} />
            </ReportCard>
            {fin && (
              <ReportCard id="rep-inv-company-value" title={rep.assetsTab.valueByCompany} actions={<FinTag />}>
                <RankList
                  emptyText={rep.maintTab.noData}
                  rows={byCompany.map((g) => ({
                    key: g.label,
                    label: g.label,
                    value: financialTableValue(assetMetricFor(g.items), rep.financialTruth.incomplete, lang),
                  }))}
                />
              </ReportCard>
            )}
          </div>

          {fin && (
            <div id="financial-data-quality" className="scroll-mt-24">
              <ReportCard id="rep-inv-fdq" title={rep.financialTruth.queueTitle} description={rep.financialTruth.queueDesc} actions={
                <div className="flex flex-wrap items-center gap-2">
                  <FinTag />
                  {qualityExportAllowed && <Button size="sm" variant="outline" onClick={onExportQuality}
                    disabled={!qualityLoaded || qualityLoading || qualityExporting || !!qualityError || financialQuality.rows.length === 0}
                    aria-busy={qualityExporting}>{qualityExporting ? rep.exporting : rep.financialTruth.exportQueue}</Button>}
                </div>
              } flush>
                {qualityError && <div role="alert" className="border-b border-line bg-bad-soft px-5 py-4 text-sm text-bad">
                  <p>{rep.loadError} {friendlyErrorStrict(qualityError, lang)}</p>
                  <Button size="sm" variant="outline" onClick={onRetryQuality} disabled={qualityLoading || qualityExporting} className="mt-2">{rep.retry}</Button>
                </div>}
                {financialQuality.summary && (
                  <div className="flex flex-wrap gap-2 px-5 pb-3 pt-3.5 text-xs" dir="ltr">
                    {([
                      ["purchase_cost", financialQuality.summary.missing_purchase_cost],
                      ["purchase_date", financialQuality.summary.missing_purchase_date],
                      ["warranty_end", financialQuality.summary.missing_warranty_end],
                      ["manufacturer", financialQuality.summary.missing_manufacturer],
                      ["model", financialQuality.summary.missing_model],
                    ] as const).map(([field, n]) => (
                      <StatusChip key={field} tone={n > 0 ? "warn" : "neu"} dot={false} className="font-mono font-medium">
                        {field}: <span className="tabular-nums">{n}</span>
                      </StatusChip>
                    ))}
                  </div>
                )}
                {qualityLoaded && !qualityError && financialQuality.rows.length === 0 ? (
                  <ReportEmpty title={rep.financialTruth.emptyQueue} />
                ) : financialQuality.rows.length > 0 ? (
                  <div tabIndex={0} className={`overflow-x-auto ${financialQuality.summary ? "border-t border-line" : ""}`}>
                    <table className="ui-table">
                      <caption className="sr-only">{rep.financialTruth.queueTitle}</caption>
                      <thead>
                        <tr><th scope="col">{rep.export.tag}</th><th scope="col">{rep.export.name}</th><th scope="col">{rep.financialTruth.missingFields}</th></tr>
                      </thead>
                      <tbody>
                        {financialQuality.rows.map((row) => (
                          <tr key={row.asset_id}>
                            <td>
                              <Link href={`/assets/${row.asset_id}`} prefetch={false} className="tag whitespace-nowrap text-[13px] font-medium text-brand-ink hover:text-brand-hover">
                                {row.asset_tag ?? "—"}
                              </Link>
                            </td>
                            <td className="text-fg-2">{row.asset_name ?? "—"}</td>
                            <td>
                              <div className="flex flex-wrap gap-1" dir="ltr">
                                {row.missing_fields.map((field) => (
                                  <StatusChip key={field} size="sm" tone="warn" dot={false} className="font-mono">{field}</StatusChip>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
                  <span className="text-xs text-muted tabular-nums" role="status">
                    {qualityLoading ? t.common.loading : qualityLoaded ? rep.financialTruth.loadedRows.replace("{count}", String(financialQuality.rows.length)) : ""}
                  </span>
                  {financialQuality.nextOffset !== null && <Button size="sm" variant="outline" onClick={onLoadMoreQuality}
                    disabled={qualityLoading || qualityExporting || !!qualityError}>{rep.financialTruth.loadMore}</Button>}
                </div>
              </ReportCard>
            </div>
          )}
        </>
      )}

      {/* ---------------- CONSUMABLES ---------------- */}
      {kind !== "asset" && (
        <>
          <ReportKpiBand
            label={L.kpiLabel}
            items={[
              { key: "items", label: rep.consTab.totalItems, value: cons.all.length },
              { key: "low", label: rep.consTab.low, value: lowCount, tone: lowCount > 0 ? "bad" : "ok", hint: lowCount > 0 ? rep.kpi.lowStockReorder : rep.kpi.lowStockGood },
            ]}
          />

          <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            <ReportCard id="rep-cons-dispensed" title={rep.consTab.mostDispensed} description={rep.consTab.recentMovementScope}>
              <BarRows
                rows={cons.mostDispensed.map(([name, q]) => ({ key: name, label: name, n: q }))}
                ariaLabel={rep.consTab.mostDispensed}
                emptyText={rep.consTab.noDispense}
                labelWidth="9rem"
              />
            </ReportCard>
            <ReportCard
              id="rep-cons-stock"
              title={rep.consTab.stockStatus}
              flush
              actions={
                <FilterChip pressed={lowOnly} count={lowCount} onClick={() => onLowOnlyChange(!lowOnly)}>
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warn" />{L.lowOnly}
                </FilterChip>
              }
            >
              {stockRows.length === 0 ? <ReportEmpty icon={PackageOpen} title={rep.maintTab.noData} /> : (
                <div tabIndex={0} className="overflow-x-auto">
                  <table className="ui-table">
                    <caption className="sr-only">{rep.consTab.stockStatus}</caption>
                    <thead>
                      <tr><th scope="col">{rep.consTab.item}</th><th scope="col">{rep.consTab.qty}</th><th scope="col">{rep.consTab.limit}</th><th scope="col">{rep.consTab.status}</th></tr>
                    </thead>
                    <tbody>
                      {stockRows.map((c) => {
                        const low = isLow(c);
                        return (
                          <tr key={c.id}>
                            <td className="font-medium text-fg">{c.name}</td>
                            <td className="whitespace-nowrap">
                              <b className={`font-bold tabular-nums ${low ? "text-bad" : "text-fg"}`}>{c.quantity_on_hand}</b>{" "}
                              <span className="text-xs text-muted">{t.consumables.form.units[c.unit as keyof typeof t.consumables.form.units] ?? c.unit}</span>
                            </td>
                            <td className="tabular-nums text-fg-2">{c.reorder_level}</td>
                            <td><StatusChip tone={low ? "bad" : "ok"}>{low ? rep.consTab.low2 : rep.consTab.good}</StatusChip></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </ReportCard>
          </div>

          {/* التوريد والصرف — أحدث العمليات + تكلفة التوريد حسب المورد (مالية لمن لديه الصلاحية) */}
          <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2 xl:grid-cols-4">
            <ReportCard id="rep-cons-moves" title={rep.consTab.recentMoves}>
              <RankList
                emptyText={rep.consTab.noMoves}
                rows={cons.recent.map((tx) => ({
                  key: tx.id,
                  label: tx.consumable?.name ?? "—",
                  value: (
                    <span className={`text-xs ${tx.txn_type === "out" ? "text-bad" : tx.txn_type === "in" ? "text-ok" : "text-fg-2"}`}>
                      {tx.txn_type === "out" ? rep.consTab.out2 : tx.txn_type === "in" ? rep.consTab.in2 : rep.consTab.adjust} <span className="tabular-nums">{tx.quantity}</span>
                    </span>
                  ),
                }))}
              />
            </ReportCard>
            <ReportCard id="rep-cons-in" title={rep.consTab.recentReplenishment}>
              <RankList
                emptyText={rep.consTab.noReplenishment}
                rows={cons.recentReplenishment.map((tx) => ({
                  key: tx.id,
                  label: <>{tx.consumable?.name ?? "—"} <span className="text-[11px] tabular-nums text-ok" dir="ltr">+{tx.quantity}</span></>,
                  value: <span className="text-xs font-normal text-muted">{fin && tx.total_cost != null ? formatSAR(tx.total_cost, lang) : formatDate(tx.created_at, lang)}</span>,
                }))}
              />
            </ReportCard>
            <ReportCard id="rep-cons-out" title={rep.consTab.recentUsage}>
              <RankList
                emptyText={rep.consTab.noUsage}
                rows={cons.recentUsage.map((tx) => ({
                  key: tx.id,
                  label: <>{tx.consumable?.name ?? "—"} <span className="text-[11px] tabular-nums text-bad" dir="ltr">-{tx.quantity}</span></>,
                  value: <span className="text-xs font-normal text-muted">{formatDate(tx.created_at, lang)}</span>,
                }))}
              />
            </ReportCard>
            <ReportCard id="rep-cons-company" title={rep.consTab.byCompany}>
              <BarRows rows={cons.byCompany.map(([name, n]) => ({ key: name, label: name, n }))} ariaLabel={rep.consTab.byCompany} emptyText={rep.maintTab.noData} />
            </ReportCard>
          </div>
          {fin && (
            <ReportCard id="rep-cons-supplier" title={rep.consTab.costBySupplier} description={rep.consTab.recentMovementScope} actions={<FinTag />}>
              <BarRows
                rows={cons.costBySupplier.map(([name, total]) => ({ key: name, label: name, n: total, display: formatSAR(total, lang) }))}
                ariaLabel={rep.consTab.costBySupplier}
                emptyText={rep.maintTab.noData}
                labelWidth="10rem"
              />
            </ReportCard>
          )}
        </>
      )}
    </div>
  );
}
