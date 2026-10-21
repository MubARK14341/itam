// ======================= خيارات الطلب المجمّعة (Need-based) =======================
// دالة نقية (بلا Supabase) تُحوّل قائمة الأصول الفردية إلى خيارات مجمّعة
// «تصنيف ← شركة ← موديل» مع عدد المتاح/الإجمالي — تُستخدم في نموذج إنشاء الطلب
// وفلترة FulfillDialog. الموديل يظهر مرة واحدة مهما تكرر الجهاز.
// شاشة موظفين فقط: البوابة لا تصل لهذه الدالة ولا لعدّادات المخزون إطلاقًا.

export interface GroupableAsset {
  id: string;
  name: string | null;
  status: string;
  category_id: string | null;
  company_id: string | null;
  model_id: string | null;
  category: { name: string; name_ar: string | null } | null;
  company: { name: string } | null;
  model: { brand: string | null; model_name: string | null } | null;
}

export interface GroupedAssetOption {
  key: string;
  categoryId: string | null;
  categoryLabel: string;      // name_ar إن وجد وإلا name (تُخزَّن كـ requested_category)
  companyId: string | null;   // FK companies إن وُجد فقط (تُخزَّن كـ preferred_company_id، غالبًا null اليوم)
  companyKey: string;         // مفتاح الماركة المشتقّة (للفلترة/التجميع) — id:<uuid> أو b:<brand> أو unspec
  companyLabel: string | null; // اسم الماركة للعرض (null ⇒ الواجهة تعرض «غير محدد»)
  modelLabel: string;         // brand+model_name إن وجد وإلا اسم الأصل (تُخزَّن كـ preferred_model)
  available_count: number;
  total_count: number;
}

export type RequestQuantityError = "invalid" | "unavailable" | "exceeds_available";

export function requestHasItems(items: readonly unknown[]): boolean {
  return items.length > 0;
}

export function validateRequestQuantity(
  rawQuantity: string | number,
  existingQuantity = 0,
  available: number | null = null,
): { quantity: number; total: number; error: RequestQuantityError | null } {
  const quantity = typeof rawQuantity === "number" ? rawQuantity : Number(rawQuantity);
  if (!Number.isInteger(quantity) || quantity < 1) return { quantity: 0, total: existingQuantity, error: "invalid" };
  const total = existingQuantity + quantity;
  if (available != null && available <= 0) return { quantity, total, error: "unavailable" };
  if (available != null && total > available) return { quantity, total, error: "exceeds_available" };
  return { quantity, total, error: null };
}

export function mergeRequestDraftLine<T extends { key: string; quantity: number }>(
  rows: T[],
  incoming: T,
  available: number | null,
): { rows: T[]; error: RequestQuantityError | null } {
  const index = rows.findIndex((row) => row.key === incoming.key);
  const existing = index >= 0 ? rows[index].quantity : 0;
  const check = validateRequestQuantity(incoming.quantity, existing, available);
  if (check.error) return { rows, error: check.error };
  if (index < 0) return { rows: [...rows, incoming], error: null };
  return {
    rows: rows.map((row, i) => i === index ? { ...row, quantity: check.total } : row),
    error: null,
  };
}

// تسمية الموديل: models(brand+model_name) أولوية، وإلا اسم الأصل الحر، وإلا "—".
export function assetModelLabel(a: Pick<GroupableAsset, "name" | "model">): string {
  const brand = a.model?.brand?.trim() ?? "";
  const modelName = a.model?.model_name?.trim() ?? "";
  const fromModel = [brand, modelName].filter(Boolean).join(" ");
  return fromModel || a.name?.trim() || "—";
}

// ======================= اشتقاق الماركة (Brand facet) =======================
// بيانات الأصول الحالية: company_id/model_id فارغة تمامًا، والماركة مدفونة في الاسم الحر
// بصيغ غير موحّدة ("laptop -hp-(15..)", "Laptop (Lenovo)", "Mac Book Air"). جدول companies
// ناقص ASUS/Acer ويخزّن Apple بينما الأصول تكتب Mac — لذلك نشتقّ الماركة من بيانات الأصل نفسها
// بأولوية: company_id (FK) ← model.brand ← مطابقة قاموس على الاسم ← «غير محدد».
export interface BrandFacet {
  key: string;            // للتجميع/الفلترة
  label: string | null;   // للعرض (null ⇒ «غير محدد»)
  companyId: string | null; // FK حقيقي فقط (يُخزَّن كـ preferred_company_id)
}

