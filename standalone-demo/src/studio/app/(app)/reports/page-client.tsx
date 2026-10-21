"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, panelId, tabId } from "@/components/ui/tabs";
import {
  type ActivityEvent,
} from "@/lib/queries";
import { isOverdue, type RequestListRow } from "@/lib/requests";
import {
  buildNotificationAlerts, DEFAULT_NOTIFICATION_SETTINGS,
} from "@/lib/notifications";
import { computeDepreciation, pickRule } from "@/lib/depreciation";
import { getTemplateByCategoryOrSection } from "@/lib/asset-type-templates";
import { useSession, canSeeFinancial as canSeeFinancialFor, useCan } from "@/lib/session";
import { STATUS_AR, dateKeyInTimeZone, formatDate, formatDateTime } from "@/lib/format";
import { downloadCSV } from "@/lib/export";
import type { AssetStatus } from "@/lib/types";
import { REQUEST_STATUS_TONE } from "@/lib/tone";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { FeatureUnavailablePanel } from "@/components/feature-gate";
import { type ReportTab } from "@/lib/report-layout";
import { resolveReportTab, visibleReportTabs } from "@/lib/report-load-plan";
import { useReportData } from "@/lib/report-data";
import { friendlyErrorStrict } from "@/lib/user-facing-errors";
import { Toast } from "@/components/ui/toast";
import {
  summarizeFinancialMetric,
  type FinancialMetric,
} from "@/lib/financial-truth";
import type { ReportKpi } from "@/components/reports/report-ui";
import { ReportFilters } from "@/components/reports/report-filters";
import { ReportsSkeleton } from "@/components/reports/reports-skeleton";
import { PrivateSavedViews } from "@/components/private-saved-views";
import { useViewUrl } from "@/lib/use-view-url";
import { filterParams, parseReportView, reportViewValues, type FilterValues } from "@/lib/view-filters";
import type { ReportFilterState } from "@/components/reports/report-filters";

const ALL_STATUSES = Object.keys(STATUS_AR) as AssetStatus[];
// (I18N-2) اختيار عمود الاسم حسب اللغة النشطة (عرض فقط، لا ترجمة لبيانات القاعدة). lang يُمرَّر من المكوّن.
const nameOf = (x: any, lang: string) => (lang === "en" ? (x?.name ?? x?.name_ar) : (x?.name_ar ?? x?.name)) ?? "—";

// Alerts and activity remain implemented below for their canonical routes, but
// cannot be selected in this page: Reports has exactly five primary areas.
type Tab = ReportTab | "alerts" | "activity";
const ASSET_FILTER_TABS: Tab[] = ["executive", "custody"];
const EMPTY_ACTIVITY: ActivityEvent[] = [];

type PanelModules = {
  executive: typeof import("@/components/reports/executive-tab")["ExecutiveTab"];
  requests: typeof import("@/components/reports/requests-tab")["RequestsTab"];
  inventory: typeof import("@/components/reports/inventory-tab")["InventoryTab"];
  maintenance: typeof import("@/components/reports/maintenance-tab")["MaintenanceTab"];
  custody: typeof import("@/components/reports/custody-tab")["CustodyTab"];
  alerts: typeof import("@/components/reports/secondary-tabs")["AlertsTab"];
  activity: typeof import("@/components/reports/secondary-tabs")["ActivityTab"];
};

// Cache code promises only. Failed loads are eligible for the existing page retry.
function codeLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => pending ??= load().catch((error: unknown) => {
    pending = null;
    throw error;
  });
}
function panelCode<T>(component: T): T {
  if (typeof component !== "function") throw new Error("report_panel_load_failed");
  return component;
}
const PANEL_LOADERS: { [K in Tab]: () => Promise<Pick<PanelModules, K>> } = {
  executive: codeLoader(() => import("@/components/reports/executive-tab").then((module) => ({ executive: panelCode(module.ExecutiveTab) }))),
  requests: codeLoader(() => import("@/components/reports/requests-tab").then((module) => ({ requests: panelCode(module.RequestsTab) }))),
  inventory: codeLoader(() => import("@/components/reports/inventory-tab").then((module) => ({ inventory: panelCode(module.InventoryTab) }))),
  maintenance: codeLoader(() => import("@/components/reports/maintenance-tab").then((module) => ({ maintenance: panelCode(module.MaintenanceTab) }))),
  custody: codeLoader(() => import("@/components/reports/custody-tab").then((module) => ({ custody: panelCode(module.CustodyTab) }))),
  alerts: codeLoader(() => import("@/components/reports/secondary-tabs").then((module) => ({ alerts: panelCode(module.AlertsTab) }))),
  activity: codeLoader(() => import("@/components/reports/secondary-tabs").then((module) => ({ activity: panelCode(module.ActivityTab) }))),
};

