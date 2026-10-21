// ============================================================================
//  Action Center — بناء المرشّحين من المصدر الموحد (alert-predicates.ts) ومزامنتهم
//  مع جدول التتبّع action_alert_instances ثم عمليات المتابعة (إسناد/بدء/ملاحظة).
//  • مصدر الحقيقة = البيانات الأصلية: المرشّحون يُحسبون بنفس الشروط حرفيًا.
//  • لا ماليات إطلاقًا: metadata تحمل label/count فقط (وقائمة بيضاء في الـRPC أيضًا).
//  • تنبيه QR عالي الحجم يُتتبَّع كمجموعة واحدة بعدّاد، ويُعالج من قائمة العمل.
// ============================================================================
import { createClient } from "@/lib/supabase/client";
import { reportOperationalFailure } from "@/lib/observability";
import {
  boundedPageSize,
  cursorReadErrorMessage,
  collectRangePages,
  escapePostgrestValue,
  takeCursorPage,
  type CursorPage,
  type DescTimeCursor,
} from "@/lib/pagination";
import {
  isMaintenanceLongOpen, isMaintenanceOpenNoAction, isMaintenancePastDue,
  isRequestPendingApproval,
} from "@/lib/alert-predicates";
import { dateKeyInTimeZone } from "@/lib/format";

const supabase = () => createClient();

export const ACTION_ALERT_TYPE_KEYS = [
  "request_pending", "request_preparing", "request_ready_delivery",
  "maint_overdue", "maint_no_technician", "consumable_below_threshold", "stocktake_review",
] as const;

export type ActionAlertType = (typeof ACTION_ALERT_TYPE_KEYS)[number];

export type ActionAlertStatus = "open" | "in_progress" | "auto_resolved" | "reopened";
export type ActionAlertSeverity = "critical" | "high" | "medium" | "low";

export interface ActionAlertInstance {
  id: string;
  stable_key: string;
  alert_type: ActionAlertType;
  entity_type: string;
  entity_id: string | null;
  severity: ActionAlertSeverity;
  status: ActionAlertStatus;
  assigned_to: string | null;
  assigned_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  auto_resolved_at: string | null;
  occurrence_count: number;
  last_action_at: string | null;
  metadata: { label?: string; count?: number; due_at?: string } | null;
}

export interface Candidate {
  stable_key: string;
  alert_type: ActionAlertType;
  entity_type: string;
  entity_id: string | null;
  severity: ActionAlertSeverity;
  metadata: { label?: string; count?: number; due_at?: string };
}

export interface ActionAlertCandidateInputs {
  maintenance: any[];
  consumables: any[];
  requests: any[];
  stocktakes: any[];
  todayISO: string;
}

// دالة نقية قابلة لاختبارات fixtures؛ الجلب والمزامنة يبقيان خارجها.
export function deriveActionAlertCandidates(input: ActionAlertCandidateInputs): Candidate[] {
  const out: Candidate[] = [];

  for (const m of input.maintenance) {
    const label = [m.asset?.asset_tag, m.asset?.name].filter(Boolean).join(" — ") || undefined;
    if (isMaintenancePastDue(m, input.todayISO) || isMaintenanceLongOpen(m, new Date(`${input.todayISO}T12:00:00+03:00`).getTime())) out.push({
      stable_key: `maint_overdue:${m.id}`, alert_type: "maint_overdue", entity_type: "maintenance",
      entity_id: m.id, severity: "high", metadata: { label, due_at: m.next_due_date ?? undefined },
    });
    if (isMaintenanceOpenNoAction(m)) out.push({
      stable_key: `maint_no_technician:${m.id}`, alert_type: "maint_no_technician", entity_type: "maintenance",
      entity_id: m.id, severity: "medium",
      metadata: { label, due_at: m.next_due_date ?? undefined },
    });
  }
  for (const r of input.requests) {
    if (isRequestPendingApproval(r)) out.push({ stable_key: `request_pending:${r.id}`, alert_type: "request_pending", entity_type: "request", entity_id: r.id, severity: "medium", metadata: { label: r.request_number, due_at: r.pickup_date ?? undefined } });
    if (["approved", "auto_provisioning", "provisioned", "preparing"].includes(r.status)) out.push({ stable_key: `request_preparing:${r.id}`, alert_type: "request_preparing", entity_type: "request", entity_id: r.id, severity: "medium", metadata: { label: r.request_number, due_at: r.pickup_date ?? undefined } });
    if (r.status === "ready_for_pickup") out.push({ stable_key: `request_ready_delivery:${r.id}`, alert_type: "request_ready_delivery", entity_type: "request", entity_id: r.id, severity: "high", metadata: { label: r.request_number, due_at: r.pickup_date ?? undefined } });
  }
  for (const c of input.consumables) {
    if (c.is_active !== false && c.reorder_level > 0 && c.quantity_on_hand <= c.reorder_level) out.push({ stable_key: `consumable_below_threshold:${c.id}`, alert_type: "consumable_below_threshold", entity_type: "consumable", entity_id: c.id, severity: c.quantity_on_hand === 0 ? "critical" : "high", metadata: { label: c.name } });
  }
  for (const take of input.stocktakes) {
    if (take.review_state === "submitted") out.push({ stable_key: `stocktake_review:${take.id}`, alert_type: "stocktake_review", entity_type: "stocktake", entity_id: take.id, severity: "medium", metadata: { label: take.location?.name ?? take.id, due_at: take.submitted_at ?? undefined } });
  }
  return out;
}