// قاموس ماركات معروف مستقل عن جدول companies (لأنه ناقص). كل مدخل: تسمية + رموز مطابقة صغيرة.
const BRAND_ALIASES: { label: string; match: string[] }[] = [
  { label: "HP", match: ["hp", "hewlett"] },
  { label: "Dell", match: ["dell"] },
  { label: "Lenovo", match: ["lenovo", "thinkpad"] },
  { label: "ASUS", match: ["asus"] },
  { label: "Acer", match: ["acer"] },
  { label: "Apple", match: ["apple", "mac", "macbook", "imac"] },
  { label: "Samsung", match: ["samsung"] },
  { label: "Honor", match: ["honor"] },
  { label: "Huawei", match: ["huawei"] },
  { label: "Microsoft", match: ["microsoft", "surface"] },
  { label: "MSI", match: ["msi"] },
  { label: "Toshiba", match: ["toshiba"] },
  { label: "Sony", match: ["sony", "vaio"] },
  { label: "LG", match: ["lg"] },
  { label: "Cisco", match: ["cisco"] },
  { label: "Canon", match: ["canon"] },
  { label: "Epson", match: ["epson"] },
  { label: "Brother", match: ["brother"] },
  { label: "Hikvision", match: ["hikvision"] },
  { label: "Dahua", match: ["dahua"] },
  { label: "Zebra", match: ["zebra"] },
  { label: "TP-LINK", match: ["tp-link", "tplink", "tp link"] },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// مطابقة رمز الماركة بحدود كلمة على النص المُصغّر (يتعامل مع "-hp-"، "(lenovo)"، "dell(")
function nameHasToken(lowerName: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(token)}(?:[^a-z0-9]|$)`).test(lowerName);
}

export function assetBrandFacet(a: GroupableAsset): BrandFacet {
  // 1) FK companies إن وُجد
  const coName = a.company?.name?.trim();
  if (a.company_id && coName) return { key: `id:${a.company_id}`, label: coName, companyId: a.company_id };
  // 2) model.brand
  const mb = a.model?.brand?.trim();
  if (mb) return { key: `b:${mb.toLowerCase()}`, label: mb, companyId: null };
  // 3) اشتقاق من الاسم الحر عبر القاموس
  const lower = (a.name ?? "").toLowerCase();
  for (const b of BRAND_ALIASES) {
    if (b.match.some((tok) => nameHasToken(lower, tok))) {
      return { key: `b:${b.label.toLowerCase()}`, label: b.label, companyId: null };
    }
  }
  // 4) غير محدد
  return { key: "unspec", label: null, companyId: null };
}

// ماركات التصنيف المختار فقط (مصدر قائمة «الشركة/الماركة») — مميّزة ومرتّبة، «غير محدد» أخيرًا.
export function brandOptionsForCategory(
  groups: GroupedAssetOption[],
  categoryId: string | null,
): { key: string; label: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const g of groups) {
    if (categoryId && g.categoryId !== categoryId) continue;
    if (!seen.has(g.companyKey)) seen.set(g.companyKey, g.companyLabel);
  }
  return Array.from(seen, ([key, label]) => ({ key, label })).sort((x, y) => {
    if (x.key === "unspec") return 1;
    if (y.key === "unspec") return -1;
    return (x.label ?? "").localeCompare(y.label ?? "", "ar");
  });
}

export function categoryLabelOf(a: Pick<GroupableAsset, "category">): string {
  return a.category?.name_ar?.trim() || a.category?.name?.trim() || "—";
}

export function groupAssetOptions(assets: GroupableAsset[]): GroupedAssetOption[] {
  const map = new Map<string, GroupedAssetOption>();
  for (const a of assets) {
    const categoryLabel = categoryLabelOf(a);
    const modelLabel = assetModelLabel(a);
    const facet = assetBrandFacet(a);
    const key = `${a.category_id ?? "-"}|${facet.key}|${modelLabel}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        categoryId: a.category_id ?? null,
        categoryLabel,
        companyId: facet.companyId,
        companyKey: facet.key,
        companyLabel: facet.label,
        modelLabel,
        available_count: 0,
        total_count: 0,
      };
      map.set(key, g);
    }
    g.total_count += 1;
    if (a.status === "available") g.available_count += 1;
  }
  // ترتيب ثابت: التصنيف ثم الماركة ثم الموديل (عرض متوقّع في القوائم)
  return Array.from(map.values()).sort((x, y) =>
    x.categoryLabel.localeCompare(y.categoryLabel, "ar") ||
    (x.companyLabel ?? "￿").localeCompare(y.companyLabel ?? "￿", "ar") ||
    x.modelLabel.localeCompare(y.modelLabel, "ar"),
  );
}

// هل يطابق الأصل احتياج بند طلب؟ (لفلترة FulfillDialog الافتراضية)
// مطابقة نصية على label التصنيف + الشركة إن حُدّدت + الموديل إن حُدّد.
// المطابقة النصية قد تفوّت اختلاف تسمية — لذلك تُعرض مع toggle «عرض كل الأصول».
export function assetMatchesNeed(
  a: GroupableAsset,
  need: { requested_category: string | null; preferred_company_id: string | null; preferred_model: string | null },
): boolean {
  if (need.requested_category && categoryLabelOf(a) !== need.requested_category) return false;
  if (need.preferred_company_id && a.company_id !== need.preferred_company_id) return false;
  if (need.preferred_model && assetModelLabel(a) !== need.preferred_model) return false;
  return true;
}
