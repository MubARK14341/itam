-- ============================================================================
--  Batch 2A — depreciation rules: company dimension + useful-life + end-of-life alerts
--  (version 20260705140000). Mirror of the live migration.
--
--  الهدف: توسيع قواعد الإهلاك لتشمل الشركة/العلامة والعمر الافتراضي وتنبيه انتهاء العمر
--  وأولوية الاختيار — إضافيًا فقط، بلا لمس annual_rate/salvage_rate أو purchase_cost.
--
--  الأعمدة الجديدة **غير مالية** (بارامترات سياسة، ليست مبالغ) → تُمنَح لـ authenticated
--  كي تعمل حالة «العمر التشغيلي» وتنبيهات مركز الإجراءات لكل الأدوار دون كشف أي رقم مالي.
--  النِّسب (annual_rate/salvage_rate) تبقى محجوبة على مستوى العمود (RPC depreciation_financial).
--
--  غير مدمّر: ADD COLUMN IF NOT EXISTS + إعادة منح. لا حذف بيانات. Rollback ممكن بإسقاط
--  الأعمدة الأربعة (اختياري) — القيم الحالية لا تتأثر.
-- ============================================================================

alter table public.depreciation_rules
  add column if not exists company_id uuid references public.companies(id) on delete set null,
  add column if not exists useful_life_years numeric,
  add column if not exists alert_before_days integer not null default 30,
  add column if not exists priority integer not null default 100;

-- تعليقات توثيقية (اختيارية، تساعد المشرف):
comment on column public.depreciation_rules.company_id is 'الشركة المُصنِّعة/العلامة (اختياري) — بُعد إضافي لاختيار القاعدة';
comment on column public.depreciation_rules.useful_life_years is 'العمر الافتراضي بالسنوات — يُشتق منه المعدل ويحدد نهاية العمر (غير مالي)';
comment on column public.depreciation_rules.alert_before_days is 'التنبيه قبل نهاية العمر بكم يوم (افتراضي 30)';
comment on column public.depreciation_rules.priority is 'مُرجِّح عند تساوي التخصيص — الأعلى يفوز (افتراضي 100)';

-- إعادة منح الأعمدة غير المالية (تشمل الأربعة الجديدة). النِّسب تبقى خارج المنحة = محجوبة.
revoke select on public.depreciation_rules from authenticated;
revoke select on public.depreciation_rules from anon;
grant select (
  id, category_id, asset_type, method, is_active, created_at, updated_at,
  company_id, useful_life_years, alert_before_days, priority
) on public.depreciation_rules to authenticated;
