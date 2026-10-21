import type { RequestStatus } from "@/lib/requests";

// مراحل شريط الطلبات — نفس مجموعات الحالات حرفيًا في request_operational_counts
// (migrations/20260809170000_production_reconciliation_non_email.sql) كي يطابق رقم الخلية القائمة المفلترة.
// «متأخر» ليس مرحلة هنا: يبقى فلتر overdueOnly القائم (نفس شرط الخادم).
export const REQUEST_STAGE_KEYS = ["review", "fulfillment", "out", "completed"] as const;
export type RequestStageKey = (typeof REQUEST_STAGE_KEYS)[number];

export const REQUEST_STAGE_STATUSES: Record<RequestStageKey, readonly RequestStatus[]> = {
  review: ["draft", "under_review", "needs_clarification"],
  fulfillment: ["approved", "auto_provisioning", "provisioned", "stock_shortage", "preparing", "ready_for_pickup"],
  out: ["delivered", "partially_returned"],
  completed: ["completed"],
};

export function isRequestStageKey(value: string | null | undefined): value is RequestStageKey {
  return (REQUEST_STAGE_KEYS as readonly string[]).includes(value ?? "");
}
