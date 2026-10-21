// نسبة اكتمال ملف الأصل — مُحسِّن مشترك يُستخدم في جدول الأصول وفي صفحة التفاصيل
// لضمان تطابق النسبة في كل المواضع (مصدر حساب واحد، لا تكرار للمنطق).
//
// يعتمد على القوالب الحالية (asset-type-templates) و IMPORT­ANT_FIELDS لكل نوع.
// الحساب: completedFields / totalImportantFields * 100 على الحقول المهمة المرئية للدور.
// لا يكشف القيم المالية — يحسب الاكتمال فقط، والقيم نفسها لا تظهر لغير المخوّل.

import {
  getAssetTemplate,
  readSpecialAttribute,
  IMPORTANT_FIELDS,
  type TemplateField,
  type TemplateId,
} from "@/lib/asset-type-templates";

/** عتبة اعتبار الملف «ناقصًا» (أصفر/أحمر قبلها). */
export const COMPLETION_LOW_THRESHOLD = 50;
export const COMPLETION_MID_THRESHOLD = 80;
/** أقل من هذه النسبة يُعتبر بحاجة لاستكمال (مطابق لسلوك صفحة التفاصيل). */
export const NEEDS_COMPLETION_BELOW = 60;

/** القيمة تُعتبر «مُدخلة» — فارغ/null/undefined/"" غير محسوب؛ الأرقام والقيم المنطقية محسوبة (بما فيها 0/false). */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return false;
    // قيم بديلة شائعة تعني «غير مُدخل»
    const empties = ["-", "—", "غير مدخل", "غير مُدخل", "not provided", "n/a", "na"];
    return !empties.includes(s.toLowerCase());
  }
  if (Array.isArray(v)) return v.length > 0;
  return true; // numbers (incl. 0), booleans (incl. false)
}

export interface AssetCompletenessInput {
  name?: string | null;
  serial_number?: string | null;
  category?: { name?: string | null; name_ar?: string | null } | null;
  special_attributes?: unknown;
}

export interface CompletenessResult {
  templateId: TemplateId;
  filled: number;
  total: number;
  pct: number; // 0..100 (rounded)
  needsCompletion: boolean;
  /** مفاتيح الحقول المهمة المرئية وغير المُدخلة (لعرض tooltip «ناقص: ...»). */
  missingKeys: string[];
  /** tier للون الشارة. */
  tier: "high" | "mid" | "low";
}

/**
 * يحسب اكتمال ملف الأصل بنفس قواعد صفحة التفاصيل:
 * يمرّ الحقل المهم إن كان مرئيًا للدور (مالي → canSeeFinancial، حساس → canWrite)
 * ولم يُستثنَ من التفاصيل (visibleInDetails !== false).
 */
export function computeCompleteness(
  asset: AssetCompletenessInput,
  opts: { canSeeFinancial: boolean; canWrite: boolean },
): CompletenessResult {
  const template = getAssetTemplate(asset);
  const importantKeys = IMPORTANT_FIELDS[template.id];

  const isVisible = (f: TemplateField) =>
    f.visibleInDetails !== false &&
    (!f.financial || opts.canSeeFinancial) &&
    (!f.sensitive || opts.canWrite);

  const importantVisible = template.fields.filter(
    (f) => isVisible(f) && importantKeys.has(f.key),
  );
  const total = importantVisible.length;
  const filledFields = importantVisible.filter((f) => hasValue(readSpecialAttribute(asset, f.key)));
  const filled = filledFields.length;
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  const missingKeys = importantVisible
    .filter((f) => !hasValue(readSpecialAttribute(asset, f.key)))
    .map((f) => f.key);

  const tier: CompletenessResult["tier"] =
    pct >= COMPLETION_MID_THRESHOLD ? "high" : pct >= COMPLETION_LOW_THRESHOLD ? "mid" : "low";

  return {
    templateId: template.id,
    filled,
    total,
    pct,
    needsCompletion: total > 0 && pct < NEEDS_COMPLETION_BELOW,
    missingKeys,
    tier,
  };
}
