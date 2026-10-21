import { createClient } from "@/lib/supabase/client";
import { reportOperationalFailure } from "@/lib/observability";
import { readFinancialBatches } from "@/lib/financial-projection";
import { collectReportRangePages } from "@/lib/report-range-pages";
import { isAssetInventoryRow } from "@/lib/asset-inventory-row";
import type { ReportAssetProjection } from "@/lib/report-load-plan";
import { consumableStockMove } from "@/lib/idempotent-stock-move";
import type { AssetInventoryRow, AssetRow, AssetStatus, ConsumableRow } from "@/lib/types";
import { visibleLocations } from "@/lib/locations";
import { classifySignUpError, type SignUpErrorCode } from "@/lib/signup-error";
import {
  buildPageRanges,
  canFetchExactTrend,
  maintenanceTrendSince,
  type MaintenanceTrendRow,
} from "@/lib/dashboard-trends";
import type { DashboardExactSummary } from "@/lib/dashboard-v2";
import {
  boundedPageSize,
  cursorReadErrorMessage,
  collectRangePages,
  escapePostgrestValue,
  postgrestIlikeContains,
  takeCursorPage,
  type AscTextCursor,
  type CursorPage,
  type DescTimeCursor,
} from "@/lib/pagination";
import type {
  AssetViewKey,
  MaintenanceViewKey,
} from "@/lib/alert-predicates";
import type { FinancialMetric } from "@/lib/financial-truth";
import {
  buildAttachmentObjectName,
  inferAttachmentMime,
  sanitizeAttachmentFileName,
  validateAttachmentContent,
} from "@/lib/attachment-files";

const supabase = () => createClient();

// حركة مخزون المستهلكات ذرّيًا عبر RPC (قفل صف + منع رصيد سالب على مستوى DB).
// يُترجم رموز أخطاء الدالة إلى رسائل عربية واضحة للمستخدم.

// ---------- options for forms ----------
export async function getFormOptions() {
  const sb = supabase();
  const [cats, models, locs, deps, emps, sups, supCats, comps, pools] = await Promise.all([
    sb.from("categories").select("id,name,name_ar,prefix,kind").order("name"),
    sb.from("models").select("id,brand,model_name,category_id").order("brand"),
    sb.from("locations").select("id,name,name_ar,code").order("name"),
    sb.from("departments").select("id,name,name_ar,code").order("name"),
    sb.from("employees").select("id,full_name,full_name_ar,employee_no").eq("is_active", true).order("full_name"),
    sb.from("suppliers").select("id,name,name_ar").eq("is_active", true).order("name"),
    sb.from("supplier_categories").select("supplier_id,category_id"),
    // الشركات/العلامات (Company) — تُدار من الإعدادات؛ نعرض المفعّلة فقط في النماذج.
    sb.from("companies").select("id,name").eq("is_active", true).order("name"),
    // مجموعات الأصول (Asset Pools) — المفعّلة فقط في النماذج/الفلاتر.
    sb.from("asset_pools").select("id,name,name_ar,category_id,company_id").eq("is_active", true).order("name"),
  ]);
  return {
    categories: cats.data ?? [],
    models: models.data ?? [],
    locations: visibleLocations(locs.data ?? []), // إخفاء «الفرع 1/2» من قوائم الواجهة
    departments: deps.data ?? [],
    employees: emps.data ?? [],
    suppliers: sups.data ?? [],
    companies: (comps.data ?? []) as { id: string; name: string }[],
    pools: (pools.data ?? []) as { id: string; name: string; name_ar: string | null; category_id: string | null; company_id: string | null }[],
    // ربط المورد بالتصنيفات (Phase 6) — لتصفية قائمة الموردين حسب تصنيف الأصل المختار.
    supplierCategories: (supCats.data ?? []) as { supplier_id: string; category_id: string }[],
    error: cats.error || models.error || locs.error || deps.error || emps.error || sups.error || supCats.error || comps.error || pools.error || null,
  };
}

// ---------- create asset ----------
export interface NewAsset {
  category_id: string;
  model_id: string | null;
  serial_number: string | null;
  name: string | null;
  status: AssetStatus;
  location_id: string | null;
  department_id: string | null;
  assigned_to_employee_id: string | null;
  purchase_date: string | null;
  purchase_cost: number | null;
  warranty_end: string | null;
  supplier_id: string | null;
  company_id: string | null;
  pool_id: string | null;
  rfid_tag: string | null;
  notes: string | null;
  // حقول خاصة بنوع الأصل (قوالب) تُخزَّن داخل special_attributes — اختيارية.
  special_attributes?: Record<string, unknown> | null;
}

export async function createAsset(input: NewAsset) {
  const { data, error } = await supabase().rpc("asset_create_atomic", { p_input: input });
  if (error) return { error: error.message, id: null as string | null };
  const result = data as { ok?: boolean; id?: string; error?: string } | null;
  return result?.ok && result.id
    ? { error: null, id: result.id }
    : { error: result?.error ?? "فشل الحفظ", id: null as string | null };
}

// ---------- إضافة بيانات مرجعية سريعة من داخل النماذج (موديل/مورد/موقع) ----------
// RLS يسمح بـ INSERT لـ admin/it_manager/technician فقط (سياسة ins_ops). الفشل يُعاد كرسالة واضحة.
export async function createModel(p: { categoryId: string; brand: string; modelName: string }) {
  const sb = supabase();
  const { data, error } = await sb
    .from("models")
    .insert({ category_id: p.categoryId, brand: p.brand.trim(), model_name: p.modelName.trim() })
    .select("id,brand,model_name,category_id")
    .single();
  if (error || !data) return { error: error?.message ?? "فشل حفظ الموديل", row: null as any };
  return { error: null as string | null, row: data };
}

export async function createSupplier(p: { name: string }) {
  const sb = supabase();
  const name = p.name.trim();
  const { data, error } = await sb
    .from("suppliers")
    .insert({ name, name_ar: name })
    .select("id,name,name_ar")
    .single();
  if (error || !data) return { error: error?.message ?? "فشل حفظ المورد", row: null as any };
  return { error: null as string | null, row: data };
}

export async function createLocation(p: { name: string }) {
  const sb = supabase();
  const name = p.name.trim();
  const { data, error } = await sb
    .from("locations")
    .insert({ name, name_ar: name })
    .select("id,name,name_ar,code")
    .single();
  if (error || !data) return { error: error?.message ?? "فشل حفظ الموقع", row: null as any };
  return { error: null as string | null, row: data };
}

// ---------- update asset (edit details) ----------
export interface AssetPatch {
  name: string | null;
  category_id: string;
  model_id: string | null;
  serial_number: string | null;
  status: AssetStatus;
  location_id: string | null;
  department_id: string | null;
  supplier_id: string | null;
  company_id: string | null;
  pool_id: string | null;
  rfid_tag: string | null;
  purchase_date: string | null;
  // HIGH-1: عمود مالي محجوب على مستوى العمود؛ يُمرَّر فقط من مخوّل مالي (وإلا يُحذف من الـ patch
  // تفاديًا لمسحه بالخطأ من غير المخوّل الذي لا يراه أصلًا).
  purchase_cost?: number | null;
  warranty_end: string | null;
  condition_grade: string | null;
  notes: string | null;
  special_attributes: Record<string, unknown>;
}

// يحدّث بيانات الأصل؛ ويُسجّل حركة تغيير حالة فقط إذا تغيّرت الحالة.
// التدقيق (audit_logs) يُكتب تلقائيًا عبر محفّز القاعدة. الحالة محكومة بآلة الحالات في القاعدة.
export async function updateAsset(assetId: string, prevStatus: AssetStatus, input: AssetPatch) {
  void prevStatus; // المصدر الموثوق للحالة السابقة هو الصف المقفول داخل RPC.
  return assetRpc("asset_update_atomic", { p_asset_id: assetId, p_input: input });
}

// ===== HIGH-1: حماية الأعمدة المالية عبر API =====
// الأعمدة المالية (المبالغ/النسب) محجوبة على مستوى العمود في DB لغير admin/it_manager.
// نجلبها للمخوّلين عبر RPCs آمنة (SECURITY DEFINER, self-gated) ونُدمجها في الصفوف بمفتاح id.
// لغير المخوّلين تُرجع RPC صفرًا من الصفوف ⇒ تبقى الحقول المالية غائبة (تُخفيها الواجهة عبر canSeeFinancial).
async function mergeFinancial<T extends Record<string, any>>(
  rows: T[], rpc: string, cols: string[], params: Record<string, unknown> | undefined,
  enabled = true,
  options: { strict?: boolean; signal?: AbortSignal } = {},
): Promise<T[]> {
  if (!enabled || !rows.length) return rows;
  const sb = supabase();
  const read = (args: Record<string, unknown> | undefined) => {
    const query = sb.rpc(rpc, args);
    return options.signal ? query.abortSignal(options.signal) : query;
  };
  const { data, error } = Array.isArray(params?.p_ids)
    ? await readFinancialBatches<any>(params.p_ids, (ids) => read({ ...params, p_ids: ids }), options.signal)
    : await collectRangePages<any>((from, to) => {
      const query = sb.rpc(rpc, params).order("id").range(from, to);
      return options.signal ? query.abortSignal(options.signal) : query;
    });
  if (error) {
    reportOperationalFailure("financial_projection_failed", error);
    if (options.strict) throw new Error(error.message || "financial_projection_failed");
    return rows;
  }
  const map = new Map<string, any>(((data ?? []) as any[]).map((d) => [d.id, d]));
  if (options.strict && rows.some((row) => !map.has(row.id))) {
    throw new Error("financial_projection_incomplete");
  }
  if (map.size) for (const r of rows) { const f = map.get((r as any).id); if (f) for (const c of cols) (r as any)[c] = f[c]; }
  return rows;
}
// قوائم أعمدة صريحة بلا الأعمدة المالية (بديل عن "*" بعد الحجب على مستوى العمود).
const ASSET_COLS_NOFIN =
  "id,asset_tag,qr_token,category_id,model_id,serial_number,name,status,condition_grade,supplier_id," +
  "location_id,department_id,assigned_to_employee_id,purchase_date,currency,warranty_end,lifespan_months," +
  "notes,special_attributes,is_active,created_by,created_at,updated_at,company_id,rfid_tag,pool_id," +
  // عدّادات تتبّع الطلبات/الإرجاع (غير مالية — ممنوحة select صراحةً في الترحيل)
  "times_checked_out,unsound_return_count,last_request_id,last_return_condition,last_out_at,last_return_at";
const MAINT_COLS_NOFIN =
  "id,asset_id,type,status,reported_at,started_at,completed_at,reported_by,technician_id," +
  "vendor_supplier_id,problem_description,action_taken,currency,outcome,downtime_hours,next_due_date," +
  "created_at,updated_at,priority,problem_type,workflow_stage,reported_by_employee_id," +
  "final_summary,vendor_name,vendor_phone,vendor_location,vendor_map_link,handoff_notes,receiver_name," +
  "diagnosis,cause_code,resolution_code,waiting_reason,labor_minutes,escalation_level,escalated_at,sla_due_at,sla_breached_at," +
  "repair_checklist,functional_test_passed,functional_test_notes,completed_by,handoff_state";

// ---------- asset detail + logs ----------
const ASSET_SELECT =
  ASSET_COLS_NOFIN + ", category:category_id(name,name_ar,prefix), model:model_id(brand,model_name), " +
  "location:location_id(name,name_ar,code), department:department_id(name,name_ar), " +
  "supplier:supplier_id(name,name_ar), company:company_id(name), pool:pool_id(name,name_ar), " +
  "holder:assigned_to_employee_id(full_name,full_name_ar,employee_no)";
// The list, quick view, illustrations and operational CSV need this projection.
// Keep ASSET_SELECT above for full details and logs.
const ASSET_INVENTORY_SELECT =
  "id,asset_tag,qr_token,name,serial_number,status,category_id,location_id,company_id,special_attributes,pool_id,last_return_condition,category:category_id(name,name_ar),model:model_id(brand,model_name),location:location_id(name,name_ar),holder:assigned_to_employee_id(full_name,full_name_ar),company:company_id(name),pool:pool_id(name,name_ar)";
const ATTACHMENT_NOFIN_SELECT =
  "id,entity_type,entity_id,file_name,storage_path,mime_type,size_bytes,kind,classification,scan_status,created_at";

export async function getAsset(id: string, includeFinancial = true) {
  const sb = supabase();
  const { data, error } = await sb.from("assets").select(ASSET_SELECT).eq("id", id).single();
  if (data) await mergeFinancial([data as any], "assets_financial", ["purchase_cost"], { p_ids: [id] }, includeFinancial);
  return { asset: data, error: error?.message ?? null };
}

export async function getAssetLogs(id: string, includeFinancial = true) {
  const sb = supabase();
  const [assignments, maintenance, movements, attachments] = await Promise.all([
    sb.from("asset_assignments").select("id,asset_id,employee_id,assigned_by,assigned_at,due_return_date,returned_at,return_condition,status,notes,created_at,updated_at, employee:employee_id(full_name,full_name_ar,employee_no)").eq("asset_id", id).order("assigned_at", { ascending: false }),
    sb.from("maintenance_records").select(MAINT_COLS_NOFIN + ", reporter:reported_by_employee_id(full_name_ar,full_name)").eq("asset_id", id).order("reported_at", { ascending: false }),
    sb.from("asset_movements").select("id,asset_id,movement_type,from_location_id,to_location_id,from_employee_id,to_employee_id,from_status,to_status,performed_by,note,created_at, to_loc:to_location_id(name_ar,name), to_emp:to_employee_id(full_name_ar,full_name)").eq("asset_id", id).order("created_at", { ascending: false }),
    sb.from("attachments").select(ATTACHMENT_NOFIN_SELECT).eq("entity_type", "asset").eq("entity_id", id).order("created_at", { ascending: false }),
  ]);
  const maint = (maintenance.data ?? []) as any[];
  await mergeFinancial(
    maint,
    "maintenance_financial_truth",
    ["cost", "cost_recorded", "currency", "invoice_number", "invoice_date"],
    { p_ids: maint.map((m) => m.id) },
    includeFinancial,
  );
  return {
    assignments: assignments.data ?? [],
    maintenance: maint,
    movements: movements.data ?? [],
    attachments: attachments.data ?? [],
  };
}

