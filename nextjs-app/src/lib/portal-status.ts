import { toneStyles, type Tone } from "./tone";
// ============================================================================
//  بوابة العميل — مُخطِّط الحالات المبسّط (المصدر الوحيد لتحويل حالة القاعدة إلى تسمية العميل).
//  العميل لا يرى الحالات الداخلية التفصيلية (ready_for_pickup/partially_returned…)،
//  بل مجموعات مفهومة. التسميات نفسها في الترجمة (t.portal.status.*).
// ============================================================================

export type PortalStatusKey =
  | "draft" | "reviewing" | "clarify" | "accepted" | "preparing"
  | "delivered" | "returned" | "completed" | "rejected" | "cancelled"
  | "pending_pm" | "pm_rejected";

// المفتاح المعروض للعميل مع مراعاة اعتماد مدير المشروع (Phase 5):
//   pending_project_manager  → pending_pm  (بانتظار اعتماد مدير المشروع)
//   rejected_by_project_manager → pm_rejected (مرفوض من مدير المشروع)
//   غير ذلك → المفتاح المشتق من حالة القاعدة.
export function portalDisplayKey(
  status: string | null | undefined,
  portalApprovalStatus: string | null | undefined,
): PortalStatusKey {
  if (portalApprovalStatus === "pending_project_manager") return "pending_pm";
  if (portalApprovalStatus === "rejected_by_project_manager") return "pm_rejected";
  return portalStatusKey(status);
}

// حالة القاعدة الخام → مفتاح مبسّط للعميل.
export function portalStatusKey(raw: string | null | undefined): PortalStatusKey {
  switch (raw) {
    case "draft": return "draft";
    case "under_review": return "reviewing";
    case "needs_clarification": return "clarify";
    case "approved": return "accepted";
    case "preparing":
    case "ready_for_pickup": return "preparing";
    case "delivered":
    case "partially_returned":
    case "overdue": return "delivered";
    case "returned": return "returned";
    case "completed": return "completed";
    case "rejected": return "rejected";
    case "cancelled": return "cancelled";
    default: return "reviewing";
  }
}

// ألوان شارة الحالة المبسّطة (فاتح/داكن).
export const PORTAL_STATUS_TONE: Record<PortalStatusKey, Tone> = {
  draft: "neu", reviewing: "info", clarify: "warn", accepted: "info", preparing: "info",
  delivered: "ok", returned: "ok", completed: "ok", rejected: "neu", cancelled: "neu",
  pending_pm: "warn", pm_rejected: "bad",
};
export const PORTAL_STATUS_STYLE: Record<PortalStatusKey, string> = toneStyles(PORTAL_STATUS_TONE);

// حالة تلبية العنصر (من portal_get_request.items[].fulfillment) → مفتاح ترجمة t.portal.fulfillment.*
export type PortalFulfillmentKey = "reviewing" | "preparing" | "procuring" | "delivered";
export function portalFulfillmentKey(raw: string | null | undefined): PortalFulfillmentKey {
  return (["reviewing", "preparing", "procuring", "delivered"] as const).includes(raw as PortalFulfillmentKey)
    ? (raw as PortalFulfillmentKey)
    : "reviewing";
}

// ألوان شارة تلبية العنصر (فاتح/داكن) — متسقة مع مجموعات الحالة أعلاه.
export const PORTAL_FULFILLMENT_TONE: Record<PortalFulfillmentKey, Tone> = {
  reviewing: "info", preparing: "res", procuring: "warn", delivered: "ok",
};
export const PORTAL_FULFILLMENT_STYLE: Record<PortalFulfillmentKey, string> = toneStyles(PORTAL_FULFILLMENT_TONE);

// قيمة نوع الطلب في القاعدة (rental/sale/service/mixed) → مفتاح البوابة (rental/purchase/maintenance/custom)
// لعرض تسمية مترجمة للعميل عبر t.portal.types.*. (المصدر الوحيد — يُستورد في صفحات البوابة.)
export const DB_TYPE_TO_PORTAL: Record<string, string> = {
  rental: "rental", sale: "purchase", service: "maintenance", mixed: "custom",
};

// تصنيف مفتاح الحالة المبسّط إلى مجموعة لوحة العميل (للعدّ في الرئيسية — مصدر واحد).
//   open = نشِط مبكّر (مسودة/قيد المراجعة) · in_progress = مقبول/تجهيز/تسليم
//   pending_pm / clarify = مجموعات انتباه · completed = منتهٍ بنجاح · closed = مرفوض/ملغى
export type PortalDashboardBucket = "open" | "pending_pm" | "clarify" | "in_progress" | "completed" | "closed";
export type PortalDashboardFilter = Extract<PortalDashboardBucket, "pending_pm" | "clarify" | "in_progress" | "completed">;

const PORTAL_DASHBOARD_FILTERS = new Set<PortalDashboardFilter>([
  "pending_pm", "clarify", "in_progress", "completed",
]);

export function portalDashboardFilterFromQuery(value: string | null | undefined): PortalDashboardFilter | null {
  return PORTAL_DASHBOARD_FILTERS.has(value as PortalDashboardFilter)
    ? value as PortalDashboardFilter
    : null;
}

export function portalDashboardBucket(key: PortalStatusKey): PortalDashboardBucket {
  switch (key) {
    case "pending_pm": return "pending_pm";
    case "clarify": return "clarify";
    case "accepted":
    case "preparing":
    case "delivered": return "in_progress";
    case "completed":
    case "returned": return "completed";
    case "rejected":
    case "cancelled":
    case "pm_rejected": return "closed";
    default: return "open"; // draft / reviewing
  }
}

// هل الطلب «نشِط» (غير منتهٍ) — أي ليس مكتملًا/مرفوضًا/ملغى. يُستخدم لعدّ «المفتوحة».
export function isPortalActive(key: PortalStatusKey): boolean {
  return portalDashboardBucket(key) !== "completed" && portalDashboardBucket(key) !== "closed";
}
