// ============================================================================
//  طبقة منطق لوحة التحكم التنفيذية — تجميع وفلترة client-side (بلا Migration).
//  الجلب الخام في queries.ts:getDashboardData ثم selectDashboard(raw, filters).
//  كل البيانات حقيقية من Supabase؛ لا توجد لقطات تاريخية فلا نعرض أي نِسب تغيّر.
// ============================================================================
import type { AssetStatus } from "@/lib/types";
import { STATUS_AR } from "@/lib/format";
import type { Dict } from "@/lib/i18n";
import {
  isAssetMaintenanceAttention, isAssetMissingQr, isMaintenanceOpenNoAction,
  isMaintenanceLongOpen,
} from "@/lib/alert-predicates";

// ---------- الفلاتر ----------
export type PeriodKey = "30d" | "90d" | "12m" | "all";
export interface DashboardFilters {
  period: PeriodKey;
  location: string;   // location id
  department: string; // department id
  status: string;     // asset status
  category: string;   // category id
}
export const DEFAULT_FILTERS: DashboardFilters = { period: "90d", location: "", department: "", status: "", category: "" };
export const PERIOD_AR: Record<PeriodKey, string> = { "30d": "آخر ٣٠ يومًا", "90d": "آخر ٩٠ يومًا", "12m": "آخر ١٢ شهرًا", all: "كل الفترات" };
const PERIOD_DAYS: Record<PeriodKey, number | null> = { "30d": 30, "90d": 90, "12m": 365, all: null };

// ---------- المنطقة الزمنية: الرياض UTC+3 ----------
const RIYADH = "Asia/Riyadh";
const fmtMonth = new Intl.DateTimeFormat("en-CA", { timeZone: RIYADH, year: "numeric", month: "2-digit" });

// مفتاح الشهر «YYYY-MM» بتوقيت الرياض
function riyadhMonthKey(d: Date): string {
  const p = fmtMonth.formatToParts(d);
  const y = p.find((x) => x.type === "year")!.value;
  const m = p.find((x) => x.type === "month")!.value;
  return `${y}-${m}`;
}

// ---------- الأنواع المُجمّعة ----------
export interface Alert {
  key: string; title: string; desc: string;
  severity: "low" | "medium" | "high" | "critical";
  count: number; href: string | null;
}
export interface DashboardData {
  kpis: {
    total: number; available: number; reserved: number; in_maintenance: number; bad: number;
    assetValue: number | null; maintCost: number | null; criticalAlerts: number;
    // تفصيل أسباب «تحتاج متابعة» (أعداد فقط، بلا مالية) — لعرض السبب لا مجرد رقم.
  };
  // StatusStrip §1 — 4 بطاقات حالة (عدد + نسبة من الإجمالي) مع رابط قائمة أصول مفلترة.
  statusStrip: { key: string; count: number; pct: number; href: string }[];
  // MaintenanceAging §3 — أعمار البلاغات المفتوحة (open/in_progress) من تاريخ البلاغ.
  maintAging: { lt3: number; d3to7: number; gt7: number; total: number };
  // DataQualityCard §2 — نِسب اكتمال فقط (بلا مالية)؛ كل بند: النسبة + عدد النواقص + رابط معالجة.
  dataQuality: {
    assetTag: { pct: number; missing: number; href: string };
    model: { pct: number; missing: number; href: string };
    company: { pct: number; missing: number; href: string };
  };
  statusDist: { key: AssetStatus; label: string; count: number }[];
  categoryDist: { label: string; count: number }[];
  locationDist: { label: string; count: number }[];
  maintByMonth: { key: string; label: string; cost: number | null }[];
  maintByProblem: [string, number][];
  topMaintCost: any[];
  topMaintFreq: { tag: string; id: string | null; count: number; cost: number | null }[];
  alerts: Alert[];
  recentAssets: any[];
  recentMaint: any[];
  recentTxns: any[];
  filteredAssetCount: number;
}

const nm = (x: any) => x?.name_ar ?? x?.name ?? null;