// الأجهزة الراجعة غير السليمة التي ما زالت في الصيانة (متابعة مدير المستودع).
// يستمر ظهورها حتى تُصلَح (in_maintenance → available). أعمدة غير مالية فقط.
export async function listUnsoundReturnedAssets() {
  const sb = supabase();
  const { data, error } = await collectRangePages((from, to) => sb.from("assets")
    .select("id,asset_tag,name,serial_number,status,last_return_condition,last_return_at,last_request_id")
    .eq("status", "in_maintenance")
    .in("last_return_condition", ["unsound", "needs_maintenance"])
    .order("last_return_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  return { rows: (data ?? []) as any[], error: error?.message ?? null };
}

// سجل خروج الأصل في الطلبات — لأي طلب/عميل/موظف خرج، متى سُلّم/أُرجع (بلا أي حقل مالي).
export async function getAssetRequestHistory(assetId: string) {
  const sb = supabase();
  const { data, error } = await sb.from("request_items")
    .select("delivered_quantity,returned_quantity,created_at," +
      "request:request_id(id,request_number,status,request_type,beneficiary_type,delivered_at,returned_at," +
      "customer_name_snapshot,customer:customer_id(name),beneficiary_employee:beneficiary_employee_id(full_name,full_name_ar))")
    .eq("asset_id", assetId).eq("item_kind", "asset")
    .order("created_at", { ascending: false }).limit(200);
  const rows = ((data ?? []) as any[])
    .map((r) => (r.request ? { ...r.request, delivered_quantity: r.delivered_quantity, returned_quantity: r.returned_quantity } : null))
    .filter(Boolean);
  return { rows: rows as any[], error: error?.message ?? null };
}

// ---------- operations ----------
// عمليات العهدة/الحالة كلها عبر RPC خادمي ذرّي (SECURITY DEFINER + معاملة واحدة):
// قفل صف الأصل + تحقق الدور وآلة الحالات + كل الكتابات معًا أو تراجع كامل.
async function assetRpc(name: string, params: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase().rpc(name, params);
  if (error) return error.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

export function assignAsset(p: { assetId: string; employeeId: string; dueDate: string | null }) {
  return assetRpc("asset_assign", {
    p_asset_id: p.assetId, p_employee_id: p.employeeId, p_due_date: p.dueDate,
  });
}

export function returnAsset(p: { assetId: string; condition: string | null }) {
  return assetRpc("asset_return", { p_asset_id: p.assetId, p_condition: p.condition });
}

export async function moveAsset(p: {
  assetId: string; toLocationId: string; fromLocationId: string | null; toDepartmentId: string | null;
}) {
  void p.fromLocationId; // المصدر الموثوق هو صف الأصل المقفول داخل RPC.
  return assetRpc("asset_move_atomic", {
    p_asset_id: p.assetId,
    p_to_location_id: p.toLocationId,
    p_to_department_id: p.toDepartmentId,
  });
}

export function changeStatus(p: { assetId: string; toStatus: AssetStatus }) {
  return assetRpc("asset_change_status", { p_asset_id: p.assetId, p_to_status: p.toStatus });
}

// إسناد فنيّ لسجل صيانة عبر RPC ذاتية التفويض؛ بلا userId = «أسندها لي».
// الإسناد يُعتبر إجراء متابعة: يُخرج السجل من تنبيه «صيانة مفتوحة بلا إجراء».
export async function assignMaintenanceTechnician(
  recordId: string, userId?: string | null,
): Promise<string | null> {
  return assetRpc("maintenance_assign_technician", {
    p_id: recordId,
    p_technician_id: userId ?? null,
  });
}

// «قوائم العمل»: تحديث الرقم التسلسلي فقط عبر RPC مقفلة؛ وaudit trigger يسجّله
// كأي تعديل أصل.
export async function updateAssetSerial(assetId: string, serial: string): Promise<string | null> {
  const s = serial.trim();
  if (!s) return "empty";
  return assetRpc("asset_set_serial", { p_asset_id: assetId, p_serial: s });
}

// إعفاء موثق من الرقم التسلسلي — trigger الخادم يقصره على admin/it_manager،
// يفرض سببًا إجباريًا عند الإعفاء، ويختم من/متى بنفسه.
export async function setAssetSerialExempt(
  assetId: string, exempt: boolean, reason?: string,
): Promise<string | null> {
  return assetRpc("asset_set_serial_exempt", {
    p_asset_id: assetId,
    p_exempt: exempt,
    p_reason: exempt ? (reason ?? "").trim() : null,
  });
}

export interface MaintInput {
  type: string; workflowStage: string; priority: string; problemType: string;
  problem: string | null; action: string | null; cost?: number | null; invoiceNumber?: string | null;
  finalSummary: string | null; nextDue: string | null;
  // Phase 5 — بيانات جهة الصيانة الخارجية / المحل (كلها اختيارية، nullable للسجلات القديمة).
  vendorSupplierId?: string | null; // ربط اختياري بمورد مُسجَّل
  vendorName?: string | null;
  vendorPhone?: string | null;
  vendorLocation?: string | null;
  vendorMapLink?: string | null;
  invoiceDate?: string | null;
  handoffNotes?: string | null;
  receiverName?: string | null;
  diagnosis?: string | null;
  causeCode?: string | null;
  resolutionCode?: string | null;
  waitingReason?: string | null;
  laborMinutes?: number;
  repairChecklist?: {
    safety_checked: boolean;
    function_checked: boolean;
    data_checked: boolean;
  };
  functionalTestPassed?: boolean | null;
  functionalTestNotes?: string | null;
}

// تحويل أسماء واجهة الصيانة إلى عقد RPC صريح، بلا تمرير حالة الأصل من المتصفح.
function maintenanceRpcPayload(p: MaintInput): Record<string, unknown> {
  return {
    type: p.type,
    workflow_stage: p.workflowStage,
    priority: p.priority,
    problem_type: p.problemType,
    problem_description: p.problem,
    action_taken: p.action,
    ...(Object.prototype.hasOwnProperty.call(p, "cost") ? { cost: p.cost ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "invoiceNumber") ? { invoice_number: p.invoiceNumber ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "invoiceDate") ? { invoice_date: p.invoiceDate ?? null } : {}),
    final_summary: p.finalSummary,
    next_due_date: p.nextDue,
    vendor_supplier_id: p.vendorSupplierId ?? null,
    vendor_name: p.vendorName ?? null,
    vendor_phone: p.vendorPhone ?? null,
    vendor_location: p.vendorLocation ?? null,
    vendor_map_link: p.vendorMapLink ?? null,
    handoff_notes: p.handoffNotes ?? null,
    receiver_name: p.receiverName ?? null,
    ...(Object.prototype.hasOwnProperty.call(p, "diagnosis") ? { diagnosis: p.diagnosis ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "causeCode") ? { cause_code: p.causeCode ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "resolutionCode") ? { resolution_code: p.resolutionCode ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "waitingReason") ? { waiting_reason: p.waitingReason ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "laborMinutes") ? { labor_minutes: p.laborMinutes ?? 0 } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "repairChecklist") ? { repair_checklist: p.repairChecklist } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "functionalTestPassed") ? { functional_test_passed: p.functionalTestPassed } : {}),
    ...(Object.prototype.hasOwnProperty.call(p, "functionalTestNotes") ? { functional_test_notes: p.functionalTestNotes ?? null } : {}),
  };
}

export async function addMaintenance(p: MaintInput & {
  assetId: string; assetStatus: AssetStatus; reporterEmployeeId: string | null;
}) {
  void p.assetStatus;
  const { data, error } = await supabase().rpc("maintenance_create_atomic", {
    p_input: {
      ...maintenanceRpcPayload(p),
      asset_id: p.assetId,
      reported_by_employee_id: p.reporterEmployeeId,
    },
  });
  if (error) return { error: error.message, id: null as string | null, warning: null as string | null };
  const result = data as { ok?: boolean; id?: string; error?: string } | null;
  return result?.ok && result.id
    ? { error: null as string | null, id: result.id, warning: null as string | null }
    : { error: result?.error ?? "فشل الحفظ", id: null as string | null, warning: null as string | null };
}

export async function updateMaintenance(id: string, assetId: string, assetStatus: AssetStatus, p: MaintInput) {
  void assetId;
  void assetStatus;
  const error = await assetRpc("maintenance_update_safe", {
    p_id: id,
    p_input: maintenanceRpcPayload(p),
    p_operation_id: crypto.randomUUID(),
  });
  return { error, warning: null as string | null };
}

export async function addMaintenanceTimeEntry(input: {
  maintenanceId: string;
  startedAt: string;
  endedAt: string;
  note?: string | null;
}) {
  const error = await assetRpc("maintenance_add_time_entry", {
    p_maintenance_id: input.maintenanceId,
    p_started_at: input.startedAt,
    p_ended_at: input.endedAt,
    p_note: input.note ?? null,
    p_operation_id: crypto.randomUUID(),
  });
  return error;
}

export async function planMaintenancePart(input: {
  maintenanceId: string;
  consumableId?: string | null;
  description?: string | null;
  plannedQuantity: number;
}) {
  const error = await assetRpc("maintenance_plan_part", {
    p_maintenance_id: input.maintenanceId,
    p_consumable_id: input.consumableId ?? null,
    p_description: input.description ?? null,
    p_planned_quantity: input.plannedQuantity,
    p_operation_id: crypto.randomUUID(),
  });
  return error;
}

export async function confirmMaintenanceHandoff(maintenanceId: string) {
  return assetRpc("maintenance_confirm_handoff", {
    p_id: maintenanceId,
    p_operation_id: crypto.randomUUID(),
  });
}

type AttachmentClassification = "internal" | "financial";

async function uploadClassifiedAttachment(args: {
  root: "assets" | "consumables" | "maintenance";
  entityType: "asset" | "consumable" | "maintenance";
  entityId: string;
  file: File;
  kind: string;
  classification: AttachmentClassification;
}): Promise<string | null> {
  const validation = await validateAttachmentContent(args.file);
  if (validation) return validation;

  const client = supabase();
  const path = buildAttachmentObjectName(
    args.root,
    args.entityId,
    args.kind,
    args.file.name,
  );
  const { error: uploadError } = await client.storage
    .from("attachments")
    .upload(path, args.file, {
      contentType: inferAttachmentMime(args.file),
      upsert: false,
    });
  if (uploadError) return uploadError.message;

  const { error: metadataError } = await client.from("attachments").insert({
    entity_type: args.entityType,
    entity_id: args.entityId,
    file_name: args.file.name,
    storage_path: path,
    mime_type: inferAttachmentMime(args.file),
    size_bytes: args.file.size,
    kind: args.kind,
    classification: args.classification,
  });
  if (!metadataError) return null;

  const { error: cleanupError } = await client.storage
    .from("attachments")
    .remove([path]);
  if (cleanupError) {
    console.error("attachment_cleanup_failed", {
      bucket: "attachments",
      error: cleanupError.message,
    });
  }
  return metadataError.message;
}

// رفع مرفق صيانة مع subtype وتصنيف مالي صريحين. الخادم يعيد اشتقاق
// classification من kind ولا يثق بقيمة العميل.
export async function uploadMaintenanceAttachment(
  maintId: string,
  file: File,
  kind: "device_photo" | "invoice" | "other",
) {
  const normalizedKind = kind === "invoice" ? "maintenance_invoice" : kind;
  return uploadClassifiedAttachment({
    root: "maintenance",
    entityType: "maintenance",
    entityId: maintId,
    file,
    kind: normalizedKind,
    classification: kind === "invoice" ? "financial" : "internal",
  });
}

// رفع مرفق على مستوى الأصل نفسه (منفصل عن مرفقات الصيانة) ووسمه عبر kind.
// kind: asset_photo (صورة الجهاز التوثيقية) · warranty_invoice · purchase_invoice · other.
// التخزين خاص (bucket attachments) — تُعرض الملفات عبر روابط موقّتة فقط، ولا تظهر في Public QR.
export type AssetAttachmentKind = "asset_photo" | "warranty_invoice" | "purchase_invoice" | "other";
export async function uploadAssetAttachment(assetId: string, file: File, kind: AssetAttachmentKind) {
  return uploadClassifiedAttachment({
    root: "assets",
    entityType: "asset",
    entityId: assetId,
    file,
    kind,
    classification: kind === "warranty_invoice" || kind === "purchase_invoice"
      ? "financial"
      : "internal",
  });
}

export type ConsumableAttachmentKind = "consumable_photo" | "consumable_invoice" | "replenishment_invoice" | "other";
export async function uploadConsumableAttachment(consumableId: string, file: File, kind: ConsumableAttachmentKind) {
  return uploadClassifiedAttachment({
    root: "consumables",
    entityType: "consumable",
    entityId: consumableId,
    file,
    kind,
    classification: kind === "consumable_invoice" || kind === "replenishment_invoice"
      ? "financial"
      : "internal",
  });
}

// ---------- consumables ----------
export interface InventoryPageFilters {
  q?: string;
  categoryId?: string;
  status?: string;
  locationId?: string;
  companyId?: string;
  poolId?: string;
  view?: AssetViewKey | null;
}

export async function listAssetsPage(input: {
  signal?: AbortSignal;
  cursor?: AscTextCursor | null;
  pageSize?: number;
  filters?: InventoryPageFilters;
} = {}): Promise<CursorPage<AssetInventoryRow, AscTextCursor>> {
  const sb = supabase();
  const pageSize = boundedPageSize(input.pageSize);
  const filters = input.filters ?? {};
  let query = sb.from("assets")
    .select(ASSET_INVENTORY_SELECT, { count: input.cursor ? undefined : "exact" })
    .eq("is_active", true);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.status) query = query.eq("status", filters.status as AssetStatus);
  if (filters.locationId) query = query.eq("location_id", filters.locationId);
  if (filters.companyId) query = query.eq("company_id", filters.companyId);
  if (filters.poolId) query = query.eq("pool_id", filters.poolId);
  if (filters.q?.trim()) {
    const pattern = postgrestIlikeContains(filters.q);
    query = query.or(
      `asset_tag.ilike.${pattern},name.ilike.${pattern},serial_number.ilike.${pattern}`,
    );
  }
  query = query.is("archived_at", null);
  switch (filters.view) {
    case "maintenance_attention": query = query.eq("status", "in_maintenance"); break;
    case "missing_location": query = query.is("location_id", null); break;
    case "no_qr": query = query.is("qr_token", null); break;
    case "unsound_return":
      query = query.eq("status", "in_maintenance")
        .in("last_return_condition", ["unsound", "needs_maintenance"]);
      break;
  }
  if (input.cursor) {
    // asset_tag has a unique database constraint, so it is itself a complete
    // cursor. Avoid an OR tie-break predicate that forces deep index filtering.
    query = query.gt("asset_tag", input.cursor.value);
  }
  if (input.signal) query = query.abortSignal(input.signal);
  const { data, error, count, status } = await query
    .order("asset_tag", { ascending: true })
    .limit(pageSize + 1)
    // Each selected foreign key embeds one object or NULL. Validate the actual
    // response below; this override never claims omitted full-detail fields.
    .returns<AssetInventoryRow[]>();
  if (error !== null || status >= 400) return { rows: [], nextCursor: null, total: null, error: cursorReadErrorMessage(error?.message, "asset_inventory_read_failed") };
  if (!Array.isArray(data) || !data.every(isAssetInventoryRow)) {
    return { rows: [], nextCursor: null, total: null, error: "asset_inventory_shape_invalid" };
  }
  const page = takeCursorPage(
    data,
    pageSize,
    (row) => ({ value: row.asset_tag ?? "", id: row.id }),
  );
  return { ...page, total: count ?? null, error: null };
}