export function actionAlertCandidateCount(candidates: Candidate[], type: ActionAlertType): number {
  return candidates.filter((c) => c.alert_type === type)
    .reduce((sum, c) => sum + (c.metadata.count ?? 1), 0);
}

// رابط «معالجة الآن» — يفتح المكان الصحيح بالحوار/الفلتر الجاهز (لا يحل شيئًا بنفسه).
export function actionAlertUrl(a: Pick<ActionAlertInstance, "alert_type" | "entity_id">): string {
  const id = a.entity_id;
  switch (a.alert_type) {
    case "maint_overdue": return id ? `/maintenance?m=${id}` : "/maintenance?view=past_due";
    case "maint_no_technician": return id ? `/maintenance?m=${id}` : "/maintenance?view=no_action";
    case "request_pending": return id ? `/requests/${id}` : "/requests?view=pending_approval";
    case "request_preparing":
    case "request_ready_delivery": return id ? `/requests/${id}` : "/requests?view=warehouse";
    case "consumable_below_threshold": return id ? `/consumables/${id}` : "/consumables?view=below_reorder";
    case "stocktake_review": return id ? `/stocktakes?stocktake=${id}` : "/stocktakes";
    default: return "/dashboard";
  }
}

// بناء المرشّحين من البيانات الأصلية — نفس الشروط الموحدة حرفيًا.
export async function buildActionAlertCandidates(): Promise<{ candidates: Candidate[]; error: string | null }> {
  const sb = supabase();
  const [maint, reqs, consumables, stocktakes] = await Promise.all([
    collectRangePages((from, to) => sb.from("maintenance_records")
      .select("id,status,action_taken,technician_id,reported_at,next_due_date, asset:asset_id(asset_tag,name)")
      .in("status", ["open", "in_progress"]).order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("requests")
      .select("id,request_number,status,pickup_date").order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("consumables")
      .select("id,name,quantity_on_hand,reorder_level,is_active").eq("is_active", true).order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("stocktakes")
      .select("id,review_state,submitted_at,location:location_id(name)").eq("review_state", "submitted").order("id").range(from, to)),
  ]);
  const error = maint.error?.message ?? reqs.error?.message ?? consumables.error?.message ?? stocktakes.error?.message ?? null;
  if (error) return { candidates: [], error };

  return {
    candidates: deriveActionAlertCandidates({
      maintenance: (maint.data ?? []) as any[],
      consumables: (consumables.data ?? []) as any[],
      requests: (reqs.data ?? []) as any[],
      stocktakes: (stocktakes.data ?? []) as any[],
      todayISO: dateKeyInTimeZone(),
    }),
    error: null,
  };
}