// ---------- التجميع النقي ----------
export function selectDashboard(raw: {
  assets: any[]; consumables: any[]; maintenance: any[]; txns: any[];
}, f: DashboardFilters, t: Dict): DashboardData {
  const now = Date.now();
  const days = PERIOD_DAYS[f.period];
  const cutoff = days == null ? null : now - days * 864e5;
  const inPeriod = (iso: string | null | undefined) => {
    if (cutoff == null) return true;
    if (!iso) return false;
    return new Date(iso).getTime() >= cutoff;
  };

  // فلترة الأصول حسب (الموقع/القسم/الحالة/التصنيف) — حالة الأصل لقطة حالية
  const assets = raw.assets.filter((a) => {
    if (f.category && a.category?.id !== f.category) return false;
    if (f.location && a.location?.id !== f.location) return false;
    if (f.department && a.department?.id !== f.department) return false;
    if (f.status && a.status !== f.status) return false;
    return true;
  });
  const assetIds = new Set(assets.map((a) => a.id));

  const byStatus = (s: AssetStatus) => assets.filter((a) => a.status === s).length;

  // الصيانة: مرتبطة بالأصول المفلترة + ضمن الفترة (حسب تاريخ البلاغ)
  const maintAll = raw.maintenance.filter((m) => !f.category && !f.location && !f.department && !f.status ? true : assetIds.has(m.asset?.id ?? m.asset_id));
  const maint = maintAll.filter((m) => inPeriod(m.reported_at ?? m.created_at));

  // ---------- KPIs ----------
  const completeAssetValues = assets.length > 0
    && assets.every((asset) => asset.purchase_cost != null);
  const assetValue = completeAssetValues
    ? assets.reduce((sum, asset) => sum + Number(asset.purchase_cost), 0)
    : null;
  const completeMaintenanceCosts = maint.length > 0
    && maint.every((record) => record.cost_recorded === true && record.cost != null);
  const maintCost = completeMaintenanceCosts
    ? maint.reduce((sum, record) => sum + Number(record.cost), 0)
    : null;

  // الشروط من المصدر الموحد (alert-predicates.ts) — نفس الشرط حرفيًا في قوائم العمل.
  // ---------- التوزيعات ----------
  const statusDist = (Object.keys(STATUS_AR) as AssetStatus[])
    .map((s) => ({ key: s, label: t.status[s], count: byStatus(s) }))
    .filter((x) => x.count > 0).sort((a, b) => b.count - a.count);

  const catMap = new Map<string, number>();
  for (const a of assets) { const k = nm(a.category) ?? t.unspecified; catMap.set(k, (catMap.get(k) ?? 0) + 1); }
  const categoryDist = Array.from(catMap.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  const locMap = new Map<string, number>();
  for (const a of assets) { const k = nm(a.location) ?? t.unspecified; locMap.set(k, (locMap.get(k) ?? 0) + 1); }
  const locationDist = Array.from(locMap.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 8);

  // تكلفة الصيانة خلال آخر ١٢ شهرًا (بتوقيت الرياض) — بيانات حقيقية بلا اختلاق
  const monthAxis: {
    key: string;
    label: string;
    cost: number | null;
    records: number;
    recorded: number;
  }[] = [];
  const base = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const key = riyadhMonthKey(d);
    monthAxis.push({ key, label: t.months[d.getMonth()], cost: 0, records: 0, recorded: 0 });
  }
  const monthIdx = new Map(monthAxis.map((m, i) => [m.key, i]));
  for (const m of maintAll) {
    const when = m.reported_at ?? m.created_at;
    if (!when) continue;
    const idx = monthIdx.get(riyadhMonthKey(new Date(when)));
    if (idx != null) {
      monthAxis[idx].records++;
      if (m.cost_recorded === true && m.cost != null) {
        monthAxis[idx].recorded++;
        const priorCost = monthAxis[idx].cost;
        monthAxis[idx].cost = typeof priorCost === "number"
          ? priorCost + Number(m.cost)
          : Number(m.cost);
      }
    }
  }
  for (const month of monthAxis) {
    if (month.records === 0 || month.recorded !== month.records) month.cost = null;
  }

  // الصيانة حسب نوع المشكلة — من كامل الصيانة المرتبطة (لا نُخفي السجلات القديمة خارج الفترة،
  // اتساقًا مع صفحة الصيانة ومع «أعلى تكلفة/أكثر تكرارًا»؛ يتفادى «لا توجد سجلات» الكاذبة).
  const probMap = new Map<string, number>();
  for (const m of maintAll) { if (!m.problem_type) continue; const l = (t.problemType as Record<string, string>)[m.problem_type] ?? m.problem_type; probMap.set(l, (probMap.get(l) ?? 0) + 1); }
  const maintByProblem = Array.from(probMap.entries()).sort((a, b) => b[1] - a[1]) as [string, number][];

  // أعلى تكلفة + أكثر تكرارًا (من كامل الصيانة المرتبطة)
  const topMaintCost = [...maintAll]
    .filter((record) => record.cost_recorded === true && record.cost != null)
    .sort((a, b) => Number(b.cost) - Number(a.cost))
    .slice(0, 10);
  const freqMap = new Map<string, {
    tag: string;
    id: string | null;
    count: number;
    recorded: number;
    cost: number;
  }>();
  for (const m of maintAll) {
    const tag = m.asset?.asset_tag ?? "—";
    if (!freqMap.has(tag)) {
      freqMap.set(tag, {
        tag,
        id: m.asset?.id ?? null,
        count: 0,
        recorded: 0,
        cost: 0,
      });
    }
    const e = freqMap.get(tag)!;
    e.count++;
    if (m.cost_recorded === true && m.cost != null) {
      e.recorded++;
      e.cost += Number(m.cost);
    }
  }
  const topMaintFreq = Array.from(freqMap.values())
    .map(({ recorded, ...row }) => ({
      ...row,
      cost: recorded === row.count ? row.cost : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // الصيانة المفتوحة الطويلة / بلا إجراء / عالية التكلفة (الشروط من المصدر الموحد)
  const longMaint = maintAll.filter((m) => isMaintenanceLongOpen(m, now));
  const openNoAction = maintAll.filter(isMaintenanceOpenNoAction);

  // ---------- التنبيهات ----------
  const maintenanceAttention = assets.filter(isAssetMaintenanceAttention);
  const noQr = assets.filter(isAssetMissingQr);

  // روابط الكروت = قوائم عمل مفلترة بنفس الشرط (لا تقارير قراءة فقط) — الرقم يطابق القائمة.
  // استثناءان تحليليان يبقيان على التقارير: high_cost (مالي) و frequent (إحصائي تجميعي).
  const al = t.dashboard.alerts;
  const rawAlerts: Alert[] = [
    { key: "long_maint", title: al.long_maint.title, desc: al.long_maint.desc, severity: "high", count: longMaint.length, href: "/maintenance?view=long_maint" },
    { key: "maintenance_attention", title: al.maintenance_attention.title, desc: al.maintenance_attention.desc, severity: "high", count: maintenanceAttention.length, href: "/assets?view=maintenance_attention" },
    { key: "open_no_action", title: al.open_no_action.title, desc: al.open_no_action.desc, severity: "medium", count: openNoAction.length, href: "/maintenance?view=no_action" },
    { key: "no_qr", title: al.no_qr.title, desc: al.no_qr.desc, severity: "low", count: noQr.length, href: "/assets?view=no_qr" },
  ];
  const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  const alerts = rawAlerts.filter((a) => a.count > 0).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count);
  // يشمل critical + high عمدًا (التسمية في الواجهة: «تنبيهات حرجة وعالية»)
  const criticalAlerts = alerts.filter((a) => a.severity === "critical" || a.severity === "high").length;

  // ---------- جداول حديثة ----------
  const recentAssets = [...assets].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))).slice(0, 5);
  // «آخر الصيانة» تُعرض من كامل الصيانة المرتبطة (لا الفترة) حتى لا تظهر «لا توجد سجلات صيانة»
  // بينما توجد سجلات مفتوحة قديمة — اتساقًا مع صفحة الصيانة وجاهزية التجربة.
  const recentMaint = [...maintAll].sort((a, b) => String(b.reported_at ?? "").localeCompare(String(a.reported_at ?? ""))).slice(0, 5);
  const recentTxns = [...raw.txns].filter((t) => inPeriod(t.created_at)).slice(0, 5);

  // ---------- StatusStrip §1 (نبض النظام) ----------
  const total = assets.length;
  const pctOf = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const statusStrip = [
    { key: "available", count: byStatus("available"), pct: pctOf(byStatus("available")), href: "/assets?status=available" },
    { key: "reserved", count: byStatus("reserved"), pct: pctOf(byStatus("reserved")), href: "/assets?status=reserved" },
    { key: "in_maintenance", count: byStatus("in_maintenance"), pct: pctOf(byStatus("in_maintenance")), href: "/assets?status=in_maintenance" },
  ];

  // ---------- MaintenanceAging §3 — أعمار البلاغات المفتوحة (من تاريخ البلاغ، fallback الإنشاء) ----------
  const openLike = maintAll.filter((m) => m.status === "open" || m.status === "in_progress");
  const maintAging = { lt3: 0, d3to7: 0, gt7: 0, total: 0 };
  for (const m of openLike) {
    const when = m.reported_at ?? m.created_at;
    if (!when) continue;
    const ageDays = (now - new Date(when).getTime()) / 864e5;
    maintAging.total++;
    if (ageDays < 3) maintAging.lt3++;
    else if (ageDays <= 7) maintAging.d3to7++;
    else maintAging.gt7++;
  }

  // ---------- DataQualityCard §2 — نِسب اكتمال (بلا مالية) ----------
  const complPct = (missing: number, base: number) => (base ? Math.round(((base - missing) / base) * 100) : 100);
  const tagMissing = assets.filter((asset) => !String(asset.asset_tag ?? "").trim()).length;
  const modelMissing = assets.filter((asset) => !asset.model).length;
  const companyMissing = assets.filter((asset) => !asset.company).length;
  const dataQuality = {
    assetTag: { pct: complPct(tagMissing, total), missing: tagMissing, href: "/assets" },
    model: { pct: complPct(modelMissing, total), missing: modelMissing, href: "/assets" },
    company: { pct: complPct(companyMissing, total), missing: companyMissing, href: "/assets" },
  };

  return {
    kpis: {
      total: assets.length, available: byStatus("available"), reserved: byStatus("reserved"),
      in_maintenance: byStatus("in_maintenance"),
      bad: 0,
      assetValue, maintCost, criticalAlerts,
    },
    statusStrip, maintAging, dataQuality,
    statusDist,
    categoryDist,
    locationDist,
    maintByMonth: monthAxis.map(({ key, label, cost }) => ({ key, label, cost })),
    maintByProblem,
    topMaintCost, topMaintFreq, alerts, recentAssets, recentMaint, recentTxns,
    filteredAssetCount: assets.length,
  };
}
