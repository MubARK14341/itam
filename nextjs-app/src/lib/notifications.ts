// ============================================================================
//  نظام التنبيهات الداخلي (In-App Notifications / Alerts) — قراءة فقط، بلا مالية.
//  • الإعدادات تُخزَّن في جدول notification_settings (صف واحد id='main') — إضافي وآمن.
//  • التنبيهات تُحسب ديناميكيًا في طبقة التطبيق من بيانات موجودة أصلًا
//    (consumables / requests / maintenance_records) — لا تُخزَّن، لا Scheduled Jobs،
//    لا تعديل مخزون، لا تغيير حالات، لا إرسال إيميل.
//  • لا يظهر أي رقم مالي (تكلفة/سعر/فاتورة) في أي تنبيه — اسم العنصر/الطلب فقط.
// ============================================================================
import { createClient } from "@/lib/supabase/client";
import { interpolate, type Dict } from "@/lib/i18n";
import type { Role } from "@/lib/session";
import { dateKeyInTimeZone } from "@/lib/format";

const supabase = () => createClient();

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------
export interface NotificationSettings {
  low_stock_enabled: boolean;
  out_of_stock_enabled: boolean;
  overdue_requests_enabled: boolean;
  pending_approval_enabled: boolean;
  maintenance_due_enabled: boolean;
  overdue_grace_days: number;
  maintenance_due_window_days: number;
  in_app_enabled: boolean;
  email_enabled: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  low_stock_enabled: true,
  out_of_stock_enabled: true,
  overdue_requests_enabled: true,
  pending_approval_enabled: true,
  maintenance_due_enabled: true,
  overdue_grace_days: 0,
  maintenance_due_window_days: 14,
  in_app_enabled: true,
  email_enabled: false, // الإيميل غير مفعّل في هذه المرحلة (قريبًا) — لا إرسال فعلي.
};

const SETTINGS_ID = "main";
const SETTINGS_COLS =
  "low_stock_enabled,out_of_stock_enabled,overdue_requests_enabled,pending_approval_enabled," +
  "maintenance_due_enabled,overdue_grace_days,maintenance_due_window_days,in_app_enabled,email_enabled";

// يقرأ الإعدادات؛ يتدرّج بأمان إلى القيم الافتراضية إن غاب الجدول/الصف أو مُنعت القراءة.
export async function getNotificationSettings(): Promise<NotificationSettings> {
  try {
    const { data, error } = await supabase()
      .from("notification_settings").select(SETTINGS_COLS).eq("id", SETTINGS_ID).maybeSingle();
    if (error || !data) return { ...DEFAULT_NOTIFICATION_SETTINGS };
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(data as Partial<NotificationSettings>) };
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

// تحديث الإعدادات (admin/it_manager فقط عبر RLS). updated_by/updated_at يُختمان بالخادم.
export async function updateNotificationSettings(p: NotificationSettings): Promise<string | null> {
  const { error } = await supabase().from("notification_settings").upsert({
    id: SETTINGS_ID,
    low_stock_enabled: p.low_stock_enabled,
    out_of_stock_enabled: p.out_of_stock_enabled,
    overdue_requests_enabled: p.overdue_requests_enabled,
    pending_approval_enabled: p.pending_approval_enabled,
    maintenance_due_enabled: p.maintenance_due_enabled,
    overdue_grace_days: Math.max(0, Math.trunc(Number(p.overdue_grace_days) || 0)),
    maintenance_due_window_days: Math.max(0, Math.trunc(Number(p.maintenance_due_window_days) || 0)),
    in_app_enabled: p.in_app_enabled,
    email_enabled: false, // يُفرض false دائمًا — لا إرسال إيميل في هذه المرحلة.
  });
  return error?.message ?? null;
}

// ---------------------------------------------------------------------------
// أنواع التنبيه الموحّد
// ---------------------------------------------------------------------------
export type AlertType =
  | "overdue_request" | "pending_approval" | "maintenance_due";
export type AlertSeverity = "info" | "warning" | "critical";

export interface NotificationAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  description: string;
  href?: string;
  entityType?: "consumable" | "request" | "maintenance" | "asset";
  entityId?: string;
  sortDate?: string | null; // لترتيب ثابت داخل نفس الشدة (لا يُعرض)
}

// أشكال المدخلات — متوافقة بنيويًا مع الصفوف المجلوبة في لوحة التحكم/التقارير.
export interface NotifConsumable {
  id: string; name: string; unit: string;
  quantity_on_hand: number | null; reorder_level: number | null;
}
export interface NotifRequest {
  id: string; request_number: string; status: string; request_type?: string;
  return_date: string | null; created_at?: string | null;
  customer?: { name: string | null } | null; customer_name_snapshot?: string | null;
}
export interface NotifMaintenance {
  id: string; status?: string | null; workflow_stage?: string | null;
  next_due_date: string | null;
  asset?: { id: string | null; asset_tag: string | null; name: string | null } | null;
}
export interface NotificationInputs {
  consumables: NotifConsumable[];
  requests: NotifRequest[];
  maintenance: NotifMaintenance[];
}