// المزامنة: تُبنى المرشّحات ثم تُرسل للـRPC (upsert + reopen + auto_resolve). ops فقط.
export async function syncActionAlerts(): Promise<string | null> {
  const { candidates, error } = await buildActionAlertCandidates();
  if (error) return error;
  const { data, error: rpcErr } = await supabase().rpc("action_alerts_sync", { p_candidates: candidates });
  if (rpcErr) return rpcErr.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

export async function listActionAlertsPage(input: {
  cursor?: DescTimeCursor | null;
  pageSize?: number;
  filters?: {
    tab?: "needsAction" | "inProgress" | "mine" | "resolved";
    type?: string;
    severity?: ActionAlertSeverity | "";
    assignedTo?: string | null;
  };
} = {}): Promise<CursorPage<ActionAlertInstance, DescTimeCursor>> {
  const pageSize = boundedPageSize(input.pageSize);
  const filters = input.filters ?? {};
  let query = supabase()
    .from("action_alert_instances")
    .select(
      "id,stable_key,alert_type,entity_type,entity_id,severity,status,assigned_to,assigned_at,first_seen_at,last_seen_at,auto_resolved_at,occurrence_count,last_action_at,metadata",
      { count: input.cursor ? undefined : "exact" },
    )
    .in("alert_type", [...ACTION_ALERT_TYPE_KEYS]);
  if (filters.tab === "needsAction") query = query.in("status", ["open", "reopened"]);
  else if (filters.tab === "inProgress") query = query.eq("status", "in_progress");
  else if (filters.tab === "resolved") query = query.eq("status", "auto_resolved");
  else if (filters.tab === "mine" && filters.assignedTo) {
    query = query.eq("assigned_to", filters.assignedTo).neq("status", "auto_resolved");
  }
  if (filters.type) query = query.eq("alert_type", filters.type);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (input.cursor) {
    const at = escapePostgrestValue(input.cursor.at);
    query = query.or(
      `last_seen_at.lt.${at},and(last_seen_at.eq.${at},id.lt.${input.cursor.id})`,
    );
  }
  const { data, error, count, status } = await query
    .order("last_seen_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);
  if (error !== null || status >= 400) return { rows: [], nextCursor: null, total: null, error: cursorReadErrorMessage(error?.message, "action_alert_list_failed") };
  if (!Array.isArray(data)) return { rows: [], nextCursor: null, total: null, error: "action_alert_list_shape_invalid" };
  const page = takeCursorPage(
    data as ActionAlertInstance[],
    pageSize,
    (row) => ({ at: row.last_seen_at, id: row.id }),
  );
  return { ...page, total: count ?? null, error: null };
}

export async function listActionAlerts(): Promise<{
  rows: ActionAlertInstance[];
  error: string | null;
  nextCursor: DescTimeCursor | null;
  total: number | null;
}> {
  return listActionAlertsPage();
}

export interface ActionAlertOperationalCounts {
  needs_action: number;
  high_severity: number;
  in_progress: number;
  mine: number;
  resolved: number;
  resolved_today: number;
}

export async function getActionAlertOperationalCounts(options: { signal?: AbortSignal } = {}): Promise<{
  counts: ActionAlertOperationalCounts | null;
  error: string | null;
}> {
  const query = supabase().rpc("action_alert_operational_counts");
  const { data, error } = await (options.signal ? query.abortSignal(options.signal) : query);
  return {
    counts: error ? null : data as unknown as ActionAlertOperationalCounts,
    error: error?.message ?? null,
  };
}

async function actionRpc(name: string, params: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase().rpc(name, params);
  if (error) return error.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

export const assignActionAlert = (id: string, userId: string | null) =>
  actionRpc("action_alert_assign", { p_id: id, p_user: userId });
export const startActionAlert = (id: string) =>
  actionRpc("action_alert_start", { p_id: id });
export const addActionAlertNote = (id: string, note: string) =>
  actionRpc("action_alert_note", { p_id: id, p_note: note });

// أسماء المسندين (uuid → label) عبر user_label الآمنة — بلا أي بيانات إضافية.
export async function resolveUserLabels(ids: string[], options: { requireComplete?: boolean } = {}): Promise<Map<string, string>> {
  const sb = supabase();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const map = new Map<string, string>();
  if (uniq.length === 0) return map;
  const { data, error } = await sb.rpc("user_labels", { p_ids: uniq });
  if (error) {
    reportOperationalFailure("action_center_user_labels_failed", error);
    if (options.requireComplete) throw new Error(error.message);
  }
  for (const row of (data ?? []) as { id: string; label: string | null }[]) {
    if (row.label) map.set(row.id, row.label);
  }
  return map;
}
