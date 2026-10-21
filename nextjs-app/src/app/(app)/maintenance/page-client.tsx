"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { UserRound, Wrench } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import { KpiBand, type KpiItem } from "@/components/ui/kpi-band";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterChip } from "@/components/ui/filter-chip";
import { StatusChip } from "@/components/ui/status-chip";
import { SearchInput, Select } from "@/components/ui/form";
import { Toast, type ToastState } from "@/components/ui/toast";
import { MaintenanceModal } from "@/components/maintenance-modal";
import {
  getMaintenanceOperationalSummary,
  listMaintenancePage,
  type MaintenanceOperationalSummary,
} from "@/lib/queries";
import type { DescTimeCursor } from "@/lib/pagination";
import { dateKeyInTimeZone, formatSAR, formatDate } from "@/lib/format";
import { useSession, canSeeFinancial, canSeeMaintenanceCost, useCan } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureRoute } from "@/components/feature-gate";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { MTYPE_OPTS, PROBLEM_TYPE_OPTS, STAGE_OPTS, maintenanceDisplayLabel } from "@/lib/maintenance";
import { MAINT_STATUS_TONE, PRIORITY_TONE, STAGE_TONE } from "@/lib/tone";
import { MAINTENANCE_VIEWS, type MaintenanceViewKey } from "@/lib/alert-predicates";
import { WorkQueueBanner } from "@/components/work-queue-banner";
import { buildMaintenancePath, maintenanceStateFromSearch } from "@/lib/maintenance-navigation";
import {
  beginOperationalListRequest,
  completeOperationalListRequest,
  createOperationalListRequestGate,
  cancelOperationalListRequest,
  operationalListRequestSignal,
} from "@/lib/operational-list-request-gate";

const MAINT_STATUS_KEYS = ["open", "in_progress", "completed", "cancelled"] as const;
const MAINT_VIEW_KEYS: MaintenanceViewKey[] = ["no_action", "long_maint", "followup", "past_due"];

// مرحلة العرض لسجل: workflow_stage إن وُجد، وإلا تُشتق من الحالة (نفس اشتقاق نافذة الصيانة) — عرض فقط.
const rowStage = (r: any): string =>
  r.workflow_stage ?? (r.status === "completed" ? "completed" : r.status === "in_progress" ? "investigating" : "open");
const isOpenRow = (r: any) => r.status !== "completed" && r.status !== "cancelled";

