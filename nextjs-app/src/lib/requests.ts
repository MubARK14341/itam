// ======================= نظام طلبات العملاء الخارجيين (Customer Requests) =======================
// العميل (customer) كيان خارجي ≠ مستخدم النظام. الطلب يطلب من مخزوننا أصولًا/مستهلكات.
// التسليم يؤثر على المخزون من طبقة التطبيق (مثل assignAsset/issueConsumable الحاليّين):
//   • الأصل المحجوز يبقى ضمن مسار الحجز/العهدة حتى الإرجاع إلى "available".
//   • السجل النهائي يُؤرشف ولا يظهر في المخزون التشغيلي.
//   • المستهلك → نقص الكمية + حركة consumable_transactions(out)؛ لا إرجاع.
// آلة الحالات في القاعدة (assets_guard_status) ترفض الانتقالات غير القانونية — نلتقط الخطأ.
// الاعتماد/الرفض عبر RPC للمدير فقط (request_approve/request_reject). RLS الحارس الفعلي.

import { createClient } from "@/lib/supabase/client";
import { isRequestOverdueReturn, type RequestViewKey } from "@/lib/alert-predicates";
import { dateKeyInTimeZone } from "@/lib/format";
import type { AssetStatus } from "@/lib/types";
import { rawRequestStatusesForDisplay, type DisplayRequestStatus } from "@/lib/request-fulfillment";
import { reportOperationalFailure } from "@/lib/observability";
import { collectReportRangePages } from "@/lib/report-range-pages";
import type { FinancialValueState } from "@/lib/financial-truth";
import {
  boundedPageSize,
  cursorReadErrorMessage,
  collectRangePages,
  escapePostgrestValue,
  postgrestIlikeContains,
  takeCursorPage,
  type CursorPage,
  type DescTimeCursor,
} from "@/lib/pagination";

const supabase = () => createClient();
async function currentUserId(): Promise<string | null> {
  const { data } = await supabase().auth.getUser();
  return data.user?.id ?? null;
}

// ---------- أنواع ----------
// 'internal' = طلب موظف داخلي (عهدة) — مرتبط حصريًا بـ beneficiary_type='employee' بقيد DB.
export type RequestType = "rental" | "sale" | "service" | "mixed" | "internal";
export type BeneficiaryType = "customer" | "employee";
export type RequestStatus =
  | "draft" | "under_review" | "needs_clarification" | "approved" | "rejected"
  | "auto_provisioning" | "provisioned" | "stock_shortage" | "preparing"
  | "ready_for_pickup" | "delivered" | "partially_returned" | "returned"
  | "completed" | "cancelled" | "overdue";
export type RequestSource = "internal" | "client_portal";
export type RequestedKind = "existing_asset" | "consumable" | "custom";

export interface CustomerRow {
  id: string; name: string; contact_person: string | null; phone: string | null;
  email: string | null; city: string | null; address: string | null;
  notes: string | null; is_active: boolean;
  approval_status?: "pending" | "approved" | "rejected";
}

export interface RequestItemRow {
  id: string; request_id: string; item_kind: "asset" | "consumable" | "custom";
  asset_id: string | null; consumable_id: string | null;
  quantity: number; approved_quantity: number | null;
  delivered_quantity: number; returned_quantity: number;
  unit_price: number | null; total_price: number | null; notes: string | null;
  // «الاحتياج المطلوب» — يُملأ من بوابة العميل؛ الداخلي يبقى existing_asset افتراضيًا.
  requested_kind: RequestedKind;
  requested_description: string | null;
  requested_category: string | null;
  preferred_model: string | null;
  preferred_company_id: string | null;
  accept_alternative: boolean;
  needs_purchase: boolean;
  asset?: { id: string; asset_tag: string | null; name: string | null; status: AssetStatus; serial_number: string | null } | null;
  consumable?: { id: string; name: string; sku: string | null; unit: string; quantity_on_hand: number } | null;
  preferred_company?: { id: string; name: string } | null;
}

// ربط بند طلب بطلب شراء (جسر المرحلة 4) — للموظفين فقط (البوابة لا تراه إطلاقًا).
export interface RequestItemPurchaseLink { pr_id: string; request_number: string }

// حدث في سجل الطلب (append-only). الموظف يقرأ الكل؛ البوابة تقرأ مجموعة مُبيّضة عبر RPC.
export interface RequestEventRow {
  id: string; event_type: string; actor_kind: "staff" | "portal" | "system";
  actor_id: string | null; message: string | null;
  metadata: Record<string, unknown>; created_at: string;
}

export interface RequestRow {
  id: string; request_number: string; customer_id: string | null;
  customer_name_snapshot: string | null; contact_phone_snapshot: string | null;
  project_name: string | null; project_city: string | null;
  request_type: RequestType; status: RequestStatus;
  request_source: RequestSource;
  // Phase 5: حالة اعتماد مدير المشروع في البوابة (not_required للطلبات الداخلية/القديمة).
  portal_approval_status: "not_required" | "pending_project_manager" | "approved_by_project_manager" | "rejected_by_project_manager";
  submitted_by: string | null;
  responsible_employee_id: string | null;
  // الجهة المستفيدة: عميل (الافتراضي) أو موظف داخلي (عهدة). قيد DB يضمن الاتساق مع request_type.
  beneficiary_type: BeneficiaryType;
  beneficiary_employee_id: string | null;
  pickup_date: string | null; return_date: string | null;
  delivered_at: string | null; returned_at: string | null;
  approved_at: string | null; rejected_at: string | null; rejection_reason: string | null;
  prepared_by: string | null; prepared_at: string | null;
  second_approved_by: string | null; second_approved_at: string | null;
  delivered_by: string | null; delivery_proof_id: string | null;
  risk_level_snapshot: "low" | "high" | null;
  risk_reason_snapshot: string | null;
  notes: string | null; internal_notes: string | null;
  created_at: string; updated_at: string;
  customer?: { id: string; name: string; phone: string | null; city: string | null } | null;
  beneficiary_employee?: { id: string; full_name: string; full_name_ar: string | null; employee_no: string | null } | null;
}

export interface DeliveryEvidence {
  receiver_name: string;
  delivered_by: string;
  acknowledged_at: string;
  created_at: string;
  delivery_notes: string | null;
  device_snapshot: { asset_id?: string; asset_tag?: string | null; name?: string | null }[];
}

export interface RequestAssetAllocation {
  request_item_id: string;
  asset_id: string;
  asset_tag: string | null;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  status: AssetStatus;
  location: string | null;
  state: "selected" | "prepared" | "delivered" | "returned" | "released";
}

