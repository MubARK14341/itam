-- ============================================================================
-- Migration: كتالوج البوابة — إغلاق ثغرة تصريح portal_list_catalog + مخطط الموديلات (شركة/تفعيل)
--            + دالة مستهلكات آمنة. (الدفعات أ + ب + ج مجمّعة، DDL فقط، صفر بيانات أعمال.)
-- Project: publication-disabled   Branch: ui/rc1-redesign
--
-- Purpose:
--   (أ) portal_list_catalog: يُعاد بناؤه ليحترم سماح التصنيفات (تعيين اسم→مفتاح بوابة، fail-closed)
--       و سماح الشركات (company_id نظيف) و portal_enabled. إسقاط آمن حصرًا بـ7 حقول (شركة بدل brand).
--   (ب) models: + company_id (FK companies) + is_active + فهرس فريد (تصنيف, شركة, lower(btrim(الاسم))).
--   (ج) portal_list_consumables: دالة جديدة بإسقاط آمن (5 حقول)، بلا مخزون/سعر/مورد/موقع/rfid/sku/notes.
--
-- Risk: إضافي/عديم الأثر عند التكرار. صفر insert/update/delete على بيانات الأعمال (models فارغ = 0 صف).
--   * لا مساس: مالي · pool_id · public_asset_by_token · تخزين · صفحات/دوال الموظفين · الأدوار/RLS القائمة.
--
-- ملاحظتان مبرّرتان (الحل التقني الوحيد لتسليم تصميم الدفعتين أ/ب، وكلاهما غير مُدمِّر):
--   1) DROP+CREATE لـ portal_list_catalog: تغيير شكل الإرجاع (brand→company_id/company_name، مطلب الدفعة أ
--      «أعِد بناء») يستحيل عبر create-or-replace في PostgreSQL. drop+create ذرّي = إعادة بناء بنفس الاسم/الغرض،
--      لا إزالة مدمِّرة؛ التصاريح تُعاد فورًا (revoke public+anon، grant authenticated).
--   2) ALTER COLUMN brand DROP NOT NULL: تصميم الدفعة ب («brand فارغ ⇒ القيم الفارغة متمايزة») يتطلب brand=NULL
--      للموديلات الجديدة كي يصبح UNIQUE(brand,model_name) القديم عديم الأثر. تخفيف قيد غير مُدمِّر (صفر فقد بيانات؛
--      models فارغ)؛ البدائل (default '' أو كتابة brand) تكسر موديلات متعددة الشركات/التصنيفات بنفس الاسم.
--
-- Rollback: (الدوال) استعادة الأجسام السابقة من Git/‏_baseline. (المخطط) الأعمدة/الفهرس إضافية غير مؤثّرة.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (ب) مخطط models — إضافي. الفهرس الفريد يطابق تطبيع companies (lower). brand يبقى موروثًا (لا حذف/قراءة/عرض).
-- ---------------------------------------------------------------------------
alter table public.models
  add column if not exists company_id uuid references public.companies(id),
  add column if not exists is_active  boolean not null default true;

-- مطلوب بتصميم الدفعة ب: brand فارغ (NULL) للموديلات الجديدة ⇒ UNIQUE(brand,model_name) القديم عديم الأثر
-- (NULL متمايزة في PostgreSQL). تخفيف قيد غير مُدمِّر — لا يُسقط عمودًا ولا بيانات (models=0 صف).
alter table public.models alter column brand drop not null;

create unique index if not exists models_uniq_cat_company_name
  on public.models (category_id, company_id, lower(btrim(model_name)));

