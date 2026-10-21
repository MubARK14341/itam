-- =====================================================================
-- Purpose: إصلاح B1 — الزناد public.maintenance_guard_financial (BEFORE INSERT/UPDATE على
--   maintenance_records) كان يضع new.cost := null عند الإدراج لغير المخوّل مالياً
--   (is_financial_viewer() = false، أي غير admin/it_manager)، بينما العمود
--   cost numeric(12,2) NOT NULL default 0 ⇒ انتهاك not-null (SQLSTATE 23502).
--   الأثر: request_inspect_return (وأي إنشاء سجل صيانة من دور غير مالي) يفشل بـHTTP 400
--   ويتراجع كامل المعاملة لكل فحص «غير سليم/يحتاج صيانة» — فيعلق الطلب والأصل (REQ-2026-0022 / LAP-2026-0063).
--   الحل: تحييد التكلفة إلى 0 (وهو الافتراضي غير الحساس أصلاً) بدل null عند الإدراج.
-- Risk: منخفض — إعادة تعريف دالة زناد واحدة عبر create or replace فقط.
--   لا تغيير على المخطط/الأعمدة/المنح/ربط الزناد. الحماية المالية تبقى: غير المخوّل لا يُدخل
--   تكلفة حقيقية (تُحيَّد إلى 0)، والعمود يبقى محجوباً قراءةً على مستوى المنح (HIGH-1).
-- Rollback: create or replace public.maintenance_guard_financial بإرجاع سطر الإدراج إلى
--   new.cost := null (النسخة الأصلية من 20260701145434_high1_financial_column_protection_strict.sql).
-- Applied: 2026-07-12 عبر Supabase MCP apply_migration على المشروع publication-disabled.
-- ملاحظة موقع: ملفات الهجرات في هذا المستودع تحت itam-app/migrations/ (لا supabase/migrations/)،
--   والتطبيق الفعلي تمّ عبر MCP وسُجّل في تاريخ هجرات Supabase باسم fix_maintenance_guard_cost_notnull.
-- =====================================================================

create or replace function public.maintenance_guard_financial()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_financial_viewer() then
    if tg_op = 'INSERT' then
      new.cost := 0;   -- B1: كان null ⇒ ينتهك NOT NULL؛ 0 هو الافتراضي غير الحساس للعمود
    else
      new.cost := old.cost;
    end if;
  end if;
  return new;
end $function$;
