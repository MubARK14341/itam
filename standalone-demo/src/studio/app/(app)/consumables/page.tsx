"use client";

// تبقى صفحة /consumables شغّالة (روابط داخلية + توافق)، لكنها لم تعد ظاهرة في القائمة الجانبية —
// المستهلكات تُدار الآن من داخل تبويب «المستهلكات» في صفحة الأصول. كلاهما يستخدم نفس اللوحة.
import { ConsumablesPanel } from "@/components/consumables/consumables-panel";
import { FeatureRoute } from "@/components/feature-gate";

export default function ConsumablesPage() {
  // إظهار تدريجي: المستهلكات من مستوى 30 — رابط مباشر تحت المستوى ⇒ لوحة «تُفعَّل لاحقًا».
  return (
    <FeatureRoute feature="consumables.list">
      <ConsumablesPanel />
    </FeatureRoute>
  );
}
