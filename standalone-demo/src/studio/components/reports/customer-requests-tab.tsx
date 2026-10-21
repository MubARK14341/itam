"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, ClipboardList, CheckCircle2, AlertTriangle, HelpCircle, Clock, PackageOpen, ShoppingCart, Paperclip } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { StatCard } from "@/components/stat-card";
import {
  getCustomerRequestAnalytics, getCustomerRequestTimeseries, getCustomerRequestOperationalReport,
  type CrqFilters, type CrqAnalytics, type CrqTimeseriesPoint, type CrqOperationalRow, type CrqBreakdownItem,
} from "@/lib/request-analytics";
import { resolveUserLabels, type RequestListRow } from "@/lib/requests";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDateTime } from "@/lib/format";
import { downloadCSV } from "@/lib/export";

const STATUS_KEYS = [
  "draft", "under_review", "needs_clarification", "approved", "rejected", "preparing",
  "ready_for_pickup", "delivered", "partially_returned", "returned", "completed", "cancelled",
];

// تبويب «طلبات العملاء» — كل الأرقام من RPCs محكومة بالقدرة report.customer_requests.
// لا حسابات أمان في الواجهة؛ العرض يعكس ما يُرجعه الخادم فقط. بلا ماليات/مخزون/أصول.
export function CustomerRequestsTab({ csvAllowed, reqRows }: { csvAllowed: boolean; reqRows: RequestListRow[] }) {
  const { t, lang } = useAppPreferences();
  const rc = t.reports.customerRequests;

  const [filters, setFilters] = useState<CrqFilters>({ granularity: "day" });
  const setF = (k: keyof CrqFilters) => (v: string) => setFilters((s) => ({ ...s, [k]: v || undefined }));

  const [analytics, setAnalytics] = useState<CrqAnalytics | null>(null);
  const [series, setSeries] = useState<CrqTimeseriesPoint[]>([]);
  const [rows, setRows] = useState<CrqOperationalRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [respLabels, setRespLabels] = useState<Record<string, string>>({});

  // خيارات الفلاتر مشتقّة من طلبات القائمة (بلا جلب إضافي).
  const customers = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of reqRows) if (r.customer?.id) m.set(r.customer.id, r.customer.name);
    return Array.from(m, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [reqRows]);
  const cities = useMemo(() => {
    const s = new Set<string>();
    for (const r of reqRows) if (r.project_city) s.add(r.project_city);
    return Array.from(s).sort().map((c) => ({ value: c, label: c }));
  }, [reqRows]);
  const responsibles = useMemo(() => {
    const ids = new Set<string>();
    for (const r of reqRows) if (r.responsible_employee_id) ids.add(r.responsible_employee_id);
    return Array.from(ids).filter((id) => respLabels[id]).map((id) => ({ value: id, label: respLabels[id] }));
  }, [reqRows, respLabels]);

  useEffect(() => {
    const ids = reqRows.map((r) => r.responsible_employee_id).filter((x): x is string => !!x);
    if (ids.length) resolveUserLabels(ids).then(setRespLabels);
  }, [reqRows]);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    (async () => {
      const [a, ts, op] = await Promise.all([
        getCustomerRequestAnalytics(filters),
        getCustomerRequestTimeseries(filters),
        getCustomerRequestOperationalReport(filters),
      ]);
      if (!active) return;
      setAnalytics(a.data); setSeries(ts.points); setRows(op.rows);
      setError(a.error ?? ts.error ?? op.error);
      setLoaded(true);
    })();
    return () => { active = false; };
  }, [filters]);

  const s = analytics?.summary;
  const b = analytics?.breakdowns;
  const tm = analytics?.timing;
  const hasFilters = Object.entries(filters).some(([k, v]) => k !== "granularity" && v);

  function exportCsv() {
    const headers = [
      rc.table.number, rc.table.customer, rc.table.project, rc.table.city, rc.table.status,
      rc.table.pmStatus, rc.table.responsible, rc.table.created, rc.table.approved, rc.table.completed,
      rc.table.items, rc.table.needsPurchase, rc.table.attachments, rc.table.lastEvent,
    ];
    downloadCSV("customer_requests_report.csv", headers, rows.map((r) => [
      r.request_number, r.customer_name, r.project_name ?? "", r.project_city ?? "",
      t.requestStatus[r.status as keyof typeof t.requestStatus] ?? r.status,
      (rc.pmStatusLabel as Record<string, string>)[r.portal_approval_status] ?? r.portal_approval_status,
      r.responsible_name ?? "", r.created_at?.slice(0, 10) ?? "", r.approved_at?.slice(0, 10) ?? "",
      r.completed_at?.slice(0, 10) ?? "", r.items_count, r.needs_purchase_count, r.attachments_count,
      r.last_event_at?.slice(0, 10) ?? "",
    ]));
  }

  return (
    <div className="space-y-5">
      {/* الفلاتر */}
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4">
          <input type="date" value={filters.date_from ?? ""} onChange={(e) => setF("date_from")(e.target.value)} dir="ltr" aria-label={rc.filters.from}
            className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-accent dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
          <input type="date" value={filters.date_to ?? ""} onChange={(e) => setF("date_to")(e.target.value)} dir="ltr" aria-label={rc.filters.to}
            className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-accent dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
          <Select value={filters.customer_id ?? ""} onChange={setF("customer_id")} placeholder={rc.filters.allCustomers} options={customers} />
          <Select value={filters.city ?? ""} onChange={setF("city")} placeholder={rc.filters.allCities} options={cities} />
          <Select value={filters.status ?? ""} onChange={setF("status")} placeholder={rc.filters.allStatuses} options={STATUS_KEYS.map((k) => ({ value: k, label: t.requestStatus[k as keyof typeof t.requestStatus] }))} />
          <Select value={filters.responsible_employee_id ?? ""} onChange={setF("responsible_employee_id")} placeholder={rc.filters.allResponsibles} options={responsibles} />
          <Select value={filters.granularity ?? "day"} onChange={setF("granularity")} options={[{ value: "day", label: rc.gran.day }, { value: "week", label: rc.gran.week }, { value: "month", label: rc.gran.month }]} />
        </div>
        {hasFilters && (
          <div className="mt-2 text-end">
            <button onClick={() => setFilters({ granularity: filters.granularity })} className="text-xs font-medium text-accent hover:underline">{rc.filters.clear}</button>
          </div>
        )}
      </Card>

      {!loaded ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div>
      ) : error ? (
        <Card className="p-8 text-center text-sm text-rose-600 dark:text-rose-300">{error === "not_authorized" ? rc.noAccess : rc.loadError}</Card>
      ) : !s ? (
        <Card className="p-8 text-center text-sm text-slate-400">{rc.noData}</Card>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatCard label={rc.kpi.total} value={s.total_requests} icon={ClipboardList} tone="teal" />
            <StatCard label={rc.kpi.pendingReview} value={s.pending_internal_review} icon={ClipboardList} tone="amber" />
            <StatCard label={rc.kpi.pendingPm} value={s.pending_project_manager} icon={Clock} tone="amber" />
            <StatCard label={rc.kpi.needsClarification} value={s.needs_clarification} icon={HelpCircle} tone="amber" />
            <StatCard label={rc.kpi.inProgress} value={s.in_progress} icon={PackageOpen} tone="blue" />
            <StatCard label={rc.kpi.completed} value={s.completed_requests} icon={CheckCircle2} tone="emerald" />
            <StatCard label={rc.kpi.needsPurchase} value={s.needs_purchase_items} icon={ShoppingCart} tone="amber" />
            <StatCard label={rc.kpi.attachments} value={s.attachments_count} icon={Paperclip} tone="slate" />
          </div>

          {/* التوقيتات */}
          {tm && (
            <Card className="p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">{rc.timing.title}</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                <TimingCell label={rc.timing.internalReview} value={tm.avg_time_to_internal_review} unit={rc.timing.hours} na={rc.timing.na} />
                <TimingCell label={rc.timing.pmApproval} value={tm.avg_time_to_pm_approval} unit={rc.timing.hours} na={rc.timing.na} />
                <TimingCell label={rc.timing.approval} value={tm.avg_time_to_approval} unit={rc.timing.hours} na={rc.timing.na} />
                <TimingCell label={rc.timing.completion} value={tm.avg_time_to_completion} unit={rc.timing.hours} na={rc.timing.na} />
                <TimingCell label={rc.timing.oldestOpen} value={tm.oldest_open_request_days} unit={rc.timing.days} na={rc.timing.na} />
              </div>
            </Card>
          )}

          {/* التوزيعات */}
          {b && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Breakdown title={rc.breakdown.byStatus} items={b.by_status} labeler={(k) => t.requestStatus[k as keyof typeof t.requestStatus] ?? k} />
              <Breakdown title={rc.breakdown.byCustomer} items={b.by_customer} />
              <Breakdown title={rc.breakdown.byCity} items={b.by_city} tone="bg-emerald-400" />
              <Breakdown title={rc.breakdown.byResponsible} items={b.by_responsible_employee} tone="bg-blue-400" />
              <Breakdown title={rc.breakdown.byPmStatus} items={b.by_portal_approval_status} labeler={(k) => (rc.pmStatusLabel as Record<string, string>)[k] ?? k} tone="bg-amber-400" />
            </div>
          )}

          {/* السلسلة الزمنية */}
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">{rc.series.title}</h2>
            {series.length === 0 ? <Empty text={rc.noData} /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <tr><Th>{rc.series.bucket}</Th><Th>{rc.series.created}</Th><Th>{rc.series.submitted}</Th><Th>{rc.series.completed}</Th><Th>{rc.series.rejected}</Th><Th>{rc.series.pendingPm}</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {series.map((p) => (
                      <tr key={p.bucket}>
                        <td className="px-3 py-2 font-medium text-slate-700 dark:text-slate-300" dir="ltr">{p.bucket}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{p.created_count}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{p.submitted_count}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{p.completed_count}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{p.rejected_count}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{p.pending_pm_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* الجدول التشغيلي */}
          <Card className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><ClipboardList className="h-4 w-4 text-accent" />{rc.table.title}</h2>
              {csvAllowed && rows.length > 0 && <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-4 w-4" />{rc.table.export}</Button>}
            </div>
            {rows.length === 0 ? <Empty text={rc.table.none} /> : (
              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-start text-sm">
                  <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <tr>
                      <Th>{rc.table.number}</Th><Th>{rc.table.customer}</Th><Th>{rc.table.project}</Th><Th>{rc.table.city}</Th>
                      <Th>{rc.table.status}</Th><Th>{rc.table.responsible}</Th><Th>{rc.table.created}</Th>
                      <Th>{rc.table.items}</Th><Th>{rc.table.needsPurchase}</Th><Th>{rc.table.attachments}</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rows.map((r, i) => (
                      <tr key={`${r.request_number}-${i}`}>
                        <td className="px-3 py-2 font-semibold text-accent" dir="ltr">{r.request_number}</td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.customer_name}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.project_name ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.project_city ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{t.requestStatus[r.status as keyof typeof t.requestStatus] ?? r.status}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.responsible_name ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-500 dark:text-slate-400" dir={lang === "ar" ? "rtl" : "ltr"}>{formatDateTime(r.created_at, lang)}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.items_count}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.needs_purchase_count}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.attachments_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function TimingCell({ label, value, unit, na }: { label: string; value: number | null; unit: string; na: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/40">
      <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{value == null ? na : `${value} ${unit}`}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}

function Breakdown({ title, items, labeler, tone = "bg-accent" }: { title: string; items: CrqBreakdownItem[]; labeler?: (k: string) => string; tone?: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <Card className="p-5">
      <h2 className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h2>
      {items.length === 0 ? <Empty text="—" /> : (
        <div className="space-y-2.5">
          {items.map((it) => (
            <div key={it.key} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-xs text-slate-600 dark:text-slate-400" title={labeler ? labeler(it.key) : it.key}>{labeler ? labeler(it.key) : it.key}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.round((it.count / max) * 100)}%` }} /></div>
              <span className="w-8 text-start text-sm font-semibold text-slate-700 dark:text-slate-200">{it.count}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Th({ children }: { children?: React.ReactNode }) { return <th className="px-3 py-2 text-start font-medium">{children}</th>; }
function Empty({ text }: { text: string }) { return <p className="py-6 text-center text-sm text-slate-400 dark:text-slate-500">{text}</p>; }
function Skeleton() { return <div className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />; }