/**
 * Active-asset totals by primary status for read-only overviews (viewer/auditor).
 * Head-only exact counts on the same non-financial `id` column and base filters as
 * listAssetsPage — no rows are returned and RLS stays the authority.
 */
export async function getAssetStatusCounts(): Promise<{
  counts: { total: number; available: number; reserved: number; in_maintenance: number } | null;
  error: string | null;
}> {
  const sb = supabase();
  const base = () => sb.from("assets").select("id", { count: "exact", head: true })
    .eq("is_active", true).is("archived_at", null);
  const [all, available, reserved, maintenance] = await Promise.all([
    base(),
    base().eq("status", "available"),
    base().eq("status", "reserved"),
    base().eq("status", "in_maintenance"),
  ]);
  const failed = [all, available, reserved, maintenance].find((r) => r.error);
  // HEAD responses carry no body, so a denied count can surface with an empty message;
  // never let that read as success (the overview would show "—" forever).
  if (failed?.error) return { counts: null, error: failed.error.message || failed.error.code || "asset_counts_failed" };
  return {
    counts: {
      total: all.count ?? 0,
      available: available.count ?? 0,
      reserved: reserved.count ?? 0,
      in_maintenance: maintenance.count ?? 0,
    },
    error: null,
  };
}

export interface ConsumablePageFilters {
  q?: string;
  categoryId?: string;
  locationId?: string;
  companyId?: string;
}

export async function listConsumablesPage(input: {
  signal?: AbortSignal;
  cursor?: AscTextCursor | null;
  pageSize?: number;
  filters?: ConsumablePageFilters;
  includeFinancial?: boolean;
} = {}): Promise<CursorPage<ConsumableRow, AscTextCursor>> {
  const sb = supabase();
  const pageSize = boundedPageSize(input.pageSize);
  const filters = input.filters ?? {};
  let query = sb
    .from("consumables")
    .select(
      "id,name,brand,sku,rfid_tag,unit,quantity_on_hand,reorder_level,category_id,company_id,supplier_id,location_id,notes, category:category_id(name,name_ar), company:company_id(name), location:location_id(name,name_ar,code)",
      { count: input.cursor ? undefined : "exact" },
    )
    .eq("is_active", true);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.locationId) query = query.eq("location_id", filters.locationId);
  if (filters.companyId) query = query.eq("company_id", filters.companyId);
  if (filters.q?.trim()) {
    const pattern = postgrestIlikeContains(filters.q);
    query = query.or(`name.ilike.${pattern},sku.ilike.${pattern},rfid_tag.ilike.${pattern}`);
  }
  if (input.cursor) {
    const value = escapePostgrestValue(input.cursor.value);
    query = query.or(
      `name.gt.${value},and(name.eq.${value},id.gt.${input.cursor.id})`,
    );
  }
  if (input.signal) query = query.abortSignal(input.signal);
  const { data, error, count, status } = await query
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(pageSize + 1);
  if (error !== null || status >= 400) return { rows: [], nextCursor: null, total: null, error: cursorReadErrorMessage(error?.message, "consumable_inventory_read_failed") };
  if (!Array.isArray(data) || data.some((row) => {
    const location: unknown = row?.location;
    if (location === null) return false;
    return !location || typeof location !== "object" || Array.isArray(location)
      || !("name" in location) || typeof location.name !== "string"
      || !("name_ar" in location) || (location.name_ar !== null && typeof location.name_ar !== "string")
      || !("code" in location) || (location.code !== null && typeof location.code !== "string");
  })) return { rows: [], nextCursor: null, total: null, error: "consumable_inventory_location_invalid" };
  const rows = data as unknown as ConsumableRow[];
  await mergeFinancial(
    rows,
    "consumables_financial",
    ["unit_cost"],
    { p_ids: rows.map((c) => c.id) },
    input.includeFinancial !== false,
    { signal: input.signal },
  );
  const page = takeCursorPage(
    rows,
    pageSize,
    (row) => ({ value: row.name, id: row.id }),
  );
  return { ...page, total: count ?? null, error: null };
}

export async function listConsumables() {
  const page = await listConsumablesPage();
  return { rows: page.rows, error: page.error, nextCursor: page.nextCursor, total: page.total };
}

// مدخلات المستهلك الكاملة (بروفايل كامل مثل الأصل لكن بسلوك مخزون)
export interface ConsumableInput {
  category_id: string; name: string; sku: string | null; brand: string | null;
  unit: string; reorder_level: number; quantity_on_hand: number;
  company_id: string | null; supplier_id: string | null; location_id: string | null;
  unit_cost: number | null; rfid_tag: string | null; notes: string | null;
}

export async function createConsumable(p: {
  category_id: string; name: string; sku: string | null; unit: string;
  quantity_on_hand: number; reorder_level: number; unit_cost: number | null;
  company_id: string | null; rfid_tag?: string | null;
}) {
  const { data, error } = await supabase().rpc("consumable_create_with_opening_stock", { p_input: p });
  if (error) return error.message;
  const result = data as { ok?: boolean; error?: string } | null;
  return result?.ok ? null : (result?.error ?? "فشل الحفظ");
}

// إنشاء مستهلك كامل (يُعيد المعرّف لإتمام رفع الصورة/أول توريد ثم فتح البروفايل).
export async function createConsumableFull(p: ConsumableInput): Promise<{ error: string | null; id: string | null }> {
  const { data, error } = await supabase().rpc("consumable_create_with_opening_stock", { p_input: p });
  if (error) return { error: error.message, id: null };
  const result = data as { ok?: boolean; id?: string; error?: string } | null;
  return result?.ok && result.id
    ? { error: null, id: result.id }
    : { error: result?.error ?? "فشل الحفظ", id: null };
}

// ---------- CSV import (Batch 2B) ----------
// الأمان في RPC import_inventory (يعيد التحقق + يصفّر الماليات لغير المخوّل). هنا التغليف فقط.
export interface ImportResult { ok: boolean; assets: number; consumables: number; error: string | null; }

export async function importInventory(items: unknown[]): Promise<ImportResult> {
  const sb = supabase();
  const { data, error } = await sb.rpc("import_inventory", { p_items: items });
  if (error) return { ok: false, assets: 0, consumables: 0, error: error.message };
  const r = data as { ok?: boolean; assets?: number; consumables?: number } | null;
  return { ok: !!r?.ok, assets: r?.assets ?? 0, consumables: r?.consumables ?? 0, error: r?.ok ? null : "failed" };
}

// معرّفات موجودة لكشف التكرار أثناء الفحص المسبق (dry-run). الحارس النهائي = فهارس القاعدة الفريدة.
export async function getExistingIdentifiers(): Promise<{ serials: Set<string>; rfids: Set<string>; skus: Set<string> }> {
  const sb = supabase();
  const [a, c] = await Promise.all([
    collectRangePages((from, to) => sb.from("assets")
      .select("serial_number,rfid_tag").eq("is_active", true)
      .order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("consumables")
      .select("sku,rfid_tag").eq("is_active", true)
      .order("id").range(from, to)),
  ]);
  const serials = new Set<string>(); const rfids = new Set<string>(); const skus = new Set<string>();
  const add = (set: Set<string>, v: unknown) => { if (v != null && String(v).trim() !== "") set.add(String(v).toLowerCase()); };
  for (const r of (a.data ?? []) as any[]) { add(serials, r.serial_number); add(rfids, r.rfid_tag); }
  for (const r of (c.data ?? []) as any[]) { add(skus, r.sku); add(rfids, r.rfid_tag); }
  return { serials, rfids, skus };
}

export async function stockTxn(p: {
  consumableId: string; type: "in" | "out"; quantity: number; current: number; reason: string | null; operationId?: string;
}) {
  // ذرّي عبر RPC: الرصيد يُحسب من القاعدة تحت قفل الصف (p.current لم يعد مصدر الحقيقة).
  return consumableStockMove({
    consumableId: p.consumableId, type: p.type, quantity: p.quantity, reason: p.reason, operationId: p.operationId,
  });
}

// ---------- maintenance list ----------
// نُرفق بيانات الأصل المختصرة + المُبلِّغ حتى تعمل نافذة الصيانة دون استعلام إضافي لكل صف.
const MAINT_LIST_SELECT =
  MAINT_COLS_NOFIN + ", asset:asset_id(id,asset_tag,name,serial_number,status," +
  "category:category_id(name,name_ar), location:location_id(name,name_ar)," +
  "holder:assigned_to_employee_id(full_name,full_name_ar,employee_no))," +
  "reporter:reported_by_employee_id(full_name,full_name_ar)";

export interface MaintenancePageFilters {
  q?: string;
  status?: string;
  type?: string;
  problemType?: string;
  view?: MaintenanceViewKey | null;
  todayISO?: string;
  longBeforeISO?: string;
  technicianId?: string;
}