-- ---------------------------------------------------------------------------
-- (أ) portal_list_catalog — إعادة بناء. الأعمدة مسمّاة صراحة (لا select *). إسقاط آمن حصرًا (7 حقول).
--     يحترم: portal_enabled · سماح التصنيفات (تعيين اسم→مفتاح بوابة، fail-closed للمجهول) · سماح الشركات (uuid).
--     دلالة السماح: لا صفوف ⇒ الكل المفعّل مسموح؛ صفوف ⇒ حصرًا ما فيها. (نمط not exists … or … in …)
--     صفر: مخزون · كمية · سعر · تكلفة · مورد · معرّف أصل · وسم · تسلسلي · rfid · pool_id · حالة · موقع.
-- ---------------------------------------------------------------------------
drop function if exists public.portal_list_catalog();
create or replace function public.portal_list_catalog()
returns table (
  category_id      uuid,
  category_name    text,
  category_name_ar text,
  company_id       uuid,
  company_name     text,
  model_id         uuid,
  model_name       text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cid uuid := public.portal_customer_id();
  v_s   public.customer_portal_settings;
begin
  if v_cid is null then return; end if;                 -- غير مستخدم بوابة ⇒ فارغ
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return; end if;        -- بوابة معطّلة/عميل غير معتمد ⇒ فارغ
  return query
  select cat.id, cat.name, cat.name_ar, comp.id, comp.name, m.id, m.model_name
  from public.models m
  join public.categories cat  on cat.id  = m.category_id
  join public.companies  comp on comp.id = m.company_id      -- شركة إلزامية للظهور (fail-closed)
  where cat.is_active = true
    and comp.is_active = true
    and coalesce(m.is_active, true) = true
    -- سماح التصنيفات (مفتاح البوابة المشتقّ من التصنيف؛ يجب أن يبقى متزامنًا مع PORTAL_CATEGORY_CATALOG)
    and (
      not exists (select 1 from public.customer_allowed_categories cac where cac.customer_id = v_cid)
      or (case
            when cat.kind = 'consumable'                 then 'consumable'
            when lower(btrim(cat.name)) = 'camera'          then 'camera'
            when lower(btrim(cat.name)) = 'printer'         then 'printer'
            when lower(btrim(cat.name)) = 'laptop'          then 'laptop'
            when lower(btrim(cat.name)) = 'pos device'      then 'pos'
            when lower(btrim(cat.name)) = 'barcode scanner' then 'scanner'
            else null
          end)
          in (select cac.category_key from public.customer_allowed_categories cac where cac.customer_id = v_cid)
    )
    -- سماح الشركات (company_id نظيف)
    and (
      not exists (select 1 from public.customer_allowed_companies aco where aco.customer_id = v_cid)
      or m.company_id in (select aco.company_id from public.customer_allowed_companies aco where aco.customer_id = v_cid)
    )
  order by cat.name, comp.name, m.model_name;
end $function$;

-- ---------------------------------------------------------------------------
-- (ج) portal_list_consumables — جديدة. إسقاط آمن حصرًا (5 حقول). يحترم portal_enabled + سماح التصنيفات.
--     is_active=true فقط. صفر: quantity_on_hand · reorder_level · unit_cost · currency · supplier_id ·
--     location_id · rfid_tag · sku · notes.
-- ---------------------------------------------------------------------------
create or replace function public.portal_list_consumables()
returns table (
  consumable_id    uuid,
  consumable_name  text,
  category_id      uuid,
  category_name    text,
  category_name_ar text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with me as (select public.portal_customer_id() as cid)
  select cn.id, cn.name, cat.id, cat.name, cat.name_ar
  from public.consumables cn
  join public.categories cat on cat.id = cn.category_id
  cross join me
  where me.cid is not null
    and (public._portal_settings(me.cid)).portal_enabled = true
    and cn.is_active = true
    and cat.is_active = true
    and (
      not exists (select 1 from public.customer_allowed_categories cac where cac.customer_id = me.cid)
      or (case
            when cat.kind = 'consumable'                 then 'consumable'
            when lower(btrim(cat.name)) = 'camera'          then 'camera'
            when lower(btrim(cat.name)) = 'printer'         then 'printer'
            when lower(btrim(cat.name)) = 'laptop'          then 'laptop'
            when lower(btrim(cat.name)) = 'pos device'      then 'pos'
            when lower(btrim(cat.name)) = 'barcode scanner' then 'scanner'
            else null
          end)
          in (select cac.category_key from public.customer_allowed_categories cac where cac.customer_id = me.cid)
    )
  order by cat.name, cn.name;
$function$;

-- ---------------------------------------------------------------------------
-- (د) التصاريح — revoke public ثم revoke anon صراحةً (Supabase يمنح anon افتراضيًا) ثم grant authenticated.
--     portal_list_catalog أُعيد إنشاؤه ⇒ فقد تصاريحه ⇒ يجب إعادتها بالكامل.
-- ---------------------------------------------------------------------------
revoke all on function public.portal_list_catalog()     from public;
revoke all on function public.portal_list_catalog()     from anon;
grant  execute on function public.portal_list_catalog() to authenticated;

revoke all on function public.portal_list_consumables()     from public;
revoke all on function public.portal_list_consumables()     from anon;
grant  execute on function public.portal_list_consumables() to authenticated;
