// ============================================================================
//  Client Portal — Phase 5: الفهرس القانوني لتصنيفات العناصر (المصدر الوحيد).
//  نفس مفاتيح شاشة «طلب جديد» (t.portal.categories). يُستخدم في:
//    • واجهة إعدادات العميل (اختيار التصنيفات المسموحة + لقطة تسميتها ar/en).
//    • احتياطي البوابة عندما تكون قائمة السماح فارغة (لا قيد).
//  الأمان مفروض في القاعدة (portal_add_item يتحقق من category_key)؛ هذا الفهرس مجرّد
//  قائمة اختيارات للواجهة — ليس مصدر الأمان.
// ============================================================================

export const PORTAL_CATEGORY_CATALOG = [
  { key: "camera", label_ar: "كاميرا", label_en: "Camera" },
  { key: "printer", label_ar: "طابعة", label_en: "Printer" },
  { key: "laptop", label_ar: "لابتوب", label_en: "Laptop" },
  { key: "pos", label_ar: "جهاز POS", label_en: "POS device" },
  { key: "scanner", label_ar: "ماسح باركود", label_en: "Barcode scanner" },
  { key: "consumable", label_ar: "مستهلك", label_en: "Consumable" },
  { key: "other", label_ar: "أخرى", label_en: "Other" },
] as const;

export type PortalCategoryKey = (typeof PORTAL_CATEGORY_CATALOG)[number]["key"];

export const PORTAL_CATEGORY_KEYS: readonly PortalCategoryKey[] =
  PORTAL_CATEGORY_CATALOG.map((c) => c.key);

// ============================================================================
//  مرآة عميلة لتعيين اسم التصنيف (الإنجليزي) → مفتاح البوابة، مطابقة لدالتي
//  portal_list_catalog / portal_list_consumables في القاعدة (يجب أن تبقيا متزامنتين).
//  القاعدة هي مصدر الفرض؛ هذا للاتساق فقط: مسار الكتابة portal_add_item يعيد التحقق
//  من category_key ضد قائمة السماح (fail-closed) — فمفتاح خاطئ/غائب يُرفَض، لا يُسرِّب.
//  (فرع kind='consumable' في القاعدة لا يُمثَّل هنا لأن صفوف الكتالوج لا تحمل kind؛
//   مسار المستهلكات يُمرّر 'consumable' افتراضيًا عند غياب مطابقة الاسم.)
// ============================================================================
export function portalKeyForCategoryName(name: string | null | undefined): PortalCategoryKey | null {
  switch ((name ?? "").trim().toLowerCase()) {
    case "camera": return "camera";
    case "printer": return "printer";
    case "laptop": return "laptop";
    case "pos device": return "pos";
    case "barcode scanner": return "scanner";
    default: return null;
  }
}

export function filterPortalCatalog<
  T extends { category_id: string; company_id: string },
>(rows: readonly T[], categoryId: string, companyId?: string): T[] {
  if (!categoryId) return [];
  return rows.filter((row) =>
    row.category_id === categoryId && (!companyId || row.company_id === companyId),
  );
}
