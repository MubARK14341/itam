// حساب الاستهلاك والقيمة الحالية التقديرية للأصل (Straight-line).
// المنطق محسوب ديناميكيًا فقط — لا يُخزَّن في قاعدة البيانات ولا يُغيّر purchase_cost الأصلي.
// القيمة الحالية لا تُعرض إلا لمن لديه canSeeFinancial (يُطبَّق في طبقة العرض).

export interface DepreciationRule {
  id: string;
  category_id: string | null;
  asset_type: string | null;
  method: string; // 'straight_line'
  annual_rate: number; // نسبة مئوية 0..100 (مالي — قد يكون undefined لغير المخوّلين)
  salvage_rate: number; // نسبة مئوية 0..100 (حد أدنى للقيمة كنسبة من سعر الشراء)
  is_active: boolean;
  // إضافات الدفعة 2A (غير مالية — بارامترات سياسة): تُحمّل لكل الأدوار.
  company_id?: string | null; // الشركة المُصنِّعة/العلامة (اختياري)
  useful_life_years?: number | null; // العمر الافتراضي بالسنوات (يشتق منه المعدل عند وجوده)
  alert_before_days?: number | null; // التنبيه قبل نهاية العمر بكم يوم
  priority?: number | null; // مُرجِّح عند تساوي التخصيص (الأعلى يفوز)
}

export type EndOfLifeStatus = "na" | "active" | "expiring_soon" | "ended";

export interface EndOfLifeResult {
  applicable: boolean; // هل يوجد تاريخ شراء + قاعدة بعمر افتراضي موجب
  endOfLifeDate: string | null; // yyyy-mm-dd نهاية العمر المتوقعة
  remainingDays: number | null; // المتبقّي بالأيام (سالب = منتهٍ)
  usefulLifeYears: number | null;
  status: EndOfLifeStatus;
}

export interface DepreciationResult {
  applicable: boolean; // هل يوجد سعر شراء + تاريخ + قاعدة فعّالة بنسبة > 0
  purchaseCost: number | null;
  ageYears: number; // عمر الأصل بالسنوات (قد يكون كسريًا)
  annualRate: number; // النسبة المستخدمة %
  salvageRate: number; // % الحد الأدنى
  accumulatedDepreciation: number; // إجمالي الاستهلاك حتى الآن
  currentValue: number | null; // القيمة الحالية التقديرية
  minValue: number; // الحد الأدنى للقيمة
}