export async function listMaintenancePage(input: {
  signal?: AbortSignal;
  cursor?: DescTimeCursor | null;
  pageSize?: number;
  filters?: MaintenancePageFilters;
  includeFinancial?: boolean;
} = {}): Promise<CursorPage<any, DescTimeCursor>> {
  const sb = supabase();
  const pageSize = boundedPageSize(input.pageSize);
  const filters = input.filters ?? {};
  const searchTerm = filters.q?.trim() ?? "";
  let query = searchTerm
    ? sb.from("maintenance_search_index")
      .select("id,reported_at", { count: input.cursor ? undefined : "exact" })
    : sb.from("maintenance_records")
      .select(MAINT_LIST_SELECT, { count: input.cursor ? undefined : "exact" });
  if (filters.status) query = query.eq("status", filters.status as any);
  if (filters.type) query = query.eq("type", filters.type as any);
  if (filters.problemType) query = query.eq("problem_type", filters.problemType);
  if (filters.technicianId) query = query.eq("technician_id", filters.technicianId);
  if (searchTerm) {
    const pattern = postgrestIlikeContains(searchTerm);
    query = query.or(
      `problem_description.ilike.${pattern},asset_tag.ilike.${pattern},asset_name.ilike.${pattern},asset_serial_number.ilike.${pattern}`,
    );
  }
  const openStatuses = ["open", "in_progress"] as const;
  switch (filters.view) {
    case "no_action":
      query = query.in("status", openStatuses)
        .is("technician_id", null)
        .or("action_taken.is.null,action_taken.eq.");
      break;
    case "long_maint":
      query = query.in("status", openStatuses)
        .lt("reported_at", filters.longBeforeISO ?? new Date(Date.now() - 14 * 86_400_000).toISOString());
      break;
    case "past_due":
      query = query.in("status", openStatuses)
        .lt("next_due_date", filters.todayISO ?? new Date().toISOString().slice(0, 10));
      break;
    case "followup":
      query = query.in("status", openStatuses).or(
        `and(technician_id.is.null,action_taken.is.null),reported_at.lt.${filters.longBeforeISO ?? new Date(Date.now() - 14 * 86_400_000).toISOString()}`,
      );
      break;
  }
  if (input.cursor) {
    const at = escapePostgrestValue(input.cursor.at);
    query = query.or(
      `reported_at.lt.${at},and(reported_at.eq.${at},id.lt.${input.cursor.id})`,
    );
  }
  if (input.signal) query = query.abortSignal(input.signal);
  const { data, error, count, status } = await query
    .order("reported_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1)
    // Both selected sources contain the same cursor; retain all extra selected fields.
    .returns<{ id: string; reported_at: string }[]>();
  if (error !== null || status >= 400) return { rows: [], nextCursor: null, total: null, error: cursorReadErrorMessage(error?.message, "maintenance_inventory_read_failed") };
  if (!Array.isArray(data) || data.some(row => row === null || typeof row !== "object" || Array.isArray(row)
    || typeof row.id !== "string" || typeof row.reported_at !== "string")) {
    return { rows: [], nextCursor: null, total: null, error: "maintenance_inventory_shape_invalid" };
  }
  const page = takeCursorPage(
    data,
    pageSize,
    (row) => ({ at: row.reported_at, id: row.id }),
  );
  let rows = page.rows;
  if (searchTerm && page.rows.length) {
    const detailQuery = sb
      .from("maintenance_records")
      .select(MAINT_LIST_SELECT)
      .in("id", page.rows.map((row) => row.id))
      .order("reported_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(page.rows.length)
      .returns<{ id: string; reported_at: string }[]>();
    const details = await (input.signal ? detailQuery.abortSignal(input.signal) : detailQuery);
    if (details.error !== null || details.status >= 400) {
      return { rows: [], nextCursor: null, total: null, error: cursorReadErrorMessage(details.error?.message, "maintenance_inventory_read_failed") };
    }
    if (!Array.isArray(details.data) || details.data.some(row => row === null || typeof row !== "object" || Array.isArray(row)
      || typeof row.id !== "string" || typeof row.reported_at !== "string")) {
      return { rows: [], nextCursor: null, total: null, error: "maintenance_inventory_shape_invalid" };
    }
    rows = details.data;
  }
  await mergeFinancial(
    rows,
    "maintenance_financial_truth",
    ["cost", "cost_recorded", "currency", "invoice_number", "invoice_date"],
    { p_ids: rows.map((m) => m.id) },
    input.includeFinancial !== false,
    { signal: input.signal },
  );
  return { rows, nextCursor: page.nextCursor, total: count ?? null, error: null };
}

export async function listMaintenance() {
  const page = await listMaintenancePage();
  return { rows: page.rows, error: page.error, nextCursor: page.nextCursor, total: page.total };
}

interface MaintenanceSummaryWire {
  open: number;
  in_progress: number;
  completed: number;
  cost: {
    state: "available" | "missing" | "forbidden" | "mixed_currency";
    amount: number | null;
    currency: string | null;
    coverage_pct: number;
    used_records: number;
    excluded_records: number;
  };
}

export interface MaintenanceOperationalSummary {
  open: number;
  inProgress: number;
  completed: number;
  cost: FinancialMetric;
}

export async function getMaintenanceOperationalSummary(): Promise<{
  summary: MaintenanceOperationalSummary | null;
  error: string | null;
}> {
  const { data, error } = await supabase().rpc("maintenance_operational_summary");
  if (error || !data) return { summary: null, error: error?.message ?? "missing_summary" };
  const wire = data as unknown as MaintenanceSummaryWire;
  const totalRecords = wire.cost.used_records + wire.cost.excluded_records;
  const state = wire.cost.state === "available"
    ? "available"
    : wire.cost.state === "forbidden" ? "forbidden" : "missing";
  return {
    summary: {
      open: wire.open,
      inProgress: wire.in_progress,
      completed: wire.completed,
      cost: {
        state,
        value: state === "available" ? wire.cost.amount : null,
        coveragePct: wire.cost.coverage_pct,
        asOf: new Date().toISOString(),
        currency: wire.cost.currency,
        usedRecords: wire.cost.used_records,
        excludedRecords: wire.cost.excluded_records,
        totalRecords,
        thresholdPct: 100,
        reason: state === "available"
          ? "complete"
          : state === "forbidden"
            ? "forbidden"
            : totalRecords === 0
              ? "no_records"
              : wire.cost.state === "mixed_currency"
                ? "mixed_currency"
                : "below_threshold",
      },
    },
    error: null,
  };
}

// ---------- سياق الصيانة لنافذة الإدارة: ملخّص الأصل + تاريخ الجهاز ----------
export async function getMaintenanceContext(assetId: string, includeFinancial = true) {
  const sb = supabase();
  const [{ data: asset }, mv, mt] = await Promise.all([
    sb.from("assets").select(ASSET_SELECT).eq("id", assetId).single(),
    sb.from("asset_movements").select("movement_type,to_status,created_at").eq("asset_id", assetId),
    sb.from("maintenance_records").select("id,reported_at,workflow_stage,status").eq("asset_id", assetId).order("reported_at", { ascending: false }),
  ]);
  const moves = (mv.data ?? []) as any[];
  const maints = (mt.data ?? []) as any[];
  await mergeFinancial(
    maints,
    "maintenance_financial_truth",
    ["cost", "cost_recorded", "currency", "invoice_number", "invoice_date"],
    { p_ids: maints.map((m) => m.id) },
    includeFinancial,
  );
  const cnt = (type: string) => moves.filter((m) => m.movement_type === type).length;
  const recordedCosts = maints.filter(
    (m) => m.cost_recorded === true && m.cost != null,
  );
  return {
    asset,
    history: {
      assigned: cnt("assign"),                 // مرات التسليم/الاستخدام
      returned: cnt("return"),                 // مرات الإرجاع
      transferred: cnt("transfer"),            // مرات النقل
      maintenanceCount: maints.length,         // مرات دخول الصيانة
      totalMaintCost: maints.length > 0 && recordedCosts.length === maints.length
        ? recordedCosts.reduce((sum, record) => sum + Number(record.cost), 0)
        : null,
      totalMaintCostCoverage: maints.length === 0
        ? 0
        : Math.round((recordedCosts.length / maints.length) * 10_000) / 100,
      lastMaintAt: maints[0]?.reported_at ?? null,
    },
  };
}

// ملحقات سجل الصيانة: المرفقات (الفاتورة) + آخر مُعدِّل + اسم الفني + سياق الجهاز.
export async function getMaintenanceExtras(
  record: { id: string; asset_id: string; technician_id?: string | null },
  includeFinancial = true,
) {
  const sb = supabase();
  const [att, lm, ctx, tech, time, parts] = await Promise.all([
    sb.from("attachments").select(ATTACHMENT_NOFIN_SELECT).eq("entity_type", "maintenance").eq("entity_id", record.id).order("created_at", { ascending: false }),
    getLastModifier("maintenance_records", record.id),
    getMaintenanceContext(record.asset_id, includeFinancial),
    record.technician_id ? sb.rpc("user_label", { uid: record.technician_id }) : Promise.resolve({ data: null } as any),
    sb.from("maintenance_time_entries")
      .select("id,started_at,ended_at,minutes,note,technician_id")
      .eq("maintenance_id", record.id)
      .order("started_at", { ascending: false }),
    sb.from("maintenance_parts")
      .select("id,consumable_id,description,planned_quantity,used_quantity,stock_transaction_id, consumable:consumable_id(name,unit)")
      .eq("maintenance_id", record.id)
      .order("created_at", { ascending: false }),
  ]);
  return {
    attachments: att.data ?? [],
    lastMod: lm,
    technician: ((tech as any)?.data as string | null) ?? null,
    asset: ctx.asset,
    history: ctx.history,
    timeEntries: time.data ?? [],
    parts: parts.data ?? [],
  };
}

// رابط عرض/تنزيل مرفق من التخزين الخاص عبر رابط موقّت آمن (لا يفتح RLS).
export async function getAttachmentUrl(storagePath: string, fileName?: string) {
  const sb = supabase();
  const fallbackName = storagePath.split("/").at(-1) ?? "attachment";
  const { data, error } = await sb.storage
    .from("attachments")
    .createSignedUrl(storagePath, 120, {
      download: sanitizeAttachmentFileName(fileName ?? fallbackName),
    });
  return { url: data?.signedUrl ?? null, error: error?.message ?? null };
}

// ---------- reports ----------
export type ReportDataset = "assets" | "consumables" | "maintenance" | "references";
export interface ReportReadOptions {
  datasets?: readonly ReportDataset[];
  assetProjection?: ReportAssetProjection;
  signal?: AbortSignal;
}

const REPORT_ASSETS_FULL_SELECT = "id,status,purchase_date,currency,warranty_end,model_id,serial_number,asset_tag,name,company_id,pool_id,special_attributes,category:category_id(id,name,name_ar),location:location_id(id,name,name_ar),department:department_id(id,name,name_ar),company:company_id(id,name),holder:assigned_to_employee_id(id,full_name,full_name_ar)";
// Keep date/department/company filters even when the selected inventory kind hides them:
// the same filter state survives report-tab changes. Financial amounts remain separate RPC reads.
const REPORT_ASSETS_INVENTORY_SELECT = "id,status,purchase_date,currency,asset_tag,name,company_id,category:category_id(id,name,name_ar),location:location_id(id,name,name_ar),department:department_id(id,name,name_ar),company:company_id(id,name)";
// Template classification/depreciation also needs serial and special attributes.
// Custody and legacy callers retain the full projection, including the holder.
const REPORT_ASSETS_EXECUTIVE_SELECT = "id,status,purchase_date,currency,asset_tag,name,company_id,serial_number,special_attributes,category:category_id(id,name,name_ar),location:location_id(id,name,name_ar),department:department_id(id,name,name_ar),company:company_id(id,name)";

/** One financial row per validated asset ID; SQL NULL remains distinct from zero. */
function mergeReportAssetFinancialPage<T extends { id: string }>(page: readonly T[], data: unknown): {
  data: T[] | null; error: { message: string } | null;
} {
  const fail = () => ({ data: null, error: { message: "financial_projection_incomplete" } });
  if (!Array.isArray(data) || data.length !== page.length) return fail();
  const expected = new Set(page.map(row => row.id)), costs = new Map<string, number | null>();
  for (const row of data) {
    if (row === null || typeof row !== "object" || Array.isArray(row) || !("id" in row)
      || typeof row.id !== "string" || !expected.has(row.id) || costs.has(row.id)
      || !("purchase_cost" in row) || !(row.purchase_cost === null
        || typeof row.purchase_cost === "number" && Number.isFinite(row.purchase_cost))) return fail();
    costs.set(row.id, row.purchase_cost);
  }
  const rows: T[] = [];
  for (const row of page) {
    const cost = costs.get(row.id);
    if (cost === undefined) return fail();
    rows.push({ ...row, purchase_cost: cost });
  }
  return { data: rows, error: null };
}

export async function getReportData(includeFinancial = true, options: ReportReadOptions = {}) {
  const sb = supabase();
  const datasets = new Set(options.datasets ?? ["assets", "consumables", "maintenance", "references"]);
  // Only the mounted financial asset resource opts in. Legacy combined and NOFIN reads keep their collectors.
  const assetFinancialPipeline = includeFinancial === true && options.datasets?.length === 1 && options.datasets[0] === "assets";
  // Explicit lean asset resources share the strict1000 table contract. Full, combined,
  // custody and all other datasets keep500; NOFIN still performs no financial projection.
  const selectedLeanAssetReport = options.datasets?.length === 1 && options.datasets[0] === "assets"
    && (options.assetProjection === "inventory" || options.assetProjection === "executive");
  const assetReportPageSize = selectedLeanAssetReport ? 1000 : 500;
  const signaled = <T extends { abortSignal(signal: AbortSignal): T }>(query: T): T =>
    options.signal ? query.abortSignal(options.signal) : query;
  const read = async (enabled: boolean, query: () => PromiseLike<{ data: any[] | null; error: { message: string } | null }>) =>
    enabled ? await query() : { data: [], error: null };
  const [assets, consumables, maintenance, txns, cats, locs, deps, comps, pools] = await Promise.all([
    read(datasets.has("assets"), () => collectReportRangePages((from, to, countExact, readSignal) => {
      // Parse each literal projection independently; a union SELECT string produces a
      // PostgREST ParserError type even though both concrete query shapes are valid.
      const count = countExact ? "exact" : undefined;
      // Serial/attributes are only used by financially authorized executive depreciation.
      const query = options.assetProjection === "inventory"
        || (selectedLeanAssetReport && !includeFinancial && options.assetProjection === "executive")
        ? sb.from("assets").select(REPORT_ASSETS_INVENTORY_SELECT, { count })
        : options.assetProjection === "executive"
          ? sb.from("assets").select(REPORT_ASSETS_EXECUTIVE_SELECT, { count })
          : sb.from("assets").select(REPORT_ASSETS_FULL_SELECT, { count });
      const signal = readSignal ?? options.signal;
      return (signal ? query.abortSignal(signal) : query).eq("is_active", true).order("id").range(from, to);
    }, options.signal, 4, assetFinancialPipeline ? {
      read: async (page, signal) => {
        const { data, error } = await sb.rpc("assets_financial", { p_ids: page.map(row => row.id) }).abortSignal(signal);
        if (error !== null) {
          reportOperationalFailure("financial_projection_failed", error);
          return { data: null, error: { message: error.message || "financial_projection_failed" } };
        }
        const result = mergeReportAssetFinancialPage(page, data);
        if (result.error) reportOperationalFailure("financial_projection_failed", result.error);
        return result;
      },
    } : undefined, assetReportPageSize)),
    read(datasets.has("consumables"), () => collectReportRangePages((from, to, countExact) => signaled(sb.from("consumables")
      .select("id,name,unit,quantity_on_hand,reorder_level,company_id, category:category_id(name,name_ar), company:company_id(id,name)", { count: countExact ? "exact" : undefined })
      .eq("is_active", true).order("id").range(from, to)), options.signal)),
    read(datasets.has("maintenance"), () => collectReportRangePages((from, to, countExact) => signaled(sb.from("maintenance_records")
      .select("id,status,type,currency,reported_at,completed_at,priority,workflow_stage,problem_type,next_due_date,problem_description, asset:asset_id(id,asset_tag,name)", { count: countExact ? "exact" : undefined })
      .order("id").range(from, to)), options.signal)),
    read(datasets.has("consumables"), () => signaled(sb.from("consumable_transactions")
      .select("id,txn_type,quantity,balance_after,reason,created_at, consumable:consumable_id(name), supplier:supplier_id(name,name_ar)")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(200))),
    read(datasets.has("references"), () => collectReportRangePages((from, to, countExact) => signaled(sb.from("categories")
      .select("id,name,name_ar", { count: countExact ? "exact" : undefined }).order("name").order("id").range(from, to)), options.signal)),
    read(datasets.has("references"), () => collectReportRangePages((from, to, countExact) => signaled(sb.from("locations")
      .select("id,name,name_ar", { count: countExact ? "exact" : undefined }).order("name").order("id").range(from, to)), options.signal)),
    read(datasets.has("references"), () => collectReportRangePages((from, to, countExact) => signaled(sb.from("departments")
      .select("id,name,name_ar", { count: countExact ? "exact" : undefined }).order("name").order("id").range(from, to)), options.signal)),
    read(datasets.has("references"), () => collectReportRangePages((from, to, countExact) => signaled(sb.from("companies")
      .select("id,name", { count: countExact ? "exact" : undefined }).eq("is_active", true).order("name").order("id").range(from, to)), options.signal)),
    // Keep the legacy full-loader surface; mounted report tabs do not use pools.
    read(options.datasets === undefined, () => signaled(sb.from("asset_pools")
      .select("id,name,name_ar,category_id,company_id").eq("is_active", true).order("name"))),
  ]);
  const assetRows = assets.data ?? [];
  const maintRows = maintenance.data ?? [];
  const txnRows = txns.data ?? [];
  let error = [assets, consumables, maintenance, txns, cats, locs, deps, comps, pools]
    .find((result) => result.error)?.error?.message ?? null;
  if (!error) {
    try {
      await Promise.all([
        assetFinancialPipeline ? Promise.resolve(assetRows) : mergeFinancial(assetRows, "assets_financial", ["purchase_cost"], { p_ids: assetRows.map((row) => row.id) }, includeFinancial, { strict: true, signal: options.signal }),
        mergeFinancial(maintRows, "maintenance_financial_truth", ["cost", "cost_recorded", "currency", "invoice_number", "invoice_date"], { p_ids: maintRows.map((row) => row.id) }, includeFinancial, { strict: true, signal: options.signal }),
        mergeFinancial(txnRows, "consumable_txn_financial_detail", ["unit_cost", "total_cost", "invoice_number", "invoice_date"], { p_ids: txnRows.map((row) => row.id) }, includeFinancial, { strict: true, signal: options.signal }),
      ]);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "financial_projection_failed";
    }
  }
  return {
    assets: assetRows, consumables: consumables.data ?? [], maintenance: maintRows, txns: txnRows,
    categories: cats.data ?? [], locations: visibleLocations(locs.data ?? []), departments: deps.data ?? [],
    companies: (comps.data ?? []) as { id: string; name: string }[],
    pools: (pools.data ?? []) as { id: string; name: string; name_ar: string | null; category_id: string | null; company_id: string | null }[],
    error,
  };
}

export interface FinancialDataQualityRow {
  asset_id: string;
  asset_tag: string | null;
  asset_name: string | null;
  missing_fields: string[];
  updated_at: string;
}

export interface FinancialDataQualitySummary {
  as_of: string;
  coverage_threshold_pct: number;
  total_assets: number;
  missing_purchase_cost: number;
  missing_purchase_date: number;
  missing_warranty_end: number;
  missing_manufacturer: number;
  missing_model: number;
}

export async function getFinancialDataQuality(input: {
  offset?: number; pageSize?: number; signal?: AbortSignal;
} = {}): Promise<{
  summary: FinancialDataQualitySummary | null;
  rows: FinancialDataQualityRow[];
  nextOffset: number | null;
  error: string | null;
}> {
  const sb = supabase();
  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset!)) : 0;
  const pageSize = Number.isFinite(input.pageSize) ? Math.max(1, Math.min(499, Math.trunc(input.pageSize!))) : 200;
  const signaled = <T extends { abortSignal(signal: AbortSignal): T }>(query: T): T =>
    input.signal ? query.abortSignal(input.signal) : query;
  const [summary, list] = await Promise.all([
    offset === 0 ? signaled(sb.rpc("financial_data_quality_summary")) : Promise.resolve({ data: null, error: null, status: 200 }),
    signaled(sb.rpc("financial_data_quality_list", { p_limit: pageSize + 1, p_offset: offset })),
  ]);
  const summaryFailed = summary.error !== null || summary.status < 200 || summary.status >= 300;
  const listFailed = list.error !== null || list.status < 200 || list.status >= 300;
  const error = summaryFailed ? cursorReadErrorMessage(summary.error?.message, "financial_data_quality_failed")
    : listFailed ? cursorReadErrorMessage(list.error?.message, "financial_data_quality_failed")
    : !Array.isArray(list.data) ? "financial_data_quality_shape_invalid" : null;
  if (error) reportOperationalFailure("financial_data_quality_failed", error);
  const rows = Array.isArray(list.data) ? list.data as FinancialDataQualityRow[] : [];
  return {
    summary: (summary.data as FinancialDataQualitySummary | null) ?? null,
    rows: error ? [] : rows.slice(0, pageSize),
    nextOffset: !error && rows.length > pageSize ? offset + pageSize : null,
    error,
  };
}

