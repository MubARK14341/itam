// تصفية الموردين حسب تصنيف الأصل (Phase 6).
// المورد المرتبط بتصنيفات يظهر فقط لتلك التصنيفات؛ المورد العام (بلا أي ربط) يظهر للجميع.

export function filterSuppliersByCategory<T extends { id: string }>(
  suppliers: T[],
  links: { supplier_id: string; category_id: string }[],
  categoryId: string | null | undefined,
): T[] {
  if (!categoryId) return suppliers;
  const bySupplier = new Map<string, Set<string>>();
  for (const l of links) {
    const set = bySupplier.get(l.supplier_id) ?? new Set<string>();
    set.add(l.category_id);
    bySupplier.set(l.supplier_id, set);
  }
  return suppliers.filter((s) => {
    const cats = bySupplier.get(s.id);
    if (!cats || cats.size === 0) return true; // مورد عام بلا تصنيف → متاح لكل التصنيفات
    return cats.has(categoryId);
  });
}
