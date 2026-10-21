import { reportOperationalFailure } from "@/lib/observability";
import { getDict } from "@/lib/i18n";
import { idempotentOperationError } from "@/lib/idempotent-operation-error";

// تحويل أخطاء Supabase/Postgres الخام إلى رسائل مفهومة للمستخدم (عربي/إنجليزي).
// لا يغيّر أي منطق صلاحيات أو workflow — عرض فقط. التفاصيل التقنية تبقى في console.

export type UiLang = "ar" | "en";

type Pair = { ar: string; en: string };

// أخطاء معروفة من RPC / RLS → رسالة محددة
const KNOWN: Array<[RegExp, Pair]> = [
  [/cannot_manage_admin/i, {
    ar: "لا يمكن تعديل حساب مسؤول النظام من هذا الدور.",
    en: "You cannot manage an admin account with this role.",
  }],
  [/cannot_manage_self/i, {
    ar: "لا يمكنك تعديل حالة أو دور حسابك الحالي.",
    en: "You cannot change the role or status of your own account.",
  }],
  [/cannot_grant_admin/i, {
    ar: "لا يمكنك منح صلاحية مسؤول النظام.",
    en: "You cannot grant admin access.",
  }],
  [/uq_assets_serial|(duplicate key|already exists).*serial|serial.*(duplicate|already)/i, {
    ar: "الرقم التسلسلي مُستخدَم بالفعل لأصل آخر. اختر رقمًا مختلفًا.",
    en: "This serial number is already used by another asset. Choose a different one.",
  }],
  [/custody_reconciliation_required/i, {
    ar: "يحتاج أحد الأصول المرتبطة إلى تسوية العهدة قبل تنفيذ هذا الإجراء.",
    en: "A linked asset needs custody reconciliation before this action can run.",
  }],
  [/insufficient_stock/i, {
    ar: "الكمية المطلوبة غير متوفرة في المخزون.",
    en: "Insufficient stock for this action.",
  }],
  [/invalid_state|invalid_transition|invalid_request_state/i, {
    ar: "لا يمكن تنفيذ الإجراء على الحالة الحالية.",
    en: "This action is not allowed in the current state.",
  }],
  [/not_authorized|row-level security|permission denied|violates row-level/i, {
    ar: "ليست لديك صلاحية لتنفيذ هذا الإجراء.",
    en: "You are not authorized to perform this action.",
  }],
];

// أنماط تدل على خطأ تقني خام (Postgres/Supabase/شبكة) لا يجب عرضه كما هو
const TECHNICAL =
  /(violates|duplicate key|foreign key|constraint|syntax error|invalid input|column .+ does not exist|relation .+ does not exist|schema cache|jwt|pgrst|postgres|supabase|failed to fetch|networkerror|fetch failed|unexpected token|internal server error|^error:|\bP\d{4}\b|\b\d{5}\b:)/i;

const FALLBACK: Pair = {
  ar: "تعذّر تنفيذ العملية. حاول مرة أخرى أو تواصل مع مسؤول النظام.",
  en: "The operation could not be completed. Please try again or contact the system administrator.",
};

/**
 * يعيد رسالة مفهومة إذا كان النص خطأً تقنيًا معروفًا/خامًا، أو null إذا كان
 * النص آمنًا للعرض كما هو (رسالة تطبيق مترجمة مسبقًا مثلًا).
 */
export function friendlyError(raw: unknown, lang: UiLang): string | null {
  const s = raw == null ? "" : String(raw);
  if (!s) return null;
  // Exact application codes are safe to translate. Arbitrary strings still
  // pass through the strict technical-error boundary below.
  const operationMessage = s.startsWith("operation_") ? idempotentOperationError(s, getDict(lang).common) : null;
  if (operationMessage) return operationMessage;
  for (const [re, msg] of KNOWN) {
    if (re.test(s)) {
      reportOperationalFailure("user_facing_error_mapped", raw);
      return msg[lang];
    }
  }
  if (TECHNICAL.test(s)) {
    reportOperationalFailure("user_facing_error_sanitized", raw);
    return FALLBACK[lang];
  }
  return null;
}

/**
 * للصفحات العامة (مثل التسجيل): لا يُعرض النص الخام أبدًا —
 * إمّا رسالة معروفة أو رسالة الاحتياط العامة.
 */
export function friendlyErrorStrict(raw: unknown, lang: UiLang): string {
  const mapped = friendlyError(raw, lang);
  if (mapped) return mapped;
  if (raw != null) reportOperationalFailure("user_facing_error_sanitized", raw);
  return FALLBACK[lang];
}
