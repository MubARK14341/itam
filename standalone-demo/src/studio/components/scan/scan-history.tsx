"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, History, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterChip } from "@/components/ui/filter-chip";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useSession, canUseScan } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { listScanLogs, type ScanLogRow, type ScanMode, type ScanResult } from "@/lib/queries";
import { downloadCSV } from "@/lib/export";
import { dateKeyInTimeZone } from "@/lib/format";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import type { Tone } from "@/lib/tone";

type FilterKey = "all" | "search" | "entry" | "exit" | "failed";
const FAILED: ScanResult[] = ["not_found", "error", "blocked"];

const RESULT_TONE: Record<ScanResult, Tone> = {
  found: "ok",
  not_found: "warn",
  blocked: "bad",
  error: "bad",
};

// سجل المسح + سجل الأخطاء + تصدير CSV. مرئي للأدوار التشغيلية فقط (RLS يحجب غيرهم أصلًا).
export function ScanHistory({ refreshKey }: { refreshKey: number }) {
  const { t, lang } = useAppPreferences();
  const { role } = useSession();
  const { isVisible } = useFeatureExposure();
  const ts = t.scan;
  const [rows, setRows] = useState<ScanLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

  const load = useCallback(async () => {
    setLoading(true);
    const { rows, error } = await listScanLogs({ limit: 300 });
    setRows(rows);
    setError(error);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "failed") return rows.filter((r) => FAILED.includes(r.result));
    return rows.filter((r) => r.scan_mode === (filter as ScanMode));
  }, [rows, filter]);

  // عدّادات الفلاتر من السجلات المحمّلة نفسها (عرض فقط).
  const counts = useMemo<Record<FilterKey, number>>(() => ({
    all: rows.length,
    search: rows.filter((r) => r.scan_mode === "search").length,
    entry: rows.filter((r) => r.scan_mode === "entry").length,
    exit: rows.filter((r) => r.scan_mode === "exit").length,
    failed: rows.filter((r) => FAILED.includes(r.result)).length,
  }), [rows]);

  // أرقام لاتينية + تقويم ميلادي في المسار العربي (اتفاقية المشروع) بدل ar-SA (هجري/أرقام هندية).
  const fmtTime = (iso: string) => new Date(iso).toLocaleString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB");
  const itemText = (r: ScanLogRow) =>
    r.asset ? (r.asset.asset_tag ?? r.asset.name ?? "—") : r.consumable ? r.consumable.name : "—";
  const reasonText = (r: ScanLogRow) =>
    r.error_code
      ? ((ts.errorCodes as Record<string, string>)[r.error_code] ?? r.error_code)
      : r.notes
        ? ((ts.noteLabels as Record<string, string>)[r.notes] ?? r.notes)
        : "—";

  function exportCsv() {
    const headers = [ts.colTime, ts.colMode, ts.colResult, ts.colValue, ts.colItem, ts.colUser, ts.colReason];
    const data = filtered.map((r) => [
      fmtTime(r.created_at),
      ts.modes[r.scan_mode],
      ts.results[r.result],
      r.scanned_value,
      itemText(r),
      r.actor ?? "",
      r.error_code
        ? ((ts.errorCodes as Record<string, string>)[r.error_code] ?? r.error_code)
        : r.notes ? ((ts.noteLabels as Record<string, string>)[r.notes] ?? r.notes) : "",
    ]);
    const stamp = dateKeyInTimeZone();
    downloadCSV(`scan-logs-${stamp}.csv`, headers, data);
  }

  const FILTERS: { key: FilterKey; label: string }[] = [
    { key: "all", label: ts.filterAll },
    { key: "search", label: ts.filterSearch },
    { key: "entry", label: ts.filterEntry },
    { key: "exit", label: ts.filterExit },
    { key: "failed", label: ts.filterFailed },
  ];

  return (
    <Card className="overflow-hidden">
      <section aria-labelledby="scan-history-title">
        <div className="flex flex-wrap items-center gap-4 p-5 sm:p-6">
          <h2 id="scan-history-title" className="flex items-center gap-2 font-display text-[17px] font-semibold text-fg">
            <History aria-hidden="true" className="h-4 w-4 text-muted" /> {filter === "failed" ? ts.errorLogTitle : ts.historyTitle}
          </h2>
          <span className="text-[12.5px] tabular-nums text-muted">{filtered.length}</span>
          <div className="flex-1" />
          <div role="group" aria-label={ts.historyFilterLabel} className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <FilterChip key={f.key} pressed={filter === f.key} count={counts[f.key]} onClick={() => setFilter(f.key)}>
                {f.label}
              </FilterChip>
            ))}
          </div>
          <span aria-hidden="true" className="hidden h-[22px] w-px bg-line-strong sm:block" />
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="ghost" onClick={load} aria-label={ts.refreshHistory} title={ts.refreshHistory}>
              <RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            {/* إظهار تدريجي: CSV سجل المسح من مستوى 70 — فوق شرط دور المسح التشغيلي */}
            {canUseScan(role) && isVisible("scan.csv") && (
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length} title={!filtered.length ? ts.exportEmptyHint : ts.exportBtn}>
                <Download aria-hidden="true" className="h-4 w-4" /> {ts.exportBtn}
              </Button>
            )}
          </div>
        </div>

        {error && <div role="alert" className="mx-5 mb-3 rounded-control bg-bad-soft px-4 py-3 text-[13px] text-bad">{friendlyErrorStrict(error, lang)}</div>}

        <div className="border-t border-line">
          {loading ? (
            <div className="flex justify-center py-10"><Spinner label={t.common.loading} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={History} title={ts.noLogs} compact />
          ) : (
            <div tabIndex={0} className="overflow-x-auto">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th scope="col">{ts.colTime}</th>
                    <th scope="col">{ts.colMode}</th>
                    <th scope="col">{ts.colResult}</th>
                    <th scope="col">{ts.colValue}</th>
                    <th scope="col">{ts.colItem}</th>
                    <th scope="col">{ts.colUser}</th>
                    <th scope="col">{ts.colReason}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const href = r.asset_id ? `/assets/${r.asset_id}` : r.consumable_id ? `/consumables/${r.consumable_id}` : null;
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap text-xs tabular-nums text-fg-2" dir="ltr">{fmtTime(r.created_at)}</td>
                        <td className="whitespace-nowrap text-fg">{ts.modes[r.scan_mode]}</td>
                        <td><StatusChip tone={RESULT_TONE[r.result]}>{ts.results[r.result]}</StatusChip></td>
                        <td className="max-w-[11rem] truncate font-mono text-xs font-medium text-fg" dir="ltr" title={r.scanned_value}>{r.scanned_value}</td>
                        <td className="text-fg-2">
                          {href ? <Link href={href} className="font-medium text-brand-ink hover:underline">{itemText(r)}</Link> : itemText(r)}
                        </td>
                        <td className="text-xs text-fg-2">{r.actor ?? "—"}</td>
                        <td className="text-xs text-muted">{reasonText(r)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </Card>
  );
}
