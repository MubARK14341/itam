// ============================================================================
//  بوابة العميل — طبقة البيانات (أغلفة portal_* RPCs حصراً).
//  لا SELECT مباشر على أي جدول داخلي — كل شيء عبر دوال SECURITY DEFINER الآمنة.
//  لا ترجع أي أعمدة مالية / internal_notes / معرّفات مخزون (مضمون في القاعدة).
// ============================================================================

import { createClient } from "@/lib/supabase/client";

const sb = () => createClient();

export type PortalRole = "project_manager" | "authorized_requester" | "viewer";

export interface PortalContext {
  customer_name: string;
  contact_name: string;
  portal_role: PortalRole;
  // إعدادات البوابة (Phase 5) — المصدر الوحيد لإظهار/إخفاء الأنواع والمرفقات وسلوك اعتماد PM.
  // الأمان مفروض في القاعدة؛ هذه للواجهة فقط (لا تُستخدم كمصدر أمان).
  portal_enabled: boolean;
  allow_rental_requests: boolean;
  allow_purchase_requests: boolean;
  allow_maintenance_requests: boolean;
  allow_custom_requests: boolean;
  allow_custom_item_requests: boolean;
  allow_attachments: boolean;
  require_project_manager_approval: boolean;
  allowed_companies_count: number;
  allowed_categories_count: number;
}

// السياق: يُرجع null لغير مستخدم البوابة (يُستخدم أيضاً كفحص هوية في التوجيه/الحارس).
/** Shape the portal_get_context payload (shared by the browser loader and the server layout). */
export function parsePortalContext(data: unknown): PortalContext | null {
  if (!data || !(data as any).ok) return null;
  const d = data as any;
  const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
  return {
    customer_name: d.customer_name,
    contact_name: d.contact_name,
    portal_role: d.portal_role,
    portal_enabled: bool(d.portal_enabled, true),
    allow_rental_requests: bool(d.allow_rental_requests, true),
    allow_purchase_requests: bool(d.allow_purchase_requests, true),
    allow_maintenance_requests: bool(d.allow_maintenance_requests, true),
    allow_custom_requests: bool(d.allow_custom_requests, true),
    allow_custom_item_requests: bool(d.allow_custom_item_requests, true),
    allow_attachments: bool(d.allow_attachments, true),
    require_project_manager_approval: bool(d.require_project_manager_approval, false),
    allowed_companies_count: Number(d.allowed_companies_count ?? 0),
    allowed_categories_count: Number(d.allowed_categories_count ?? 0),
  };
}

export async function getPortalContext(): Promise<PortalContext | null> {
  try {
    const { data } = await sb().rpc("portal_get_context");
    return parsePortalContext(data);
  } catch {
    return null;
  }
}

// الشركات/التصنيفات المسموحة لهذا العميل (Phase 5) — قوائم مُبيّضة (بلا مخزون/أعداد/أسعار).
export interface PortalAllowedCompany { id: string; name: string }
export interface PortalAllowedCategory { key: string; label_ar: string | null; label_en: string | null }

export async function portalListAllowedCompanies(): Promise<PortalAllowedCompany[]> {
  const { data, error } = await sb().rpc("portal_list_allowed_companies");
  if (error) return [];
  const d = data as any;
  return d?.ok ? ((d.companies ?? []) as PortalAllowedCompany[]) : [];
}
export async function portalListAllowedCategories(): Promise<PortalAllowedCategory[]> {
  const { data, error } = await sb().rpc("portal_list_allowed_categories");
  if (error) return [];
  const d = data as any;
  return d?.ok ? ((d.categories ?? []) as PortalAllowedCategory[]) : [];
}