export interface RequestListRow extends RequestRow {
  item_count: number;
  total_value: number | null;
  financial_state: FinancialValueState;
  financial_coverage_pct: number;
  financial_used_records: number;
  financial_excluded_records: number;
}

const REQUEST_COLS_NOFIN =
  "id,request_number,customer_id,customer_name_snapshot,contact_phone_snapshot,project_name,project_city," +
  "request_type,status,request_source,portal_approval_status,submitted_by,responsible_employee_id," +
  "beneficiary_type,beneficiary_employee_id,pickup_date,return_date,delivered_at,returned_at,approved_at," +
  "rejected_at,rejection_reason,prepared_by,prepared_at,second_approved_by,second_approved_at," +
  "delivered_by,delivery_proof_id,risk_level_snapshot,risk_reason_snapshot," +
  "notes,internal_notes,created_at,updated_at";

// ---------- مساعدة: هل الطلب متأخّر؟ (يُحسب ديناميكيًا، لا يُخزَّن) ----------
// الشرط نفسه من المصدر الموحد (alert-predicates.ts) — كروت اللوحة وقوائم العمل
// والتنبيهات كلها تستخدم المنطق ذاته حرفيًا.
export function isOverdue(r: { status: RequestStatus; return_date: string | null }): boolean {
  return isRequestOverdueReturn(r, dateKeyInTimeZone());
}


