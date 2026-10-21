-- ============================================================================
-- Migration: بوابة العميل — إكمال الفجوات الوظيفية (ملف شخصي قابل للتحرير + كتالوج آمن +
--            إلزام جوال خادمي + تثبيت rental + اشتقاق التواصل من الجلسة)
-- Purpose:
--   1) portal_get_profile()            [جديد] قراءة ملف مستخدم البوابة (بلا بريد، بلا معرّف عميل)
--   2) portal_update_profile(...)      [جديد] تحديث الاسم/الجوال (والمدينة لمدير المشروع فقط) — الصف من auth.uid() حصرًا
--   3) portal_list_catalog()           [جديد] كتالوج آمن (تصنيف→ماركة→موديل) من models/categories فقط — صفر مخزون/سعر/معرّف أصل/pool
--   4) handle_new_user()               [استبدال] إضافة حارس «الجوال إلزامي» داخل فرع البوابة فقط — فرعا الموظف/الدعوة بايت ببايت
--   5) portal_create_request(...)      [استبدال] تثبيت rental + اشتقاق الجوال/البريد من الجلسة + رفض الجوال الفارغ (التوقيع بلا تغيير)
--   6) portal_add_item(...)            [استبدال] رفض الكمية غير الصحيحة و requested_kind غير المسموح (التوقيع بلا تغيير)
-- Risk: إضافي/عديم الأثر عند التكرار (create or replace). لا drop، لا تعداد، لا جدول، لا سياسة، لا عمود.
--       لا مساس: مالي · pool_id · public_asset_by_token · سياسات التخزين · صفحات/دوال الموظفين · الأدوار.
-- Rollback: استعادة الأجسام السابقة للدوال المستبدَلة من _baseline/تاريخ Git (لا تغيير بنيوي يُتراجع عنه).
-- Notes:
--   * الدوال الجديدة: revoke public + grant authenticated (لا anon).
--   * الدوال المستبدَلة تحافظ على تصاريحها القائمة (create or replace لا يُسقط GRANT) وعلى search_path الأصلي.
--   * models فارغ حاليًا في الإنتاج ⇒ الكتالوج يُرجع صفوفًا فارغة حتى تُضاف بيانات المنتجات (جاهزية بيانات، لا فجوة قدرة).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) قراءة الملف — بلا معاملات، بلا بريد، بلا معرّف عميل. الأعمدة مسمّاة صراحة.
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_profile()
returns table (
  contact_name text,
  phone        text,
  city         text,
  company_name text,
  portal_role  text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare v_cid uuid := public.portal_customer_id();
begin
  if v_cid is null then
    raise exception 'not_portal';
  end if;
  return query
  select cpu.contact_name,
         cpu.phone,
         c.city,
         c.name,                 -- اسم الشركة = customers.name (عرض فقط)
         cpu.portal_role
  from public.customer_portal_users cpu
  join public.customers c on c.id = cpu.customer_id
  where cpu.id = auth.uid() and cpu.is_active = true;
end $function$;

-- ---------------------------------------------------------------------------
-- 2) تحديث الملف — الصف يُحدَّد بـ auth.uid() حصرًا (لا معامل هوية). قائمة أعمدة بيضاء صريحة.
--    الجوال إلزامي حتى في التحديث (يُجبر العميل القديم على استكماله). المدينة: project_manager فقط.
-- ---------------------------------------------------------------------------
create or replace function public.portal_update_profile(
  p_contact_name text,
  p_phone        text,
  p_city         text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cid   uuid;
  v_role  text;
  v_name  text := btrim(coalesce(p_contact_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_city  text := btrim(coalesce(p_city, ''));
begin
  v_cid := public.portal_customer_id();
  if v_cid is null then
    raise exception 'not_portal';
  end if;
  if v_name  = '' then raise exception 'contact_name_required'; end if;
  if v_phone = '' then raise exception 'phone_required';        end if;

  select portal_role into v_role
  from public.customer_portal_users
  where id = auth.uid() and is_active = true;

  update public.customer_portal_users
     set contact_name = v_name,
         phone        = v_phone,
         updated_at   = now()
   where id = auth.uid();                    -- صف الجلسة حصرًا

  if v_role = 'project_manager' and v_city <> '' then
    update public.customers
       set city = v_city,
           updated_at = now()
     where id = v_cid;
  end if;
end $function$;

-- ---------------------------------------------------------------------------
-- 3) الكتالوج الآمن — تصنيف→ماركة→موديل من models/categories فقط. الأعمدة مسمّاة صراحة (لا select *).
--    صفر: عدّاد مخزون · كمية · سعر · تكلفة · معرّف أصل · وسم · تسلسلي · تتبع لاسلكي · pool_id · حالة · موقع.
--    التتالي صحيح بالبناء: الماركة/الموديل لا تظهر إلا إن وُجد لها صف في ذلك التصنيف.
-- ---------------------------------------------------------------------------
create or replace function public.portal_list_catalog()
returns table (
  category_id      uuid,
  category_name    text,
  category_name_ar text,
  brand            text,
  model_id         uuid,
  model_name       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select cat.id, cat.name, cat.name_ar, m.brand, m.id, m.model_name
  from public.models m
  join public.categories cat on cat.id = m.category_id
  where public.portal_customer_id() is not null      -- مستخدم بوابة فقط
    and cat.is_active = true
  order by cat.name, m.brand, m.model_name;
$function$;

-- ---------------------------------------------------------------------------
-- 4) handle_new_user — إضافة حارس «الجوال إلزامي» داخل فرع البوابة فقط.
--    فرعا الموظف والدعوة منقولان حرفيًا (بايت ببايت) من التعريف الأصلي. search_path محفوظ كما كان ('public').
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_full_name text := nullif(meta->>'full_name','');
  v_phone     text := nullif(meta->>'phone','');
  v_note      text := nullif(meta->>'registration_note','');
  v_req_role  text := nullif(meta->>'requested_role','');
  v_code      text := nullif(meta->>'invite_code','');
  v_dept      uuid;
  v_mode      text;
  v_default_role text;
  v_invite    record;
  v_pinvite   record;
  v_new_cust  uuid;
begin
  if coalesce(meta->>'user_type','') = 'portal' then
    -- [إضافة] الجوال إلزامي لتسجيل البوابة — داخل فرع البوابة حصرًا (لا يمسّ إنشاء العملاء الداخليين).
    if btrim(coalesce(v_phone,'')) = '' then
      raise exception 'phone is required for portal registration' using errcode = '23514';
    end if;
    if v_code is not null then
      select * into v_pinvite from public.customer_portal_invites
      where lower(code) = lower(coalesce(v_code,''))
        and is_active = true and expires_at > now() and used_count < max_uses
      order by created_at desc limit 1;
      if not found then
        raise exception 'invalid_portal_invite' using errcode = '22023';
      end if;
      insert into public.customer_portal_users (id, customer_id, contact_name, phone, portal_role, invited_by)
      values (new.id, v_pinvite.customer_id,
              coalesce(v_full_name, split_part(new.email,'@',1)),
              v_phone, v_pinvite.portal_role, v_pinvite.created_by);
      update public.customer_portal_invites set used_count = used_count + 1 where id = v_pinvite.id;
      return new;
    else
      insert into public.customers (name, phone, email, city, approval_status, is_active, created_by)
      values (coalesce(nullif(meta->>'company_name',''), v_full_name, split_part(new.email,'@',1)),
              v_phone, new.email, nullif(meta->>'city',''), 'pending', true, new.id)
      returning id into v_new_cust;
      insert into public.customer_portal_users (id, customer_id, contact_name, phone, portal_role)
      values (new.id, v_new_cust, coalesce(v_full_name, split_part(new.email,'@',1)), v_phone, 'project_manager');
      return new;
    end if;
  end if;

  begin v_dept := (meta->>'department_id')::uuid; exception when others then v_dept := null; end;

  select mode, default_requested_role into v_mode, v_default_role
  from public.registration_settings where id = 'main';
  v_default_role := coalesce(v_default_role, 'viewer');

  if v_code is not null then
    select * into v_invite from public.registration_invites
    where lower(code) = lower(v_code) and is_active = true
      and (expires_at is null or expires_at > now())
      and (max_uses is null or used_count < max_uses)
    limit 1;
    if found then
      v_req_role := coalesce(v_invite.default_role, v_req_role, v_default_role);
      update public.registration_invites set used_count = used_count + 1 where id = v_invite.id;
      insert into public.registration_invite_uses (invite_id, user_id, email)
      values (v_invite.id, new.id, new.email);
    end if;
  end if;

  if v_mode = 'gradual' then
    update public.registration_settings
    set remaining_slots = greatest(remaining_slots - 1, 0)
    where id = 'main' and remaining_slots > 0;
  end if;

  insert into public.app_users
    (id, email, role_id, full_name, phone, department_id,
     registration_note, requested_role, approval_status, is_active)
  values
    (new.id, new.email,
     (select id from public.roles where key = 'viewer'),
     v_full_name, v_phone, v_dept, v_note,
     coalesce(v_req_role, v_default_role, 'viewer'),
     'pending', true)
  on conflict (id) do nothing;

  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- 5) portal_create_request — التوقيع بلا تغيير. الجديد:
--    * request_type مثبَّتة 'rental' (تُتجاهَل قيمة الواجهة تمامًا).
--    * الجوال يُشتقّ من صف مستخدم الجلسة (customer_portal_users.phone) — لا من الحمولة. فارغ ⇒ رفض.
--    * البريد يُشتقّ من auth.users — لا من الحمولة. لا يُرجَع للعميل (يُخزَّن كلقطة فقط).
--    p_contact_phone / p_contact_email / p_request_type تُقبَل في التوقيع لكن تُتجاهَل (توافق العميل القائم).
-- ---------------------------------------------------------------------------
create or replace function public.portal_create_request(
  p_project_name text, p_project_city text, p_contact_phone text, p_contact_email text,
  p_request_type text, p_pickup_date date, p_return_date date, p_notes text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_cust_name text; v_id uuid;
  v_phone text; v_email text;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  -- rental مثبَّتة على الخادم؛ يُتحقق من إتاحتها في إعدادات العميل (سلوك النوع القائم).
  if not v_s.allow_rental_requests then return json_build_object('ok', false, 'error', 'request_type_not_allowed'); end if;

  -- الجوال والبريد من الجلسة حصرًا — لا من الحمولة.
  select phone into v_phone from public.customer_portal_users where id = auth.uid() and is_active = true;
  select email into v_email from auth.users where id = auth.uid();
  if btrim(coalesce(v_phone,'')) = '' then return json_build_object('ok', false, 'error', 'phone_required'); end if;

  select name into v_cust_name from public.customers where id = v_cid;
  insert into public.requests (
    customer_id, customer_name_snapshot, contact_phone_snapshot, contact_email_snapshot,
    project_name, project_city, request_type, status, request_source, submitted_by,
    pickup_date, return_date, notes, created_by
  ) values (
    v_cid, v_cust_name, v_phone, v_email,
    nullif(p_project_name,''), nullif(p_project_city,''), 'rental', 'draft', 'client_portal', auth.uid(),
    p_pickup_date, p_return_date,           -- rental يحتفظ بتاريخ الإرجاع
    nullif(p_notes,''), auth.uid()
  ) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $function$;

-- ---------------------------------------------------------------------------
-- 6) portal_add_item — التوقيع بلا تغيير. الجديد: رفض الكمية غير الصحيحة و requested_kind غير المسموح.
--    بقية الجسم منقول كما هو (تحقق الفئة/الشركة/الحالة).
-- ---------------------------------------------------------------------------
create or replace function public.portal_add_item(
  p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text,
  p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean,
  p_preferred_company_id uuid default null::uuid, p_category_key text default null::text)
 returns json
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_kind text; v_cat_label text;
  v_company_count int; v_category_count int; v_needs boolean := coalesce(p_needs_purchase, false);
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- [إضافة] رفض requested_kind غير المسموح والكمية غير الصحيحة (عدد صحيح ≥ 1).
  if coalesce(p_requested_kind,'') not in ('consumable','custom') then
    return json_build_object('ok', false, 'error', 'invalid_kind'); end if;
  if p_quantity is null or p_quantity < 1 or p_quantity <> floor(p_quantity) then
    return json_build_object('ok', false, 'error', 'invalid_quantity'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;

  if v_needs and not v_s.allow_custom_item_requests then
    return json_build_object('ok', false, 'error', 'custom_item_not_allowed'); end if;

  if p_preferred_company_id is not null then
    select count(*) into v_company_count from public.customer_allowed_companies where customer_id = v_cid;
    if v_company_count = 0 then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
    if not exists (select 1 from public.customer_allowed_companies
                   where customer_id = v_cid and company_id = p_preferred_company_id) then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
  end if;

  select count(*) into v_category_count from public.customer_allowed_categories where customer_id = v_cid;
  if v_category_count > 0 then
    if nullif(btrim(p_category_key),'') is null
       or not exists (select 1 from public.customer_allowed_categories
                      where customer_id = v_cid and category_key = p_category_key) then
      return json_build_object('ok', false, 'error', 'category_not_allowed');
    end if;
    select coalesce(category_label_ar, category_label_en, category_key)
      into v_cat_label
      from public.customer_allowed_categories
      where customer_id = v_cid and category_key = p_category_key;
  else
    v_cat_label := nullif(p_requested_category, '');
  end if;

  v_kind := case when p_requested_kind = 'consumable' then 'consumable' else 'custom' end;
  insert into public.request_items (
    request_id, item_kind, requested_kind, requested_description, requested_category,
    quantity, preferred_model, preferred_company_id, accept_alternative, needs_purchase
  ) values (
    p_request_id, 'custom', v_kind, nullif(p_requested_description,''), v_cat_label,
    greatest(coalesce(p_quantity,1), 1), nullif(p_preferred_model,''), p_preferred_company_id,
    coalesce(p_accept_alternative, true), v_needs
  );
  return json_build_object('ok', true);
end $function$;

-- ---------------------------------------------------------------------------
-- التصاريح — للدوال الجديدة فقط (المستبدَلة تحافظ على تصاريحها). لا anon.
-- ---------------------------------------------------------------------------
-- تنبيه: Supabase يمنح EXECUTE افتراضيًا لـ anon عند إنشاء الدالة (ALTER DEFAULT PRIVILEGES)، فلا يكفي
-- revoke from public وحده. إزالة منح anon المباشر في ملف الترحيل التالي: 20260713120500_portal_new_fns_revoke_anon.sql
revoke all on function public.portal_get_profile()                     from public;
revoke all on function public.portal_update_profile(text, text, text)  from public;
revoke all on function public.portal_list_catalog()                    from public;
grant execute on function public.portal_get_profile()                    to authenticated;
grant execute on function public.portal_update_profile(text, text, text) to authenticated;
grant execute on function public.portal_list_catalog()                   to authenticated;