// ---------- ملفي الشخصي (portal_get_profile / portal_update_profile) ----------
// portal_get_profile دالة تُرجع صفًا واحدًا (returns table) ⇒ data مصفوفة. لا تُرجع البريد إطلاقًا.
export interface PortalProfile {
  contact_name: string; phone: string | null; city: string | null;
  company_name: string; portal_role: PortalRole;
}
export async function portalGetProfile(): Promise<{ data: PortalProfile | null; error: string | null }> {
  const { data, error } = await sb().rpc("portal_get_profile");
  if (error) return { data: null, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { data: null, error: "not_found" };
  return { data: row as PortalProfile, error: null };
}
// تحديث الملف عبر RPC آمن — الهوية من الجلسة داخل القاعدة (لا معرّف من الواجهة). يُرجع رمز خطأ أو null.
export async function portalUpdateProfile(p: { contact_name: string; phone: string; city?: string | null }): Promise<string | null> {
  const { error } = await sb().rpc("portal_update_profile", {
    p_contact_name: p.contact_name, p_phone: p.phone, p_city: p.city ?? null,
  });
  return error ? error.message : null;
}

// ---------- الكتالوج الآمن (portal_list_catalog) — تصنيف→ماركة(شركة)→موديل، بلا مخزون/سعر/معرّف أصل/pool ----------
export interface PortalCatalogRow {
  category_id: string; category_name: string; category_name_ar: string | null;
  company_id: string; company_name: string; model_id: string; model_name: string;
}
export async function portalListCatalog(): Promise<PortalCatalogRow[]> {
  const { data, error } = await sb().rpc("portal_list_catalog");
  if (error) return [];
  return (Array.isArray(data) ? data : []) as PortalCatalogRow[];
}

// ---------- مستهلكات آمنة (portal_list_consumables) — تصنيف→مستهلك، بلا كمية/سعر/مورد/موقع/rfid/sku ----------
export interface PortalConsumableRow {
  consumable_id: string; consumable_name: string;
  category_id: string; category_name: string; category_name_ar: string | null;
}
export async function portalListConsumables(): Promise<PortalConsumableRow[]> {
  const { data, error } = await sb().rpc("portal_list_consumables");
  if (error) return [];
  return (Array.isArray(data) ? data : []) as PortalConsumableRow[];
}

export interface PortalItemAvailability {
  item_type: "durable" | "consumable";
  available_quantity: number;
}

// Safe aggregate only. This RPC intentionally never returns asset, warehouse,
// reservation, staff, or financial fields.
export async function portalGetItemAvailability(input: {
  item_type: "durable" | "consumable";
  category_id?: string | null;
  model_id?: string | null;
  consumable_id?: string | null;
}): Promise<PortalItemAvailability | null> {
  const { data, error } = await (sb() as any).rpc("portal_item_availability", {
    p_item_type: input.item_type,
    p_category_id: input.category_id ?? null,
    p_model_id: input.model_id ?? null,
    p_consumable_id: input.consumable_id ?? null,
  });
  if (error || !(data as any)?.ok) return null;
  return {
    item_type: (data as any).item_type,
    available_quantity: Number((data as any).available_quantity ?? 0),
  };
}

// أدنى شكل يحتاجه كرت صف الطلب المشترك (PortalRequestRowCard) — يرضيه القائمة ولوحة الملخص.
export interface PortalRequestCardItem {
  id: string; request_number: string; status: string; portal_approval_status: string;
  project_name: string | null; project_city?: string | null; created_at: string; item_count: number;
}

export interface PortalRequestListItem {
  id: string; request_number: string; status: string; request_type: string;
  portal_approval_status: string;
  project_name: string | null; project_city: string | null;
  pickup_date: string | null; return_date: string | null; created_at: string; item_count: number;
}

export async function portalListRequests(): Promise<{ rows: PortalRequestListItem[]; error: string | null }> {
  const { data, error } = await sb().rpc("portal_list_requests");
  if (error) return { rows: [], error: error.message };
  const d = data as any;
  if (!d?.ok) return { rows: [], error: d?.error ?? "failed" };
  return { rows: (d.requests ?? []) as PortalRequestListItem[], error: null };
}

export interface PortalRequestItem {
  id: string; requested_kind: string; requested_description: string | null; requested_category: string | null;
  preferred_model: string | null; accept_alternative: boolean; needs_purchase: boolean;
  quantity: number; fulfillment: string;
}
export interface PortalRequestEvent {
  event_type: string; to_status: string | null; message: string | null; created_at: string;
}
export interface PortalRequestHeader {
  id: string; request_number: string; status: string; request_type: string;
  portal_approval_status: string;
  portal_rejection_reason: string | null;
  can_pm_approve: boolean;
  can_submit_draft?: boolean;
  project_name: string | null; project_city: string | null;
  contact_phone: string | null; contact_email: string | null;
  pickup_date: string | null; return_date: string | null; notes: string | null;
  created_at: string; rejection_reason: string | null;
}
export interface PortalRequestDetail {
  request: PortalRequestHeader; items: PortalRequestItem[]; events: PortalRequestEvent[];
  creation_complete: boolean;
}

export async function portalGetRequest(id: string, accessToken?: string): Promise<{ data: PortalRequestDetail | null; error: string | null }> {
  const request = sb().rpc("portal_get_request", { p_request_id: id });
  if (accessToken) request.setHeader("Authorization", `Bearer ${accessToken}`);
  const { data, error } = await request;
  if (error) return { data: null, error: error.message };
  const d = data as any;
  if (!d?.ok) return { data: null, error: d?.error ?? "failed" };
  return { data: { request: d.request, items: d.items ?? [], events: d.events ?? [], creation_complete: d.creation_complete === true }, error: null };
}

// مساعد عام: يُرجع رمز خطأ مترجَم أو null عند النجاح.
async function portalRpc(name: string, params: Record<string, unknown>, accessToken?: string): Promise<string | null> {
  const request = sb().rpc(name, params);
  if (accessToken) request.setHeader("Authorization", `Bearer ${accessToken}`);
  const { data, error } = await request;
  if (error) return error.message;
  const d = data as any;
  return d?.ok ? null : (d?.error ?? "failed");
}

export interface PortalNewRequest {
  project_name: string | null; project_city: string | null;
  contact_phone: string | null; contact_email: string | null;
  request_type: string; pickup_date: string | null; return_date: string | null; notes: string | null;
}
// إنشاء طلب draft — يُرجع المعرّف (لإضافة العناصر بعده).
export async function portalCreateRequest(input: PortalNewRequest): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await sb().rpc("portal_create_request", {
    p_project_name: input.project_name, p_project_city: input.project_city,
    p_contact_phone: input.contact_phone, p_contact_email: input.contact_email,
    p_request_type: input.request_type, p_pickup_date: input.pickup_date,
    p_return_date: input.return_date, p_notes: input.notes,
  });
  if (error) return { id: null, error: error.message };
  const d = data as any;
  return d?.ok ? { id: d.id as string, error: null } : { id: null, error: d?.error ?? "failed" };
}