// ---------- أدوات تاريخ (اليوم التشغيلي بتوقيت الرياض) ----------
export function todayStr(): string { return dateKeyInTimeZone(); }
function shiftDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00Z").getTime();
  const b = new Date(toIso + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((b - a) / 864e5));
}

// الطلبات «خارج المخزن» المؤهّلة للتأخير (تُطابق OUT_STATUSES في requests.ts + حالة overdue إن وُجدت).
const OUT_STATUSES = new Set(["delivered", "partially_returned", "overdue"]);
// مراحل صيانة منتهية لا تُعتبر «مستحقّة».
const DONE_MAINT = new Set(["completed", "cancelled", "unrepairable"]);

const canApprove = (role: Role) => role === "admin" || role === "it_manager";

// ============================================================================
//  الدالة النقية: تبني قائمة التنبيهات الموحّدة من المدخلات + الإعدادات + الترجمة + الدور.
//  RBAC: pending_approval يُعرض للمديرين فقط (admin/it_manager). بقية التنبيهات تشغيلية للجميع.
//  لا تُدرج أي قيمة مالية. تُرتَّب: critical ثم warning ثم info، ثم بالأقدم تاريخًا.
// ============================================================================
export function buildNotificationAlerts(
  inputs: NotificationInputs,
  settings: NotificationSettings,
  t: Dict,
  role: Role,
): NotificationAlert[] {
  if (!settings.in_app_enabled) return [];
  const tn = t.notifications;
  const it = tn.item;
  const today = todayStr();
  const alerts: NotificationAlert[] = [];

  // ---------- الطلبات: متأخرة / بانتظار الموافقة ----------
  const overdueBefore = shiftDays(today, -Math.max(0, settings.overdue_grace_days || 0));
  for (const r of inputs.requests) {
    const customer = r.customer?.name ?? r.customer_name_snapshot ?? it.unknownCustomer;
    // متأخّر: يُحسب ديناميكيًا فقط (لا نغيّر status إلى overdue، ولا نحتاج Job).
    if (settings.overdue_requests_enabled && OUT_STATUSES.has(r.status) && r.return_date && r.return_date < overdueBefore) {
      const days = daysBetween(r.return_date, today);
      alerts.push({
        id: `ovr-${r.id}`, type: "overdue_request", severity: "critical",
        title: interpolate(it.overdueTitle, { number: r.request_number }),
        description: interpolate(it.overdueDesc, { customer, days }),
        href: `/requests/${r.id}`, entityType: "request", entityId: r.id, sortDate: r.return_date,
      });
    }
    // بانتظار الموافقة: للمديرين فقط. الشدة ترتفع مع عمر الطلب.
    if (settings.pending_approval_enabled && canApprove(role) && r.status === "under_review") {
      const age = r.created_at ? daysBetween(r.created_at.slice(0, 10), today) : 0;
      alerts.push({
        id: `pnd-${r.id}`, type: "pending_approval", severity: age >= 3 ? "warning" : "info",
        title: interpolate(it.pendingTitle, { number: r.request_number }),
        description: interpolate(it.pendingDesc, { customer }),
        href: `/requests/${r.id}`, entityType: "request", entityId: r.id, sortDate: r.created_at ?? null,
      });
    }
  }

  // ---------- الصيانة المستحقّة/المتأخرة (فقط إن توفّر next_due_date) ----------
  if (settings.maintenance_due_enabled) {
    const dueWithin = shiftDays(today, Math.max(0, settings.maintenance_due_window_days || 0));
    for (const m of inputs.maintenance) {
      if (!m.next_due_date) continue;
      const status = String(m.status ?? m.workflow_stage ?? "");
      if (DONE_MAINT.has(status)) continue;
      const tag = m.asset?.asset_tag ?? m.asset?.name ?? "—";
      if (m.next_due_date < today) {
        alerts.push({
          id: `mnt-${m.id}`, type: "maintenance_due", severity: "critical",
          title: interpolate(it.maintOverdueTitle, { tag }),
          description: interpolate(it.maintDesc, { date: m.next_due_date }),
          href: `/maintenance?m=${m.id}`, entityType: "maintenance", entityId: m.id, sortDate: m.next_due_date,
        });
      } else if (m.next_due_date <= dueWithin) {
        alerts.push({
          id: `mnt-${m.id}`, type: "maintenance_due", severity: "warning",
          title: interpolate(it.maintDueSoonTitle, { tag }),
          description: interpolate(it.maintDesc, { date: m.next_due_date }),
          href: `/maintenance?m=${m.id}`, entityType: "maintenance", entityId: m.id, sortDate: m.next_due_date,
        });
      }
    }
  }

  const SEV: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort(
    (a, b) => SEV[a.severity] - SEV[b.severity] || String(a.sortDate ?? "").localeCompare(String(b.sortDate ?? "")),
  );
}

// عدّاد لكل نوع (للملخّص في لوحة التحكم/التقارير).
export function countByType(alerts: NotificationAlert[]): Record<AlertType, number> {
  const c: Record<AlertType, number> = {
    overdue_request: 0, pending_approval: 0, maintenance_due: 0,
  };
  for (const a of alerts) c[a.type]++;
  return c;
}
