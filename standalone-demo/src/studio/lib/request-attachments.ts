// ============================================================================
//  مرفقات الطلبات — طبقة البيانات (bucket خاص request-attachments).
//  التدفق الآمن: (1) تحقق في العميل → (2) رفع الملف إلى الـ bucket (سياسات storage
//  تحرس المسار والدور) → (3) استدعاء register RPC (يتحقق من ملكية الكائن ويقرأ
//  mime/size من metadata السيرفر) → (4) عند فشل التسجيل: حذف الكائن غير المسجّل.
//  لا public URLs — كل فتح عبر createSignedUrl لمدة 120 ثانية. لا storage_path
//  في واجهة البوابة إطلاقًا (البوابة تطلب المسار عند الضغط عبر RPC فقط).
// ============================================================================

import { createClient } from "@/lib/supabase/client";
import {
  ALLOWED_ATTACHMENT_MIME,
  MAX_ATTACHMENT_BYTES,
  inferAttachmentMime,
  sanitizeAttachmentFileName,
  validateAttachmentContent,
  validateAttachmentFile,
} from "@/lib/attachment-files";

const sb = () => createClient();
const BUCKET = "request-attachments";
const SIGNED_TTL = 120;

export { ALLOWED_ATTACHMENT_MIME, MAX_ATTACHMENT_BYTES, validateAttachmentFile };
export const ATTACHMENT_ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,application/pdf,image/png,image/jpeg,image/webp";

export type AttachmentValidation =
  | "bad_type"
  | "too_large"
  | "content_mismatch"
  | null;
export type RequestAttachmentClassification =
  | "customer_visible"
  | "internal"
  | "financial";

export function buildAttachmentPath(
  requestId: string,
  actor: "portal" | "staff",
  classification: RequestAttachmentClassification,
  fileName: string,
): string {
  return `requests/${requestId}/${actor}/${classification}/${globalThis.crypto.randomUUID()}_${sanitizeAttachmentFileName(fileName)}`;
}

// مساعد RPC موحّد: رمز خطأ مترجَم أو null عند النجاح.
async function rpc(name: string, params: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await sb().rpc(name, params);
  if (error) return error.message;
  const d = data as { ok?: boolean; error?: string } | null;
  return d?.ok ? null : (d?.error ?? "failed");
}

// رفع + تسجيل + rollback عند فشل التسجيل.
async function uploadAndRegister(
  requestId: string,
  actor: "portal" | "staff",
  classification: RequestAttachmentClassification,
  file: File,
  register: (path: string) => Promise<string | null>,
): Promise<string | null> {
  const v = await validateAttachmentContent(file);
  if (v) return v;
  const path = buildAttachmentPath(requestId, actor, classification, file.name);
  const { error: upErr } = await sb().storage.from(BUCKET).upload(path, file, {
    contentType: inferAttachmentMime(file),
    upsert: false,
  });
  if (upErr) return "upload_failed";
  const regErr = await register(path);
  if (regErr) {
    // الكائن غير مسجّل بعد → مسموح حذفه بسياسة req_att_delete_own_unregistered.
    const { error: cleanupError } = await sb().storage.from(BUCKET).remove([path]);
    if (cleanupError) {
      console.error("request_attachment_cleanup_failed", {
        bucket: BUCKET,
        error: cleanupError.message,
      });
    }
    return regErr;
  }
  return null;
}

interface PortalUploadAttempt { path: string; state: "new" | "upload_unknown" | "uploaded" | "registered" }
// Files and paths stay in RAM. A retry of this File reuses its exact object.
const portalUploadAttempts = new WeakMap<File, Map<string, PortalUploadAttempt>>();

