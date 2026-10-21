// ============================================================================
//  Purchase Requests — طبقة بيانات طلبات شراء المستهلكات (تجهيز/متابعة فقط).
//  • المخزون لا يرتفع من هنا أبدًا: التوريد الفعلي يبقى عبر consumable_stock_move
//    (نافذة «توريد» الموجودة) — `received` هنا Goods Receipt فقط بلا أثر مخزني.
//  • unit_cost مالي: يُقرأ عبر purchase_request_items_financial (مدراء فقط)،
//    وأي كتابة له من غير المصرح يصفّرها trigger الخادم.
//  • الحالة تتغير عبر RPC حصريًا (آلة حالات في الخادم).
// ============================================================================
import { createClient } from "@/lib/supabase/client";
import { reportOperationalFailure } from "@/lib/observability";
import { executeIdempotentMutation } from "@/lib/idempotent-operation";
import { collectReportRangePages } from "@/lib/report-range-pages";
import {
  boundedPageSize,
  escapePostgrestValue,
  takeCursorPage,
  type CursorPage,
  type DescTimeCursor,
} from "@/lib/pagination";

const supabase = () => createClient();

export type PurchaseRequestStatus =
  | "draft" | "submitted" | "approved" | "ordered"
  | "partially_received" | "received" | "cancelled";

export interface PurchaseRequestRow {
  id: string;
  request_number: string;
  supplier_id: string | null;
  status: PurchaseRequestStatus;
  requested_by: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  second_approved_by: string | null;
  second_approved_at: string | null;
  cancelled_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  supplier: { name: string; name_ar: string | null } | null;
  item_count: number;
}

export interface PurchaseRequestItemRow {
  id: string;
  purchase_request_id: string;
  consumable_id: string | null; // null لبنود الوصف الحر المُحوَّلة من طلب (جسر المرحلة 4)
  description: string | null;    // وصف حر — يُعرض حين لا يوجد مستهلك
  requested_quantity: number;
  received_quantity: number;
  suggested_quantity: number | null;
  notes: string | null;
  unit_cost?: number | null; // يُدمج للمصرح ماليًا فقط
  consumable: { name: string; unit: string; quantity_on_hand: number; reorder_level: number } | null;
}

export async function listPurchaseRequestsPage(input: {
  cursor?: DescTimeCursor | null;
  pageSize?: number;
  status?: PurchaseRequestStatus | "";
} = {}): Promise<CursorPage<PurchaseRequestRow, DescTimeCursor>> {
  const pageSize = boundedPageSize(input.pageSize);
  let query = supabase()
    .from("purchase_requests")
    .select(
      "id,request_number,supplier_id,status,requested_by,submitted_at,approved_at,second_approved_by,second_approved_at,cancelled_at,notes,created_at,updated_at, supplier:supplier_id(name,name_ar), items:purchase_request_items(id)",
      { count: input.cursor ? undefined : "exact" },
    );
  if (input.status) query = query.eq("status", input.status);
  if (input.cursor) {
    const at = escapePostgrestValue(input.cursor.at);
    query = query.or(
      `created_at.lt.${at},and(created_at.eq.${at},id.lt.${input.cursor.id})`,
    );
  }
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);
  if (error) return { rows: [], nextCursor: null, total: null, error: error.message };
  const rows = ((data ?? []) as any[]).map((r) => ({
    ...r,
    item_count: Array.isArray(r.items) ? r.items.length : 0,
    items: undefined,
  })) as PurchaseRequestRow[];
  const page = takeCursorPage(
    rows,
    pageSize,
    (row) => ({ at: row.created_at, id: row.id }),
  );
  return { ...page, total: count ?? null, error: null };
}

export async function listPurchaseRequests(): Promise<{
  rows: PurchaseRequestRow[];
  error: string | null;
  nextCursor: DescTimeCursor | null;
  total: number | null;
}> {
  const page = await listPurchaseRequestsPage();
  return page;
}