export default function ReportsPage({ initialTab = "executive" }: { initialTab?: ReportTab }) {
  const { userId, role, approvalStatus, capabilities, loading: roleLoading } = useSession();
  const { t, lang } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const can = useCan();
  const fin = canSeeFinancialFor(role);
  // إظهار تدريجي: التبويبات الظاهرة لهذا الدور/المستوى + إتاحة أزرار CSV.
  // ملاحظة: هذا لا يغيّر الحجب المالي داخل التبويبات/الأعمدة — الدور (fin) يبقى الحاكم.
  // حارس مزدوج لتبويب طلبات العملاء: الإظهار التدريجي + قدرة report.customer_requests (تُطبَّق في الخادم أيضًا).
  const customerReportsAllowed = can("report.customer_requests");
  const visibleTabs = useMemo(() => visibleReportTabs(isVisible, customerReportsAllowed), [isVisible, customerReportsAllowed]);
  // إتاحة التصدير = الإظهار التدريجي + قدرة report.export (قابلة للمنع لكل مستخدم من المصفوفة).
  const csvAllowed = isVisible("reports.csv") && can("report.export");
  const parseView = useCallback((params: URLSearchParams) => parseReportView(params, visibleTabs), [visibleTabs]);
  const [viewState, updateView] = useViewUrl({ initial: parseReportView(new URLSearchParams({ tab: initialTab }), visibleTabs), parse: parseView, values: reportViewValues });
  const selectedTab = viewState.tab;
  const setTab = (value: Tab) => updateView({ tab: resolveReportTab(value, visibleTabs) });
  const activeTab = resolveReportTab(selectedTab, visibleTabs);
  const tab = activeTab as Tab;
  const reportEnabled = !roleLoading && !!userId && !!role && visibleTabs.length > 0;
  const report = useReportData({
    tab: activeTab, financial: fin,
    identityKey: `${userId ?? ""}|${role ?? ""}|${approvalStatus}|${[...capabilities].sort().join(",")}|${fin}`,
    enabled: reportEnabled,
  });
  const { data, reqRows, deprRules, decisionCount } = report;
  const [loadedPanels, setLoadedPanels] = useState<Partial<PanelModules>>({});
  const [failedPanels, setFailedPanels] = useState<Partial<Record<Tab, true>>>({});
  const [panelRetry, setPanelRetry] = useState(0);
  const { executive: ExecutiveTab, requests: RequestsTab, inventory: InventoryTab,
    maintenance: MaintenanceTab, custody: CustodyTab, alerts: AlertsTab, activity: ActivityTab } = loadedPanels;
  const panelReady = loadedPanels[tab] !== undefined;
  const panelError = failedPanels[tab] ? "report_panel_load_failed" : null;
  useEffect(() => {
    if (!reportEnabled || panelReady || panelError) return;
    let active = true;
    void PANEL_LOADERS[tab]().then((module) => {
      if (active) setLoadedPanels((previous) => ({ ...previous, ...module }));
    }).catch(() => {
      if (active) setFailedPanels((previous) => ({ ...previous, [tab]: true }));
    });
    return () => { active = false; };
  }, [tab, reportEnabled, panelReady, panelError, panelRetry]);
  const reportError = report.error ?? panelError;
  const reportLoading = report.loading || roleLoading || (!panelReady && !panelError);
  const retryReport = () => {
    setFailedPanels((previous) => {
      const next = { ...previous };
      delete next[tab];
      return next;
    });
    setPanelRetry((version) => version + 1);
    report.retry();
  };
  const financialQuality = report.quality.data;
  // These legacy, unmounted panels keep their handlers; canonical routes load their own data.
  const activity = EMPTY_ACTIVITY;
  const notifSettings = DEFAULT_NOTIFICATION_SETTINGS;
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const inventoryKind = viewState.kind;
  const setInventoryKind = (kind: typeof inventoryKind) => updateView({ kind });
  const requestSource = viewState.source;
  const setRequestSource = (source: typeof requestSource) => updateView({ source });
  const f = useMemo<ReportFilterState>(() => ({ category: viewState.category, status: viewState.status, location: viewState.location,
    department: viewState.department, company: viewState.company, from: viewState.from, to: viewState.to }), [viewState]);
  const set = (key: keyof ReportFilterState) => (value: string) => updateView({ [key]: value });
  const clearFilters = () => updateView({ category: "", status: "", location: "", department: "", company: "", from: "", to: "" });
  const normalizeSavedView = useCallback((values: FilterValues) => reportViewValues(parseView(filterParams(values))), [parseView]);

  const assets = useMemo(() => {
    return data.assets.filter((a: any) => {
      if (f.category && a.category?.id !== f.category) return false;
      if (f.status && a.status !== f.status) return false;
      if (f.location && a.location?.id !== f.location) return false;
      if (f.department && a.department?.id !== f.department) return false;
      if (f.company && a.company_id !== f.company) return false;
      if (f.from && (!a.purchase_date || a.purchase_date < f.from)) return false;
      if (f.to && (!a.purchase_date || a.purchase_date > f.to)) return false;
      return true;
    });
  }, [data.assets, f]);

  const financialAsOf = useMemo(() => new Date(), []);

  const assetValueMetric = useMemo(
    () => summarizeFinancialMetric({
      authorized: fin,
      rows: assets as any[],
      valueOf: (asset) => asset.purchase_cost,
      currencyOf: (asset) => asset.currency,
      asOf: financialAsOf,
    }),
    [assets, fin, financialAsOf],
  );

  // الإهلاك لا يصبح KPI قابلًا للعرض إلا إذا كان كل أصل ضمن النطاق يملك
  // التكلفة والتاريخ وقاعدة قابلة للتطبيق. لا نعيد partial sum.
  const depreciationRows = useMemo(() => {
    if (tab !== "executive" || !fin) return [];
    return (assets as any[]).map((a) => {
      // نفس منطق صفحة تفاصيل الأصل (section + special_attributes) حتى تتطابق الإجماليات مع القيم الفردية
      const tmplId = getTemplateByCategoryOrSection(
        a.category?.name, a.category?.name_ar,
        (a.special_attributes?.section as string | undefined) ?? null,
        a.name, a.serial_number, a.special_attributes,
      );
      const rule = pickRule(deprRules, a.category?.id ?? a.category_id ?? null, tmplId);
      const d = computeDepreciation(a.purchase_cost, a.purchase_date, rule);
      return {
        currency: a.currency,
        current: d.applicable ? d.currentValue : null,
        depreciation: d.applicable ? d.accumulatedDepreciation : null,
      };
    });
  }, [assets, deprRules, tab, fin]);

  const currentValueMetric = useMemo(
    () => summarizeFinancialMetric({
      authorized: fin,
      rows: depreciationRows,
      valueOf: (row) => row.current,
      currencyOf: (row) => row.currency,
      asOf: financialAsOf,
    }),
    [depreciationRows, fin, financialAsOf],
  );
  const depreciationMetric = useMemo(
    () => summarizeFinancialMetric({
      authorized: fin,
      rows: depreciationRows,
      valueOf: (row) => row.depreciation,
      currencyOf: (row) => row.currency,
      asOf: financialAsOf,
    }),
    [depreciationRows, fin, financialAsOf],
  );

  const kpi = useMemo(() => {
    const byStatus = (s: AssetStatus) => assets.filter((a: any) => a.status === s).length;
    const openM = (data?.maintenance ?? []).filter((m: any) => m.status === "open" || m.status === "in_progress").length;
    return {
      total: assets.length, available: byStatus("available"), reserved: byStatus("reserved"),
      maint: byStatus("in_maintenance"),
      bad: 0,
      openM,
    };
  }, [assets, data]);

  const byCategory = useMemo(() => groupBy(assets, (a) => a.category, t.unspecified), [assets, t]);
  const byLocation = useMemo(() => groupBy(assets, (a) => a.location, t.unspecified), [assets, t]);
  const byDepartment = useMemo(() => groupBy(assets, (a) => a.department, t.unspecified), [assets, t]);
  const byCompany = useMemo(() => groupBy(assets, (a) => a.company, t.unspecified), [assets, t]);
  const custodyAssets = useMemo(
    () => assets.filter((a: any) => a.status === "reserved" && a.holder),
    [assets],
  );
  const byEmployee = useMemo(
    () => groupBy(custodyAssets, (a) => a.holder, t.unspecified),
    [custodyAssets, t],
  );

  const maint = useMemo(() => {
    const m = data?.maintenance ?? [];
    const today = dateKeyInTimeZone();
    const cutoff = Date.now() - 14 * 864e5;
    const tl = (g: Record<string, string>, k: string) => g[k] ?? k;
    return {
      count: m.length,
      open: m.filter((x: any) => x.status === "open" || x.status === "in_progress").length,
      completed: m.filter((x: any) => x.status === "completed").length,
      byType: countBy(m, (x: any) => x.type).map(([k, n]) => [tl(t.mtype, k), n] as [string, number]),
      byPriority: countBy(m.filter((x: any) => x.priority), (x: any) => x.priority).map(([k, n]) => [tl(t.priority, k), n] as [string, number]),
      byProblemType: countBy(m.filter((x: any) => x.problem_type), (x: any) => x.problem_type).map(([k, n]) => [tl(t.problemType, k), n] as [string, number]),
      byStage: countBy(m.filter((x: any) => x.workflow_stage), (x: any) => x.workflow_stage).map(([k, n]) => [tl(t.stage, k), n] as [string, number]),
      topCost: [...m]
        .filter((x: any) => x.cost_recorded === true && x.cost != null)
        .sort((a: any, b: any) => Number(b.cost) - Number(a.cost))
        .slice(0, 6),
      topFreq: topMaintained(m),
      overdue: m.filter((x: any) => x.next_due_date && x.next_due_date < today && x.status !== "completed"),
      long: m.filter((x: any) => (x.status === "open" || x.status === "in_progress") && x.reported_at && new Date(x.reported_at).getTime() < cutoff),
      critical: m.filter((x: any) => (x.priority === "critical" || x.priority === "high") && x.status !== "completed"),
      recent: m.slice(0, 8),
    };
  }, [data, t]);

  const maintenanceCostMetric = useMemo(
    () => summarizeFinancialMetric({
      authorized: fin,
      rows: (data?.maintenance ?? []) as any[],
      valueOf: (record) => record.cost_recorded === true ? record.cost : null,
      currencyOf: (record) => record.currency,
      asOf: financialAsOf,
    }),
    [data, fin, financialAsOf],
  );

  const risk = useMemo(() => {
    const a = assets;
    return {
      maintenanceAttention: a.filter((x: any) => x.status === "in_maintenance"),
    };
  }, [assets]);

  const cons = useMemo(() => {
    const c = data?.consumables ?? [];
    const txns = data?.txns ?? [];
    const dispensed = new Map<string, number>();
    for (const tx of txns as any[]) if (tx.txn_type === "out") {
      const n = tx.consumable?.name ?? "—"; dispensed.set(n, (dispensed.get(n) ?? 0) + Number(tx.quantity || 0));
    }
    const byCompanyMap = new Map<string, number>();
    for (const x of c as any[]) {
      const name = x.company?.name ?? t.unspecified;
      byCompanyMap.set(name, (byCompanyMap.get(name) ?? 0) + 1);
    }
    // تكلفة التوريد حسب المورد (للمخوّلين ماليًا) + آخر عمليات التوريد/الصرف
    const costBySupplierMap = new Map<string, number>();
    for (const tx of txns as any[]) if (tx.txn_type === "in" && tx.total_cost != null) {
      const name = tx.supplier?.name_ar ?? tx.supplier?.name ?? t.unspecified;
      costBySupplierMap.set(
        name,
        (costBySupplierMap.get(name) ?? 0) + Number(tx.total_cost),
      );
    }
    return {
      all: c,
      mostDispensed: Array.from(dispensed.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6),
      recent: (txns as any[]).slice(0, 8),
      byCompany: Array.from(byCompanyMap.entries()).sort((a, b) => b[1] - a[1]),
      recentReplenishment: (txns as any[]).filter((x) => x.txn_type === "in").slice(0, 8),
      recentUsage: (txns as any[]).filter((x) => x.txn_type === "out").slice(0, 8),
      costBySupplier: Array.from(costBySupplierMap.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [data, t]);

  const actInsights = useMemo(() => {
    const edits = new Map<string, number>();
    for (const e of activity) if (e.op === "asset_edit" && e.entityLabel) edits.set(e.entityLabel, (edits.get(e.entityLabel) ?? 0) + 1);
    return {
      mostEdited: Array.from(edits.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6),
      recentMaint: activity.filter((e) => e.kind === "maintenance").slice(0, 6),
      recentCustody: activity.filter((e) => e.op === "assign" || e.op === "return").slice(0, 6),
    };
  }, [activity]);

  const reportRequests = useMemo(() => reqRows.filter((r) => {
    if (requestSource === "employee") return r.beneficiary_type === "employee";
    if (requestSource === "customer") return r.beneficiary_type !== "employee";
    return true;
  }), [reqRows, requestSource]);

  // ---- إحصاءات الطلبات الموحّدة (KPIs + توزيع الحالات + الاتجاه الشهري) ----
  const reqStats = useMemo(() => {
    const all = reportRequests;
    const by = (s: string) => all.filter((r) => r.status === s).length;
    const tl = (g: Record<string, string>, k: string) => g[k] ?? k;
    const statusCount = countBy(all, (r: any) => r.status).map(([k, n]) => [tl(t.requestStatus, k), n] as [string, number]);
    const monthMap = new Map<string, number>();
    for (const r of all) { const m = (r.created_at ?? "").slice(0, 7); if (m) monthMap.set(m, (monthMap.get(m) ?? 0) + 1); }
    const trend = Array.from(monthMap.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-8) as [string, number][];
    return {
      total: all.length,
      review: by("under_review") + by("draft"),
      approved: by("approved"),
      out: by("delivered") + by("partially_returned"),
      overdue: all.filter((r) => isOverdue(r)).length,
      completed: by("completed") + by("returned"),
      rejected: by("rejected") + by("cancelled"),
      statusCount, trend, recent: all.slice(0, 8),
    };
  }, [reportRequests, t]);

  const requestValueMetric = useMemo(
    () => summarizeFinancialMetric({
      authorized: fin,
      rows: reportRequests,
      valueOf: (request) => request.financial_state === "available"
        ? request.total_value
        : null,
      currencyOf: () => "SAR",
      asOf: financialAsOf,
    }),
    [reportRequests, fin, financialAsOf],
  );

  // ---- التنبيهات التشغيلية الموحّدة (مخزون/طلبات/صيانة) — In-App، بلا مالية ----
  const opAlerts = useMemo(
    () => tab === "alerts" ? buildNotificationAlerts(
      {
        consumables: [],
        requests: reqRows as any,
        maintenance: (data?.maintenance ?? []) as any,
      },
      notifSettings, t, role,
    ) : [],
    [tab, data, reqRows, notifSettings, t, role],
  );
  const operationalAlerts = useMemo(() => {
    if (tab !== "alerts") return [];
    const source = opAlerts.filter((a) => ["overdue_request", "pending_approval", "maintenance_due"].includes(a.type));
    const rows = [
      ...risk.maintenanceAttention.map((a: any) => ({ id: `maintenance-${a.id}`, severity: "warning" as const, title: repLabel(t.reports.risksLabels.inMaintenance, a), description: t.dashboard.alerts.maintenance_attention.desc, href: `/assets/${a.id}` })),
      ...maint.long.map((m: any) => ({ id: `long-${m.id}`, severity: "warning" as const, title: repLabel(t.reports.risksLabels.longMaint, m.asset), description: t.dashboard.alerts.long_maint.desc, href: `/maintenance?m=${m.id}` })),
      ...source.map((a) => ({ id: a.id, severity: a.severity, title: a.title, description: a.description, href: a.href })),
    ];
    const order = { critical: 0, warning: 1, info: 2 } as const;
    return rows.sort((a, b) => order[a.severity] - order[b.severity]);
  }, [tab, opAlerts, risk, maint.long, t]);

  // إظهار تدريجي: لا تبويبات ظاهرة بهذا المستوى ⇒ لوحة «تُفعَّل لاحقًا» الودّية
  // (ليست رسالة صلاحيات — RLS/الدور لم يتغيرا). admin لا يصل هنا أبدًا (يرى 100%).
  if (!roleLoading && visibleTabs.length === 0) return <FeatureUnavailablePanel />;

  const rep = t.reports;
  const rep2 = t.requests;
  const tnf = t.notifications;
  const ops = t.activity.ops as Record<string, string>;

  function saveCSV(...args: Parameters<typeof downloadCSV>) {
    if (!downloadCSV(...args)) throw new Error("report_export_failed");
  }

  async function runExport(exporter: () => void | Promise<void>) {
    if (exporting) return;
    setExporting(true);
    try {
      if (!panelReady || panelError) throw new Error("report_not_ready");
      report.assertFresh();
      await exporter();
    } catch (error) {
      setToast({ type: "error", message: `${rep.exportFailed} ${friendlyErrorStrict(error instanceof Error ? error.message : error, lang)}` });
    } finally {
      setExporting(false);
    }
  }

  async function exportQualityQueue() {
    const rows = await report.exportQuality();
    saveCSV("financial_data_quality.csv", [rep.export.tag, rep.export.name, rep.financialTruth.missingFields],
      rows.map((row) => [row.asset_tag ?? "", row.asset_name ?? "", row.missing_fields.join("; ")]));
  }

  const assetMetricFor = (rows: any[]) => summarizeFinancialMetric({
    authorized: fin,
    rows,
    valueOf: (asset) => asset.purchase_cost,
    currencyOf: (asset) => asset.currency,
    asOf: financialAsOf,
  });

  function exportCategory() {
    // عمود القيمة الإجمالية (مالي) يُحذف لغير المصرّح لهم
    const headers = [rep.export.category, rep.export.assetCount, ...(fin ? [rep.export.totalValue] : [])];
    saveCSV("category_summary.csv", headers,
      byCategory.map((g) => [
        g.label,
        g.items.length,
        ...(fin ? [assetMetricFor(g.items).value ?? ""] : []),
      ]));
  }

  function exportRequests() {
    const headers = [rep2.number, rep2.requesterParty, rep2.customer, rep2.project, rep2.city, rep2.status, rep2.pickup, rep2.return, rep2.items, ...(fin ? [rep2.totalValue] : [])];
    saveCSV("requests_report.csv", headers, reportRequests.map((r) => [
      r.request_number, r.beneficiary_type === "employee" ? rep2.partyEmployee : rep2.partyCustomer,
      requestPartyName(r, rep2.partyEmployee), r.project_name ?? "", r.project_city ?? "",
      t.requestStatus[r.status] ?? r.status, r.pickup_date ?? "", r.return_date ?? "", r.item_count,
      ...(fin ? [r.total_value ?? ""] : []),
    ]));
  }

  // تصدير التنبيهات التشغيلية — بلا أي عمود مالي (نوع/شدة/عنوان/تفاصيل فقط).
  function exportAlerts() {
    const tnc = t.notifications.csv;
    const headers = [tnc.severity, tnc.title, tnc.detail];
    saveCSV("operational_alerts.csv", headers, operationalAlerts.map((a) => [
      t.notifications.sev[a.severity], a.title, a.description,
    ]));
  }

  function exportInventory() {
    const headers = [t.assetForm.itemType, rep.export.category, rep.export.name, rep.consTab.qty, rep.export.status, rep.export.location, rep.allCompanies, ...(fin ? [rep.export.purchaseCost] : [])];
    const assetRows = inventoryKind === "consumable" ? [] : assets.map((a: any) => [
      t.assetForm.typeAsset, nameOf(a.category, lang), a.name ?? a.asset_tag ?? "", 1,
      t.status[a.status as AssetStatus], nameOf(a.location, lang), a.company?.name ?? "",
      ...(fin ? [a.purchase_cost ?? ""] : []),
    ]);
    const consumableRows = inventoryKind === "asset" ? [] : (cons.all as any[]).map((c) => [
      t.assetForm.typeConsumable, nameOf(c.category, lang), c.name, c.quantity_on_hand,
      "", "", c.company?.name ?? "", ...(fin ? [""] : []),
    ]);
    saveCSV("inventory_report.csv", headers, [...assetRows, ...consumableRows]);
  }

  // تصدير الصيانة — عمود التكلفة (مالي) يُحذف لغير المصرّح لهم (نفس بوابة fin القائمة).
  function exportMaintenance() {
    const mh = t.maintenance.headers;
    const headers = [rep.export.tag, mh.problem, mh.status, mh.date, ...(fin ? [mh.cost] : [])];
    saveCSV("maintenance_report.csv", headers, ((data?.maintenance ?? []) as any[]).map((m) => [
      m.asset?.asset_tag ?? m.asset?.name ?? "",
      m.problem_description ?? "",
      t.stage[m.workflow_stage as keyof typeof t.stage] ?? t.maintStatus[m.status as keyof typeof t.maintStatus] ?? m.status,
      m.reported_at ? formatDate(m.reported_at, lang) : "",
      ...(fin ? [m.cost ?? ""] : []),
    ]));
  }

  function exportCustody() {
    saveCSV(
      "custody_summary.csv",
      [rep.custodyTab.employee, rep.custodyTab.custodyCount],
      byEmployee.map((group) => [group.label, group.items.length]),
    );
  }

  // تصدير النشاط — لا أعمدة مالية.
  function exportActivity() {
    const cc = rep.csvCol;
    const headers = [cc.operation, cc.item, cc.actor, cc.time];
    saveCSV("activity_report.csv", headers, activity.map((e) => [
      ops[e.op] ?? e.op, e.entityLabel ?? "", e.actor ?? "", formatDateTime(e.at, lang),
    ]));
  }

  // تصدير الملخّص التنفيذي — صفوف مؤشر/قيمة؛ الصفوف المالية للمصرّح لهم فقط.
  async function exportExecutive() {
    const counts = await report.prepareExecutiveExport();
    const cc = rep.csvCol;
    const rows: (string | number)[][] = [
      [rep.kpi.totalAssets, kpi.total],
      [rep.kpi.reserved, kpi.reserved],
      [rep.kpi.available, kpi.available],
      [rep.kpi.inMaintenance, kpi.maint],
      [rep.kpi.openMaint, kpi.openM],
      [rep.requestsTab.total, counts.total],
      [rep.requestsTab.overdue, counts.overdue],
    ];
    if (fin) {
      rows.push([
        rep.kpi.assetValue,
        financialExportValue(assetValueMetric, lang),
      ]);
      rows.push([
        t.depreciation.totalCurrent,
        financialExportValue(currentValueMetric, lang),
      ]);
      rows.push([
        rep.maintTab.totalCost,
        financialExportValue(maintenanceCostMetric, lang),
      ]);
    }
    saveCSV("executive_summary.csv", [cc.metric, cc.value], rows);
  }

  const showFilters = ASSET_FILTER_TABS.includes(tab) || (tab === "inventory" && inventoryKind === "asset");

  // زر التصدير الرئيسي يتغيّر حسب التبويب.
  const exportConfig: Partial<Record<Tab, { label: string; fn: () => void | Promise<void> }>> = {
    executive: { label: rep.exportExecutive, fn: exportExecutive },
    requests: { label: rep.requestsTab.exportRequests, fn: exportRequests },
    inventory: { label: rep.exportInventory, fn: exportInventory },
    maintenance: { label: rep.maintTab.exportMaintenance, fn: exportMaintenance },
    custody: { label: rep.custodyTab.exportCustody, fn: exportCustody },
    alerts: { label: tnf.exportAlerts, fn: exportAlerts },
    activity: { label: rep.activityTab.exportActivity, fn: exportActivity },
  };
  const primaryExport = exportConfig[tab];
  // تعطيل زر التصدير عند عدم وجود بيانات في التبويب الحالي (تفادي ملفات فارغة مضلِّلة).
  const exportEmpty: Partial<Record<Tab, boolean>> = {
    executive: false, // Request counts are read on demand rather than fetching all request rows.
    requests: reportRequests.length === 0,
    inventory: (inventoryKind === "asset" ? assets.length : inventoryKind === "consumable" ? cons.all.length : assets.length + cons.all.length) === 0,
    maintenance: (data.maintenance?.length ?? 0) === 0,
    custody: byEmployee.length === 0,
    alerts: operationalAlerts.length === 0,
    activity: activity.length === 0,
  };
  const primaryDisabled = !!exportEmpty[tab] || reportLoading || !!reportError || exporting;

  // ---- Ledger KPI bands (عرض فقط — الخلايا المالية تُضاف للمخوّلين ماليًا فقط كما كانت) ----
  const L = rep.ledger;
  const pctOfTotal = (n: number) => (kpi.total ? Math.round((n / kpi.total) * 100) : 0);
  const executiveKpis: ReportKpi[] = [
    { key: "total", label: rep.kpi.totalAssets, value: kpi.total, hint: L.withinFilters },
    ...(fin ? [{ key: "value", label: rep.kpi.assetValue, metric: assetValueMetric, wide: true }] : []),
    { key: "available", label: rep.kpi.available, value: kpi.available, tone: "ok", hint: <><span className="tabular-nums">{pctOfTotal(kpi.available)}%</span> {L.ofTotal}</> },
    { key: "reserved", label: rep.kpi.reserved, value: kpi.reserved, tone: "res", hint: L.reservedHint },
    { key: "maint", label: rep.kpi.inMaintenance, value: kpi.maint, tone: "warn", hint: L.maintHint },
    {
      key: "decisions", label: rep.kpi.decisionsRequired, value: decisionCount, tone: decisionCount > 0 ? "bad" : undefined,
      href: "/alerts", hint: <span className="font-semibold text-brand-ink">{rep.decisions.openActionCenter}</span>,
    },
  ];
  const financialKpis: ReportKpi[] = [
    { key: "purchase", label: t.depreciation.totalPurchase, metric: assetValueMetric },
    { key: "current", label: t.depreciation.totalCurrent, metric: currentValueMetric },
    { key: "depreciation", label: t.depreciation.totalDepreciation, metric: depreciationMetric },
  ];
  const financialIncomplete = fin && [
    assetValueMetric,
    currentValueMetric,
    depreciationMetric,
  ].some((metric) => metric.state !== "available");

  const requestKpis: ReportKpi[] = [
    { key: "total", label: rep.requestsTab.total, value: reqStats.total },
    { key: "review", label: rep.requestsTab.underReview, value: reqStats.review, tone: "info" },
    { key: "approved", label: rep.requestsTab.approved, value: reqStats.approved },
    { key: "out", label: rep.requestsTab.delivered, value: reqStats.out, tone: "res" },
    { key: "overdue", label: rep.requestsTab.overdue, value: reqStats.overdue, tone: reqStats.overdue > 0 ? "bad" : undefined },
    { key: "completed", label: rep.requestsTab.completed, value: reqStats.completed, tone: "ok" },
    { key: "rejected", label: rep.requestsTab.rejected, value: reqStats.rejected, tone: "neu" },
    ...(fin ? [{ key: "value", label: rep.requestsTab.totalValue, metric: requestValueMetric }] : []),
  ];
  const requestStatusRows = countBy(reportRequests, (r: any) => r.status).map(([k, n]) => ({
    key: k, label: (t.requestStatus as Record<string, string>)[k] ?? k, n, tone: REQUEST_STATUS_TONE[k] ?? "neu",
  }));
  const employeeRequests = reqRows.filter((r) => r.beneficiary_type === "employee").length;
  const requestSourceCounts = { all: reqRows.length, employee: employeeRequests, customer: reqRows.length - employeeRequests };

  const maintenanceKpis: ReportKpi[] = [
    { key: "open", label: rep.maintTab.openInProgress, value: maint.open, tone: "warn" },
    { key: "completed", label: rep.maintTab.completed, value: maint.completed, tone: "ok" },
    { key: "overdue", label: rep.maintTab.overdue, value: maint.overdue.length, tone: maint.overdue.length > 0 ? "bad" : undefined },
    ...(fin ? [{ key: "cost", label: rep.maintTab.totalCost, metric: maintenanceCostMetric }] : []),
  ];

  const filters = showFilters ? (
    <ReportFilters
      value={f}
      onChange={set}
      onClear={clearFilters}
      count={assets.length}
      options={{
        categories: data.categories.map((c: any) => ({ value: c.id, label: nameOf(c, lang) })),
        statuses: ALL_STATUSES.map((s) => ({ value: s, label: t.status[s] })),
        locations: data.locations.map((l: any) => ({ value: l.id, label: nameOf(l, lang) })),
        departments: data.departments.map((d: any) => ({ value: d.id, label: nameOf(d, lang) })),
        companies: data.companies.map((c: any) => ({ value: c.id, label: c.name })),
      }}
    />
  ) : null;

  return (
    <div>
      <PageHeader title={rep.title} description={rep.subtitle} actions={
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button variant="outline" onClick={() => window.print()} disabled={reportLoading || !!reportError}><Printer aria-hidden="true" />{L.print}</Button>
          {/* إظهار تدريجي: أزرار CSV من مستوى 70 — التجريد المالي داخل ملفات التصدير يبقى بالدور كما هو */}
          {csvAllowed && tab === "inventory" && inventoryKind === "asset" && <Button variant="outline" onClick={() => void runExport(exportCategory)} disabled={assets.length === 0 || primaryDisabled} title={assets.length === 0 ? t.common.noExportData : undefined}><Download aria-hidden="true" />{rep.exportCategory}</Button>}
          {csvAllowed && primaryExport && <Button onClick={() => void runExport(primaryExport.fn)} disabled={primaryDisabled} title={exportEmpty[tab] ? t.common.noExportData : undefined} aria-busy={exporting}><Download aria-hidden="true" />{exporting ? rep.exporting : primaryExport.label}</Button>}
        </div>
      } />

      <Tabs<Tab>
        items={visibleTabs.map((k) => ({ key: k, label: rep.tabs[k] }))}
        value={tab}
        onChange={setTab}
        label={rep.title}
        idBase="reports"
        className="mb-6 print:hidden"
      />

      <div className="mb-6 print:hidden">
        <PrivateSavedViews actorId={reportEnabled ? userId : null} surface="reports"
          identityKey={`${role ?? ""}|${approvalStatus}|${visibleTabs.join(",")}`}
          filters={reportViewValues(viewState)} normalize={normalizeSavedView}
          onApply={(values) => updateView(parseView(filterParams(values)))} />
      </div>

      <div role="tabpanel" id={panelId("reports", tab)} aria-labelledby={tabId("reports", tab)} aria-busy={reportLoading} className="space-y-6">
        {reportError ? (
          <div role="alert" className="rounded-control border border-bad/20 bg-bad-soft p-5 text-bad">
            <p className="font-semibold">{rep.loadError}</p>
            <p className="mt-1 text-sm">{friendlyErrorStrict(reportError, lang)}</p>
            <Button variant="outline" onClick={retryReport} className="mt-3">{rep.retry}</Button>
          </div>
        ) : reportLoading ? <ReportsSkeleton /> : <>
        {tab !== "inventory" && filters}

        {/* ---------------- EXECUTIVE ---------------- */}
        {tab === "executive" && ExecutiveTab && (
          <ExecutiveTab
            kpis={executiveKpis}
            financialKpis={fin ? financialKpis : undefined}
            financialNotice={financialIncomplete ? assetValueMetric : null}
            assets={assets}
            byCategory={byCategory}
            byLocation={byLocation}
            risks={[
              { key: "inMaintenance", label: rep.risksLabels.inMaintenance, n: risk.maintenanceAttention.length },
              { key: "overdueMaint", label: rep.risksLabels.overdueMaint, n: maint.overdue.length },
              { key: "longMaint", label: rep.risksLabels.longMaint, n: maint.long.length },
            ]}
            onClearFilters={clearFilters}
          />
        )}

        {/* ---------------- OPERATIONAL ALERTS (تنبيهات تشغيلية) ---------------- */}
        {tab === "alerts" && AlertsTab && (
          <AlertsTab
            counts={[
              { key: "inMaintenance", label: rep.risksLabels.inMaintenance, n: risk.maintenanceAttention.length },
              { key: "longMaint", label: rep.risksLabels.longMaint, n: maint.long.length },
              { key: "overdueRequest", label: tnf.types.overdue_request, n: opAlerts.filter((a) => a.type === "overdue_request").length },
            ]}
            alerts={operationalAlerts}
            inAppEnabled={notifSettings.in_app_enabled}
          />
        )}

        {/* ---------------- REQUESTS (طلبات العملاء) ---------------- */}
        {tab === "requests" && RequestsTab && (
          <RequestsTab
            kpis={requestKpis}
            source={requestSource}
            onSourceChange={setRequestSource}
            sourceCounts={requestSourceCounts}
            statusRows={requestStatusRows}
            trend={reqStats.trend}
            recent={reqStats.recent}
            partyName={(r) => requestPartyName(r, rep2.partyEmployee)}
          />
        )}

        {/* ---------------- INVENTORY: ASSETS + CONSUMABLES ---------------- */}
        {tab === "inventory" && InventoryTab && (
          <InventoryTab
            kind={inventoryKind}
            onKindChange={setInventoryKind}
            lowOnly={viewState.low === "1"}
            onLowOnlyChange={(value) => updateView({ low: value ? "1" : "" })}
            filters={filters}
            fin={fin}
            kpi={kpi}
            assets={assets}
            byCategory={byCategory}
            byLocation={byLocation}
            byDepartment={byDepartment}
            byCompany={byCompany}
            assetMetricFor={assetMetricFor}
            financialQuality={financialQuality}
            qualityLoaded={report.quality.loaded}
            qualityLoading={report.quality.loading}
            qualityError={report.quality.error}
            qualityExporting={report.quality.exporting || exporting}
            qualityExportAllowed={csvAllowed}
            onLoadMoreQuality={report.loadMoreQuality}
            onRetryQuality={report.retryQuality}
            onExportQuality={() => void runExport(exportQualityQueue)}
            cons={cons}
          />
        )}

        {/* ---------------- MAINTENANCE ---------------- */}
        {tab === "maintenance" && MaintenanceTab && <MaintenanceTab kpis={maintenanceKpis} maint={maint} fin={fin} />}

        {/* ---------------- CUSTODY ---------------- */}
        {tab === "custody" && CustodyTab && <CustodyTab custodyCount={custodyAssets.length} byEmployee={byEmployee} />}

        {/* ---------------- ACTIVITY ---------------- */}
        {tab === "activity" && ActivityTab && <ActivityTab activity={activity} insights={actInsights} />}
        </>}
      </div>
      {toast && <Toast toast={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

// ---------- helpers ----------
function groupBy(items: any[], keyFn: (a: any) => any, unspecified: string) {
  const map = new Map<string, { label: string; items: any[] }>();
  for (const a of items) {
    const k = keyFn(a);
    const id = k?.id ?? "—";
    // Related employees use full_name/full_name_ar while the reference tables
    // use name/name_ar. Supporting both prevents valid custody relationships
    // from being shown as anonymous “—” rows.
    const label = k ? (k.full_name_ar ?? k.full_name ?? k.name_ar ?? k.name ?? "—") : unspecified;
    if (!map.has(id)) map.set(id, { label, items: [] });
    map.get(id)!.items.push(a);
  }
  return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length);
}

function countBy(items: any[], keyFn: (a: any) => any): [string, number][] {
  const m: Record<string, number> = {};
  for (const x of items) { const k = keyFn(x) ?? "—"; m[k] = (m[k] ?? 0) + 1; }
  return (Object.entries(m) as [string, number][]).sort((a, b) => b[1] - a[1]);
}


function topMaintained(maint: any[]) {
  const m = new Map<string, {
    tag: string;
    count: number;
    recordedCount: number;
    recordedCost: number;
  }>();
  for (const r of maint) {
    const tag = r.asset?.asset_tag ?? "—";
    if (!m.has(tag)) {
      m.set(tag, { tag, count: 0, recordedCount: 0, recordedCost: 0 });
    }
    const e = m.get(tag)!;
    e.count++;
    if (r.cost_recorded === true && r.cost != null) {
      e.recordedCount++;
      e.recordedCost += Number(r.cost);
    }
  }
  return Array.from(m.values())
    .map((row) => ({
      tag: row.tag,
      count: row.count,
      cost: row.recordedCount === row.count ? row.recordedCost : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function formatFinancialAmount(value: number, currency: string, lang: string) {
  return new Intl.NumberFormat(lang === "ar" ? "ar-SA" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}


function financialExportValue(metric: FinancialMetric, lang: string) {
  if (
    metric.state !== "available"
    || metric.value == null
    || metric.currency == null
  ) {
    return `INCOMPLETE | coverage=${metric.coveragePct}% | used=${metric.usedRecords} | excluded=${metric.excludedRecords} | as_of=${metric.asOf}`;
  }
  return `${formatFinancialAmount(metric.value, metric.currency, lang)} | coverage=${metric.coveragePct}% | used=${metric.usedRecords} | excluded=${metric.excludedRecords} | as_of=${metric.asOf}`;
}



function requestPartyName(r: RequestListRow, employeeFallback: string): string {
  if (r.beneficiary_type === "employee") {
    return r.beneficiary_employee?.full_name_ar ?? r.beneficiary_employee?.full_name ?? employeeFallback;
  }
  return r.customer?.name ?? r.customer_name_snapshot ?? "—";
}

function repLabel(prefix: string, entity: any): string {
  const label = entity?.asset_tag ?? entity?.name ?? entity?.id;
  return label ? `${prefix} — ${label}` : prefix;
}