// =========================================================================
// العملاء
// =========================================================================
export async function listCustomers(opts?: { activeOnly?: boolean }): Promise<{ rows: CustomerRow[]; error: string | null }> {
  const sb = supabase();
  let q = sb.from("customers").select("id,name,contact_person,phone,email,city,address,notes,is_active,approval_status").order("name");
  if (opts?.activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q;
  return { rows: (data ?? []) as CustomerRow[], error: error?.message ?? null };
}

export interface CustomerInput {
  name: string; contact_person: string | null; phone: string | null; email: string | null;
  city: string | null; address: string | null; notes: string | null; is_active: boolean;
}

function customerInputPayload(p: CustomerInput) {
  const optional = (value: string | null) => value?.trim() || null;
  return {
    name: p.name.trim(),
    contact_person: optional(p.contact_person),
    phone: optional(p.phone),
    email: optional(p.email),
    city: optional(p.city),
    address: optional(p.address),
    notes: optional(p.notes),
    is_active: p.is_active,
  };
}

type CustomerMutationResult = { ok?: boolean; error?: string; id?: string } | null;

export async function createCustomer(p: CustomerInput): Promise<{ error: string | null; id: string | null }> {
  const { data, error } = await supabase().rpc("customer_save_atomic", {
    p_customer_id: null,
    p_input: customerInputPayload(p),
  });
  const result = data as CustomerMutationResult;
  if (error || !result?.ok || typeof result.id !== "string") {
    return { error: error?.message ?? result?.error ?? "save_failed", id: null };
  }
  return { error: null, id: result.id };
}

export async function updateCustomer(id: string, p: CustomerInput): Promise<string | null> {
  const { data, error } = await supabase().rpc("customer_save_atomic", {
    p_customer_id: id,
    p_input: customerInputPayload(p),
  });
  const result = data as CustomerMutationResult;
  return error?.message ?? (result?.ok ? null : result?.error ?? "save_failed");
}

export async function setCustomerActive(id: string, isActive: boolean): Promise<string | null> {
  const { data, error } = await supabase().rpc("customer_set_active", {
    p_customer_id: id,
    p_is_active: isActive,
  });
  const result = data as CustomerMutationResult;
  return error?.message ?? (result?.ok ? null : result?.error ?? "save_failed");
}

// =========================================================================
// بيانات نموذج إنشاء الطلب (عملاء + أصول + مستهلكات متاحة)
// =========================================================================
export interface RequestFormAsset {
  id: string; asset_tag: string | null; name: string | null; serial_number: string | null;
  status: AssetStatus; pool_id: string | null;
  category_id: string | null; company_id: string | null; model_id: string | null;
  category: { name: string; name_ar: string | null } | null;
  company: { name: string } | null;
  model: { brand: string | null; model_name: string | null } | null;
  location: { name: string; name_ar: string | null } | null;
}
export interface RequestFormData {
  customers: CustomerRow[];
  assets: RequestFormAsset[];
  consumables: { id: string; name: string; sku: string | null; unit: string; quantity_on_hand: number }[];
  // مجموعات الأصول النشطة — فلتر مساعد لاختيار الأصل فقط (لا يغيّر منطق الطلب).
  pools: { id: string; name: string; name_ar: string | null }[];
  // للنموذج الاحتياجي: تصنيفات/شركات لبناء «التصنيف ← الشركة ← الموديل»، وموظفون للعهدة الداخلية.
  categories: { id: string; name: string; name_ar: string | null; kind: string | null }[];
  companies: { id: string; name: string }[];
  employees: { id: string; full_name: string; full_name_ar: string | null; employee_no: string | null; department_id: string | null }[];
  error: string | null;
}

export async function getRequestFormData(): Promise<RequestFormData> {
  const sb = supabase();
  const [cust, assets, cons, pools, cats, comps, emps] = await Promise.all([
    collectRangePages((from, to) => sb.from("customers").select("id,name,contact_person,phone,email,city,address,notes,is_active").eq("is_active", true).order("name").order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("assets").select("id,asset_tag,name,serial_number,status,pool_id,category_id,company_id,model_id, category:category_id(name,name_ar), company:company_id(name), model:model_id(brand,model_name), location:location_id(name,name_ar)").eq("is_active", true).is("archived_at", null).order("asset_tag").order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("consumables").select("id,name,sku,unit,quantity_on_hand").eq("is_active", true).order("name").order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("asset_pools").select("id,name,name_ar").eq("is_active", true).order("name").order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("categories").select("id,name,name_ar,kind").order("name").order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("companies").select("id,name").eq("is_active", true).order("name").order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("employees").select("id,full_name,full_name_ar,employee_no,department_id").eq("is_active", true).order("full_name").order("id").range(from, to)),
  ]);
  return {
    customers: (cust.data ?? []) as CustomerRow[],
    // PostgREST يستنتج الـ embed كمصفوفة؛ القيمة الفعلية كائن واحد (FK أحادي) — نمرّر عبر unknown.
    assets: (assets.data ?? []) as unknown as RequestFormData["assets"],
    consumables: (cons.data ?? []) as RequestFormData["consumables"],
    pools: (pools.data ?? []) as RequestFormData["pools"],
    categories: (cats.data ?? []) as RequestFormData["categories"],
    companies: (comps.data ?? []) as RequestFormData["companies"],
    employees: (emps.data ?? []) as RequestFormData["employees"],
    error: cust.error?.message ?? assets.error?.message ?? cons.error?.message ?? pools.error?.message
      ?? cats.error?.message ?? comps.error?.message ?? emps.error?.message ?? null,
  };
}

// =========================================================================
// قائمة الطلبات
// =========================================================================
async function hydrateRequestListRows(
  base: any[],
  includeFinancial?: boolean,
  strictFinancial = false,
  signal?: AbortSignal,
  reportRead = false,
): Promise<{ rows: RequestListRow[]; error: string | null }> {
  const sb = supabase();
  // HIGH-1/P0-04: لا نجلب الأسعار أصلًا لغير المخوّل. للمخوّل، يبقى الإجمالي
  // null إذا كان أي بند بلا total_price؛ الصفر المسجل يبقى قيمة كاملة.
  const ids = base.map((r) => r.id);
  const requestedIds = new Set(ids);
  let financialAllowed = includeFinancial;
  if (financialAllowed === undefined) {
    const accessQuery = sb.rpc("is_financial_viewer");
    const { data, error, status } = await (signal ? accessQuery.abortSignal(signal) : accessQuery);
    financialAllowed = data === true;
    if (error !== null || status >= 400 || typeof data !== "boolean") {
      const message = cursorReadErrorMessage(error?.message, "request_list_financial_access_failed");
      reportOperationalFailure("request_list_financial_access_failed", error ?? { message });
      if (strictFinancial) return { rows: [], error: message };
    }
  }
  const byReq = new Map<string, { sum: number; used: number; records: number }>();
  const operationalCounts = new Map<string, number>();
  const operationalParents = new Map<string, string>();
  if ((financialAllowed !== true || strictFinancial) && ids.length) {
    // Embedded children are capped independently of their parent page. Read
    // only granted operational IDs so large requests keep their full item count
    // without retrieving prices or requiring broader SELECT privileges.
    const seen = new Set<string>();
    // Ordinary lists keep their bounded parent-ID filters. Complete reports
    // read one counted child source with the same parent visibility/filter.
    const readBatch = async (batch: string[]) => {
      const readChildPage = async (from: number, to: number) => {
        if (signal?.aborted) return { data: null, error: { message: "read_aborted" } };
        const query = sb.from("request_items").select("id,request_id")
          .in("request_id", batch).order("id").range(from, to);
        const page = await (signal ? query.abortSignal(signal) : query);
        if (page.error !== null || page.status >= 400 || !Array.isArray(page.data)) {
          return { data: null, error: { message: cursorReadErrorMessage(page.error?.message, "request_item_counts_failed") } };
        }
        return page;
      };
      return { allowedIds: new Set(batch), ...await collectRangePages<any>(readChildPage) };
    };
    const appendBatch = (batch: Awaited<ReturnType<typeof readBatch>>): string | null => {
      if (batch.error) return batch.error.message || "request_item_counts_failed";
      for (const item of batch.data) {
        if (typeof item.id !== "string" || seen.has(item.id) || !batch.allowedIds.has(item.request_id)) {
          return "request_item_counts_incomplete";
        }
        seen.add(item.id);
        operationalParents.set(item.id, item.request_id);
        operationalCounts.set(item.request_id, (operationalCounts.get(item.request_id) ?? 0) + 1);
      }
      return null;
    };
    if (reportRead) {
      const children = await collectReportRangePages(async (from, to, countExact) => {
        if (signal?.aborted) return { data: null, error: { message: "read_aborted" } };
        const query = sb.from("request_items")
          .select("id,request_id,request:requests!request_items_request_id_fkey!inner(id)",
            { count: countExact ? "exact" : undefined })
          .not("request.portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)")
          .order("id").range(from, to);
        const page = await (signal ? query.abortSignal(signal) : query);
        if (page.error !== null || !Array.isArray(page.data)) return page;
        // Validate the joined parent before a completed slot can refill.
        if (page.data.some(item => {
          if (!item || typeof item.request_id !== "string" || !requestedIds.has(item.request_id)) return true;
          const joined: unknown = item.request;
          return !joined || typeof joined !== "object" || Array.isArray(joined)
            || !("id" in joined) || joined.id !== item.request_id;
        })) return { data: null, error: { message: "request_item_counts_incomplete" }, count: page.count };
        return page;
      }, signal, 4, undefined, 1000);
      if (signal?.aborted) return { rows: [], error: "read_aborted" };
      const failure = appendBatch({ ...children, allowedIds: requestedIds });
      if (failure) return { rows: [], error: failure };
    } else {
      // Keep each GET filter below the gateway's 8 KiB request-line limit.
      const batches: string[][] = [];
      for (let from = 0; from < ids.length; from += 100) batches.push(ids.slice(from, from + 100));
      const batchConcurrency = Math.max(1, batches.length);
      for (let offset = 0; offset < batches.length; offset += batchConcurrency) {
        if (signal?.aborted) return { rows: [], error: "read_aborted" };
        const results = await Promise.all(batches.slice(offset, offset + batchConcurrency).map(readBatch));
        if (signal?.aborted) return { rows: [], error: "read_aborted" };
        for (const batch of results) {
          const failure = appendBatch(batch);
          if (failure) return { rows: [], error: failure };
        }
      }
    }
    if (base.some((row) => (operationalCounts.get(row.id) ?? 0) < (row.items?.length ?? 0))) {
      return { rows: [], error: "request_item_counts_incomplete" };
    }
  }
  if (financialAllowed === true && ids.length) {
    // A request may have more items than the API row cap; page items, not just request IDs.
    const readFinancialPage = async (from: number, to: number, countExact = false) => {
      if (signal?.aborted) return { data: null, error: { message: "read_aborted" } };
      const rpc = reportRead
        ? sb.rpc("request_items_financial", { p_request_ids: ids }, { count: countExact ? "exact" : undefined })
        : sb.rpc("request_items_financial", { p_request_ids: ids });
      const query = rpc.order("id").range(from, to);
      const page = await (signal ? query.abortSignal(signal) : query);
      if (!reportRead && (page.error !== null || page.status >= 400 || !Array.isArray(page.data))) {
        return { data: null, error: { message: cursorReadErrorMessage(page.error?.message, "request_list_financial_projection_failed") } };
      }
      return page;
    };
    const { data: fin, error: financialError } = reportRead
      ? await collectReportRangePages(readFinancialPage, signal, 4, undefined, 1000)
      : await collectRangePages<any>(readFinancialPage);
    if (financialError) {
      reportOperationalFailure("request_list_financial_projection_failed", financialError);
      if (strictFinancial) return { rows: [], error: financialError.message || "request_list_financial_projection_failed" };
    }
    const seen = new Set<string>();
    for (const item of (fin ?? []) as any[]) {
      const invalidStrictRow = strictFinancial && (operationalParents.get(item.id) !== item.request_id
        || (item.total_price !== null && (typeof item.total_price !== "number" || !Number.isFinite(item.total_price))));
      if (seen.has(item.id) || !requestedIds.has(item.request_id) || invalidStrictRow) {
        if (strictFinancial) return { rows: [], error: "financial_projection_incomplete" };
        continue;
      }
      seen.add(item.id);
      const current = byReq.get(item.request_id) ?? { sum: 0, used: 0, records: 0 };
      current.records++;
      if (item.total_price != null && Number.isFinite(Number(item.total_price))) {
        current.sum += Number(item.total_price);
        current.used++;
      }
      byReq.set(item.request_id, current);
    }
    if (strictFinancial && base.some((row) => (byReq.get(row.id)?.records ?? 0) !== (operationalCounts.get(row.id) ?? 0))) {
      return { rows: [], error: "financial_projection_incomplete" };
    }
  }
  const rows = base.map((r) => {
    const items = (r.items ?? []) as { quantity: number }[];
    const aggregate = byReq.get(r.id) ?? { sum: 0, used: 0, records: 0 };
    const itemCount = financialAllowed === true && !strictFinancial
      ? Math.max(items.length, aggregate.records)
      : operationalCounts.get(r.id) ?? 0;
    const excluded = itemCount - aggregate.used;
    const coverage = itemCount === 0
      ? 0
      : Math.round((aggregate.used / itemCount) * 10_000) / 100;
    const state: FinancialValueState = financialAllowed !== true
      ? "forbidden"
      : itemCount > 0 && excluded === 0
        ? "available"
        : "missing";
    return {
      ...r,
      item_count: itemCount,
      total_value: state === "available" ? aggregate.sum : null,
      financial_state: state,
      financial_coverage_pct: state === "forbidden" ? 0 : coverage,
      financial_used_records: state === "forbidden" ? 0 : aggregate.used,
      financial_excluded_records: state === "forbidden" ? itemCount : excluded,
    } as RequestListRow;
  });
  return { rows, error: null };
}

export interface RequestPageFilters {
  q?: string;
  status?: string;
  city?: string;
  party?: "portal" | "customer" | "employee" | "";
  customerId?: string;
  responsibleId?: string;
  overdueOnly?: boolean;
  view?: RequestViewKey | null;
  todayISO?: string;
  statuses?: readonly string[];
}

export interface RequestOperationalCounts {
  total: number;
  review: number;
  awaiting: number;
  out: number;
  completed: number;
  overdue: number;
}

export interface RequestFilterOptions {
  cities: string[];
  customers: { id: string; name: string }[];
  responsible_ids: string[];
}

export async function getRequestOperationalCounts(options: { signal?: AbortSignal } = {}): Promise<{
  counts: RequestOperationalCounts | null;
  error: string | null;
}> {
  const query = supabase().rpc("request_operational_counts");
  const { data, error } = await (options.signal ? query.abortSignal(options.signal) : query);
  return {
    counts: error ? null : data as unknown as RequestOperationalCounts,
    error: error?.message ?? null,
  };
}

export async function getRequestFilterOptions(): Promise<{
  options: RequestFilterOptions | null;
  error: string | null;
}> {
  const { data, error } = await supabase().rpc("request_filter_options");
  return {
    options: error ? null : data as unknown as RequestFilterOptions,
    error: error?.message ?? null,
  };
}

export async function listRequestsPage(input: {
  signal?: AbortSignal;
  cursor?: DescTimeCursor | null;
  pageSize?: number;
  filters?: RequestPageFilters;
  ascending?: boolean;
  /**
   * Data-minimization hint only. `true` never grants access: the financial RPC
   * still authorizes against the database role. `false` skips a projection the
   * caller cannot display.
   */
  includeFinancial?: boolean;
  /** Export-only: reject failed financial reads instead of marking them missing. */
  strictFinancial?: boolean;
} = {}): Promise<CursorPage<RequestListRow, DescTimeCursor>> {
  const sb = supabase();
  const pageSize = boundedPageSize(input.pageSize);
  const filters = input.filters ?? {};
  let query = sb.from("requests")
    .select(
      `${REQUEST_COLS_NOFIN}, customer:customer_id(id,name,phone,city), beneficiary_employee:beneficiary_employee_id(id,full_name,full_name_ar,employee_no), items:request_items(quantity)`,
      { count: input.cursor ? undefined : "exact" },
    )
    .not("portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)");
  if (filters.statuses?.length) query = query.in("status", [...filters.statuses]);
  if (filters.status) query = query.in("status", rawRequestStatusesForDisplay(filters.status as DisplayRequestStatus));
  if (filters.city) query = query.eq("project_city", filters.city);
  if (filters.customerId) query = query.eq("customer_id", filters.customerId);
  if (filters.responsibleId === "__unassigned") query = query.is("responsible_employee_id", null);
  else if (filters.responsibleId) query = query.eq("responsible_employee_id", filters.responsibleId);
  if (filters.party === "portal") query = query.eq("request_source", "client_portal");
  else if (filters.party === "employee") query = query.eq("beneficiary_type", "employee");
  else if (filters.party === "customer") {
    query = query.eq("request_source", "internal").eq("beneficiary_type", "customer");
  }
  const today = filters.todayISO ?? dateKeyInTimeZone();
  if (filters.overdueOnly || filters.view === "overdue_return") {
    query = query.or(
      `status.eq.overdue,and(status.in.(delivered,partially_returned),return_date.lt.${today})`,
    );
  } else if (filters.view === "returns_due") {
    query = query.or(
      `status.eq.overdue,and(status.in.(delivered,partially_returned),return_date.lte.${today})`,
    );
  } else if (filters.view === "pending_approval") {
    query = query.eq("status", "under_review");
  }
  if (filters.q?.trim()) {
    const pattern = postgrestIlikeContains(filters.q);
    query = query.or(
      `request_number.ilike.${pattern},project_name.ilike.${pattern},project_city.ilike.${pattern},customer_name_snapshot.ilike.${pattern}`,
    );
  }
  if (input.cursor) {
    const at = escapePostgrestValue(input.cursor.at);
    query = input.ascending
      ? query.or(`created_at.gt.${at},and(created_at.eq.${at},id.gt.${input.cursor.id})`)
      : query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${input.cursor.id})`);
  }
  if (input.signal) query = query.abortSignal(input.signal);
  const { data, error, count, status } = await query
    .order("created_at", { ascending: Boolean(input.ascending) })
    .order("id", { ascending: Boolean(input.ascending) })
    .limit(pageSize + 1);
  if (error !== null || status >= 400) return { rows: [], nextCursor: null, total: null, error: cursorReadErrorMessage(error?.message, "request_report_failed") };
  if (!Array.isArray(data)) return { rows: [], nextCursor: null, total: null, error: "request_list_shape_invalid" };
  const basePage = takeCursorPage(
    data,
    pageSize,
    (row) => ({ at: row.created_at, id: row.id }),
  );
  const hydrated = await hydrateRequestListRows(basePage.rows, input.includeFinancial, input.strictFinancial, input.signal);
  if (hydrated.error !== null) return { rows: [], nextCursor: null, total: null, error: cursorReadErrorMessage(hydrated.error, "request_report_failed") };
  return {
    rows: hydrated.rows,
    nextCursor: basePage.nextCursor,
    total: count ?? null,
    error: null,
  };
}

export async function listRequests(input: { includeFinancial?: boolean; strictFinancial?: boolean; signal?: AbortSignal } = {}): Promise<{ rows: RequestListRow[]; error: string | null }> {
  const rows: RequestListRow[] = [];
  let cursor: DescTimeCursor | null = null;
  do {
    const page = await listRequestsPage({ cursor, pageSize: 250, includeFinancial: input.includeFinancial, strictFinancial: input.strictFinancial, signal: input.signal });
    if (page.error !== null) return { rows: [], error: page.error || "request_report_failed" };
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  return { rows, error: null };
}

// =========================================================================
// تفاصيل طلب + بنوده
// =========================================================================
export async function getRequest(id: string, includeFinancial = true): Promise<{
  request: RequestRow | null;
  items: RequestItemRow[];
  events: RequestEventRow[];
  responsibleLabel: string | null;
  deliveryEvidence: DeliveryEvidence | null;
  deliveredByLabel: string | null;
  purchaseLinks: Record<string, RequestItemPurchaseLink>;
  error: string | null;
}> {
  const sb = supabase();
  const [req, items, events, proof] = await Promise.all([
    sb.from("requests").select(`${REQUEST_COLS_NOFIN}, customer:customer_id(id,name,phone,city), beneficiary_employee:beneficiary_employee_id(id,full_name,full_name_ar,employee_no)`).eq("id", id).single(),
    sb.from("request_items").select(
      "id,request_id,item_kind,asset_id,consumable_id,quantity,approved_quantity,delivered_quantity,returned_quantity,notes,created_at," +
      "requested_kind,requested_description,requested_category,preferred_model,preferred_company_id,accept_alternative,needs_purchase," +
      " asset:asset_id(id,asset_tag,name,status,serial_number), consumable:consumable_id(id,name,sku,unit,quantity_on_hand), preferred_company:preferred_company_id(id,name)"
    ).eq("request_id", id).order("created_at"),
    sb.from("request_events").select("id,event_type,actor_kind,actor_id,message,metadata,created_at").eq("request_id", id).order("created_at"),
    sb.from("request_delivery_proofs")
      .select("receiver_name,delivered_by,acknowledged_at,created_at,delivery_notes,device_snapshot")
      .eq("request_id", id)
      .eq("evidence_status", "verified")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const rows = (items.data ?? []) as any[];
  // روابط طلب الشراء لكل بند مُحوَّل (source_request_item_id) — للموظفين فقط (RLS = is_approved).
  const purchaseLinks: Record<string, RequestItemPurchaseLink> = {};
  const itemIds = rows.map((r) => r.id);
  if (itemIds.length) {
    const { data: links } = await sb
      .from("purchase_request_items")
      .select("source_request_item_id, purchase_request_id, pr:purchase_request_id(request_number)")
      .in("source_request_item_id", itemIds);
    for (const l of (links ?? []) as any[]) {
      if (l.source_request_item_id) {
        purchaseLinks[l.source_request_item_id] = { pr_id: l.purchase_request_id, request_number: l.pr?.request_number ?? "" };
      }
    }
  }
  // HIGH-1: الأسعار (unit_price/total_price) محجوبة على مستوى العمود؛ تُدمَج للمخوّلين عبر RPC آمن.
  if (includeFinancial) {
    const { data: fin, error: financialError } = await sb.rpc("request_items_financial", { p_request_ids: [id] });
    if (financialError) reportOperationalFailure("request_detail_financial_projection_failed", financialError);
    if (fin) {
      const m = new Map((fin as any[]).map((x) => [x.id, x]));
      for (const r of rows) { const f = m.get(r.id); if (f) { r.unit_price = f.unit_price; r.total_price = f.total_price; } }
    }
  }
  // اسم المسؤول عبر user_label الآمنة (تُرجع الاسم للمدير فقط، null لغيره) — بلا لمس RLS على app_users.
  const request = (req.data as unknown as RequestRow) ?? null;
  let responsibleLabel: string | null = null;
  if (request?.responsible_employee_id) {
    const { data: lbl } = await sb.rpc("user_label", { uid: request.responsible_employee_id });
    responsibleLabel = (lbl as string) ?? null;
  }
  const deliveryEvidence = (proof.data as unknown as DeliveryEvidence) ?? null;
  let deliveredByLabel: string | null = null;
  if (deliveryEvidence?.delivered_by) {
    const { data: lbl } = await sb.rpc("user_label", { uid: deliveryEvidence.delivered_by });
    deliveredByLabel = (lbl as string) ?? null;
  }
  return {
    request,
    items: rows as RequestItemRow[],
    events: (events.data ?? []) as RequestEventRow[],
    responsibleLabel,
    deliveryEvidence,
    deliveredByLabel,
    purchaseLinks,
    // Delivery evidence is staff-only by RLS. A self-service employee can still
    // read the request even when that optional operational card is unavailable.
    error: req.error?.message ?? items.error?.message ?? null,
  };
}

// =========================================================================
// إنشاء طلب جديد (رأس + بنود)
// =========================================================================
export interface NewRequestItem {
  // 'custom' = سطر احتياج (Need-based): بلا asset_id — يُربط بالمخزون لاحقًا عبر request_item_fulfill.
  item_kind: "asset" | "consumable" | "custom";
  asset_id: string | null; consumable_id: string | null;
  quantity: number; notes: string | null;
  // حقول الاحتياج (تُملأ لعناصر custom؛ تبقى undefined للعناصر المباشرة)
  requested_kind?: RequestedKind;
  requested_description?: string | null;
  requested_category?: string | null;
  preferred_company_id?: string | null;
  preferred_model?: string | null;
}
export interface NewRequestInput {
  status: "draft" | "under_review";
  customer_id: string | null;
  customer_name_snapshot: string | null;
  contact_phone_snapshot: string | null;
  project_name: string | null;
  project_city: string | null;
  request_type: RequestType;
  // الجهة المستفيدة: عميل (افتراضي) أو موظف داخلي (يتطلب beneficiary_employee_id + request_type='internal')
  beneficiary_type?: BeneficiaryType;
  beneficiary_employee_id?: string | null;
  pickup_date: string | null;
  return_date: string | null;
  notes: string | null;
  internal_notes: string | null;
  items: NewRequestItem[];
}

export async function createRequest(
  input: NewRequestInput,
  operationId = crypto.randomUUID(),
): Promise<{ error: string | null; id: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.rpc("request_create_idempotent", {
    p_operation_id: operationId,
    p_input: {
      status: input.status,
      customer_id: input.customer_id,
      customer_name: input.customer_name_snapshot,
      contact_phone: input.contact_phone_snapshot,
      project_name: input.project_name,
      project_city: input.project_city,
      request_type: input.request_type,
      pickup_date: input.pickup_date,
      return_date: input.return_date,
      notes: input.notes,
      internal_notes: input.internal_notes,
      items: input.items.map((it) => ({
        item_kind: it.item_kind,
        consumable_id: it.item_kind === "consumable" ? it.consumable_id : null,
        quantity: it.quantity,
        notes: it.notes,
        requested_kind: it.requested_kind ?? (it.item_kind === "consumable" ? "consumable" : "existing_asset"),
        requested_description: it.requested_description ?? null,
        requested_category: it.requested_category ?? null,
        preferred_company_id: it.preferred_company_id ?? null,
        preferred_model: it.preferred_model ?? null,
      })),
    },
  });
  if (error) return { error: error.message, id: null };
  const result = data as { ok: boolean; error?: string; id?: string };
  if (!result?.ok) return { error: result?.error ?? "save_failed", id: null };
  return { error: null, id: result.id ?? null };
}

// طلب موظف داخلي (عهدة) — يُسجَّل تلقائيًا باسم الحساب الحالي عبر RPC آمن.
// المستفيد يُشتق خادميًا من app_users.employee_id لـauth.uid() — لا يُقبل beneficiary من العميل
// (يمنع الطلب باسم موظف آخر). بلا أي حقول مالية.
export async function createEmployeeRequest(input: {
  status: "draft" | "under_review";
  project_name: string | null;
  pickup_date: string | null;
  return_date: string | null;
  notes: string | null;
  items: NewRequestItem[];
}, operationId = crypto.randomUUID()): Promise<{ error: string | null; id: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.rpc("request_create_idempotent", {
    p_operation_id: operationId,
    p_input: {
      status: input.status,
      project_name: input.project_name,
      pickup_date: input.pickup_date,
      return_date: input.return_date,
      notes: input.notes,
      items: input.items.map((it) => ({
        item_kind: "custom",
        quantity: it.quantity,
        notes: it.notes,
        requested_description: it.requested_description,
        requested_category: it.requested_category,
        accept_alternative: true,
      })),
    },
  });
  if (error) return { error: error.message, id: null };
  const res = data as { ok: boolean; error?: string; id?: string };
  if (!res?.ok) return { error: res?.error ?? "save_failed", id: null };
  return { error: null, id: res.id ?? null };
}

// =========================================================================
// انتقالات الحالة — كلها عبر RPC خادمي ذرّي (SECURITY DEFINER + transaction واحدة):
// يتحقق من الدور/الاعتماد/الحالة/التوفّر وينفّذ كل تأثيرات المخزون معًا أو يتراجع بالكامل.
// العميل لا يستطيع تحديث requests.status مباشرة (مسحوب على مستوى العمود) — فلا تجاوز للمنطق.
// كل دالة تُعيد رمز خطأ (يُترجَم عبر t.requests.err) أو null عند النجاح.
// =========================================================================
async function requestRpc(name: string, params: Record<string, unknown>): Promise<string | null> {
  const sb = supabase();
  const { data, error } = await sb.rpc(name, params);
  if (error) return error.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

async function requestIdempotent(
  id: string,
  operationType: string,
  payload: Record<string, unknown> = {},
  operationId = crypto.randomUUID(),
) {
  return requestRpc("request_execute_idempotent", {
    p_request_id: id,
    p_operation_type: operationType,
    p_operation_id: operationId,
    p_payload: payload,
  });
}

export const approveRequest = (id: string, operationId?: string) =>
  requestIdempotent(id, "approve", {}, operationId);
export const submitRequest = (id: string, operationId?: string) =>
  requestIdempotent(id, "submit", {}, operationId);
// حجز تلقائي للأجهزة المطابقة؛ يضبط provisioned/stock_shortage.
export const autoProvisionRequest = (id: string) => requestRpc("request_auto_provision", { p_id: id });
// قرار النقص: تجهيز المتاح فقط (يُسقِط أسطر الاحتياج غير المُلبّاة) — stock_shortage → provisioned.
export const fulfillAvailableShortage = (id: string) => requestRpc("request_shortage_fulfill_available", { p_id: id });
export const rejectRequest = (id: string, reason: string | null, operationId?: string) =>
  requestIdempotent(id, "reject", { reason }, operationId);
export const startPreparing = (id: string, operationId?: string) =>
  requestIdempotent(id, "start_preparing", {}, operationId);
export const markReady = (id: string, operationId?: string) =>
  requestIdempotent(id, "mark_ready", {}, operationId);
export const confirmDevicesReady = (id: string, operationId?: string) =>
  requestIdempotent(id, "confirm_ready", {}, operationId);
export type DeliveryProofMethod = "acknowledgement" | "otp" | "signature";
export interface DeliveryProofInput {
  receiver_name: string;
  delivery_notes?: string | null;
  acknowledged: true;
  verified_asset_ids: string[];
}
export interface DeliveryRequirements {
  risk_level: "low" | "high";
  risk_reason: string;
  second_approval_required: boolean;
  second_approval_complete: boolean;
  allowed_proof_methods: DeliveryProofMethod[];
}
export const deliverRequest = (id: string, proof: DeliveryProofInput, operationId = crypto.randomUUID()) =>
  requestRpc("request_deliver_with_proof", {
    p_id: id,
    p_proof: {
      method: "acknowledgement",
      receiver_name: proof.receiver_name,
      delivery_notes: proof.delivery_notes ?? null,
      acknowledged: proof.acknowledged,
      signature_reference: null,
      otp_challenge_id: null,
      attachment_id: null,
      verified_asset_ids: proof.verified_asset_ids,
    },
    p_operation_id: operationId,
  });
export async function getRequestAssetAllocations(id: string): Promise<{
  rows: RequestAssetAllocation[];
  error: string | null;
}> {
  const { data, error } = await supabase().rpc("request_asset_allocation_summary", { p_request_id: id });
  return { rows: (data ?? []) as RequestAssetAllocation[], error: error?.message ?? null };
}
export async function selectExactRequestAsset(
  requestItemId: string,
  assetId: string,
  operationId = crypto.randomUUID(),
): Promise<string | null> {
  const { data, error } = await supabase().rpc("request_allocate_asset", {
    p_request_item_id: requestItemId,
    p_asset_id: assetId,
    p_operation_id: operationId,
  });
  if (error) return error.message;
  const result = data as { ok?: boolean; error?: string } | null;
  return result?.ok ? null : result?.error ?? "save_failed";
}
export const secondaryApproveRequest = (id: string, reason: string) =>
  requestRpc("request_secondary_approve", {
    p_id: id,
    p_reason: reason,
    p_operation_id: crypto.randomUUID(),
  });
export async function getDeliveryRequirements(id: string): Promise<{
  requirements: DeliveryRequirements | null;
  error: string | null;
}> {
  const { data, error } = await supabase().rpc("request_delivery_requirements", {
    p_request_id: id,
  });
  if (error) return { requirements: null, error: error.message };
  const result = data as ({ ok?: boolean; error?: string } & Partial<DeliveryRequirements>) | null;
  if (!result?.ok) return { requirements: null, error: result?.error ?? "failed" };
  return {
    requirements: {
      risk_level: result.risk_level as "low" | "high",
      risk_reason: result.risk_reason ?? "standard_delivery",
      second_approval_required: Boolean(result.second_approval_required),
      second_approval_complete: Boolean(result.second_approval_complete),
      allowed_proof_methods: result.allowed_proof_methods ?? ["acknowledgement"],
    },
    error: null,
  };
}
export const returnRequest = (id: string, operationId?: string) =>
  requestIdempotent(id, "return", {}, operationId);
// The warehouse records the intake result, not a technical diagnosis. A device
// either returns in good condition or enters the existing maintenance intake.
export type InspectionCondition = "sound" | "needs_inspection";
export interface InspectionLine { asset_id: string; condition: InspectionCondition; notes?: string | null }
export const inspectReturnRequest = (id: string, lines: InspectionLine[], operationId?: string) =>
  requestIdempotent(id, "inspect_return", { lines }, operationId);
export const changeReservedAsset = (
  itemId: string,
  replacementAssetId: string,
  operationId = crypto.randomUUID(),
) => requestRpc("request_change_reserved_asset", {
  p_item_id: itemId,
  p_new_asset_id: replacementAssetId,
  p_operation_id: operationId,
});
export const completeRequest = (id: string, operationId?: string) =>
  requestIdempotent(id, "complete", {}, operationId);
export const cancelRequest = (id: string, operationId?: string) =>
  requestIdempotent(id, "cancel", {}, operationId);

export async function lookupRequestOperation(operationId: string) {
  const { data, error } = await supabase().rpc("request_operation_result_lookup", {
    p_operation_id: operationId,
  });
  return {
    result: (data ?? null) as Record<string, unknown> | null,
    error: error?.message ?? null,
  };
}

// اعتماد/رفض عميل خارجي مسجَّل ذاتيًا (admin/it_manager فقط) — يفعّل/يعطّل بوابته.
export const approveCustomer = (customerId: string, approve: boolean) =>
  requestRpc("approve_customer", { p_customer_id: customerId, p_approve: approve });

// طلب توضيح من العميل (under_review → needs_clarification) — يتطلب صلاحية request.approve.
export const requestClarification = (id: string, message: string | null) =>
  requestRpc("request_request_clarification", { p_id: id, p_message: message });
// تعيين المسؤول عن الطلب (المدير/صاحب صلاحية الاعتماد). p_user_id = uuid لموظف معتمد.
export const setRequestResponsible = (id: string, userId: string) =>
  requestRpc("request_set_responsible", { p_id: id, p_user_id: userId });
// «أسندها لي» — يعيّن المستخدم الحالي مسؤولًا.
export async function assignResponsibleToMe(id: string): Promise<string | null> {
  const uid = await currentUserId();
  if (!uid) return "no_session";
  return setRequestResponsible(id, uid);
}
// ربط عنصر احتياج بمخزون حقيقي (موظف). مرجع واحد فقط: أصل أو مستهلك.
export const fulfillRequestItem = (itemId: string, ref: { assetId?: string | null; consumableId?: string | null }) =>
  requestRpc("request_item_fulfill", { p_item_id: itemId, p_asset_id: ref.assetId ?? null, p_consumable_id: ref.consumableId ?? null });
// فكّ الربط — يعيد العنصر إلى custom (احتياج غير مُلبّى).
export const unfulfillRequestItem = (itemId: string) =>
  requestRpc("request_item_unfulfill", { p_item_id: itemId });
// تحويل بند احتياج (custom) إلى بند طلب شراء draft (جديد أو قائم). لا يلمس المخزون؛
// يضع needs_purchase=true فتعرض البوابة «جارٍ التوفير». الصلاحية: request.approve أو admin/it_manager.
export const convertRequestItemToPr = (itemId: string, prId?: string | null) =>
  requestRpc("request_item_convert_to_pr", { p_item_id: itemId, p_pr_id: prId ?? null });

// معرّف المستخدم الحالي (لتحديد إن كان هو المسؤول عن الطلب).
export async function getCurrentUserId(): Promise<string | null> {
  return currentUserId();
}

// أسماء المسؤولين عبر user_label الآمنة (تُرجع الاسم للمدير فقط، null لغيره) — لبناء فلتر المسؤول.
export async function resolveUserLabels(ids: string[]): Promise<Record<string, string>> {
  const sb = supabase();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const out: Record<string, string> = {};
  if (uniq.length === 0) return out;
  // استدعاء واحد بدل جولة شبكة لكل معرّف (user_labels يطبّق نفس بوابة user_label).
  const { data } = await sb.rpc("user_labels", { p_ids: uniq });
  for (const row of (data ?? []) as { id: string; label: string | null }[]) {
    if (row.label) out[row.id] = row.label;
  }
  return out;
}

// =========================================================================
// إدارة وصول بوابة العميل (admin/it_manager) — عبر RPCs الآمنة فقط.
// =========================================================================
export type PortalRoleKey = "project_manager" | "authorized_requester" | "viewer";
export interface PortalInviteRow {
  id: string; code: string; customer_id: string; portal_role: PortalRoleKey;
  expires_at: string; max_uses: number; used_count: number; is_active: boolean; created_at: string;
}
export interface PortalUserRow {
  id: string; customer_id: string; contact_name: string; phone: string | null;
  portal_role: PortalRoleKey; is_active: boolean; created_at: string;
}

export async function createPortalInvite(customerId: string, role: PortalRoleKey, validDays: number): Promise<{ code: string | null; error: string | null }> {
  const { data, error } = await supabase().rpc("create_customer_portal_invite", {
    p_customer_id: customerId, p_portal_role: role, p_valid_days: validDays, p_max_uses: 1,
  });
  if (error) return { code: null, error: error.message };
  const d = data as { ok: boolean; code?: string; error?: string };
  return d?.ok ? { code: d.code ?? null, error: null } : { code: null, error: d?.error ?? "failed" };
}
export const revokePortalInvite = (inviteId: string) => requestRpc("revoke_customer_portal_invite", { p_invite_id: inviteId });
export const setPortalUserActive = (userId: string, active: boolean) => requestRpc("set_customer_portal_user_active", { p_user_id: userId, p_active: active });

export async function listPortalInvites(customerId: string): Promise<PortalInviteRow[]> {
  const { data } = await supabase().rpc("list_customer_portal_invites", { p_customer_id: customerId });
  return (data ?? []) as PortalInviteRow[];
}
export async function listPortalUsers(customerId: string): Promise<PortalUserRow[]> {
  const { data } = await supabase().rpc("list_customer_portal_users", { p_customer_id: customerId });
  return (data ?? []) as PortalUserRow[];
}

// =========================================================================
// إعدادات بوابة العميل (Phase 5) — admin/it_manager عبر RPCs الآمنة فقط.
// =========================================================================
export interface CustomerPortalSettings {
  portal_enabled: boolean;
  allow_rental_requests: boolean;
  allow_purchase_requests: boolean;
  allow_maintenance_requests: boolean;
  allow_custom_requests: boolean;
  allow_custom_item_requests: boolean;
  allow_attachments: boolean;
  require_project_manager_approval: boolean;
}
export interface AllowedCompanyRow { company_id: string; name: string }
export interface AllowedCategoryRow { category_key: string; label_ar: string | null; label_en: string | null }
export interface CustomerPortalConfig {
  settings: CustomerPortalSettings;
  allowed_companies: AllowedCompanyRow[];
  allowed_categories: AllowedCategoryRow[];
}
export interface CompanyRow { id: string; name: string }

export async function getCustomerPortalSettings(customerId: string): Promise<{ data: CustomerPortalConfig | null; error: string | null }> {
  const { data, error } = await supabase().rpc("get_customer_portal_settings", { p_customer_id: customerId });
  if (error) return { data: null, error: error.message };
  const d = data as any;
  if (!d?.ok) return { data: null, error: d?.error ?? "failed" };
  return {
    data: { settings: d.settings as CustomerPortalSettings, allowed_companies: (d.allowed_companies ?? []) as AllowedCompanyRow[], allowed_categories: (d.allowed_categories ?? []) as AllowedCategoryRow[] },
    error: null,
  };
}

export const updateCustomerPortalSettings = (customerId: string, s: CustomerPortalSettings) =>
  requestRpc("update_customer_portal_settings", {
    p_customer_id: customerId,
    p_portal_enabled: s.portal_enabled,
    p_allow_rental: s.allow_rental_requests,
    p_allow_purchase: s.allow_purchase_requests,
    p_allow_maintenance: s.allow_maintenance_requests,
    p_allow_custom: s.allow_custom_requests,
    p_allow_custom_item: s.allow_custom_item_requests,
    p_allow_attachments: s.allow_attachments,
    p_require_pm: s.require_project_manager_approval,
  });

export const setCustomerAllowedCompanies = (customerId: string, companyIds: string[]) =>
  requestRpc("set_customer_allowed_companies", { p_customer_id: customerId, p_company_ids: companyIds });

export const setCustomerAllowedCategories = (
  customerId: string,
  categories: { key: string; label_ar: string | null; label_en: string | null }[],
) => requestRpc("set_customer_allowed_categories", { p_customer_id: customerId, p_categories: categories });

// قائمة الشركات النشطة (لاختيار قائمة السماح في الإعدادات). قراءة موظف عادية (RLS يسمح للمعتمد).
export async function listCompanies(): Promise<CompanyRow[]> {
  const { data } = await supabase().from("companies").select("id,name").eq("is_active", true).order("name");
  return (data ?? []) as CompanyRow[];
}

// =========================================================================
// تقرير الطلبات (KPIs + توزيع الحالات + اتجاه شهري) — للوحة التقارير
// =========================================================================
export interface RequestReportData {
  rows: RequestListRow[];
  error: string | null;
}
export async function getRequestsReport(includeFinancial = true, options: { signal?: AbortSignal } = {}): Promise<RequestReportData> {
  const sb = supabase();
  // Reports need every parent before hydration. Counted, stably ordered pages
  // avoid a serial parent -> children -> finance -> next-parent waterfall.
  const { data: base, error } = await collectReportRangePages((from, to, countExact) => {
    const query = sb.from("requests")
      .select(`${REQUEST_COLS_NOFIN}, customer:customer_id(id,name,phone,city), beneficiary_employee:beneficiary_employee_id(id,full_name,full_name_ar,employee_no), items:request_items(quantity)`,
        { count: countExact ? "exact" : undefined })
      .not("portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
    return options.signal ? query.abortSignal(options.signal) : query;
  }, options.signal, 4, undefined, 1000);
  if (error !== null) return { rows: [], error: error.message || "request_report_failed" };
  return hydrateRequestListRows(base, includeFinancial, true, options.signal, true);
}