export interface PortalNewItem {
  requested_kind: "consumable" | "custom" | "existing_asset"; requested_description: string | null; requested_category: string | null;
  quantity: number; preferred_model: string | null; accept_alternative: boolean; needs_purchase: boolean;
  // Phase 5: مفتاح التصنيف الثابت (للتحقق في القاعدة) + الشركة المفضّلة (من قائمة السماح فقط).
  category_key: string | null; preferred_company_id: string | null;
  model_id?: string | null; consumable_id?: string | null;
  additional_quantity_requested?: boolean;
}
export interface PortalRequestBundle extends PortalNewRequest { items: PortalNewItem[] }
export interface PortalCreateOperationResult {
  ok?: boolean; id?: string; error?: string;
  definitive_rollback?: boolean;
  _operation?: { type?: string; target_id?: string; input_fingerprint?: string };
}

/** One transaction creates the complete draft; the caller owns the retry UUID. */
export async function portalCreateRequestAtomic(operationId: string, input: PortalRequestBundle, accessToken?: string) {
  const request = sb().rpc("portal_create_request_atomic", {
    p_operation_id: operationId, p_input: input,
  });
  if (accessToken) request.setHeader("Authorization", `Bearer ${accessToken}`);
  const { data, error } = await request;
  return { data: data as PortalCreateOperationResult | null, error };
}

export const portalAddItem = (reqId: string, it: PortalNewItem) =>
  portalRpc("portal_add_item", {
    p_request_id: reqId, p_requested_kind: it.requested_kind, p_requested_description: it.requested_description,
    p_requested_category: it.requested_category, p_quantity: it.quantity, p_preferred_model: it.preferred_model,
    p_accept_alternative: it.accept_alternative, p_needs_purchase: it.needs_purchase,
    p_preferred_company_id: it.preferred_company_id, p_category_key: it.category_key,
    p_model_id: it.model_id ?? null, p_consumable_id: it.consumable_id ?? null,
    p_additional_quantity_requested: !!it.additional_quantity_requested,
  });
export const portalRemoveItem = (itemId: string) => portalRpc("portal_remove_item", { p_item_id: itemId });

// إرسال الطلب — يُرجع pendingPm=true عندما يُرفع لاعتماد مدير المشروع بدل الوصول للفريق.
export async function portalSubmitRequest(reqId: string, accessToken?: string): Promise<{ error: string | null; pendingPm: boolean; outcomeUnknown?: boolean }> {
  const request = sb().rpc("portal_submit_request", { p_request_id: reqId });
  if (accessToken) request.setHeader("Authorization", `Bearer ${accessToken}`);
  const { data, error } = await request;
  if (error) return { error: error.message, pendingPm: false, outcomeUnknown: !/^[0-9A-Z]{5}$/.test(error.code ?? "") };
  const d = data as any;
  if (!d?.ok) return { error: d?.error ?? "failed", pendingPm: false };
  return { error: null, pendingPm: !!d.pending_pm };
}

