// ============================================================================
//  Batch 6 — طبقة بيانات تحليلات طلبات العملاء (أغلفة RPCs الآمنة فقط).
//  الأمان في القاعدة (report.customer_requests + fail-closed). الواجهة تعرض ما يُرجَع فقط.
//  لا حسابات أمان في الواجهة · لا أعمدة مالية/مخزون/أصول في أي مخرج.
// ============================================================================

import { createClient } from "@/lib/supabase/client";

const sb = () => createClient();

export interface CrqFilters {
  date_from?: string;
  date_to?: string;
  customer_id?: string;
  request_type?: string;
  status?: string;
  source?: string;
  city?: string;
  responsible_employee_id?: string;
  portal_approval_status?: string;
  granularity?: "day" | "week" | "month";
}

export interface CrqBreakdownItem { key: string; count: number }

export interface CrqSummary {
  total_requests: number; client_portal_requests: number; internal_requests: number;
  open_requests: number; completed_requests: number; rejected_requests: number;
  needs_clarification: number; pending_project_manager: number; pending_internal_review: number;
  in_progress: number; needs_purchase_items: number; attachments_count: number;
}
export interface CrqBreakdowns {
  by_status: CrqBreakdownItem[]; by_request_type: CrqBreakdownItem[]; by_source: CrqBreakdownItem[];
  by_portal_approval_status: CrqBreakdownItem[]; by_city: CrqBreakdownItem[];
  by_customer: CrqBreakdownItem[]; by_responsible_employee: CrqBreakdownItem[];
}
export interface CrqTiming {
  avg_time_to_pm_approval: number | null;
  avg_time_to_approval: number | null;
  avg_time_to_internal_review: number | null;
  avg_time_to_completion: number | null;
  oldest_open_request_days: number | null;
}
export interface CrqAnalytics { summary: CrqSummary; breakdowns: CrqBreakdowns; timing: CrqTiming }

export interface CrqTimeseriesPoint {
  bucket: string; created_count: number; submitted_count: number;
  completed_count: number; rejected_count: number; pending_pm_count: number;
}

export interface CrqOperationalRow {
  request_number: string; customer_name: string; project_name: string | null; project_city: string | null;
  request_type: string; status: string; portal_approval_status: string; responsible_name: string | null;
  created_at: string; approved_at: string | null; completed_at: string | null;
  items_count: number; needs_purchase_count: number; attachments_count: number; last_event_at: string | null;
}

// يُنظّف الفلاتر من القيم الفارغة قبل الإرسال (undefined/"" تُسقَط ⇒ '{}' عند غيابها كلها).
function clean(filters: CrqFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) if (v) out[k] = v;
  return out;
}

export async function getCustomerRequestAnalytics(filters: CrqFilters): Promise<{ data: CrqAnalytics | null; error: string | null }> {
  const { data, error } = await sb().rpc("get_customer_request_analytics", { p_filters: clean(filters) });
  if (error) return { data: null, error: error.message };
  const d = data as any;
  if (!d?.ok) return { data: null, error: d?.error ?? "failed" };
  return { data: { summary: d.summary, breakdowns: d.breakdowns, timing: d.timing }, error: null };
}

export async function getCustomerRequestTimeseries(filters: CrqFilters): Promise<{ points: CrqTimeseriesPoint[]; granularity: string; error: string | null }> {
  const { data, error } = await sb().rpc("get_customer_request_timeseries", { p_filters: clean(filters) });
  if (error) return { points: [], granularity: "day", error: error.message };
  const d = data as any;
  if (!d?.ok) return { points: [], granularity: "day", error: d?.error ?? "failed" };
  return { points: (d.series ?? []) as CrqTimeseriesPoint[], granularity: d.granularity ?? "day", error: null };
}

export async function getCustomerRequestOperationalReport(filters: CrqFilters): Promise<{ rows: CrqOperationalRow[]; error: string | null }> {
  const { data, error } = await sb().rpc("get_customer_request_operational_report", { p_filters: clean(filters) });
  if (error) return { rows: [], error: error.message };
  const d = data as any;
  if (!d?.ok) return { rows: [], error: d?.error ?? "failed" };
  return { rows: (d.rows ?? []) as CrqOperationalRow[], error: null };
}