export async function uploadRequestAttachmentPortal(requestId: string, file: File, expectedActorId?: string): Promise<string | null> {
  const client = sb();
  const { data, error } = await client.auth.getSession();
  const session = data.session;
  if (expectedActorId && session?.user.id !== expectedActorId) return "operation_actor_changed";
  if (error || !session?.user.id || !session.access_token) return "not_authorized";
  const actorId = session.user.id, accessToken = session.access_token;
  const sameActor = async () => {
    const current = await client.auth.getSession();
    return !current.error && current.data.session?.user.id === actorId;
  };
  const validation = await validateAttachmentContent(file);
  if (!await sameActor()) return "operation_actor_changed";
  if (validation) return validation;
  const key = `${actorId}:${requestId}`;
  let attempts = portalUploadAttempts.get(file);
  if (!attempts) { attempts = new Map(); portalUploadAttempts.set(file, attempts); }
  let attempt = attempts.get(key);
  if (!attempt) {
    attempt = { path: buildAttachmentPath(requestId, "portal", "customer_visible", file.name), state: "new" };
    attempts.set(key, attempt);
  }
  if (attempt.state === "registered") return null;

  const register = async () => {
    if (!await sameActor()) return { error: "operation_actor_changed", missing: false };
    const response = await client.rpc("portal_register_request_attachment", {
      p_request_id: requestId, p_file_name: file.name, p_storage_path: attempt.path,
    }).setHeader("Authorization", `Bearer ${accessToken}`);
    if (!await sameActor()) return { error: "operation_actor_changed", missing: false };
    const result = response.data as { ok?: boolean; error?: string } | null;
    if (!response.error && result?.ok === true) {
      attempt.state = "registered";
      return { error: null, missing: false };
    }
    const registrationError = response.error?.message ?? result?.error ?? "failed";
    return { error: registrationError, missing: !response.error && result?.error === "object_not_found" };
  };

  // A lost upload or registration reply may already have committed. Reconcile
  // first; the RPC only accepts a replay when owner and all metadata match.
  if (attempt.state !== "new") {
    const recovered = await register();
    if (!recovered.missing) return recovered.error;
  }
  if (!await sameActor()) return "operation_actor_changed";
  attempt.state = "upload_unknown";
  const uploaded = await client.storage.from(BUCKET).upload(attempt.path, file, {
    contentType: inferAttachmentMime(file), upsert: false,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!await sameActor()) return "operation_actor_changed";
  if (uploaded.error) return "upload_failed";
  attempt.state = "uploaded";
  // Do not delete after a lost registration reply: the attachment can already
  // be registered. Keep this draft and retry registration of the same object.
  return (await register()).error;
}

export function uploadRequestAttachmentStaff(
  requestId: string, file: File, visibleToCustomer: boolean,
): Promise<string | null> {
  const classification: RequestAttachmentClassification =
    visibleToCustomer ? "customer_visible" : "internal";
  return uploadAndRegister(requestId, "staff", classification, file, (path) =>
    rpc("staff_register_request_attachment_v2", {
      p_request_id: requestId, p_file_name: file.name, p_storage_path: path,
      p_classification: classification,
      p_functional_type: "request_attachment",
      p_visible_to_customer: visibleToCustomer,
    }));
}

// ---------- قراءة البوابة (بلا storage_path) ----------
export interface PortalAttachment {
  id: string; file_name: string; mime_type: string; size_bytes: number;
  created_at: string; uploaded_by_kind: "portal" | "staff";
  scan_status: AttachmentScanStatus;
}

export type AttachmentScanStatus = "pending" | "clean" | "infected" | "error";

export async function portalListRequestAttachments(
  requestId: string,
): Promise<{ rows: PortalAttachment[]; error: string | null }> {
  const { data, error } = await sb().rpc("portal_list_request_attachments", { p_request_id: requestId });
  if (error) return { rows: [], error: error.message };
  const d = data as { ok?: boolean; error?: string; attachments?: PortalAttachment[] } | null;
  if (!d?.ok) return { rows: [], error: d?.error ?? "failed" };
  return { rows: d.attachments ?? [], error: null };
}

// المسار يُطلب عند الضغط فقط، ثم يُوقَّع فورًا (لا يُخزَّن ولا يُعرض في UI).
export async function getPortalAttachmentUrl(
  attachmentId: string,
): Promise<{ url: string | null; error: string | null }> {
  const { data, error } = await sb().rpc("portal_get_request_attachment_path", { p_attachment_id: attachmentId });
  if (error) return { url: null, error: error.message };
  const d = data as {
    ok?: boolean;
    error?: string;
    path?: string;
    file_name?: string;
  } | null;
  if (!d?.ok || !d.path) return { url: null, error: d?.error ?? "failed" };
  const downloadName = sanitizeAttachmentFileName(d.file_name ?? "attachment");
  const { data: signed, error: sErr } = await sb().storage
    .from(BUCKET)
    .createSignedUrl(d.path, SIGNED_TTL, { download: downloadName });
  if (sErr || !signed?.signedUrl) return { url: null, error: sErr?.message ?? "sign_failed" };
  return { url: signed.signedUrl, error: null };
}

// ---------- قراءة الموظف (select مباشر تحت RLS sel_staff) ----------
export interface StaffAttachment {
  id: string; request_id: string; uploaded_by_kind: "portal" | "staff"; uploaded_by: string;
  visible_to_customer: boolean; file_name: string; storage_path: string;
  classification: RequestAttachmentClassification; functional_type: string;
  mime_type: string; size_bytes: number; created_at: string;
  scan_status: AttachmentScanStatus;
}

export async function listRequestAttachmentsStaff(
  requestId: string,
): Promise<{ rows: StaffAttachment[]; error: string | null }> {
  const { data, error } = await sb()
    .from("request_attachments")
    .select("id,request_id,uploaded_by_kind,uploaded_by,visible_to_customer,classification,functional_type,file_name,storage_path,mime_type,size_bytes,created_at,scan_status")
    .eq("request_id", requestId)
    .order("created_at");
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as StaffAttachment[], error: null };
}

export async function getStaffAttachmentUrl(
  storagePath: string,
  fileName: string,
): Promise<{ url: string | null; error: string | null }> {
  const { data, error } = await sb().storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_TTL, {
      download: sanitizeAttachmentFileName(fileName),
    });
  if (error || !data?.signedUrl) return { url: null, error: error?.message ?? "sign_failed" };
  return { url: data.signedUrl, error: null };
}

export const setAttachmentVisibility = (attachmentId: string, visible: boolean): Promise<string | null> =>
  rpc("staff_set_request_attachment_visibility", { p_attachment_id: attachmentId, p_visible: visible });