export async function getPurchaseRequestItems(prId: string, fin: boolean, options: { signal?: AbortSignal } = {}): Promise<{ rows: PurchaseRequestItemRow[]; error: string | null }> {
  const sb = supabase();
  const { data, error } = await collectReportRangePages((from, to, countExact) => {
    const query = sb.from("purchase_request_items")
      .select("id,purchase_request_id,consumable_id,description,requested_quantity,received_quantity,suggested_quantity,notes, consumable:consumable_id(name,unit,quantity_on_hand,reorder_level)", { count: countExact ? "exact" : undefined })
      .eq("purchase_request_id", prId).order("created_at").order("id").range(from, to)
      // The consumable_id foreign key produces one joined object or NULL. Validate
      // that runtime shape below rather than accepting the SDK's inferred array.
      .returns<PurchaseRequestItemRow[]>();
    return options.signal ? query.abortSignal(options.signal) : query;
  }, options.signal);
  if (error !== null) return { rows: [], error: error.message || "purchase_request_items_failed" };
  const rows: PurchaseRequestItemRow[] = data;
  if (rows.some(row => {
    const consumable = row.consumable;
    return row.purchase_request_id !== prId || !Number.isFinite(row.requested_quantity)
      || row.requested_quantity <= 0 || !Number.isFinite(row.received_quantity) || row.received_quantity < 0
      || (consumable !== null && (typeof consumable !== "object" || Array.isArray(consumable)
        || typeof consumable.name !== "string" || typeof consumable.unit !== "string"
        || !Number.isFinite(consumable.quantity_on_hand) || !Number.isFinite(consumable.reorder_level)));
  })) {
    return { rows: [], error: "purchase_request_items_incomplete" };
  }
  if (fin && rows.length) {
    // Financial amounts are separately authorized by the RPC. A failed or incomplete
    // projection invalidates the whole read; NULL remains a legitimate stored value.
    try {
      const { data: costs, error: financialError } = await collectReportRangePages<{ id: string; unit_cost: number | null }>((from, to, countExact) => {
        const query = sb.rpc("purchase_request_items_financial", { p_pr_ids: [prId] }, { count: countExact ? "exact" : undefined })
          .order("id").range(from, to);
        return options.signal ? query.abortSignal(options.signal) : query;
      }, options.signal);
      if (financialError !== null) throw new Error(financialError.message || "purchase_request_financial_projection_failed");
      const expected = new Set(rows.map(row => row.id)), map = new Map<string, number | null>();
      for (const cost of costs) {
        if (!expected.has(cost.id) || map.has(cost.id) || (cost.unit_cost !== null && !Number.isFinite(cost.unit_cost))) {
          throw new Error("purchase_request_financial_projection_incomplete");
        }
        map.set(cost.id, cost.unit_cost);
      }
      if (map.size !== expected.size) throw new Error("purchase_request_financial_projection_incomplete");
      options.signal?.throwIfAborted();
      for (const row of rows) row.unit_cost = map.get(row.id)!;
    } catch (financialError) {
      reportOperationalFailure("purchase_request_financial_projection_failed", financialError);
      return { rows: [], error: options.signal?.aborted ? "read_aborted"
        : financialError instanceof Error && financialError.message ? financialError.message : "purchase_request_financial_projection_failed" };
    }
  }
  return { rows, error: null };
}

export interface ShortageDraftItem {
  consumable_id: string;
  supplier_id: string | null;
  quantity: number;
}

// «تجهيز طلب شراء» من قائمة النواقص: يجمع حسب المورد (طلب لكل مورد + طلب للبلا-مورد).
// الكمية المقترحة: ما يرفع الرصيد فوق حد إعادة الطلب (بحد أدنى 1).
export function suggestedQuantity(c: { quantity_on_hand?: number | string | null; reorder_level?: number | string | null }): number {
  const qty = Number(c.quantity_on_hand ?? 0);
  const reorder = Number(c.reorder_level ?? 0);
  return Math.max(reorder - qty, 1);
}