export default function MaintenancePage({ initialNowMs }: { initialNowMs: number }) {
  const { role, userId: currentUserId } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const can = useCan();
  const write = can("maintenance.manage");
  const fin = canSeeFinancial(role);
  const costVis = canSeeMaintenanceCost(role);
  const colCount = costVis ? 7 : 6;
  // إظهار تدريجي: بطاقات الإحصاء من 60، نموذج التحديث في المودال من 60.
  // بطاقة/عمود التكلفة يبقيان بالدور حصرًا (fin/costVis) — لا يلمسهما الإظهار التدريجي.
  const expStats = isVisible("maintenance.stats");
  const expUpdate = isVisible("maintenance.update");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<DescTimeCursor | null>(null);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<MaintenanceOperationalSummary | null>(null);
  const [q, setQ] = useState(""); const [st, setSt] = useState(""); const [tp, setTp] = useState(""); const [pt, setPt] = useState("");
  const [active, setActive] = useState<any | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  // قائمة عمل (?view=) — نفس شرط كرت اللوحة حرفيًا (alert-predicates.ts).
  const [view, setView] = useState<MaintenanceViewKey | null>(null);
  const [initialized, setInitialized] = useState(false);
  const initialFocusId = useRef<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  // فلاتر عرض محلية (بلا استعلام): مرحلة العمل + غير مسندة + أولوية حرجة — على السجلات المحمّلة فقط.
  const [stage, setStage] = useState("");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const listRequestGate = useRef(createOperationalListRequestGate());
  const [nowMs, setNowMs] = useState(initialNowMs);
  const todayISO = useMemo(() => dateKeyInTimeZone(new Date(nowMs)), [nowMs]);
  const navigationState = useMemo(() => ({
    q, status: st, type: tp, problemType: pt, view: view ?? "", mineOnly, focusId: active?.id ?? "",
  }), [q, st, tp, pt, view, mineOnly, active?.id]);

  async function reload(focusId?: string, reset = true) {
    if (mineOnly && !currentUserId) return;
    const generation = beginOperationalListRequest(listRequestGate.current, reset, cursor !== null);
    if (generation === null) return;
    const signal = operationalListRequestSignal(listRequestGate.current, generation);
    if (reset) setLoading(true); else setLoadingMore(true);
    const page = await listMaintenancePage({
      cursor: reset ? null : cursor,
      includeFinancial: fin,
      signal,
      filters: {
        q, status: st, type: tp, problemType: pt, view, todayISO,
        longBeforeISO: new Date(nowMs - 14 * 86_400_000).toISOString(),
        technicianId: mineOnly ? currentUserId ?? undefined : undefined,
      },
    });
    if (!completeOperationalListRequest(listRequestGate.current, generation)) return;
    setRows((previous) => reset ? page.rows : [...previous, ...page.rows]);
    setCursor(page.nextCursor);
    if (page.total != null) setTotal(page.total);
    setLoading(false); setLoadingMore(false);
    if (page.error) setToast({ type: "error", message: t.maintenance.loadError + page.error });
    if (focusId) {
      const r = page.rows.find((x: any) => x.id === focusId);
      if (r) setActive(r);
      else setToast({ type: "error", message: t.maintenance.notFound });
    }
  }

  useEffect(() => {
    // ?m=<id> يفتح نافذة الصيانة مباشرة (روابط من «آخر العمليات»)
    const parsed = maintenanceStateFromSearch(window.location.search);
    setQ(parsed.q); setSt(parsed.status); setTp(parsed.type); setPt(parsed.problemType);
    setMineOnly(parsed.mineOnly);
    if ((MAINT_VIEW_KEYS as string[]).includes(parsed.view)) setView(parsed.view as MaintenanceViewKey);
    initialFocusId.current = parsed.focusId || null;
    setInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialized) return;
    const timer = window.setTimeout(() => {
      window.history.replaceState({}, "", buildMaintenancePath(navigationState));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [initialized, navigationState]);

  // The signed-in user id only matters for the "assigned to me" filter; arriving later must not
  // re-run an unrelated search (it produced a duplicate request when typing right after load).
  const mineUserKey = mineOnly ? currentUserId : null;
  const lastLoadQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized) return;
    // 250ms delay only while typing in search; the first load and filter changes are immediate.
    const typing = lastLoadQuery.current !== null && lastLoadQuery.current !== q;
    lastLoadQuery.current = q;
    const timer = window.setTimeout(() => {
      const focusId = initialFocusId.current ?? undefined;
      initialFocusId.current = null;
      void reload(focusId, true);
    }, typing ? 250 : 0);
    const gate = listRequestGate.current;
    return () => { window.clearTimeout(timer); cancelOperationalListRequest(gate); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, q, st, tp, pt, view, mineOnly, mineUserKey, fin, nowMs]);

  useEffect(() => {
    getMaintenanceOperationalSummary().then(({ summary, error }) => {
      if (error) setToast({ type: "error", message: t.maintenance.loadError + error });
      setStats(summary);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearView = () => {
    setView(null);
  };

  const filtered = useMemo(() => rows.filter((r) => {
    // قائمة العمل أولًا: نفس شرط كرت اللوحة حرفيًا — الرقم يطابق القائمة.
    if (view && !MAINTENANCE_VIEWS[view](r, nowMs, todayISO)) return false;
    if (st && r.status !== st) return false;
    if (tp && r.type !== tp) return false;
    if (pt && r.problem_type !== pt) return false;
    const normalizedQuery = q.trim().toLowerCase();
    if (
      normalizedQuery
      && !`${r.asset?.asset_tag ?? ""} ${r.asset?.name ?? ""} ${r.asset?.serial_number ?? ""} ${r.problem_description ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery)
    ) return false;
    return true;
  }), [rows, q, st, tp, pt, view, nowMs, todayISO]);


  const viewCount = view ? total : 0;

  // عدّادات تبويبات المرحلة والرقائق السريعة من السجلات المحمّلة (عرض فقط، بلا استعلام إضافي).
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of filtered) counts[rowStage(r)] = (counts[rowStage(r)] ?? 0) + 1;
    return counts;
  }, [filtered]);
  const stageScoped = useMemo(() => (stage ? filtered.filter((r) => rowStage(r) === stage) : filtered), [filtered, stage]);
  const unassignedCount = useMemo(() => stageScoped.filter((r) => isOpenRow(r) && !r.technician_id).length, [stageScoped]);
  const criticalCount = useMemo(() => stageScoped.filter((r) => r.priority === "critical").length, [stageScoped]);
  const visibleRows = useMemo(() => stageScoped.filter((r) => {
    if (unassignedOnly && !(isOpenRow(r) && !r.technician_id)) return false;
    if (criticalOnly && r.priority !== "critical") return false;
    return true;
  }), [stageScoped, unassignedOnly, criticalOnly]);
  const hasLocalFilters = Boolean(q || st || tp || pt || stage || unassignedOnly || criticalOnly || mineOnly);
  const clearLocalFilters = () => {
    setQ(""); setSt(""); setTp(""); setPt(""); setStage("");
    setUnassignedOnly(false); setCriticalOnly(false); setMineOnly(false);
  };

  const stageLabel = (v: string) => maintenanceDisplayLabel(v, lang, t.stage[v as keyof typeof t.stage] ?? v);
  const priorityLabel = (v: string) => maintenanceDisplayLabel(v, lang, t.priority[v as keyof typeof t.priority] ?? v);
  const kindLabel = (r: any) => r.problem_type
    ? maintenanceDisplayLabel(r.problem_type, lang, t.problemType[r.problem_type as keyof typeof t.problemType] ?? r.problem_type)
    : maintenanceDisplayLabel(r.type, lang, t.mtype[r.type as keyof typeof t.mtype] ?? r.type);
  const statusChip = (r: any) => (
    <StatusChip tone={MAINT_STATUS_TONE[r.status]} size="sm">{t.maintStatus[r.status as keyof typeof t.maintStatus] ?? r.status}</StatusChip>
  );

  const kpis: KpiItem[] = [];
  if (expStats) {
    kpis.push({ key: "open", label: t.maintenance.stats.open, value: stats?.open ?? 0, tone: "warn" });
    kpis.push({ key: "in_progress", label: t.maintenance.stats.inProgress, value: stats?.inProgress ?? 0, tone: "info" });
    kpis.push({ key: "completed", label: t.maintenance.stats.completed, value: stats?.completed ?? 0, tone: "ok" });
  }
  if (fin && stats) {
    kpis.push({
      key: "cost",
      label: t.maintenance.stats.totalCost,
      value: stats.cost.value != null ? formatSAR(stats.cost.value, lang) : t.reports.financialTruth.incomplete,
      hint: `${t.reports.financialTruth.coverage}: ${stats.cost.coveragePct}% · ${t.reports.financialTruth.used}: ${stats.cost.usedRecords} · ${t.reports.financialTruth.excluded}: ${stats.cost.excludedRecords} · ${t.reports.financialTruth.asOf}: ${formatDate(stats.cost.asOf, lang)}`,
    });
  }

  const emptyState = (
    <EmptyState
      icon={Wrench}
      title={hasLocalFilters ? t.maintenance.emptyFiltered : t.maintenance.empty}
      description={hasLocalFilters ? t.maintenance.emptyFilteredHint : undefined}
      action={hasLocalFilters ? <Button size="sm" variant="outline" onClick={clearLocalFilters}>{t.maintenance.clearFilters}</Button> : undefined}
    />
  );

  return (
    <FeatureRoute feature="maintenance.list">
    <div className="space-y-5">
      <PageHeader className="!mb-1" title={t.maintenance.title} description={loading ? t.maintenance.loading : `${visibleRows.length} ${t.common.of} ${total}`} />

      {/* شعار قائمة العمل — من كروت التنبيهات (?view=). العدد يطابق الكرت (نفس الشرط).
          الضغط على أي صف يفتح نافذة التحديث نفسها — الإجراء مباشر. */}
      {view && (
        <WorkQueueBanner
          title={t.workQueue.views[view].title}
          desc={t.workQueue.views[view].desc}
          action={t.workQueue.views[view].action}
          count={viewCount}
          clearLabel={t.workQueue.showAll}
          onClear={clearView}
        />
      )}

      {/* إظهار تدريجي: بطاقات الإحصاء التشغيلية من 60. بطاقة التكلفة مالية:
          تبقى بالدور (fin) فقط كما هي — لا تُربط بمستوى العرض. */}
      {(expStats || fin) && kpis.length > 0 && <KpiBand items={kpis} label={t.maintenance.title} />}

      {/* تبويبات مرحلة العمل — تصفية محلية مع عدّادات من السجلات المحمّلة */}
      <div role="group" aria-label={t.maintenance.stageFilterLabel} className="ui-tabs">
        {[["", t.maintenance.allStages] as [string, string], ...STAGE_OPTS.map(([v]) => [v, stageLabel(v)] as [string, string])].map(([key, label]) => (
          <button
            key={key || "all"}
            type="button"
            aria-pressed={stage === key}
            onClick={() => setStage(key)}
            className="ui-tab aria-[pressed=true]:border-fg aria-[pressed=true]:font-semibold aria-[pressed=true]:text-fg"
          >
            {label}
            <span className="ui-count">{key ? stageCounts[key] ?? 0 : filtered.length}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
        <div role="group" aria-label={t.maintenance.quickFilters} className="flex flex-wrap items-center gap-2">
          <FilterChip pressed={unassignedOnly} count={unassignedCount} onClick={() => setUnassignedOnly((value) => !value)}>
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warn" />{t.maintenance.unassigned}
          </FilterChip>
          <FilterChip pressed={criticalOnly} count={criticalCount} onClick={() => setCriticalOnly((value) => !value)}>
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-bad" />{t.maintenance.criticalOnly}
          </FilterChip>
          <FilterChip pressed={mineOnly} disabled={!currentUserId} onClick={() => setMineOnly((value) => !value)} className="disabled:opacity-50">
            <UserRound aria-hidden="true" className="h-3.5 w-3.5" />{t.maintenance.showMyAssignedQueue}
          </FilterChip>
          {hasLocalFilters && (
            <Button size="sm" variant="ghost" onClick={clearLocalFilters} className="text-brand-ink">{t.maintenance.clearFilters}</Button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <SearchInput label={t.maintenance.searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")} clearLabel={t.common.clearSearch}
            placeholder={t.maintenance.searchPlaceholder} />
          <Select value={st} onChange={setSt} placeholder={t.maintenance.allStatuses} options={MAINT_STATUS_KEYS.map((v) => ({ value: v, label: t.maintStatus[v] }))} />
          <Select value={pt} onChange={setPt} placeholder={t.maintenance.allProblems} options={PROBLEM_TYPE_OPTS.map(([v]) => ({ value: v, label: t.problemType[v as keyof typeof t.problemType] ?? v }))} />
          <Select value={tp} onChange={setTp} placeholder={t.maintenance.allTypes} options={MTYPE_OPTS.map(([v]) => ({ value: v, label: t.mtype[v as keyof typeof t.mtype] ?? v }))} />
        </div>
      </div>

      <Card className="overflow-hidden md:hidden">
        {loading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="animate-pulse rounded-xl border border-line p-4">
                <div className="h-4 w-28 rounded bg-sunk" />
                <div className="mt-3 h-3 w-full rounded bg-sunk" />
              </div>
            ))}
          </div>
        ) : visibleRows.length === 0 ? emptyState : (
          <ul>
            {visibleRows.map((r) => (
              <li key={r.id} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => setActive(r)}
                  className="block w-full p-4 text-start transition-colors hover:bg-surface-2 active:bg-sunk"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="tag text-xs font-semibold text-brand-ink">{r.asset?.asset_tag ?? "—"}</span>
                      <p className="mt-1 line-clamp-2 text-sm font-semibold text-fg">{r.problem_description ?? "—"}</p>
                    </div>
                    <StatusChip tone={STAGE_TONE[rowStage(r)]} size="sm" className="shrink-0">{stageLabel(rowStage(r))}</StatusChip>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                    {r.priority && <StatusChip tone={PRIORITY_TONE[r.priority]} size="sm">{priorityLabel(r.priority)}</StatusChip>}
                    {statusChip(r)}
                    <span className="min-w-0 flex-1 truncate">{kindLabel(r)}</span>
                    <span className="shrink-0 tabular-nums">{formatDate(r.reported_at, lang)} · <span className="font-semibold text-brand-ink">{t.common.view}</span></span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="hidden overflow-hidden md:block">
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th scope="col">{t.maintenance.headers.asset}</th>
                <th scope="col">{t.maintenance.headers.problem}</th>
                <th scope="col">{t.maintenance.headers.priority}</th>
                <th scope="col">{t.maintenance.stageHeader}</th>
                <th scope="col">{t.maintenance.headers.status}</th>
                {costVis && <th scope="col">{t.maintenance.headers.cost}</th>}
                <th scope="col">{t.maintenance.headers.date}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={colCount} className="py-12 text-center text-muted">{t.maintenance.loading}</td></tr>
              : visibleRows.length === 0 ? <tr><td colSpan={colCount} className="p-0">{emptyState}</td></tr>
              : visibleRows.map((r) => (
                <tr key={r.id} onClick={() => setActive(r)} className="cursor-pointer">
                  <td className="py-2.5">
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); setActive(r); }}
                      aria-label={`${t.common.view}: ${r.asset?.asset_tag ?? t.common.dash}`}
                      className="flex min-h-10 max-w-[20rem] items-center gap-3 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <EquipmentPhoto asset={r.asset} />
                      <span className="min-w-0">
                      <span className="tag block text-xs font-semibold text-brand-ink hover:underline">{r.asset?.asset_tag ?? "—"}</span>
                      {r.asset?.name && <span className="block truncate text-[13px] font-semibold text-fg">{r.asset.name}</span>}
                      </span>
                    </button>
                  </td>
                  <td className="max-w-[22rem] py-2.5">
                    <span className="block truncate font-medium text-fg">{r.problem_description ?? "—"}</span>
                    <span className="block truncate text-xs text-muted">{kindLabel(r)}</span>
                  </td>
                  <td>{r.priority ? <StatusChip tone={PRIORITY_TONE[r.priority]} size="sm">{priorityLabel(r.priority)}</StatusChip> : <span className="text-muted">—</span>}</td>
                  <td><StatusChip tone={STAGE_TONE[rowStage(r)]} size="sm">{stageLabel(rowStage(r))}</StatusChip></td>
                  <td>{statusChip(r)}</td>
                  {costVis && <td className="whitespace-nowrap tabular-nums text-fg-2">{formatSAR(r.cost, lang)}</td>}
                  <td className="whitespace-nowrap tabular-nums text-muted">{formatDate(r.reported_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-4 py-2.5 text-[13px] text-muted">
          <span className="tabular-nums">{visibleRows.length} {t.common.of} {total}</span>
        </div>
      </Card>

      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loading || loadingMore} onClick={() => void reload(undefined, false)}>
            {loadingMore ? t.maintenance.loading : t.reports.showMore}
          </Button>
        </div>
      )}

      {/* إظهار تدريجي: نموذج التحديث من 60 — تحت المستوى تُفتح النافذة للعرض فقط */}
      <MaintenanceModal
        record={active}
        canWrite={write && expUpdate}
        canSeeFinancial={fin}
        canSeeMaintenanceCost={costVis}
        onClose={() => setActive(null)}
        onDone={(m) => { setToast(m); if (m?.type === "success") { setActive(null); setNowMs(Date.now()); } }}
      />
      <Toast toast={toast} onDone={() => setToast(null)} />
    </div>
    </FeatureRoute>
  );
}