// اعتماد/رفض مدير المشروع داخل البوابة (Phase 5) — project_manager فقط (مفروض في القاعدة).
export const portalPmApproveRequest = (reqId: string, accessToken?: string) =>
  portalRpc("portal_pm_approve_request", { p_request_id: reqId }, accessToken);
export const portalPmRejectRequest = (reqId: string, reason: string, accessToken?: string) =>
  portalRpc("portal_pm_reject_request", { p_request_id: reqId, p_reason: reason }, accessToken);

export const portalReplyClarification = (reqId: string, message: string, accessToken?: string) =>
  portalRpc("portal_reply_clarification", { p_request_id: reqId, p_message: message }, accessToken);

// ---------- لوحة ملخص العميل (Batch 6) — عبر RPC معزول بنفس عزل portal_list_requests ----------
export interface PortalDashboardCount { status: string; portal_approval_status: string; count: number }
export interface PortalDashboardRecent {
  id: string; request_number: string; status: string; portal_approval_status: string;
  request_type: string; project_name: string | null; created_at: string; item_count: number;
}
export interface PortalRequestDashboard {
  portal_role: PortalRole;
  total_my_requests: number; open_requests: number; waiting_pm_approval: number;
  needs_clarification: number; in_progress: number; completed: number; rejected: number;
  counts_by_status: PortalDashboardCount[];
  recent_requests: PortalDashboardRecent[];
}
export async function portalGetRequestDashboard(): Promise<{ data: PortalRequestDashboard | null; error: string | null }> {
  const { data, error } = await sb().rpc("portal_get_request_dashboard");
  if (error) return { data: null, error: error.message };
  const d = data as any;
  if (!d?.ok) return { data: null, error: d?.error ?? "failed" };
  return { data: d as PortalRequestDashboard, error: null };
}

// ---------- التسجيل بالدعوة ----------
export interface InviteValidation { valid: boolean; customer_name?: string; portal_role?: PortalRole; expires_at?: string; }
export async function validatePortalInvite(code: string): Promise<InviteValidation> {
  const { data, error } = await sb().rpc("validate_portal_invite", { p_code: code });
  if (error || !data) return { valid: false };
  return data as InviteValidation;
}

// تسجيل مستخدم بوابة — signUp بميتاداتا user_type=portal؛ handle_new_user ينشئ صف البوابة.
export async function portalSignUp(p: {
  code: string; email: string; password: string; full_name: string; phone: string | null;
}): Promise<{ error: string | null; needsEmailVerification: boolean }> {
  const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/login` : undefined;
  const { data, error } = await sb().auth.signUp({
    email: p.email.trim(), password: p.password,
    options: {
      emailRedirectTo: redirectTo,
      data: { user_type: "portal", invite_code: p.code.trim(), full_name: p.full_name.trim(), phone: p.phone },
    },
  });
  if (error) return { error: error.message, needsEmailVerification: false };
  return { error: null, needsEmailVerification: !data.session };
}

// تسجيل ذاتي مفتوح للعميل (بلا دعوة): ينشئ عميلًا بحالة pending عبر handle_new_user.
// company/city اختياريان. code اختياري (إن وُجد يتحوّل لمسار الدعوة). العميل معلّق حتى اعتماد المدير.
export async function portalSelfRegister(p: {
  email: string; password: string; full_name: string; phone: string | null;
  company_name: string | null; city: string | null; code?: string | null;
  captcha_token?: string | null;
}): Promise<{ error: string | null; needsEmailVerification: boolean; pending: boolean }> {
  const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/login` : undefined;
  const meta: Record<string, string> = { user_type: "portal", full_name: p.full_name.trim() };
  if (p.phone) meta.phone = p.phone.trim();
  if (p.company_name && p.company_name.trim()) meta.company_name = p.company_name.trim();
  if (p.city && p.city.trim()) meta.city = p.city.trim();
  const invited = !!(p.code && p.code.trim());
  if (invited) meta.invite_code = p.code!.trim();
  const { data, error } = await sb().auth.signUp({
    email: p.email.trim(), password: p.password,
    options: {
      emailRedirectTo: redirectTo,
      captchaToken: p.captcha_token ?? undefined,
      data: meta,
    },
  });
  if (error) return { error: error.message, needsEmailVerification: false, pending: false };
  return { error: null, needsEmailVerification: !data.session, pending: !invited };
}
