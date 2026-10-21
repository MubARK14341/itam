"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Download, Users, ClipboardList, SearchX, List, Columns3, Warehouse } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { SearchInput, Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterChip } from "@/components/ui/filter-chip";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { RequestStatusBadge } from "@/components/requests/request-status-badge";
import { CustomersManager } from "@/components/requests/customers-manager";
import { RequestStageStrip, type StageCell } from "@/components/requests/request-stage-strip";
import { RequestsBoard } from "@/components/requests/requests-board";
import { WarehouseTaskView } from "@/components/requests/warehouse-task-view";
import { PartyTag, RequestNumber, ResponsibleCell } from "@/components/requests/request-list-bits";
import {
  getRequestOperationalCounts,
  getRequestFilterOptions,
  listRequestsPage,
  isOverdue,
  resolveUserLabels,
  type RequestListRow,
  type RequestOperationalCounts,
  type RequestFilterOptions,
} from "@/lib/requests";
import { collectCursorPages, type DescTimeCursor } from "@/lib/pagination";
import {
  beginOperationalListRequest,
  completeOperationalListRequest,
  createOperationalListRequestGate,
  cancelOperationalListRequest,
  operationalListRequestSignal,
} from "@/lib/operational-list-request-gate";
import { WAREHOUSE_REQUEST_STATUSES } from "@/lib/warehouse-buckets";
import { REQUEST_STAGE_STATUSES, isRequestStageKey, type RequestStageKey } from "@/lib/request-stages";
import { useSession, canWrite as canWriteFor, canManageSettings, canSeeFinancial as canSeeFinancialFor } from "@/lib/session";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureRoute } from "@/components/feature-gate";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { dateKeyInTimeZone, formatDate, formatDateTime, formatSAR } from "@/lib/format";
import { downloadCSV } from "@/lib/export";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { REQUEST_VIEWS, type RequestViewKey } from "@/lib/alert-predicates";
import { WorkQueueBanner } from "@/components/work-queue-banner";
import { DISPLAY_REQUEST_STATUSES, simplifiedRequestStatus } from "@/lib/request-fulfillment";
import {
  buildRequestQueuePath,
  requestQueueStateFromSearch,
  withRequestQueueContext,
  type RequestQueueState,
} from "@/lib/request-navigation";

// خريطة الحالة → فئة تشغيلية للعرض (نفس تعريف الحالات في warehouse-buckets.ts، بلا مساس به).
// الحالة الحرفية "overdue" (نوع معرّف، صفر صفوف حاليًا في البيانات) تُسند إلى «يحتاج متابعة/إرجاع»
// حتى لا تختفي إن ظهرت مستقبلًا. الحالات غير التشغيلية (draft/under_review/needs_clarification/
// rejected/cancelled/completed) تعيد null فلا تظهر في المنظور التشغيلي (completed لها قسمها المطوي).
const REQUEST_STATUSES = DISPLAY_REQUEST_STATUSES;
// الجهة الطالبة (ثلاثية): بوابة عميل / عميل (إدخال داخلي) / موظف داخلي (عهدة)
const REQUEST_PARTIES = ["portal", "customer", "employee"] as const;
const REQUEST_VIEW_KEYS: RequestViewKey[] = ["overdue_return", "returns_due", "pending_approval"];
// طريقة العرض: القائمة واللوحة حالة محلية (لا تُكتب في ?view= حتى لا تتعارض مع قوائم العمل)،
// ومنظور المستودع هو نفسه ?view=warehouse القائم.
type RequestLayout = "list" | "board";
type RequestViewOption = RequestLayout | "warehouse";

