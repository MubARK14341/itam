// ============================================================================
//  المصدر الموحد لشروط التنبيهات (Shared Alert Predicates) — بلا أي اتصال شبكة.
//  القاعدة المعمارية: شرط واحد فقط لكل تنبيه، يستهلكه:
//    1) عدّ كروت لوحة التحكم (dashboard.ts)
//    2) قوائم العمل المفلترة (?view= في الأصول/المستهلكات/الصيانة/الطلبات)
//    3) مرشّحو مركز الإجراءات (action-center.ts)
//    4) تصدير CSV لقوائم العمل
//  ممنوع تكرار هذه الشروط في أي مكان آخر — الرقم في الكرت يجب أن يطابق القائمة 100%.
//  الشروط منقولة حرفيًا من dashboard.ts (سلوك اليوم) مع تعديلين موثّقين فقط:
//    • no_serial: يستثني الأصول المُعفاة (serial_exempt) — معالجة موثقة بقرار.
//    • maintenance no_action: تعيين فنيّ (technician_id) يُعتبر إجراءً —
//      كل السجلات الحالية بلا فني، فالعدد لا يتغير لحظة النشر.
// ============================================================================

// أشكال بنيوية دنيا (structural) حتى تعمل الشروط على صفوف اللوحة وصفوف الصفحات معًا.
export interface AssetAlertShape {
  status?: string | null;
  location_id?: string | null;
  qr_token?: string | null;
  last_return_condition?: string | null;
  last_return_at?: string | null;
}

export interface MaintenanceAlertShape {
  status?: string | null;
  action_taken?: string | null;
  technician_id?: string | null;
  reported_at?: string | null;
  next_due_date?: string | null;
}

export interface RequestAlertShape {
  status?: string | null;
  return_date?: string | null;
}

// ---------------------------------------------------------------------------
// الأصول
// ---------------------------------------------------------------------------
export const isAssetMaintenanceAttention = (a: AssetAlertShape) => a.status === "in_maintenance";

export const isAssetMissingLocation = (a: AssetAlertShape) => !a.location_id;

export const isAssetMissingQr = (a: AssetAlertShape) => !a.qr_token;

// «جهاز راجع غير سليم يحتاج صيانة»: عاد من طلب بحالة غير سليمة وما زال في الصيانة.
// يستمر حتى يُصلَح (in_maintenance → available فيسقط الشرط). لا يختفي إلا بحل فعلي.
export const isAssetUnsoundReturn = (a: AssetAlertShape) =>
  a.status === "in_maintenance" &&
  (a.last_return_condition === "unsound" || a.last_return_condition === "needs_maintenance");

// تذكير المتابعة (كل يومين): جهاز راجع غير سليم مضى على رجوعه أكثر من يومين بلا معالجة.
export const UNSOUND_FOLLOWUP_DAYS = 2;
export const isAssetUnsoundReturnStale = (a: AssetAlertShape, nowMs: number) =>
  isAssetUnsoundReturn(a) &&
  !!a.last_return_at &&
  new Date(a.last_return_at).getTime() < nowMs - UNSOUND_FOLLOWUP_DAYS * 864e5;

// ---------------------------------------------------------------------------
// الصيانة
// ---------------------------------------------------------------------------
export const LONG_MAINT_DAYS = 14;

const isMaintenanceOpenLike = (m: MaintenanceAlertShape) =>
  m.status === "open" || m.status === "in_progress";

// «مفتوحة بلا إجراء»: لا وصف إجراء ولا فنيّ معيَّن (تعيين الفني إجراء متابعة).
export const isMaintenanceOpenNoAction = (m: MaintenanceAlertShape) =>
  isMaintenanceOpenLike(m) &&
  !(m.action_taken && String(m.action_taken).trim()) &&
  !m.technician_id;

// «صيانة طويلة»: مفتوحة منذ أكثر من LONG_MAINT_DAYS يومًا.
export const isMaintenanceLongOpen = (m: MaintenanceAlertShape, nowMs: number) =>
  isMaintenanceOpenLike(m) &&
  !!m.reported_at &&
  new Date(m.reported_at).getTime() < nowMs - LONG_MAINT_DAYS * 864e5;

export const isMaintenanceFollowup = (m: MaintenanceAlertShape, nowMs: number) =>
  isMaintenanceOpenNoAction(m) || isMaintenanceLongOpen(m, nowMs);

export const isMaintenancePastDue = (m: MaintenanceAlertShape, todayISO: string) =>
  isMaintenanceOpenLike(m) &&
  !!m.next_due_date &&
  m.next_due_date < todayISO;

// ---------------------------------------------------------------------------
// الطلبات (عملاء)
// ---------------------------------------------------------------------------
// «متأخر عن الإرجاع»: خارج المخزن وتجاوز تاريخ الإرجاع، أو حالته overdue صراحة.
export const isRequestOverdueReturn = (r: RequestAlertShape, todayISO: string) =>
  r.status === "overdue" ||
  ((r.status === "delivered" || r.status === "partially_returned") &&
    !!r.return_date &&
    r.return_date < todayISO);

export const isRequestPendingApproval = (r: RequestAlertShape) =>
  r.status === "under_review";

export const isRequestReturnDue = (r: RequestAlertShape, todayISO: string) =>
  r.status === "overdue" ||
  ((r.status === "delivered" || r.status === "partially_returned") &&
    !!r.return_date &&
    r.return_date <= todayISO);

// ---------------------------------------------------------------------------
// سجلّ قوائم العمل (?view=) — مفاتيح موحدة تستخدمها الصفحات والكروت والروابط.
// ---------------------------------------------------------------------------
export type AssetViewKey =
  | "maintenance_attention" | "missing_location" | "no_qr" | "unsound_return";
export type MaintenanceViewKey = "no_action" | "long_maint" | "followup" | "past_due";
export type RequestViewKey = "overdue_return" | "returns_due" | "pending_approval";

export const ASSET_VIEWS: Record<AssetViewKey, (a: AssetAlertShape) => boolean> = {
  maintenance_attention: isAssetMaintenanceAttention,
  missing_location: isAssetMissingLocation,
  no_qr: isAssetMissingQr,
  unsound_return: isAssetUnsoundReturn,
};

export const MAINTENANCE_VIEWS: Record<
  MaintenanceViewKey,
  (m: MaintenanceAlertShape, nowMs: number, todayISO: string) => boolean
> = {
  no_action: (m) => isMaintenanceOpenNoAction(m),
  long_maint: (m, nowMs) => isMaintenanceLongOpen(m, nowMs),
  followup: (m, nowMs) => isMaintenanceFollowup(m, nowMs),
  past_due: (m, _nowMs, todayISO) => isMaintenancePastDue(m, todayISO),
};

export const REQUEST_VIEWS: Record<
  RequestViewKey,
  (r: RequestAlertShape, todayISO: string) => boolean
> = {
  overdue_return: isRequestOverdueReturn,
  returns_due: isRequestReturnDue,
  pending_approval: (r) => isRequestPendingApproval(r),
};

// قراءة view= من الرابط بأمان (نمط ?m= المجرب في الصيانة). null إن غاب/غير معروف.
export function parseViewParam<K extends string>(valid: readonly K[]): K | null {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("view");
    return v && (valid as readonly string[]).includes(v) ? (v as K) : null;
  } catch {
    return null;
  }
}