// ---------- executive dashboard (raw fetch; aggregation client-side in lib/dashboard.ts) ----------
// مجموعة استعلامات متوازية مُحسّنة (round-trips قليلة). RLS يحكم كل شيء.
async function fetchDashboardMaintenanceTrend(
  field: "reported_at" | "completed_at",
  since: string,
  count: number,
): Promise<{ rows: MaintenanceTrendRow[]; error: string | null }> {
  const sb = supabase();
  const rows: MaintenanceTrendRow[] = [];
  for (const [from, to] of buildPageRanges(count)) {
    let query = sb.from("maintenance_records")
      .select("id,reported_at,completed_at,status")
      .gte(field, since);
    if (field === "completed_at") query = query.eq("status", "completed");
    const { data, error } = await query
      .order(field, { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) return { rows: [], error: error.message };
    rows.push(...((data ?? []) as MaintenanceTrendRow[]));
  }
  return { rows, error: null };
}

export async function getDashboardData() {
  const sb = supabase();
  const trendSince = maintenanceTrendSince();
  const [assets, consumables, maintenance, cats, locs, deps, reportedCountResult, completedCountResult, summaryResult] = await Promise.all([
    collectRangePages((from, to) => sb.from("assets").select(
      "id,asset_tag,name,status,serial_number,serial_exempt,qr_token,created_at,model_id,company_id," +
      "category:category_id(id,name,name_ar)," +
      "model:model_id(id,model_name)," +
      "company:company_id(id,name)," +
      "location:location_id(id,name,name_ar)," +
      "department:department_id(id,name,name_ar)," +
      "holder:assigned_to_employee_id(id,full_name,full_name_ar)"
    ).eq("is_active", true).order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("consumables")
      .select("id,name,unit,quantity_on_hand,reorder_level")
      .eq("is_active", true).order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("maintenance_records")
      .select("id,status,workflow_stage,priority,problem_type,reported_at,completed_at,created_at,action_taken,technician_id,next_due_date, asset:asset_id(id,asset_tag,name)")
      .order("id").range(from, to)),
    sb.from("categories").select("id,name,name_ar").order("name"),
    sb.from("locations").select("id,name,name_ar,code").order("name"),
    sb.from("departments").select("id,name,name_ar").order("name"),
    sb.from("maintenance_records").select("id", { count: "exact", head: true }).gte("reported_at", trendSince),
    sb.from("maintenance_records").select("id", { count: "exact", head: true }).gte("completed_at", trendSince).eq("status", "completed"),
    sb.rpc("dashboard_operational_summary"),
  ]);

  const reportedCount = reportedCountResult.count ?? 0;
  const completedCount = completedCountResult.count ?? 0;
  const countError = reportedCountResult.error?.message ?? completedCountResult.error?.message ?? null;
  const exactTrendAllowed = !countError && canFetchExactTrend(reportedCount, completedCount);
  let trendRows: MaintenanceTrendRow[] = [];
  let trendError = countError;

  if (exactTrendAllowed) {
    const [reportedRows, completedRows] = await Promise.all([
      fetchDashboardMaintenanceTrend("reported_at", trendSince, reportedCount),
      fetchDashboardMaintenanceTrend("completed_at", trendSince, completedCount),
    ]);
    trendRows = [...reportedRows.rows, ...completedRows.rows];
    trendError = reportedRows.error ?? completedRows.error;
  } else if (!countError) {
    console.warn("Dashboard maintenance trend skipped: exact row limit exceeded", { reportedCount, completedCount });
  }

  return {
    assets: assets.data ?? [],
    consumables: consumables.data ?? [],
    maintenance: maintenance.data ?? [],
    summary: (summaryResult.data as DashboardExactSummary | null) ?? null,
    trendRows,
    trendUnavailable: !exactTrendAllowed || Boolean(trendError),
    trendCounts: { reported: reportedCount, completed: completedCount },
    categories: cats.data ?? [],
    locations: visibleLocations(locs.data ?? []), // إخفاء «الفرع 1/2»
    departments: deps.data ?? [],
    error: assets.error?.message ?? consumables.error?.message ?? maintenance.error?.message ?? summaryResult.error?.message ?? null,
  };
}

export interface DashboardRequestRow {
  id: string;
  status: string;
  return_date: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  returned_at: string | null;
  approved_at: string | null;
}

export interface DashboardRequestEvent {
  id: string;
  request_id: string;
  event_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// Dashboard-only request projection. It deliberately excludes request_items and
// every financial column/RPC, so non-financial roles never fetch values merely
// to render operational counters.
export async function getDashboardRequestData(): Promise<{
  requests: DashboardRequestRow[];
  events: DashboardRequestEvent[];
  eventsUnavailable: boolean;
  error: string | null;
}> {
  const sb = supabase();
  const since = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const [requests, events] = await Promise.all([
    collectRangePages((from, to) => sb.from("requests")
      .select("id,status,return_date,created_at,updated_at,delivered_at,returned_at,approved_at")
      .not("portal_approval_status", "in", "(pending_project_manager,rejected_by_project_manager)")
      .order("id").range(from, to)),
    collectRangePages((from, to) => sb.from("request_events")
      .select("id,request_id,event_type,metadata,created_at")
      .in("event_type", ["submitted", "status_changed"])
      .gte("created_at", since)
      .order("id").range(from, to)),
  ]);

  return {
    requests: (requests.data ?? []) as DashboardRequestRow[],
    events: (events.data ?? []) as DashboardRequestEvent[],
    eventsUnavailable: Boolean(events.error),
    error: requests.error?.message ?? events.error?.message ?? null,
  };
}

// ---------- last modifier (from audit_logs; actor resolved via secure RPC) ----------
// audit_logs قراءته مقصورة على admin/it_manager، فيظهر «بواسطة» للمدير فقط (وهو المطلوب).
export async function getLastModifier(table: string, id: string) {
  const sb = supabase();
  const { data } = await sb
    .from("audit_logs")
    .select("changed_by,created_at,action")
    .eq("table_name", table).eq("record_id", id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  let by: string | null = null;
  if (data.changed_by) {
    const { data: label } = await sb.rpc("user_label", { uid: data.changed_by });
    by = (label as string | null) ?? null;
  }
  return { by, at: data.created_at as string, action: data.action as string };
}

// ---------- update consumable metadata (quantity changes require stocktake) ----------
export async function updateConsumable(id: string, input: {
  category_id: string; name: string; sku: string | null; brand: string | null;
  unit: string; reorder_level: number; notes: string | null;
  company_id: string | null; supplier_id?: string | null; location_id?: string | null;
  rfid_tag?: string | null; unit_cost?: number | null;
}) {
  return assetRpc("consumable_update_atomic", {
    p_consumable_id: id,
    p_input: input,
  });
}

// ---------- activity feed (آخر العمليات) ----------
// مصادر تشغيلية يقرأها كل authenticated (RLS): asset_movements / maintenance_records / consumable_transactions.
// المنفّذ (بواسطة) وأحداث «تعديل الأصل» تُشتقّ من audit_logs، وهو مقصور على admin/it_manager في RLS،
// فتظهر هذه التفاصيل للمخوّلين فقط تلقائيًا — بلا أي تعديل في القاعدة. (movement_type=create مستثنى لأنه استيراد أولي ضخم.)
export interface ActivityEvent {
  id: string;
  kind: "movement" | "maintenance" | "consumable" | "asset_edit";
  op: string; // assign|return|transfer|status_change|dispose|maint_open|maint_done|cons_in|cons_out|cons_adjust|asset_edit
  at: string;
  actorId: string | null;
  actor: string | null;
  entity: "asset" | "consumable" | null;
  entityId: string | null;
  entityLabel: string | null;
  maintId: string | null; // معرّف سجل الصيانة المرتبط (لفتح نافذة الصيانة)
  href: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fromLoc: string | null;
  toLoc: string | null;
  employee: string | null;
  qty: number | null;
  note: string | null;
  text: string | null;
}

export async function getActivity(opts: { includeAudit: boolean }) {
  const sb = supabase();
  const nm = (x: any) => x?.name_ar ?? x?.name ?? null;
  const enm = (x: any) => x?.full_name_ar ?? x?.full_name ?? null;

  // audit_logs يُجلب في نفس الموجة (لا يعتمد على غيره) وبحقلين فقط من JSON بدل السجل كاملًا.
  const auditQuery = opts.includeAudit
    ? sb.from("audit_logs")
      .select("id, table_name, record_id, action, changed_by, created_at, " +
        "old_status:old_data->>status, new_status:new_data->>status, " +
        "old_tag:old_data->>asset_tag, new_tag:new_data->>asset_tag")
      .in("table_name", ["assets", "maintenance_records"])
      .order("created_at", { ascending: false }).limit(400)
    : Promise.resolve({ data: null });
  const [mv, mt, ct, auditResult] = await Promise.all([
    sb.from("asset_movements")
      .select("id, asset_id, movement_type, from_status, to_status, note, created_at, performed_by, " +
        "asset:asset_id(id,asset_tag,name), from_loc:from_location_id(name_ar,name), " +
        "to_loc:to_location_id(name_ar,name), to_emp:to_employee_id(full_name_ar,full_name)")
      .neq("movement_type", "create")
      .order("created_at", { ascending: false }).limit(200),
    sb.from("maintenance_records")
      .select("id, asset_id, status, workflow_stage, problem_description, reported_at, completed_at, created_at, asset:asset_id(id,asset_tag,name)")
      .order("reported_at", { ascending: false }).limit(120),
    sb.from("consumable_transactions")
      .select("id, consumable_id, txn_type, quantity, reason, created_at, performed_by, consumable:consumable_id(id,name)")
      .order("created_at", { ascending: false }).limit(120),
    auditQuery,
  ]);

  const events: ActivityEvent[] = [];

  for (const m of (mv.data ?? []) as any[]) {
    events.push({
      id: `mv-${m.id}`, kind: "movement", op: m.movement_type, at: m.created_at,
      actorId: m.performed_by ?? null, actor: null,
      entity: "asset", entityId: m.asset?.id ?? m.asset_id, entityLabel: m.asset?.asset_tag ?? null,
      maintId: null, href: m.asset?.id ? `/assets/${m.asset.id}` : null,
      fromStatus: m.from_status ?? null, toStatus: m.to_status ?? null,
      fromLoc: nm(m.from_loc), toLoc: nm(m.to_loc), employee: enm(m.to_emp),
      qty: null, note: m.note ?? null, text: null,
    });
  }

  for (const r of (mt.data ?? []) as any[]) {
    events.push({
      id: `mt-${r.id}`, kind: "maintenance", op: "maint_open", at: r.reported_at ?? r.created_at,
      actorId: null, actor: null, entity: "asset", entityId: r.asset?.id ?? r.asset_id,
      entityLabel: r.asset?.asset_tag ?? null, maintId: r.id, href: `/maintenance?m=${r.id}`,
      fromStatus: null, toStatus: null, fromLoc: null, toLoc: null, employee: null,
      qty: null, note: r.workflow_stage ?? null, text: r.problem_description ?? null,
    });
    if (r.completed_at) {
      events.push({
        id: `mtD-${r.id}`, kind: "maintenance", op: "maint_done", at: r.completed_at,
        actorId: null, actor: null, entity: "asset", entityId: r.asset?.id ?? r.asset_id,
        entityLabel: r.asset?.asset_tag ?? null, maintId: r.id, href: `/maintenance?m=${r.id}`,
        fromStatus: null, toStatus: null, fromLoc: null, toLoc: null, employee: null,
        qty: null, note: r.workflow_stage ?? null, text: null,
      });
    }
  }

  for (const t of (ct.data ?? []) as any[]) {
    events.push({
      id: `ct-${t.id}`, kind: "consumable", op: `cons_${t.txn_type}`, at: t.created_at,
      actorId: t.performed_by ?? null, actor: null,
      entity: "consumable", entityId: t.consumable?.id ?? t.consumable_id, entityLabel: t.consumable?.name ?? null,
      maintId: null, href: "/consumables", fromStatus: null, toStatus: null, fromLoc: null, toLoc: null,
      employee: null, qty: t.quantity ?? null, note: t.reason ?? null, text: null,
    });
  }

  if (opts.includeAudit) {
    // audit_logs مقصور على admin/it_manager في RLS — يُرجع فارغًا لغيرهم بلا خطأ
    const audit = auditResult.data;

    // ربط منفّذ بلاغ الصيانة عبر record_id
    const maintActorId = new Map<string, string>();
    for (const a of (audit ?? []) as any[]) {
      if (a.table_name === "maintenance_records" && a.action === "INSERT" && a.changed_by && !maintActorId.has(a.record_id)) {
        maintActorId.set(a.record_id, a.changed_by);
      }
    }
    for (const e of events) {
      if (e.kind === "maintenance" && e.op === "maint_open") {
        const rid = e.id.slice(3);
        e.actorId = maintActorId.get(rid) ?? e.actorId;
      }
    }

    // خريطة سجل الصيانة → الأصل (لأحداث «تحديث الصيانة»)
    const maintAsset = new Map<string, { id: string | null; tag: string | null }>();
    for (const r of (mt.data ?? []) as any[]) {
      maintAsset.set(r.id, { id: r.asset?.id ?? r.asset_id ?? null, tag: r.asset?.asset_tag ?? null });
    }

    // أحداث «تحديث الصيانة» — من تعديلات maintenance_records (تظهر للمدير عبر RLS)
    for (const a of (audit ?? []) as any[]) {
      if (a.table_name === "maintenance_records" && a.action === "UPDATE") {
        const am = maintAsset.get(a.record_id);
        events.push({
          id: `mtU-${a.id}`, kind: "maintenance", op: "maint_update", at: a.created_at,
          actorId: a.changed_by ?? null, actor: null,
          entity: "asset", entityId: am?.id ?? null, entityLabel: am?.tag ?? null,
          maintId: a.record_id, href: `/maintenance?m=${a.record_id}`,
          fromStatus: null, toStatus: null, fromLoc: null, toLoc: null, employee: null,
          qty: null, note: null, text: null,
        });
      }
    }

    // أحداث «تعديل بيانات الأصل» (تعديل بلا تغيير حالة — تغييرات الحالة تظهر كحركة)
    for (const a of (audit ?? []) as any[]) {
      if (a.table_name === "assets" && a.action === "UPDATE") {
        const oldS = a.old_status, newS = a.new_status;
        if (oldS && newS && oldS !== newS) continue;
        const tag = a.new_tag ?? a.old_tag ?? null;
        events.push({
          id: `au-${a.id}`, kind: "asset_edit", op: "asset_edit", at: a.created_at,
          actorId: a.changed_by ?? null, actor: null,
          entity: "asset", entityId: a.record_id, entityLabel: tag,
          maintId: null, href: a.record_id ? `/assets/${a.record_id}` : null,
          fromStatus: null, toStatus: null, fromLoc: null, toLoc: null, employee: null,
          qty: null, note: null, text: null,
        });
      }
    }

    // تحويل معرّفات المنفّذين إلى أسماء عبر RPC آمن (يُرجع أسماء للمدير فقط) —
    // استدعاء دفعة واحد بدل جولة شبكة لكل منفّذ متمايز (كان N+1).
    const ids = Array.from(new Set(events.map((e) => e.actorId).filter(Boolean))) as string[];
    const labels = new Map<string, string>();
    if (ids.length) {
      const { data } = await sb.rpc("user_labels", { p_ids: ids });
      for (const row of (data ?? []) as { id: string; label: string | null }[]) {
        if (row.label) labels.set(row.id, row.label);
      }
    }
    for (const e of events) if (e.actorId) e.actor = labels.get(e.actorId) ?? null;
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { events, error: mv.error?.message ?? mt.error?.message ?? ct.error?.message ?? null };
}

// ======================= Settings: Suppliers (Phase 6) =======================
// تُدار الموردين من الإعدادات فقط (admin / it_manager عبر RLS). لا حذف حقيقي — تعطيل is_active.

export interface SupplierAdminRow {
  id: string; name: string; name_ar: string | null;
  contact_person: string | null; phone: string | null; email: string | null;
  address: string | null; notes: string | null; is_active: boolean;
  category_ids: string[];
}

export async function listSuppliersAdmin(): Promise<{ rows: SupplierAdminRow[]; error: string | null }> {
  const sb = supabase();
  const [sups, links] = await Promise.all([
    sb.from("suppliers")
      .select("id,name,name_ar,contact_person,phone,email,address,notes,is_active")
      .order("name"),
    sb.from("supplier_categories").select("supplier_id,category_id"),
  ]);
  const bySupplier = new Map<string, string[]>();
  for (const l of (links.data ?? []) as { supplier_id: string; category_id: string }[]) {
    const arr = bySupplier.get(l.supplier_id) ?? [];
    arr.push(l.category_id);
    bySupplier.set(l.supplier_id, arr);
  }
  const rows = ((sups.data ?? []) as any[]).map((s) => ({
    ...s, category_ids: bySupplier.get(s.id) ?? [],
  })) as SupplierAdminRow[];
  return { rows, error: sups.error?.message ?? links.error?.message ?? null };
}

export interface SupplierInput {
  name: string; name_ar: string | null; contact_person: string | null;
  phone: string | null; email: string | null; address: string | null;
  notes: string | null; is_active: boolean; category_ids: string[];
}

function supplierInputPayload(p: SupplierInput) {
  return {
    name: p.name.trim(),
    name_ar: p.name_ar?.trim() || p.name.trim(),
    contact_person: p.contact_person,
    phone: p.phone,
    email: p.email,
    address: p.address,
    notes: p.notes,
    is_active: p.is_active,
    category_ids: [...new Set(p.category_ids)],
  };
}

function supplierMutationError(
  data: unknown,
  error: { message: string } | null,
): string | null {
  if (error) return error.message;
  const result = data as { ok?: boolean; error?: string } | null;
  return result?.ok ? null : (result?.error ?? "failed");
}

export async function createSupplierFull(p: SupplierInput) {
  const { data, error } = await supabase().rpc("supplier_save_atomic", {
    p_supplier_id: null,
    p_input: supplierInputPayload(p),
  });
  return supplierMutationError(data, error);
}

export async function updateSupplierFull(id: string, p: SupplierInput) {
  const { data, error } = await supabase().rpc("supplier_save_atomic", {
    p_supplier_id: id,
    p_input: supplierInputPayload(p),
  });
  return supplierMutationError(data, error);
}

export async function setSupplierActive(id: string, isActive: boolean) {
  const { data, error } = await supabase().rpc("supplier_set_active", {
    p_supplier_id: id,
    p_is_active: isActive,
  });
  return supplierMutationError(data, error);
}

// ======================= Settings: Depreciation rules (Phase 7) =======================

export interface DepreciationRuleRow {
  id: string; category_id: string | null; asset_type: string | null;
  method: string; annual_rate: number; salvage_rate: number; is_active: boolean;
  // إضافات 2A (غير مالية): بُعد الشركة + العمر الافتراضي + تنبيه انتهاء العمر + الأولوية.
  company_id: string | null; useful_life_years: number | null;
  alert_before_days: number | null; priority: number | null;
}

export async function listDepreciationRules(includeFinancial = true, options: { signal?: AbortSignal; strictFinancial?: boolean } = {}): Promise<{
  rows: DepreciationRuleRow[];
  error: string | null;
  lifecycleAvailable: boolean;
}> {
  const sb = supabase();
  const baseQuery = sb.from("depreciation_rules")
    // Keep the browser read inside the established non-financial column grant.
    // Staging currently denies the lifecycle projection. Reading it here turns
    // every report/asset visit into a 403, while guessing the hidden values
    // would make depreciation output untrustworthy.
    .select("id,category_id,asset_type,method,is_active")
    .order("created_at", { ascending: true });
  const { data, error } = await (options.signal ? baseQuery.abortSignal(options.signal) : baseQuery);
  const rows = ((data ?? []) as any[]).map((row) => ({
    ...row,
    company_id: null,
    useful_life_years: null,
    alert_before_days: null,
    priority: null,
  }));
  // النِّسب (annual_rate/salvage_rate) محجوبة على مستوى العمود؛ تُدمَج للمخوّلين عبر RPC آمن.
  let financialError: string | null = null;
  if (!error) {
    try {
      await mergeFinancial(rows, "depreciation_financial", ["annual_rate", "salvage_rate"], undefined, includeFinancial, { signal: options.signal, strict: options.strictFinancial });
    } catch (failure) {
      financialError = failure instanceof Error ? failure.message : "financial_projection_failed";
    }
  }
  return {
    rows: rows as DepreciationRuleRow[],
    error: error?.message ?? financialError,
    lifecycleAvailable: false,
  };
}

export interface DepreciationRuleInput {
  category_id: string | null; asset_type: string | null;
  method: string; annual_rate: number; salvage_rate: number; is_active: boolean;
  company_id: string | null; useful_life_years: number | null;
  alert_before_days: number | null; priority: number | null;
}

export async function createDepreciationRule(p: DepreciationRuleInput) {
  return assetRpc("depreciation_rule_save_atomic", {
    p_rule_id: null,
    p_input: p,
  });
}

export async function updateDepreciationRule(id: string, p: DepreciationRuleInput) {
  return assetRpc("depreciation_rule_save_atomic", {
    p_rule_id: id,
    p_input: p,
  });
}

export async function setDepreciationRuleActive(id: string, isActive: boolean) {
  return assetRpc("depreciation_rule_set_active", {
    p_rule_id: id,
    p_is_active: isActive,
  });
}

// ======================= Settings: Granular capabilities (Batch 2C) =======================
// الحارس الفعلي في القاعدة (has_capability + RLS/RPC). هذه دوال قراءة/إدارة للمصفوفة فقط.
export interface PermissionRow { key: string; grp: string | null; description: string | null; }

export async function listPermissions(): Promise<{ rows: PermissionRow[]; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.from("permissions").select("key,grp,description").order("grp").order("key");
  return { rows: (data ?? []) as PermissionRow[], error: error?.message ?? null };
}

// مصفوفة الأدوار: role_key -> قائمة مفاتيح الصلاحيات الممنوحة افتراضيًا لذلك الدور.
export async function getRoleCapabilityMatrix(): Promise<{ matrix: Record<string, string[]>; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.from("role_permissions").select("role:role_id(key), permission:permission_id(key)");
  const matrix: Record<string, string[]> = {};
  for (const r of (data ?? []) as any[]) {
    const rk = r.role?.key; const pk = r.permission?.key;
    if (rk && pk) (matrix[rk] ??= []).push(pk);
  }
  return { matrix, error: error?.message ?? null };
}

export async function setRoleCapability(roleKey: string, permKey: string, allowed: boolean): Promise<string | null> {
  const { data, error } = await supabase().rpc("set_role_capability", { p_role_key: roleKey, p_key: permKey, p_allowed: allowed });
  if (error) return error.message;
  const r = data as { ok?: boolean; error?: string } | null;
  return r?.ok ? null : (r?.error ?? "failed");
}

// تجاوزات مستخدم بعينه: permission_key -> allow(true)/deny(false). غياب المفتاح = وراثة الدور.
export async function getUserCapabilityOverrides(userId: string): Promise<{ overrides: Record<string, boolean>; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.from("user_permissions").select("allow, permission:permission_id(key)").eq("user_id", userId);
  const overrides: Record<string, boolean> = {};
  for (const r of (data ?? []) as any[]) { const pk = r.permission?.key; if (pk) overrides[pk] = r.allow; }
  return { overrides, error: error?.message ?? null };
}

export async function setUserCapability(userId: string, permKey: string, state: "allow" | "deny" | "inherit"): Promise<string | null> {
  const { data, error } = await supabase().rpc("set_user_capability", { p_user: userId, p_key: permKey, p_state: state });
  if (error) return error.message;
  const r = data as { ok?: boolean; error?: string } | null;
  return r?.ok ? null : (r?.error ?? "failed");
}

// ======================= Settings: Companies / Brands =======================
// «الشركة» = الشركة المُصنِّعة/العلامة (ليست المورد). تُدار من الإعدادات (admin/it_manager).
// لا حذف حقيقي — تعطيل is_active.

export interface CompanyAdminRow {
  id: string; name: string; notes: string | null; is_active: boolean;
}

export async function listCompaniesAdmin(): Promise<{ rows: CompanyAdminRow[]; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.from("companies")
    .select("id,name,notes,is_active").order("name");
  return { rows: (data ?? []) as CompanyAdminRow[], error: error?.message ?? null };
}

export async function createCompany(p: { name: string; notes: string | null; is_active: boolean }) {
  const sb = supabase();
  const name = p.name.trim();
  const { error } = await sb.from("companies").insert({
    name, normalized_name: name.toLowerCase(), notes: p.notes, is_active: p.is_active,
  });
  return error?.message ?? null;
}

export async function updateCompany(id: string, p: { name: string; notes: string | null; is_active: boolean }) {
  const sb = supabase();
  const name = p.name.trim();
  const { error } = await sb.from("companies").update({
    name, normalized_name: name.toLowerCase(), notes: p.notes, is_active: p.is_active,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  return error?.message ?? null;
}

export async function setCompanyActive(id: string, isActive: boolean) {
  const sb = supabase();
  const { error } = await sb.from("companies")
    .update({ is_active: isActive, updated_at: new Date().toISOString() }).eq("id", id);
  return error?.message ?? null;
}

// ======================= الكتالوج — تصنيفات + موديلات (Batch E) =======================
// تُدار من الإعدادات > الكتالوج. RLS يفرض: التصنيفات كتابة admin فقط؛ الموديلات إدراج
// admin/it_manager (نمط ins_ops القائم) وتحديث admin. لا حذف حقيقي — is_active=false.
// كل الكتابات عبر الجداول محكومة بـRLS (لا مالي/مخزون/معرّف أصل/pool هنا إطلاقًا).

// unique_violation ⇒ رمز "duplicate" ليترجمه العميل لرسالة واضحة؛ غيره يُمرَّر كما هو.
function dupOr(message: string | undefined): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("duplicate key") || m.includes("already exists") || m.includes("unique")) return "duplicate";
  return message;
}

export interface CategoryAdminRow {
  id: string; name: string; name_ar: string | null; prefix: string; kind: string; is_active: boolean;
}
export async function listCategoriesAdmin(): Promise<{ rows: CategoryAdminRow[]; error: string | null }> {
  const { data, error } = await supabase().from("categories")
    .select("id,name,name_ar,prefix,kind,is_active").order("name");
  return { rows: (data ?? []) as CategoryAdminRow[], error: error?.message ?? null };
}
export async function createCategory(p: { name: string; name_ar: string | null; prefix: string; kind: string; is_active: boolean }) {
  const { error } = await supabase().from("categories").insert({
    name: p.name.trim(), name_ar: p.name_ar?.trim() || null, prefix: p.prefix.trim(), kind: p.kind, is_active: p.is_active,
  });
  return dupOr(error?.message);
}
export async function updateCategory(id: string, p: { name: string; name_ar: string | null; prefix: string; kind: string; is_active: boolean }) {
  const { error } = await supabase().from("categories").update({
    name: p.name.trim(), name_ar: p.name_ar?.trim() || null, prefix: p.prefix.trim(), kind: p.kind, is_active: p.is_active,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  return dupOr(error?.message);
}
export async function setCategoryActive(id: string, isActive: boolean) {
  const { error } = await supabase().from("categories")
    .update({ is_active: isActive, updated_at: new Date().toISOString() }).eq("id", id);
  return error?.message ?? null;
}

export interface ModelAdminRow {
  id: string; model_name: string; is_active: boolean;
  category_id: string; company_id: string | null;
  category_name: string | null; company_name: string | null;
}
// أسماء التصنيف/الشركة تُحلّ عبر خرائط منفصلة (بلا اعتماد على embed لعلاقة company_id المُضافة حديثًا).
export async function listModelsAdmin(): Promise<{ rows: ModelAdminRow[]; error: string | null }> {
  const sb = supabase();
  const [mRes, cRes, coRes] = await Promise.all([
    sb.from("models").select("id,model_name,is_active,category_id,company_id").order("model_name"),
    sb.from("categories").select("id,name"),
    sb.from("companies").select("id,name"),
  ]);
  const err = mRes.error?.message ?? cRes.error?.message ?? coRes.error?.message ?? null;
  const catMap = new Map<string, string>((cRes.data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
  const coMap = new Map<string, string>((coRes.data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
  const rows = ((mRes.data ?? []) as { id: string; model_name: string; is_active: boolean; category_id: string; company_id: string | null }[])
    .map((r) => ({
      id: r.id, model_name: r.model_name, is_active: r.is_active,
      category_id: r.category_id, company_id: r.company_id,
      category_name: catMap.get(r.category_id) ?? null,
      company_name: r.company_id ? (coMap.get(r.company_id) ?? null) : null,
    })) as ModelAdminRow[];
  return { rows, error: err };
}
// اسم مميّز عن createModel القديمة (إضافة سريعة من نموذج الأصل تكتب brand)؛ هذه تكتب company_id وتترك brand=NULL.
export async function createCatalogModel(p: { category_id: string; company_id: string; model_name: string; is_active: boolean }) {
  // brand يبقى NULL (عمود موروث؛ لا يُكتب فيه — الفهرس القديم عديم الأثر عبر تمايز NULL).
  const { error } = await supabase().from("models").insert({
    category_id: p.category_id, company_id: p.company_id, model_name: p.model_name.trim(), is_active: p.is_active,
  });
  return dupOr(error?.message);
}
export async function updateCatalogModel(id: string, p: { category_id: string; company_id: string; model_name: string; is_active: boolean }) {
  const { error } = await supabase().from("models").update({
    category_id: p.category_id, company_id: p.company_id, model_name: p.model_name.trim(), is_active: p.is_active,
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  return dupOr(error?.message);
}
export async function setCatalogModelActive(id: string, isActive: boolean) {
  const { error } = await supabase().from("models")
    .update({ is_active: isActive, updated_at: new Date().toISOString() }).eq("id", id);
  return error?.message ?? null;
}

// ======================= Asset Pools — تجميع أصول متشابهة =======================
// تُدار من الإعدادات > المخزون (admin/it_manager). قراءة لكل معتمد. لا حذف حقيقي — is_active=false.
// created_by يُختم بالخادم (trigger). updated_at يُحدَّث بالخادم (trigger).
export interface PoolAdminRow {
  id: string; name: string; name_ar: string | null;
  category_id: string | null; company_id: string | null;
  description: string | null; is_active: boolean;
  category: { name: string; name_ar: string | null } | null;
  company: { name: string } | null;
}

export async function listPoolsAdmin(): Promise<{ rows: PoolAdminRow[]; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.from("asset_pools")
    .select("id,name,name_ar,category_id,company_id,description,is_active, category:category_id(name,name_ar), company:company_id(name)")
    .order("name");
  return { rows: (data ?? []) as unknown as PoolAdminRow[], error: error?.message ?? null };
}

export interface PoolInput {
  name: string; name_ar: string | null;
  category_id: string | null; company_id: string | null;
  description: string | null; is_active: boolean;
}
// عند تعارض اسم مجموعة نشطة (unique_violation 23505) نُعيد رمزًا ثابتًا تترجمه الواجهة.
const poolErr = (error: { code?: string; message: string } | null) =>
  error ? (error.code === "23505" ? "pool_name_duplicate" : error.message) : null;

export async function createPool(p: PoolInput): Promise<string | null> {
  const sb = supabase();
  const { error } = await sb.from("asset_pools").insert({
    name: p.name.trim(), name_ar: p.name_ar?.trim() || null,
    category_id: p.category_id || null, company_id: p.company_id || null,
    description: p.description?.trim() || null, is_active: p.is_active,
  });
  return poolErr(error);
}
export async function updatePool(id: string, p: PoolInput): Promise<string | null> {
  const sb = supabase();
  const { error } = await sb.from("asset_pools").update({
    name: p.name.trim(), name_ar: p.name_ar?.trim() || null,
    category_id: p.category_id || null, company_id: p.company_id || null,
    description: p.description?.trim() || null, is_active: p.is_active,
  }).eq("id", id);
  return poolErr(error);
}
export async function setPoolActive(id: string, isActive: boolean): Promise<string | null> {
  const sb = supabase();
  const { error } = await sb.from("asset_pools").update({ is_active: isActive }).eq("id", id);
  return error?.message ?? null;
}

// ======================= Registration: public status (anon) =======================
// تُستدعى من صفحتي تسجيل الدخول والتسجيل لمعرفة هل التسجيل مفتوح — دون كشف أي أسرار/رموز.
export interface RegistrationStatus {
  mode: "closed" | "open_with_approval" | "gradual" | "invite_only";
  require_email_verification: boolean;
  has_slots: boolean;
  remaining_slots: number | null;
  default_requested_role: string;
  message_ar: string | null;
  message_en: string | null;
  departments: { id: string; name: string; name_ar: string | null }[];
}

export async function getRegistrationStatus(): Promise<RegistrationStatus | null> {
  const sb = supabase();
  const { data, error } = await sb.rpc("registration_status");
  if (error || !data) return null;
  return data as RegistrationStatus;
}

export async function validateInvite(code: string): Promise<{ valid: boolean; default_role: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.rpc("validate_registration_invite", { p_code: code });
  if (error || !data) return { valid: false, default_role: null };
  return data as { valid: boolean; default_role: string | null };
}

// إنشاء حساب موظف — Supabase Auth signUp مع تمرير بيانات التسجيل في user_metadata.
// المُحفّز handle_new_user يلتقطها وينشئ سجل app_users بحالة pending.
// لا تأكيد بريد للموظفين الداخليين: الموافقة الإدارية وحدها هي البوابة. إن أرجع
// signUp جلسة فورية (Confirm email = OFF) نُسجّل الخروج فورًا حتى لا تبقى جلسة
// معلّقة لمستخدم pending، ويكون الدخول لاحقًا صريحًا بعد اعتماد المسؤول.
//
// نُعيد رمز خطأ ثابتًا (لا نصًّا خامًا من الخادم) لتعرض الواجهة رسالة دقيقة
// مترجمة، مع تسجيل التفاصيل التقنية للمطوّر في console فقط (بلا كلمة مرور/مفاتيح).
// منطق التصنيف في وحدة نقيّة قابلة للاختبار: ./signup-error.
export async function signUpEmployee(p: {
  email: string; password: string; full_name: string; phone: string | null;
  department_id: string | null; registration_note: string | null;
  requested_role: string | null; invite_code: string | null;
  captcha_token?: string | null;
}): Promise<{ error: SignUpErrorCode | null }> {
  const sb = supabase();
  const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/login` : undefined;
  const { error } = await sb.auth.signUp({
    email: p.email.trim(),
    password: p.password,
    options: {
      emailRedirectTo: redirectTo,
      captchaToken: p.captcha_token ?? undefined,
      data: {
        full_name: p.full_name.trim(),
        phone: p.phone,
        department_id: p.department_id,
        registration_note: p.registration_note,
        requested_role: p.requested_role,
        invite_code: p.invite_code,
      },
    },
  });
  if (error) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    // للمطوّر فقط: نطبع الرسالة/الحالة/الرمز — دون كلمة المرور أو أي مفاتيح.
    if (typeof console !== "undefined") {
      console.warn("[signUpEmployee] signUp failed:", { message: error.message, status, code });
    }
    return { error: classifySignUpError(error.message, status, code) };
  }
  await sb.auth.signOut();
  return { error: null };
}

// حالة حساب المستخدم الحالي — لصفحة /pending-approval (يقرأ المستخدم سجله فقط عبر RLS).
export interface MyAccountStatus {
  approval_status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  email: string | null;
  email_confirmed: boolean;
}

export async function getMyAccountStatus(): Promise<MyAccountStatus | null> {
  const sb = supabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from("app_users")
    .select("approval_status,rejection_reason").eq("id", user.id).maybeSingle();
  return {
    approval_status: ((data as any)?.approval_status ?? "pending") as MyAccountStatus["approval_status"],
    rejection_reason: (data as any)?.rejection_reason ?? null,
    email: user.email ?? null,
    email_confirmed: !!(user as any).email_confirmed_at || !!(user as any).confirmed_at,
  };
}

// ======================= Settings: Registration management (admin/it_manager) =======================
export interface RegistrationSettingsRow {
  mode: string; require_email_verification: boolean; remaining_slots: number;
  default_requested_role: string; message_ar: string | null; message_en: string | null;
}

export async function getRegistrationSettings(): Promise<{ row: RegistrationSettingsRow | null; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.from("registration_settings")
    .select("mode,require_email_verification,remaining_slots,default_requested_role,message_ar,message_en")
    .eq("id", "main").maybeSingle();
  return { row: (data as RegistrationSettingsRow) ?? null, error: error?.message ?? null };
}

export async function updateRegistrationSettings(p: RegistrationSettingsRow) {
  const sb = supabase();
  const { data, error } = await sb.rpc("registration_settings_update_atomic", { p_input: {
    mode: p.mode, require_email_verification: p.require_email_verification,
    remaining_slots: p.remaining_slots, default_requested_role: p.default_requested_role,
    message_ar: p.message_ar, message_en: p.message_en,
  } });
  return registrationMutationError(data, error);
}

export interface InviteRow {
  id: string; code: string; label: string | null; default_role: string;
  max_uses: number | null; used_count: number; expires_at: string | null; is_active: boolean;
}

export async function listInvites(): Promise<{ rows: InviteRow[]; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.from("registration_invites")
    .select("id,code,label,default_role,max_uses,used_count,expires_at,is_active")
    .order("created_at", { ascending: false });
  return { rows: (data ?? []) as InviteRow[], error: error?.message ?? null };
}

export interface InviteInput {
  label: string | null; default_role: string;
  max_uses: number | null; expires_at: string | null; is_active: boolean;
}

export async function createInvite(p: InviteInput) {
  const sb = supabase();
  const { data, error } = await sb.rpc("registration_invite_create_atomic", { p_input: {
    label: p.label, default_role: p.default_role, max_uses: p.max_uses,
    expires_at: p.expires_at, is_active: p.is_active,
  } });
  return registrationMutationError(data, error);
}

export async function updateInvite(id: string, p: InviteInput) {
  const sb = supabase();
  const { data, error } = await sb.rpc("registration_invite_update_atomic", {
    p_invite_id: id,
    p_input: {
      label: p.label, default_role: p.default_role, max_uses: p.max_uses,
      expires_at: p.expires_at, is_active: p.is_active,
    },
  });
  return registrationMutationError(data, error);
}

export async function setInviteActive(id: string, isActive: boolean) {
  const sb = supabase();
  const { data, error } = await sb.rpc("registration_invite_set_active", {
    p_invite_id: id,
    p_is_active: isActive,
  });
  return registrationMutationError(data, error);
}

function registrationMutationError(
  data: unknown,
  error: { message: string } | null,
): string | null {
  if (error) return error.message;
  const result = data as { ok?: boolean; error?: string } | null;
  return result?.ok ? null : (result?.error ?? "failed");
}

export interface RegistrationRequest {
  id: string; email: string; full_name: string | null; phone: string | null;
  department_id: string | null; department_name: string | null;
  registration_note: string | null; requested_role: string | null; assigned_role: string | null;
  approval_status: "pending" | "approved" | "rejected"; created_at: string;
  approved_at: string | null; rejected_at: string | null; rejection_reason: string | null;
  email_confirmed: boolean;
}

export async function listRegistrationRequests(status?: string): Promise<{ rows: RegistrationRequest[]; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb.rpc("list_registration_requests", { p_status: status ?? null });
  return { rows: (data ?? []) as RegistrationRequest[], error: error?.message ?? null };
}

// قبول/رفض/إرجاع — عبر RPC آمنة تتحقّق من صلاحية المدير وتمنع it_manager من منح admin
// أو تعديل حسابات admin أو حسابه الشخصي.
// ترجمة رموز أخطاء دوال إدارة المستخدمين إلى رسائل واضحة (tu = t.usersSettings).
export function userMgmtError(
  tu: { cannotGrantAdmin: string; cannotManageAdmin: string; cannotManageSelf: string; actionError: string;
    employeeRequired: string; employeeNotFound: string; employeeInactive: string; employeeAlreadyLinked: string; userAlreadyLinked: string },
  e: string
): string {
  if (e === "cannot_grant_admin") return tu.cannotGrantAdmin;
  if (e === "cannot_manage_admin") return tu.cannotManageAdmin;
  if (e === "cannot_manage_self") return tu.cannotManageSelf;
  if (e === "employee_required") return tu.employeeRequired;
  if (e === "employee_not_found") return tu.employeeNotFound;
  if (e === "employee_inactive") return tu.employeeInactive;
  if (e === "employee_already_linked") return tu.employeeAlreadyLinked;
  if (e === "user_already_linked") return tu.userAlreadyLinked;
  return tu.actionError + e;
}

export async function approveUser(userId: string, roleKey: string): Promise<string | null> {
  const sb = supabase();
  const { data, error } = await sb.rpc("approve_user", { p_user_id: userId, p_role_key: roleKey });
  if (error) return error.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

export interface EmployeeApprovalOption { id: string; full_name: string; full_name_ar: string | null; employee_no: string | null }

export async function listEmployeeApprovalOptions(): Promise<{ rows: EmployeeApprovalOption[]; error: string | null }> {
  const { data, error } = await supabase().from("employees")
    .select("id,full_name,full_name_ar,employee_no").eq("is_active", true).order("full_name");
  return { rows: (data ?? []) as EmployeeApprovalOption[], error: error?.message ?? null };
}

export async function approveEmployeeUser(userId: string, employeeId: string): Promise<string | null> {
  const { data, error } = await supabase().rpc("approve_employee_user", { p_user_id: userId, p_employee_id: employeeId });
  return registrationMutationError(data, error);
}

export async function rejectUser(userId: string, reason: string | null): Promise<string | null> {
  const sb = supabase();
  const { data, error } = await sb.rpc("reject_user", { p_user_id: userId, p_reason: reason });
  if (error) return error.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

export async function resetUserPending(userId: string): Promise<string | null> {
  const sb = supabase();
  const { data, error } = await sb.rpc("reset_user_pending", { p_user_id: userId });
  if (error) return error.message;
  const res = data as { ok: boolean; error?: string };
  return res?.ok ? null : (res?.error ?? "failed");
}

// ======================= Consumable profile (full profile + stock) =======================
const CONSUMABLE_SELECT =
  "id,name,brand,sku,rfid_tag,unit,quantity_on_hand,reorder_level,notes,is_active," +
  "category_id,company_id,supplier_id,location_id," +
  "category:category_id(name,name_ar), company:company_id(name)," +
  "supplier:supplier_id(name,name_ar), location:location_id(name,name_ar)";

export async function getConsumable(id: string, includeFinancial = true) {
  const sb = supabase();
  const { data, error } = await sb.from("consumables").select(CONSUMABLE_SELECT).eq("id", id).single();
  if (data) await mergeFinancial([data as any], "consumables_financial", ["unit_cost"], { p_ids: [id] }, includeFinancial);
  return { consumable: data, error: error?.message ?? null };
}

// سجل حركات المستهلك (توريد/صرف/تسوية) مع الجهات المرتبطة + اسم المنفّذ (للمدير عبر RPC آمن).
export async function getConsumableHistory(id: string, includeFinancial = true, options: { signal?: AbortSignal } = {}) {
  const sb = supabase();
  const { data, error } = await collectReportRangePages((from, to, countExact) => {
    const query = sb.from("consumable_transactions")
      .select("id,txn_type,quantity,previous_quantity,balance_after,reason,created_at,performed_by,supplier:supplier_id(name,name_ar),employee:related_employee_id(full_name,full_name_ar),department:department_id(name,name_ar),location:location_id(name,name_ar)", { count: countExact ? "exact" : undefined })
      .eq("consumable_id", id).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(from, to);
    return options.signal ? query.abortSignal(options.signal) : query;
  }, options.signal);
  if (error) return { rows: [], error: error.message };
  const rows: Array<(typeof data)[number] & {
    unit_cost?: number | null; total_cost?: number | null; invoice_number?: string | null;
    invoice_date?: string | null; actor?: string | null;
  }> = data;
  // المبالغ (unit_cost/total_cost) محجوبة على مستوى العمود؛ تُدمَج للمخوّلين عبر RPC آمن.
  try {
    await mergeFinancial(
      rows,
      "consumable_txn_financial_detail",
      ["unit_cost", "total_cost", "invoice_number", "invoice_date"],
      { p_ids: rows.map((r) => r.id) },
      includeFinancial,
      { strict: true, signal: options.signal },
    );
    // أسماء المنفّذين تظهر للمدير فقط (user_labels يُرجع null لغيره) — بلا تغيير RLS.
    // Each batch returns at most one label per actor and stays below the API row ceiling.
    const ids = Array.from(new Set(rows.map((r) => r.performed_by).filter(Boolean))) as string[];
    const labels = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      options.signal?.throwIfAborted();
      const query = sb.rpc("user_labels", { p_ids: ids.slice(offset, offset + 500) });
      const result = await (options.signal ? query.abortSignal(options.signal) : query);
      if (result.error) throw new Error(result.error.message || "consumable_actor_labels_failed");
      for (const row of (result.data ?? []) as { id: string; label: string | null }[]) {
        if (row.label) labels.set(row.id, row.label);
      }
    }
    options.signal?.throwIfAborted();
    for (const r of rows) r.actor = r.performed_by ? (labels.get(r.performed_by) ?? null) : null;
  } catch (failure) {
    return { rows: [], error: options.signal?.aborted ? "read_aborted"
      : failure instanceof Error ? failure.message : "consumable_history_failed" };
  }
  return { rows, error: null };
}

export async function getConsumableAttachments(id: string) {
  const sb = supabase();
  const { data } = await sb.from("attachments").select(ATTACHMENT_NOFIN_SELECT).eq("entity_type", "consumable").eq("entity_id", id).order("created_at", { ascending: false });
  return data ?? [];
}

// توريد المستهلك: يزيد الكمية + يسجّل حركة مفصّلة (سعر/مورد/فاتورة/تاريخ) + يحدّث آخر سعر.
export interface ReplenishInput {
  consumableId: string; current: number; quantity: number; operationId?: string;
  unitCost: number | null; supplierId: string | null;
  invoiceNumber: string | null; invoiceDate: string | null; notes: string | null;
}
export async function replenishConsumable(p: ReplenishInput): Promise<string | null> {
  if (!Number.isFinite(p.quantity) || p.quantity <= 0) return "أدخل كمية صحيحة.";
  // ذرّي: التوريد يزيد الكمية + يسجّل الحركة (سعر/مورّد/فاتورة) + يحدّث آخر سعر — كله في معاملة واحدة.
  return consumableStockMove({
    consumableId: p.consumableId, type: "in", quantity: p.quantity, reason: p.notes, operationId: p.operationId,
    unitCost: p.unitCost, supplierId: p.supplierId,
    invoiceNumber: p.invoiceNumber, invoiceDate: p.invoiceDate,
  });
}

// صرف المستهلك: ينقص الكمية فقط (لا عهدة، لا إرجاع) مع منع الرصيد السالب.
export interface IssueInput {
  consumableId: string; current: number; quantity: number; operationId?: string;
  employeeId: string | null; departmentId: string | null; reason: string | null;
}
export async function issueConsumable(p: IssueInput): Promise<string | null> {
  if (!Number.isFinite(p.quantity) || p.quantity <= 0) return "أدخل كمية صحيحة.";
  // The RPC checks current stock under a row lock, after recovering any prior commit.
  return consumableStockMove({
    consumableId: p.consumableId, type: "out", quantity: p.quantity, reason: p.reason, operationId: p.operationId,
    employeeId: p.employeeId, departmentId: p.departmentId,
  });
}

// ======================= Scan: نظام المسح التشغيلي للمستودع =======================
// أوضاع: بحث/دخول/خروج + سجل + Error Log. لا يغيّر حالة الأصول ولا يتجاوز طلبات العملاء.
export type ScanMode = "smart" | "search" | "entry" | "exit";
export type ScanResult = "found" | "not_found" | "error" | "blocked";
export type ScanItemKind = "asset" | "consumable" | "unknown";
export type ScanMatchedBy = "qr_token" | "asset_tag" | "serial_number" | "rfid_tag" | "barcode" | "sku" | "name" | "manual";

export interface ScanMatch {
  type: "asset" | "consumable";
  id: string;
  label: string;                                   // الوسم/الكود المميّز أو الاسم
  sub: string | null;                              // الاسم (للأصل) أو SKU (للمستهلك)
  matchedBy: ScanMatchedBy;                         // الحقل الذي طابق القيمة الممسوحة
  status: AssetStatus | null;                       // للأصل فقط
  location: { id: string; name: string; name_ar: string | null } | null;
  company: { name: string } | null;
  pool: { name: string; name_ar: string | null } | null; // للأصل فقط
  quantity: number | null;                          // للمستهلك فقط
  unit: string | null;                              // للمستهلك فقط
}

// بحث عن أصل/مستهلك بقيمة ممسوحة (QR/asset_tag/serial/RFID/SKU/barcode-as-identifier).
// استعلامات eq منفصلة (آمنة من حقن فلاتر PostgREST مقارنةً بـ .or مع مدخل المستخدم).
// لا يُرجع أي بيانات مالية (لا purchase_cost/unit_cost) ولا مرفقات/فواتير.
export async function scanLookup(raw: string): Promise<ScanMatch[]> {
  const sb = supabase();
  const value = raw.trim();
  if (!value) return [];
  // استخراج token من رابط /a/<token> إن وُجد
  let token = value;
  const idx = value.indexOf("/a/");
  if (idx !== -1) token = value.slice(idx + 3).split(/[/?#]/)[0];

  const out: ScanMatch[] = [];
  const seen = new Set<string>();
  const pushAsset = (a: any, by: ScanMatchedBy) => {
    const k = `a:${a?.id}`;
    if (a && !seen.has(k)) {
      seen.add(k);
      out.push({
        type: "asset", id: a.id, label: a.asset_tag ?? a.name ?? "—", sub: a.name ?? null,
        matchedBy: by, status: (a.status ?? null) as AssetStatus | null,
        location: a.location ?? null, company: a.company ?? null, pool: a.pool ?? null, quantity: null, unit: null,
      });
    }
  };
  const pushCons = (c: any, by: ScanMatchedBy) => {
    const k = `c:${c?.id}`;
    if (c && !seen.has(k)) {
      seen.add(k);
      out.push({
        type: "consumable", id: c.id, label: c.name, sub: c.sku ?? null,
        matchedBy: by, status: null, location: c.location ?? null, company: c.company ?? null, pool: null,
        quantity: c.quantity_on_hand ?? null, unit: c.unit ?? null,
      });
    }
  };

  const ASEL = "id,asset_tag,name,status,location:location_id(id,name,name_ar),company:company_id(name),pool:pool_id(name,name_ar)";
  const CSEL = "id,name,sku,quantity_on_hand,unit,location:location_id(name,name_ar),company:company_id(name)";
  const [qrTok, qrVal, tag, serial, rfA, skuC, rfC] = await Promise.all([
    sb.from("assets").select(ASEL).eq("qr_token", token).maybeSingle(),
    token !== value ? sb.from("assets").select(ASEL).eq("qr_token", value).maybeSingle() : Promise.resolve({ data: null } as any),
    sb.from("assets").select(ASEL).eq("asset_tag", value).maybeSingle(),
    sb.from("assets").select(ASEL).eq("serial_number", value).limit(5),
    sb.from("assets").select(ASEL).eq("rfid_tag", value).limit(5),
    sb.from("consumables").select(CSEL).eq("sku", value).eq("is_active", true).limit(5),
    sb.from("consumables").select(CSEL).eq("rfid_tag", value).eq("is_active", true).limit(5),
  ]);
  // ترتيب الأولوية يحدّد matchedBy عند تعدّد المطابقات لنفس العنصر
  pushAsset(qrTok.data, "qr_token"); pushAsset((qrVal as any).data, "qr_token"); pushAsset(tag.data, "asset_tag");
  for (const a of (serial.data ?? []) as any[]) pushAsset(a, "serial_number");
  for (const a of (rfA.data ?? []) as any[]) pushAsset(a, "rfid_tag");
  for (const c of (skuC.data ?? []) as any[]) pushCons(c, "sku");
  for (const c of (rfC.data ?? []) as any[]) pushCons(c, "rfid_tag");
  return out;
}

// كتابة سطر في scan_logs. performed_by يُختم بالخادم (trigger) — نتجاهل أي قيمة من العميل.
// الإدراج محكوم بـ RLS: admin/it_manager/technician فقط (viewer/anon/pending محجوبون).
export interface ScanLogInput {
  mode: ScanMode;
  result: ScanResult;
  itemKind?: ScanItemKind | null;
  assetId?: string | null;
  consumableId?: string | null;
  scannedValue: string;
  matchedBy?: string | null;
  locationId?: string | null;
  notes?: string | null;
  errorCode?: string | null;
}
export async function logScan(p: ScanLogInput): Promise<string | null> {
  const sb = supabase();
  const { error } = await sb.from("scan_logs").insert({
    scan_mode: p.mode,
    result: p.result,
    item_kind: p.itemKind ?? null,
    asset_id: p.assetId ?? null,
    consumable_id: p.consumableId ?? null,
    scanned_value: (p.scannedValue ?? "").slice(0, 500),
    matched_by: p.matchedBy ?? null,
    location_id: p.locationId ?? null,
    notes: p.notes ?? null,
    error_code: p.errorCode ?? null,
  });
  return error?.message ?? null;
}

export async function smartWarehouseScanMove(input: {
  assetId: string;
  action: "entry" | "exit";
  warehouseId: string;
  operationId: string;
  destinationId?: string | null;
}): Promise<{ ok: boolean; error?: string; idempotent?: boolean }> {
  if (input.action === "exit" && !input.destinationId) return { ok: false, error: "destination_required" };
  const sb = supabase();
  const { data, error } = input.action === "exit" ? await sb.rpc("scan_warehouse_exit", {
    p_asset_id: input.assetId,
    p_warehouse_id: input.warehouseId,
    p_destination_id: input.destinationId!,
    p_operation_id: input.operationId,
  }) : await sb.rpc("scan_warehouse_move", {
    p_asset_id: input.assetId,
    p_action: input.action,
    p_warehouse_id: input.warehouseId,
    p_operation_id: input.operationId,
  });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string; idempotent?: boolean };
}

// هل الأصل مرتبط بطلب عميل «حيّ» (قبل الإغلاق)؟ لمنع Scan Exit من تجاوز مسار الطلبات.
const LIVE_REQUEST_STATUSES = [
  "draft", "under_review", "approved", "preparing", "ready_for_pickup",
  "delivered", "partially_returned", "overdue",
];
export async function assetInLiveRequest(assetId: string): Promise<boolean> {
  const sb = supabase();
  const { data } = await sb
    .from("request_items")
    .select("id, request:request_id(status)")
    .eq("asset_id", assetId)
    .limit(50);
  return ((data ?? []) as any[]).some((r) => r.request && LIVE_REQUEST_STATUSES.includes(r.request.status));
}

// قراءة سجل المسح (SELECT محكوم بـ RLS للأدوار التشغيلية). الفلترة حسب الوضع/النتيجة تتم في الواجهة.
export interface ScanLogRow {
  id: string;
  scan_mode: ScanMode;
  result: ScanResult;
  item_kind: ScanItemKind | null;
  scanned_value: string;
  matched_by: string | null;
  error_code: string | null;
  notes: string | null;
  created_at: string;
  asset_id: string | null;
  consumable_id: string | null;
  asset: { asset_tag: string | null; name: string | null } | null;
  consumable: { name: string } | null;
  performed_by: string | null;
  actor: string | null;
}
export async function listScanLogs(opts?: { limit?: number }): Promise<{ rows: ScanLogRow[]; error: string | null }> {
  const sb = supabase();
  const { data, error } = await sb
    .from("scan_logs")
    .select("id,scan_mode,result,item_kind,scanned_value,matched_by,error_code,notes,created_at,asset_id,consumable_id,performed_by, asset:asset_id(asset_tag,name), consumable:consumable_id(name)")
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 200);
  if (error) return { rows: [], error: error.message };
  const rows = (data ?? []) as any[];
  // اسم المنفّذ يظهر للمدير فقط (user_label يُرجع null لغيره) — بلا تغيير RLS
  const labels = new Map<string, string>();
  const ids = Array.from(new Set(rows.map((r) => r.performed_by).filter(Boolean))) as string[];
  if (ids.length) {
    const result = await sb.rpc("user_labels", { p_ids: ids });
    if (result.error) reportOperationalFailure("consumable_actor_labels_failed", result.error);
    for (const row of (result.data ?? []) as { id: string; label: string | null }[]) {
      if (row.label) labels.set(row.id, row.label);
    }
  }
  // نُهيّئ actor دائمًا (حتى مع بطاقة فارغة) لاحترام النوع string | null
  for (const r of rows) r.actor = r.performed_by ? (labels.get(r.performed_by) ?? null) : null;
  return { rows: rows as ScanLogRow[], error: null };
}