/** عدد السنوات (كسري) بين تاريخ الشراء والآن. يرجع 0 إن لم يوجد تاريخ صالح. */
export function ageInYears(purchaseDate: string | null | undefined, asOf?: Date): number {
  if (!purchaseDate) return 0;
  const start = new Date(purchaseDate);
  if (Number.isNaN(start.getTime())) return 0;
  const end = asOf ?? new Date();
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return 0;
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * يختار القاعدة الأنسب حسب الأولوية:
 *   company+category+asset_type ← company+category ← category+asset_type ← category ← company ← عام(افتراضي)
 * القاعدة التي تُحدِّد حقلًا يجب أن تطابقه (لا تُطبَّق قاعدة نوع/شركة/تصنيف مختلف).
 * عند تساوي التخصيص يفوز الأعلى `priority`. يتجاهل غير الفعّالة.
 *
 * ملاحظة توافقية: القواعد الحالية كلها بـ category_id (وبلا company_id) → السلوك يبقى:
 * قاعدة النوع أولًا ثم القاعدة الافتراضية للتصنيف. القواعد العامة (بلا تصنيف) لا توجد بعد،
 * فلا يتغيّر أي حساب قائم حتى يُضيف المشرف قاعدة جديدة.
 */
export function pickRule(
  rules: DepreciationRule[],
  categoryId: string | null | undefined,
  assetType?: string | null,
  companyId?: string | null,
): DepreciationRule | null {
  let best: DepreciationRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    if (!r.is_active) continue;
    // إن حدّدت القاعدة حقلًا فيجب أن يطابق (قاعدة عامة = بلا تحديد تطابق الجميع).
    if (r.company_id && r.company_id !== companyId) continue;
    if (r.category_id && r.category_id !== categoryId) continue;
    if (r.asset_type && r.asset_type !== assetType) continue;
    // درجة التخصيص: كل حقل محدد يزيد الوزن؛ ثم priority كمُرجِّح.
    let spec = 0;
    if (r.company_id) spec += 4;
    if (r.category_id) spec += 2;
    if (r.asset_type) spec += 1;
    const score = spec * 1000 + (r.priority ?? 100);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

/**
 * الاستهلاك الخطّي:
 *   depreciation = purchase_cost * (annual_rate/100) * years
 *   minValue     = purchase_cost * (salvage_rate/100)
 *   currentValue = max(purchase_cost - depreciation, minValue)
 */
export function computeDepreciation(
  purchaseCost: number | null | undefined,
  purchaseDate: string | null | undefined,
  rule: DepreciationRule | null,
  asOf?: Date,
): DepreciationResult {
  const cost = purchaseCost != null && Number.isFinite(purchaseCost) ? purchaseCost : null;
  const salvageRate = rule ? (rule.salvage_rate ?? 0) : 0;
  // العمر الافتراضي (سنوات) يُقدَّم على النسبة اليدوية عند وجوده:
  //   annual_rate المشتق = (100 − salvage%) / useful_life_years  → القسط الثابت حتى القيمة المتبقية.
  const life = rule && rule.useful_life_years != null && Number(rule.useful_life_years) > 0
    ? Number(rule.useful_life_years) : null;
  const annualRate = rule
    ? (life != null ? (100 - salvageRate) / life : rule.annual_rate)
    : 0;
  const ageYears = ageInYears(purchaseDate, asOf);

  const base: DepreciationResult = {
    applicable: false,
    purchaseCost: cost,
    ageYears,
    annualRate,
    salvageRate,
    accumulatedDepreciation: 0,
    currentValue: cost,
    minValue: cost != null ? cost * (salvageRate / 100) : 0,
  };

  // غير قابل للحساب: لا تكلفة، أو لا تاريخ شراء، أو لا قاعدة فعّالة بنسبة موجبة.
  if (cost == null || !purchaseDate || !rule || annualRate <= 0) {
    return base;
  }

  const minValue = cost * (salvageRate / 100);
  const rawDepreciation = cost * (annualRate / 100) * ageYears;
  const currentValue = Math.max(cost - rawDepreciation, minValue);
  const accumulatedDepreciation = cost - currentValue;

  return {
    applicable: true,
    purchaseCost: cost,
    ageYears,
    annualRate,
    salvageRate,
    accumulatedDepreciation,
    currentValue,
    minValue,
  };
}

const DAY_MS = 864e5;

/**
 * حالة نهاية العمر التشغيلي — **غير مالية بالكامل**: تعتمد على تاريخ الشراء + العمر الافتراضي فقط،
 * فتعمل لكل الأدوار (فني/عارض) دون أي رقم مالي، وتبقى مزامنة مركز الإجراءات خالية من الماليات.
 * غير قابلة للحساب ما لم يوجد تاريخ شراء وقاعدة بعمر افتراضي موجب — فلا تنبيهات على البيانات الحالية
 * حتى يضبط المشرف `useful_life_years` للقاعدة.
 */
export function computeEndOfLife(
  purchaseDate: string | null | undefined,
  rule: DepreciationRule | null,
  asOf?: Date,
): EndOfLifeResult {
  const na: EndOfLifeResult = {
    applicable: false, endOfLifeDate: null, remainingDays: null, usefulLifeYears: null, status: "na",
  };
  const life = rule && rule.useful_life_years != null && Number(rule.useful_life_years) > 0
    ? Number(rule.useful_life_years) : null;
  if (!purchaseDate || !rule || life == null) return na;
  const start = new Date(purchaseDate);
  if (Number.isNaN(start.getTime())) return na;

  const eolMs = start.getTime() + life * 365.25 * DAY_MS;
  const now = (asOf ?? new Date()).getTime();
  const remainingDays = Math.ceil((eolMs - now) / DAY_MS);
  const alertBefore = rule.alert_before_days != null ? Number(rule.alert_before_days) : 30;

  const status: EndOfLifeStatus =
    remainingDays <= 0 ? "ended"
      : remainingDays <= alertBefore ? "expiring_soon"
        : "active";

  return {
    applicable: true,
    endOfLifeDate: new Date(eolMs).toISOString().slice(0, 10),
    remainingDays,
    usefulLifeYears: life,
    status,
  };
}