export default function RequestsPage() {
  const router = useRouter();
  const { role, userId: myUid } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const tr = t.requests;
  const tl = tr.ledger;
  const canWrite = canWriteFor(role);
  const isManager = canManageSettings(role);
  const fin = canSeeFinancialFor(role);
  // الدوران التشغيليان يريان الطلبات كمهام مستودع افتراضيًا؛ المدراء يفتحونها اختياريًا بـ ?view=warehouse.
  const isOpsRole = role === "technician" || role === "warehouse_manager";
  // إظهار تدريجي (فوق شروط الدور القائمة): إنشاء من 40، شرائح/فلاتر متقدمة من 50، CSV من 70.
  // الصفحة نفسها لا تُخفى عن admin/it_manager أبدًا (أدوات الاعتماد).
  const expCreate = isVisible("requests.create");
  const expAdvanced = isVisible("requests.filters.advanced");
  const expCsv = isVisible("requests.csv");

  const [rows, setRows] = useState<RequestListRow[] | null>(null);
  const [warehouseCompleted, setWarehouseCompleted] = useState<RequestListRow[]>([]);
  const [cursor, setCursor] = useState<DescTimeCursor | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [serverKpi, setServerKpi] = useState<RequestOperationalCounts | null>(null);
  const [filterOptions, setFilterOptions] = useState<RequestFilterOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [custOpen, setCustOpen] = useState(false);
  const [f, setF] = useState<Omit<RequestQueueState, "view">>({
    q: "", status: "", stage: "", city: "", source: "", customer: "", responsible: "", overdueOnly: false,
  });
  const initialQueueFocus = useRef<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => {
    initialQueueFocus.current = null;
    setF((s) => ({ ...s, [k]: k === "overdueOnly" ? v === "1" : v }));
  };
  // قائمة عمل (?view=) — نفس شرط التنبيه حرفيًا (alert-predicates.ts).
  const [view, setView] = useState<RequestViewKey | null>(null);
  // منظور مهام المستودع (?view=warehouse) — عرض تشغيلي مقسّم بالحالة بدل الجدول الإداري.
  const [warehouseView, setWarehouseView] = useState(false);
  const [layout, setLayout] = useState<RequestLayout>("list");
  const [initialized, setInitialized] = useState(false);
  const [respLabels, setRespLabels] = useState<Record<string, string>>({});
  const listRequestGate = useRef(createOperationalListRequestGate());
  const todayISO = useMemo(() => dateKeyInTimeZone(), []);
  const warehouseMode = warehouseView || isOpsRole;
  const queueState = useMemo<RequestQueueState>(() => ({
    ...f,
    view: warehouseMode ? "warehouse" : view ?? "",
  }), [f, view, warehouseMode]);

  // The user id only matters for the "mine" responsible filter; its late arrival must not reload.
  const mineUid = f.responsible === "__mine" ? myUid : null;

  async function loadPage(reset: boolean) {
    if (f.responsible === "__mine" && !myUid) return;
    const generation = beginOperationalListRequest(listRequestGate.current, reset, cursor !== null);
    if (generation === null) return;
    const signal = operationalListRequestSignal(listRequestGate.current, generation);
    if (reset) setRows(null); else setLoadingMore(true);
    const responsibleId = f.responsible === "__mine"
      ? myUid ?? undefined
      : f.responsible || undefined;
    const page = await listRequestsPage({
      cursor: reset ? null : cursor,
      ascending: warehouseMode,
      includeFinancial: fin,
      signal,
      filters: {
        q: f.q,
        status: f.status,
        city: f.city,
        party: f.source as (typeof REQUEST_PARTIES)[number] | "",
        customerId: f.customer,
        responsibleId,
        overdueOnly: f.overdueOnly,
        view,
        todayISO,
        statuses: warehouseMode
          ? WAREHOUSE_REQUEST_STATUSES
          : isRequestStageKey(f.stage) ? [...REQUEST_STAGE_STATUSES[f.stage]] : undefined,
      },
    });
    const ids = page.rows.map((r) => r.responsible_employee_id).filter((x): x is string => !!x);
    const labels = ids.length && !signal.aborted ? await resolveUserLabels(ids) : {};
    if (!completeOperationalListRequest(listRequestGate.current, generation)) return;
    setError(page.error);
    setRows((previous) => reset ? page.rows : [...(previous ?? []), ...page.rows]);
    setCursor(page.nextCursor);
    if (page.total != null) setTotal(page.total);
    if (ids.length) setRespLabels((previous) => ({ ...previous, ...labels }));
    setLoadingMore(false);
  }

  const lastLoadQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized) return;
    // تأخير 250ms فقط عند كتابة البحث؛ التحميل الأول وتغيير الفلاتر فوريان.
    const typing = lastLoadQuery.current !== null && lastLoadQuery.current !== f.q;
    lastLoadQuery.current = f.q;
    const timer = window.setTimeout(() => { void loadPage(true); }, typing ? 250 : 0);
    const gate = listRequestGate.current;
    return () => { window.clearTimeout(timer); cancelOperationalListRequest(gate); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, f.q, f.status, f.stage, f.city, f.source, f.customer, f.responsible, f.overdueOnly, view, mineUid, warehouseMode, fin]);

  useEffect(() => {
    Promise.all([
      getRequestOperationalCounts(),
      getRequestFilterOptions(),
    ]).then(async ([countsResult, optionsResult]) => {
      if (countsResult.error || optionsResult.error) {
        setError(countsResult.error ?? optionsResult.error);
      }
      setServerKpi(countsResult.counts);
      setFilterOptions(optionsResult.options);
      const ids = optionsResult.options?.responsible_ids ?? [];
      if (ids.length) setRespLabels(await resolveUserLabels(ids));
    });
  }, []);

  useEffect(() => {
    const parsed = requestQueueStateFromSearch(window.location.search);
    initialQueueFocus.current = window.location.hash.match(/^#request-([0-9a-f-]+)$/i)?.[1] ?? null;
    setF({
      q: parsed.q, status: parsed.status, stage: parsed.stage, city: parsed.city, source: parsed.source,
      customer: parsed.customer, responsible: parsed.responsible, overdueOnly: parsed.overdueOnly,
    });
    if (parsed.view === "warehouse") setWarehouseView(true);
    else if ((REQUEST_VIEW_KEYS as string[]).includes(parsed.view)) setView(parsed.view as RequestViewKey);
    setInitialized(true);
  }, []);

  // مزامنة الرابط مؤجّلة 250ms. أي نقرة داخل الصفحة تُفرغها فورًا قبل بدء التنقل،
  // وإلا فإن replaceState المتأخر يُلغي تنقّلًا جاريًا (نقرة سريعة على طلب بعد الكتابة في البحث).
  const flushUrlSync = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!initialized) return;
    let done = false;
    const sync = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.history.replaceState({}, "", buildRequestQueuePath(queueState, initialQueueFocus.current ?? undefined));
    };
    const timer = window.setTimeout(sync, 250);
    flushUrlSync.current = sync;
    return () => { done = true; window.clearTimeout(timer); };
  }, [initialized, queueState]);

  useEffect(() => {
    if (!initialized || !warehouseMode) { setWarehouseCompleted([]); return; }
    let alive = true;
    const controller = new AbortController();
    void listRequestsPage({
      pageSize: 20,
      includeFinancial: fin,
      signal: controller.signal,
      filters: { q: f.q, statuses: ["completed"] },
    })
      .then((page) => { if (alive) setWarehouseCompleted(page.rows); });
    return () => { alive = false; controller.abort(); };
  }, [initialized, warehouseMode, f.q, fin]);

  useEffect(() => {
    if (!rows?.length || !initialQueueFocus.current) return;
    const target = document.getElementById(`request-${initialQueueFocus.current}`);
    target?.scrollIntoView({ block: "center" });
  }, [rows]);

  const clearView = () => {
    setView(null);
  };

  const cities = filterOptions?.cities ?? [];

  // خيارات فلتر العميل (من الطلبات المحمّلة) وفلتر المسؤول (الأسماء عبر user_label للمدير فقط).
  const customers = (filterOptions?.customers ?? []).map(
    ({ id, name }) => ({ value: id, label: name }),
  );
  const responsibles = useMemo(() => {
    const ids = filterOptions?.responsible_ids ?? [];
    return ids.filter((id) => respLabels[id]).map((id) => ({ value: id, label: respLabels[id] })).sort((a, b) => a.label.localeCompare(b.label));
  }, [filterOptions, respLabels]);

  const custName = (r: RequestListRow) =>
    r.beneficiary_type === "employee"
      ? (r.beneficiary_employee ? (r.beneficiary_employee.full_name_ar ?? r.beneficiary_employee.full_name) : tr.partyEmployee)
      : (r.customer?.name ?? r.customer_name_snapshot ?? tr.externalCustomer);
  // الجهة الطالبة المشتقة للصف (فلتر/شارة)
  const partyOf = (r: RequestListRow): (typeof REQUEST_PARTIES)[number] =>
    r.request_source === "client_portal" ? "portal" : r.beneficiary_type === "employee" ? "employee" : "customer";
  const responsibleLabel = (r: RequestListRow): string | null =>
    r.responsible_employee_id ? (respLabels[r.responsible_employee_id] ?? tr.responsibleStaff) : null;

  const filtered = useMemo(() => (rows ?? []).filter((r) => {
    // قائمة العمل أولًا: نفس شرط التنبيه حرفيًا — الرقم يطابق القائمة.
    if (view && !REQUEST_VIEWS[view](r, todayISO)) return false;
    if (f.status && simplifiedRequestStatus(r.status) !== f.status) return false;
    if (isRequestStageKey(f.stage) && !REQUEST_STAGE_STATUSES[f.stage].includes(r.status)) return false;
    if (f.source && partyOf(r) !== f.source) return false;
    if (f.city && r.project_city !== f.city) return false;
    if (f.customer && r.customer?.id !== f.customer) return false;
    if (f.responsible === "__mine" && r.responsible_employee_id !== myUid) return false;
    if (f.responsible === "__unassigned" && r.responsible_employee_id) return false;
    if (f.responsible && f.responsible !== "__mine" && f.responsible !== "__unassigned" && r.responsible_employee_id !== f.responsible) return false;
    if (f.overdueOnly && !isOverdue(r)) return false;
    if (f.q) {
      const hay = `${r.request_number} ${custName(r)} ${r.project_name ?? ""} ${r.project_city ?? ""}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }), [rows, f, view, todayISO, myUid]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewCount = view ? total : 0;
  const kpi = serverKpi ?? {
    total: 0, review: 0, awaiting: 0, out: 0, completed: 0, overdue: 0,
  };

  // بحث نصّي فقط للمنظور التشغيلي (لا فلاتر إدارية) — يُبقي التقسيم بالحالة داخل WarehouseTaskView.
  const searchedRows = useMemo(() => {
    const base = rows ?? [];
    if (!f.q) return base;
    const q = f.q.toLowerCase();
    return base.filter((r) => `${r.request_number} ${custName(r)} ${r.project_name ?? ""} ${r.project_city ?? ""}`.toLowerCase().includes(q));
  }, [rows, f.q]); // eslint-disable-line react-hooks/exhaustive-deps
  const adminQueueIds = useMemo(() => filtered.slice(0, 25).map((row) => row.id), [filtered]);

  async function exportCsv() {
    if (exportBusy) return;
    setExportBusy(true);
    try {
    const result = await collectCursorPages<RequestListRow, DescTimeCursor>((cursor) => listRequestsPage({
      cursor, pageSize: 250, ascending: warehouseMode, includeFinancial: fin, strictFinancial: true,
      filters: { q: f.q, status: f.status, city: f.city, party: f.source as (typeof REQUEST_PARTIES)[number] | "",
        customerId: f.customer, responsibleId: f.responsible === "__mine" ? myUid ?? undefined : f.responsible || undefined,
        overdueOnly: f.overdueOnly, view, todayISO,
        statuses: warehouseMode ? WAREHOUSE_REQUEST_STATUSES : isRequestStageKey(f.stage) ? [...REQUEST_STAGE_STATUSES[f.stage]] : undefined },
    }));
    if (result.error) { setError(result.error); return; }
    const headers = [tr.number, tr.customer, tr.project, tr.city, tr.status, tr.pickup, tr.return, tr.items, ...(fin ? [tr.totalValue] : [])];
    downloadCSV("customer_requests.csv", headers, result.rows.map((r) => [
      r.request_number, custName(r), r.project_name ?? "", r.project_city ?? "",
      t.requestStatus[simplifiedRequestStatus(r.status)] ?? r.status,
      r.pickup_date ?? "", r.return_date ?? "", r.item_count,
      ...(fin ? [r.total_value ?? ""] : []),
    ]));
    } finally { setExportBusy(false); }
  }

  // ===== واجهة فقط: طريقة العرض، شريط المراحل، مسح الفلاتر =====
  const activeView: RequestViewOption = warehouseMode ? "warehouse" : layout;
  function chooseView(next: RequestViewOption) {
    if (next === "warehouse") { clearView(); setWarehouseView(true); return; }
    setWarehouseView(false);
    setLayout(next);
  }
  const viewOptions: { key: RequestViewOption; label: string; icon: typeof List }[] = [
    { key: "list", label: tl.viewList, icon: List },
    { key: "board", label: tl.viewBoard, icon: Columns3 },
    { key: "warehouse", label: tl.viewWarehouse, icon: Warehouse },
  ];
  const hasFilters = Boolean(f.q || f.status || f.stage || f.city || f.source || f.customer || f.responsible || f.overdueOnly);
  function clearFilters() {
    initialQueueFocus.current = null;
    setF({ q: "", status: "", stage: "", city: "", source: "", customer: "", responsible: "", overdueOnly: false });
  }
  // خلية المرحلة = نفس مجموعة حالات عدّاد الخادم (request-stages.ts) — الرقم يطابق القائمة.
  // المرحلة وفلتر الحالة التفصيلي متنافيان كي لا يتقاطعا بصمت.
  const toggleStage = (stage: RequestStageKey) => () => {
    initialQueueFocus.current = null;
    setF((s) => ({ ...s, status: "", stage: s.stage === stage ? "" : stage }));
  };
  const counted = (n: number) => (serverKpi ? n : null);
  const stageCells: StageCell[] = [
    { key: "all", label: tl.stageAll, caption: tl.stageAllCap, count: counted(kpi.total), tone: "neu",
      pressed: !f.status && !f.stage && !f.overdueOnly,
      onPick: () => { initialQueueFocus.current = null; setF((s) => ({ ...s, status: "", stage: "", overdueOnly: false })); } },
    { key: "review", label: t.requestStatus.under_review, caption: tl.stageReviewCap, count: counted(kpi.review), tone: "info",
      pressed: f.stage === "review", onPick: toggleStage("review") },
    { key: "fulfillment", label: tr.kpiInFulfillment, caption: tl.stageFulfillmentCap, count: counted(kpi.awaiting), tone: "res",
      pressed: f.stage === "fulfillment", onPick: toggleStage("fulfillment") },
    { key: "out", label: tr.kpiOut, caption: tl.stageOutCap, count: counted(kpi.out), tone: "neu",
      pressed: f.stage === "out", onPick: toggleStage("out") },
    { key: "completed", label: tr.kpiCompleted, caption: tl.stageCompletedCap, count: counted(kpi.completed), tone: "ok",
      pressed: f.stage === "completed", onPick: toggleStage("completed") },
    { key: "overdue", label: tr.overdue, caption: tl.stageOverdueCap, count: counted(kpi.overdue), tone: "bad",
      pressed: f.overdueOnly, onPick: () => set("overdueOnly")(f.overdueOnly ? "" : "1") },
  ];
  const colSpan = fin ? 8 : 7;

  return (
    <FeatureRoute feature="requests.list">
    <div className="space-y-6" onClickCapture={() => flushUrlSync.current()}>
      <PageHeader title={tr.title} description={warehouseMode ? t.warehouse.subtitle : tr.subtitle} actions={<>
          {!warehouseMode && (
            <>
              {isManager && <Button variant="outline" onClick={() => setCustOpen(true)}><Users aria-hidden="true" />{t.customers.manage}</Button>}
              {expCsv && <Button variant="outline" onClick={exportCsv} disabled={exportBusy || filtered.length === 0} title={filtered.length === 0 ? tr.noExportData : undefined}><Download aria-hidden="true" />{tr.exportCsv}</Button>}
              {canWrite && expCreate && <Link href="/requests/new" className={buttonClass("primary", "md")}><Plus aria-hidden="true" />{tr.new}</Link>}
            </>
          )}
        </>} />

      {/* شعار قائمة العمل — من التنبيهات (?view=). العدد يطابق مصدر التنبيه (نفس الشرط).
          فتح الطلب يعرض أزرار الدورة/الاعتماد الموجودة — الإجراء مباشر. */}
      {!warehouseMode && view && (
        <WorkQueueBanner
          title={t.workQueue.views[view].title}
          desc={t.workQueue.views[view].desc}
          action={t.workQueue.views[view].action}
          count={viewCount}
          clearLabel={t.workQueue.showAll}
          onClear={clearView}
        />
      )}

      {/* شريط المراحل — عدادات الخادم نفسها (request_operational_counts)؛ الضغط يطبّق فلتر الحالة/المتأخر القائم. إظهار تدريجي من 50 */}
      {!warehouseMode && expAdvanced && <RequestStageStrip cells={stageCells} label={tl.stagesLabel} />}

      {/* طريقة العرض — الدوران التشغيليان يريان منظور المستودع فقط */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line">
        {!isOpsRole && (
          <div role="group" aria-label={tl.viewLabel} className="flex max-w-full items-center gap-6 overflow-x-auto">
            {viewOptions.map((option) => (
              <button key={option.key} type="button" aria-pressed={activeView === option.key} onClick={() => chooseView(option.key)} className={`inline-flex min-h-12 shrink-0 items-center gap-2 border-b-[3px] px-0.5 text-[13px] transition-colors ${activeView === option.key ? "border-brand font-semibold text-fg" : "border-transparent text-muted hover:text-fg"}`}>
                <option.icon aria-hidden="true" className="h-4 w-4" />{option.label}
              </button>
            ))}
          </div>
        )}
        {!warehouseMode && rows && (
          <>
            {!isOpsRole && <span aria-hidden="true" className="hidden h-[22px] w-px bg-line-strong sm:block" />}
            <p className="text-[13px] text-fg-2"><span className="tabular-nums">{filtered.length} / {total}</span> {tr.countLabel}</p>
          </>
        )}
        {!warehouseMode && hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="ms-auto text-brand-ink">{tl.clearFilters}</Button>
        )}
      </div>

      {warehouseMode ? (
        <WarehouseTaskView
          rows={searchedRows}
          completedRows={warehouseCompleted}
          loading={rows === null}
          loadingMore={loadingMore}
          total={total}
          hasMore={Boolean(cursor)}
          onLoadMore={() => void loadPage(false)}
          q={f.q}
          onQ={set("q")}
          queueState={queueState}
          custName={custName}
          partyOf={partyOf}
        />
      ) : (
      <>
      <div role="group" aria-label={tl.filtersLabel} className="flex flex-wrap items-center gap-3 rounded-card bg-surface p-5">
        <SearchInput label={tr.searchPlaceholder} clearLabel={t.common.clearSearch}
          value={f.q} onChange={(e) => set("q")(e.target.value)} onClear={() => set("q")('')}
          placeholder={tr.searchPlaceholder} containerClassName="w-full sm:w-72" />
        <div className="w-full sm:w-44">
          <Select value={f.status} onChange={(v) => { initialQueueFocus.current = null; setF((s) => ({ ...s, status: v, stage: v ? "" : s.stage })); }} placeholder={tr.allStatuses} options={REQUEST_STATUSES.map((s) => ({ value: s, label: t.requestStatus[s as keyof typeof t.requestStatus] }))} />
        </div>
        <div className="w-full sm:w-44">
          <Select value={f.source} onChange={set("source")} placeholder={tr.allSources} options={REQUEST_PARTIES.map((s) => ({ value: s, label: tr.partyLabel[s] }))} />
        </div>
        {/* إظهار تدريجي: فلاتر المدينة/المسؤول/المتأخر من 50 (البحث والحالة أساسيان من 40) */}
        {expAdvanced && (
          <>
            <div className="w-full sm:w-36">
              <Select value={f.city} onChange={set("city")} placeholder={tr.allCities} options={cities.map((c) => ({ value: c, label: c }))} />
            </div>
            <div className="w-full sm:w-48">
              <Select value={f.customer} onChange={set("customer")} placeholder={tr.allCustomers} options={customers} />
            </div>
            <div className="w-full sm:w-44">
              <Select value={f.responsible} onChange={set("responsible")} placeholder={tr.allResponsibles}
                options={[{ value: "__mine", label: tr.responsibleMine }, { value: "__unassigned", label: tr.responsibleUnassignedOpt }, ...responsibles]} />
            </div>
            <FilterChip pressed={f.overdueOnly} onClick={() => set("overdueOnly")(f.overdueOnly ? "" : "1")}>
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-bad" />{tr.overdueOnly}
            </FilterChip>
          </>
        )}
      </div>

      {layout === "board" && rows && !error ? (
        <RequestsBoard
          rows={filtered}
          queueState={queueState}
          custName={custName}
          partyOf={partyOf}
          responsibleLabel={responsibleLabel}
          hasMore={Boolean(cursor)}
        />
      ) : (
      <Card className="overflow-hidden">
        <div tabIndex={0} className="overflow-x-auto">
          <table className="ui-table">
            <caption className="sr-only">{tr.title}</caption>
            <thead>
              <tr>
                <th scope="col">{tr.number}</th>
                <th scope="col">{tl.customerProject}</th>
                <th scope="col">{tr.status}</th>
                <th scope="col">{tr.items}</th>
                <th scope="col">{tr.deliveredDate}</th>
                <th scope="col">{tr.return}</th>
                <th scope="col">{tr.responsible}</th>
                {fin && <th scope="col">{tr.totalValue}</th>}
              </tr>
            </thead>
            <tbody>
              {!rows ? <tr><td colSpan={colSpan} className="py-12 text-center"><Spinner label={tr.loading} /></td></tr>
              : error ? <tr><td colSpan={colSpan} className="py-12 text-center text-sm font-medium text-bad">{friendlyErrorStrict(error, lang)}</td></tr>
              : filtered.length === 0 ? (
                <tr><td colSpan={colSpan} className="!h-auto">
                  {rows.length === 0 ? (
                    <EmptyState icon={ClipboardList} title={tr.emptyTitle} description={tr.emptyHint} action={<>
                      {isManager && <Button variant="outline" size="sm" onClick={() => setCustOpen(true)}><Users aria-hidden="true" />{t.customers.manage}</Button>}
                      {canWrite && <Link href="/requests/new" className={buttonClass("primary", "sm")}><Plus aria-hidden="true" />{tr.new}</Link>}
                    </>} />
                  ) : (
                    <EmptyState compact icon={SearchX} title={tr.empty}
                      action={hasFilters ? <Button variant="outline" size="sm" onClick={clearFilters}>{tl.clearFilters}</Button> : undefined} />
                  )}
                </td></tr>
              )
              : filtered.map((r) => {
                const over = isOverdue(r);
                const requestHref = withRequestQueueContext(
                  r.id,
                  buildRequestQueuePath(queueState, r.id),
                  adminQueueIds,
                );
                return (
                  <tr id={`request-${r.id}`} key={r.id} className="cursor-pointer scroll-mt-24" onClick={() => router.push(requestHref)}>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <Link href={requestHref} onClick={(e) => e.stopPropagation()} className="rounded text-brand-ink hover:underline focus-visible:underline">
                          <RequestNumber>{r.request_number}</RequestNumber>
                        </Link>
                        {r.request_source === "client_portal" && <PartyTag>{tr.sourceBadgePortal}</PartyTag>}
                        {r.beneficiary_type === "employee" && <PartyTag>{tr.sourceBadgeEmployee}</PartyTag>}
                      </div>
                      {(r.portal_approval_status === "approved_by_project_manager" || r.status === "needs_clarification") && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.portal_approval_status === "approved_by_project_manager" && <StatusChip tone="ok" size="sm">{tr.pmApprovedBadge}</StatusChip>}
                          {r.status === "needs_clarification" && <StatusChip tone="warn" size="sm">{tr.clarifyBadge}</StatusChip>}
                        </div>
                      )}
                    </td>
                    <td className="max-w-[320px]">
                      <span className="block truncate font-semibold text-fg">{custName(r)}</span>
                      {(r.project_name || r.project_city) && (
                        <span className="block truncate text-xs text-muted">{[r.project_name, r.project_city].filter(Boolean).join(" · ")}</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <RequestStatusBadge status={r.status} />
                        {over && <StatusChip tone="bad" size="sm">{tr.overdueBadge}</StatusChip>}
                      </div>
                    </td>
                    <td className="tabular-nums text-fg-2">{r.item_count}</td>
                    <td className="whitespace-nowrap text-[13px] tabular-nums text-fg-2" dir={lang === "ar" ? "rtl" : "ltr"}>{r.delivered_at ? formatDateTime(r.delivered_at, lang) : "—"}</td>
                    <td className={`whitespace-nowrap text-[13px] tabular-nums ${over ? "font-semibold text-bad" : "text-fg-2"}`} dir={lang === "ar" ? "rtl" : "ltr"}>{r.return_date ? formatDate(r.return_date, lang) : "—"}</td>
                    <td><ResponsibleCell label={responsibleLabel(r)} unassignedLabel={tr.responsibleUnassigned} /></td>
                    {fin && <td className="whitespace-nowrap tabular-nums text-fg-2">{r.total_value != null ? formatSAR(r.total_value, lang) : "—"}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      )}
      {cursor && (
        <div className="flex justify-center">
          <Button variant="outline" disabled={rows === null || loadingMore} onClick={() => void loadPage(false)}>
            {loadingMore ? tr.loading : t.reports.showMore}
          </Button>
        </div>
      )}
      </>
      )}

      <Dialog open={custOpen} onClose={() => setCustOpen(false)} title={t.customers.title} size="5xl" closeLabel={t.common.close}>
        <CustomersManager />
      </Dialog>
    </div>
    </FeatureRoute>
  );
}