export async function createPurchaseRequestsFromShortages(
  items: ShortageDraftItem[],
): Promise<{ numbers: string[]; error: string | null }> {
  const { data, error } = await supabase().rpc("purchase_requests_create_from_shortages", {
    p_items: items,
  });
  if (error) return { numbers: [], error: error.message };
  const result = data as { ok?: boolean; numbers?: string[]; error?: string } | null;
  return result?.ok
    ? { numbers: result.numbers ?? [], error: null }
    : { numbers: [], error: result?.error ?? "insert_failed" };
}

async function prRpc(name: string, params: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase().rpc(name, params);
  if (error) return error.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

export type PurchaseRequestAction = PurchaseRequestStatus | "second_approved";
export const setPurchaseRequestStatus = (id: string, to: PurchaseRequestAction) =>
  prRpc("purchase_request_set_status", { p_id: id, p_to: to });

export const receivePurchaseRequestItem = (itemId: string, qty: number, operationId?: string) =>
  executeIdempotentMutation({
    type: "purchase_receipt", targetId: itemId,
    rpcName: "purchase_request_item_receive_idempotent", operationId,
    params: { p_item_id: itemId, p_qty: qty },
  });

export type ProcurementDocumentType =
  | "purchase_order"
  | "goods_receipt"
  | "invoice"
  | "stock_receipt";

export interface ProcurementState {
  ok: boolean;
  purchase_request_id?: string;
  legacy_received_semantic?: "goods_receipt_tracking_only";
  legacy_received_has_stock_effect?: false;
  purchase_orders?: number;
  goods_receipts?: number;
  invoices?: number | null;
  stock_receipts?: number;
  error?: string;
}

// يسجل مرجع وثيقة في نظام خارجي. لا ينشئ PO أو فاتورة أو قيدًا ماليًا.
// Stock Receipt لا يُقبل إلا بمرجع حركة توريد فعلية مطابقة لبند الطلب.
export async function recordProcurementDocument(input: {
  purchaseRequestId: string;
  purchaseRequestItemId?: string | null;
  documentType: ProcurementDocumentType;
  sourceSystem: string;
  externalReference: string;
  documentStatus?: "recorded" | "confirmed" | "cancelled";
  stockTransactionId?: string | null;
  metadata?: Record<string, unknown>;
  operationId?: string;
}) {
  const { data, error } = await supabase().rpc("procurement_record_external_document", {
      p_purchase_request_id: input.purchaseRequestId,
      p_purchase_request_item_id: input.purchaseRequestItemId ?? null,
      p_document_type: input.documentType,
      p_source_system: input.sourceSystem,
      p_external_reference: input.externalReference,
      p_document_status: input.documentStatus ?? "recorded",
      p_stock_transaction_id: input.stockTransactionId ?? null,
      p_metadata: input.metadata ?? {},
      p_operation_id: input.operationId ?? crypto.randomUUID(),
  });
  if (error) return { result: null, error: error.message };
  const result = data as { ok?: boolean; error?: string } | null;
  return result?.ok
    ? { result, error: null }
    : { result: null, error: result?.error ?? "failed" };
}

export async function getPurchaseRequestProcurementState(
  purchaseRequestId: string,
): Promise<{ state: ProcurementState | null; error: string | null }> {
  const { data, error } = await supabase().rpc("purchase_request_procurement_state", {
    p_purchase_request_id: purchaseRequestId,
  });
  if (error) return { state: null, error: error.message };
  const state = data as ProcurementState | null;
  return state?.ok
    ? { state, error: null }
    : { state: null, error: state?.error ?? "failed" };
}

// فلترة النواقص بنفس الشرط الموحد — تُستخدم في زر «تجهيز طلب شراء».
export const filterShortages = <T extends { quantity_on_hand?: number | string | null; reorder_level?: number | string | null }>(rows: T[]) =>
  rows.filter((row) => Number(row.quantity_on_hand) <= Number(row.reorder_level));
