-- ============================================================================
--  Client Portal — Phase 5 (2/2): فرض الإعدادات في RPCs + اعتماد مدير المشروع + RPCs إدارية.
--  إضافي وآمن. كل الفرض في القاعدة (لا الواجهة). لا لمس منطق المخزون · لا anon.
--
--  خريطة نوع الطلب (قيمة القاعدة → مفتاح السماح):
--    rental  → allow_rental_requests
--    sale    → allow_purchase_requests      (شراء من منظور العميل = بيع من مخزوننا)
--    service → allow_maintenance_requests   (خدمة = صيانة)
--    mixed   → allow_custom_requests        (طلب خاص/مختلط)
--
--  اعتماد مدير المشروع (portal_approval_status على requests):
--    • authorized_requester + require_pm=true  ⇒ submit لا يصل للفريق: يبقى draft +
--      portal_approval_status='pending_project_manager' (لا يظهر داخليًا حتى الاعتماد).
--    • project_manager يعتمد ⇒ draft→under_review + approved_by_project_manager (يظهر للفريق).
--    • project_manager يرفض ⇒ draft→cancelled + rejected_by_project_manager (لا يظهر للفريق).
--    • project_manager يرسل مباشرةً ⇒ under_review فورًا.
--    • not_required (الطلبات القديمة/الداخلية) = سلوك سابق تمامًا.
-- ============================================================================

-- ###########################################################################
--  أ) RPCs إدارية (admin/it_manager فقط) — إدارة الإعدادات وقوائم السماح
-- ###########################################################################

-- 1) قراءة إعدادات عميل + قوائمه (للواجهة الإدارية). يُرجع الافتراضات إن لم يوجد صف.
create or replace function public.get_customer_portal_settings(p_customer_id uuid)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_role text := public.app_user_role(); v_s public.customer_portal_settings;
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  v_s := public._portal_settings(p_customer_id);
  return json_build_object('ok', true,
    'settings', json_build_object(
      'portal_enabled', v_s.portal_enabled,
      'allow_rental_requests', v_s.allow_rental_requests,
      'allow_purchase_requests', v_s.allow_purchase_requests,
      'allow_maintenance_requests', v_s.allow_maintenance_requests,
      'allow_custom_requests', v_s.allow_custom_requests,
      'allow_custom_item_requests', v_s.allow_custom_item_requests,
      'allow_attachments', v_s.allow_attachments,
      'require_project_manager_approval', v_s.require_project_manager_approval
    ),
    'allowed_companies', coalesce((
      select json_agg(json_build_object('company_id', c.id, 'name', c.name) order by c.name)
      from public.customer_allowed_companies ac join public.companies c on c.id = ac.company_id
      where ac.customer_id = p_customer_id), '[]'::json),
    'allowed_categories', coalesce((
      select json_agg(json_build_object('category_key', category_key,
        'label_ar', category_label_ar, 'label_en', category_label_en) order by category_key)
      from public.customer_allowed_categories where customer_id = p_customer_id), '[]'::json)
  );
end $func$;

-- 2) حفظ الإعدادات (upsert) — يختم updated_by.
create or replace function public.update_customer_portal_settings(
  p_customer_id uuid,
  p_portal_enabled boolean, p_allow_rental boolean, p_allow_purchase boolean,
  p_allow_maintenance boolean, p_allow_custom boolean, p_allow_custom_item boolean,
  p_allow_attachments boolean, p_require_pm boolean
) returns json language plpgsql security definer set search_path = public as $func$
declare v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  insert into public.customer_portal_settings (
    customer_id, portal_enabled, allow_rental_requests, allow_purchase_requests,
    allow_maintenance_requests, allow_custom_requests, allow_custom_item_requests,
    allow_attachments, require_project_manager_approval, updated_by, updated_at
  ) values (
    p_customer_id, coalesce(p_portal_enabled,true), coalesce(p_allow_rental,true), coalesce(p_allow_purchase,true),
    coalesce(p_allow_maintenance,true), coalesce(p_allow_custom,true), coalesce(p_allow_custom_item,true),
    coalesce(p_allow_attachments,true), coalesce(p_require_pm,false), auth.uid(), now()
  )
  on conflict (customer_id) do update set
    portal_enabled = excluded.portal_enabled,
    allow_rental_requests = excluded.allow_rental_requests,
    allow_purchase_requests = excluded.allow_purchase_requests,
    allow_maintenance_requests = excluded.allow_maintenance_requests,
    allow_custom_requests = excluded.allow_custom_requests,
    allow_custom_item_requests = excluded.allow_custom_item_requests,
    allow_attachments = excluded.allow_attachments,
    require_project_manager_approval = excluded.require_project_manager_approval,
    updated_by = auth.uid(), updated_at = now();
  return json_build_object('ok', true);
end $func$;

-- 3) ضبط الشركات المسموحة (استبدال كامل). يتحقق من وجود كل شركة.
create or replace function public.set_customer_allowed_companies(p_customer_id uuid, p_company_ids uuid[])
returns json language plpgsql security definer set search_path = public as $func$
declare v_role text := public.app_user_role(); v_cid uuid;
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  -- تحقّق من صلاحية المعرّفات (يمنع إدخال شركة غير موجودة).
  if p_company_ids is not null then
    foreach v_cid in array p_company_ids loop
      if not exists (select 1 from public.companies where id = v_cid) then
        return json_build_object('ok', false, 'error', 'company_not_found'); end if;
    end loop;
  end if;
  delete from public.customer_allowed_companies where customer_id = p_customer_id;
  if p_company_ids is not null and array_length(p_company_ids, 1) is not null then
    insert into public.customer_allowed_companies (customer_id, company_id, created_by)
    select p_customer_id, x, auth.uid() from unnest(p_company_ids) as x
    on conflict do nothing;
  end if;
  return json_build_object('ok', true);
end $func$;

-- 4) ضبط التصنيفات المسموحة (استبدال كامل). p_categories = jsonb array [{key,label_ar,label_en}].
create or replace function public.set_customer_allowed_categories(p_customer_id uuid, p_categories jsonb)
returns json language plpgsql security definer set search_path = public as $func$
declare v_role text := public.app_user_role(); v_el jsonb; v_key text;
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  delete from public.customer_allowed_categories where customer_id = p_customer_id;
  if p_categories is not null and jsonb_typeof(p_categories) = 'array' then
    for v_el in select * from jsonb_array_elements(p_categories) loop
      v_key := nullif(btrim(v_el->>'key'), '');
      if v_key is not null then
        insert into public.customer_allowed_categories (customer_id, category_key, category_label_ar, category_label_en, created_by)
        values (p_customer_id, v_key, nullif(v_el->>'label_ar',''), nullif(v_el->>'label_en',''), auth.uid())
        on conflict (customer_id, category_key) do update set
          category_label_ar = excluded.category_label_ar, category_label_en = excluded.category_label_en;
      end if;
    end loop;
  end if;
  return json_build_object('ok', true);
end $func$;

-- ###########################################################################
--  ب) دوال البوابة — قراءة الإعدادات/القوائم (مُبيّضة، بلا مخزون/أعداد/أسعار)
-- ###########################################################################

-- 5) سياق البوابة — يضيف الإعدادات الفعّالة + أعداد القوائم (المصدر الوحيد لحالة البوابة).
create or replace function public.portal_get_context()
returns json language plpgsql stable security definer set search_path = public as $func$
declare
  v_cid uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_name text; v_contact text;
  v_s public.customer_portal_settings;
  v_companies int; v_categories int;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  select c.name, pu.contact_name into v_name, v_contact
    from public.customer_portal_users pu join public.customers c on c.id = pu.customer_id
    where pu.id = auth.uid() and pu.is_active = true;
  v_s := public._portal_settings(v_cid);
  select count(*) into v_companies  from public.customer_allowed_companies  where customer_id = v_cid;
  select count(*) into v_categories from public.customer_allowed_categories where customer_id = v_cid;
  return json_build_object('ok', true,
    'customer_name', v_name, 'contact_name', v_contact, 'portal_role', v_role,
    'portal_enabled', v_s.portal_enabled,
    'allow_rental_requests', v_s.allow_rental_requests,
    'allow_purchase_requests', v_s.allow_purchase_requests,
    'allow_maintenance_requests', v_s.allow_maintenance_requests,
    'allow_custom_requests', v_s.allow_custom_requests,
    'allow_custom_item_requests', v_s.allow_custom_item_requests,
    'allow_attachments', v_s.allow_attachments,
    'require_project_manager_approval', v_s.require_project_manager_approval,
    'allowed_companies_count', v_companies,
    'allowed_categories_count', v_categories
  );
end $func$;

-- 6) الشركات المسموحة للعميل (id + name فقط — بلا أي بيانات داخلية).
create or replace function public.portal_list_allowed_companies()
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  return json_build_object('ok', true, 'companies', coalesce((
    select json_agg(json_build_object('id', c.id, 'name', c.name) order by c.name)
    from public.customer_allowed_companies ac join public.companies c on c.id = ac.company_id
    where ac.customer_id = v_cid and c.is_active = true
  ), '[]'::json));
end $func$;

-- 7) التصنيفات المسموحة للعميل (مفتاح + تسميات). فارغ ⇒ الواجهة تستخدم القائمة العامة.
create or replace function public.portal_list_allowed_categories()
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  return json_build_object('ok', true, 'categories', coalesce((
    select json_agg(json_build_object('key', category_key,
      'label_ar', category_label_ar, 'label_en', category_label_en) order by category_key)
    from public.customer_allowed_categories where customer_id = v_cid
  ), '[]'::json));
end $func$;

-- ###########################################################################
--  ج) دوال البوابة — الكتابة (فرض portal_enabled + الأنواع + الشركات/التصنيفات)
-- ###########################################################################

-- 8) إنشاء طلب — يفرض portal_enabled + نوع الطلب المسموح.
create or replace function public.portal_create_request(
  p_project_name text, p_project_city text, p_contact_phone text, p_contact_email text,
  p_request_type text, p_pickup_date date, p_return_date date, p_notes text
) returns json language plpgsql security definer set search_path = public as $func$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_cust_name text; v_type text; v_id uuid; v_allowed boolean;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  v_type := case when p_request_type in ('rental','sale','service','mixed') then p_request_type else 'rental' end;
  v_allowed := case v_type
    when 'rental'  then v_s.allow_rental_requests
    when 'sale'    then v_s.allow_purchase_requests
    when 'service' then v_s.allow_maintenance_requests
    when 'mixed'   then v_s.allow_custom_requests
    else false end;
  if not v_allowed then return json_build_object('ok', false, 'error', 'request_type_not_allowed'); end if;
  select name into v_cust_name from public.customers where id = v_cid;
  insert into public.requests (
    customer_id, customer_name_snapshot, contact_phone_snapshot, contact_email_snapshot,
    project_name, project_city, request_type, status, request_source, submitted_by,
    pickup_date, return_date, notes, created_by
  ) values (
    v_cid, v_cust_name, nullif(p_contact_phone,''), nullif(p_contact_email,''),
    nullif(p_project_name,''), nullif(p_project_city,''), v_type, 'draft', 'client_portal', auth.uid(),
    p_pickup_date, case when v_type = 'sale' then null else p_return_date end,
    nullif(p_notes,''), auth.uid()
  ) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $func$;

-- 9) إضافة عنصر — يفرض allow_custom_item_requests + قائمة الشركات + قائمة التصنيفات.
--    توقيع جديد (إضافة p_preferred_company_id + p_category_key). نُسقِط التوقيع القديم أولًا.
drop function if exists public.portal_add_item(uuid, text, text, text, numeric, text, boolean, boolean);
create or replace function public.portal_add_item(
  p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text,
  p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean,
  p_preferred_company_id uuid default null, p_category_key text default null
) returns json language plpgsql security definer set search_path = public as $func$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_kind text;
  v_company_count int; v_category_count int; v_needs boolean := coalesce(p_needs_purchase, false);
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;

  -- (أ) عنصر غير متوفر (needs_purchase) يتطلب allow_custom_item_requests.
  if v_needs and not v_s.allow_custom_item_requests then
    return json_build_object('ok', false, 'error', 'custom_item_not_allowed'); end if;

  -- (ب) الشركة المفضّلة — يجب أن تكون ضمن قائمة السماح؛ والقائمة الفارغة تمنع أي شركة.
  if p_preferred_company_id is not null then
    select count(*) into v_company_count from public.customer_allowed_companies where customer_id = v_cid;
    if v_company_count = 0 then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
    if not exists (select 1 from public.customer_allowed_companies
                   where customer_id = v_cid and company_id = p_preferred_company_id) then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
  end if;

  -- (ج) التصنيف — يُفرض فقط إن كانت قائمة السماح غير فارغة.
  if nullif(btrim(p_category_key),'') is not null then
    select count(*) into v_category_count from public.customer_allowed_categories where customer_id = v_cid;
    if v_category_count > 0 and not exists (select 1 from public.customer_allowed_categories
        where customer_id = v_cid and category_key = p_category_key) then
      return json_build_object('ok', false, 'error', 'category_not_allowed'); end if;
  end if;

  v_kind := case when p_requested_kind = 'consumable' then 'consumable' else 'custom' end;
  insert into public.request_items (
    request_id, item_kind, requested_kind, requested_description, requested_category,
    quantity, preferred_model, preferred_company_id, accept_alternative, needs_purchase
  ) values (
    p_request_id, 'custom', v_kind, nullif(p_requested_description,''), nullif(p_requested_category,''),
    greatest(coalesce(p_quantity,1), 1), nullif(p_preferred_model,''), p_preferred_company_id,
    coalesce(p_accept_alternative, true), v_needs
  );
  return json_build_object('ok', true);
end $func$;

-- 10) إرسال الطلب — منطق اعتماد مدير المشروع.
create or replace function public.portal_submit_request(p_request_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_items int; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  select count(*) into v_items from public.request_items where request_id = p_request_id;
  if v_items = 0 then return json_build_object('ok', false, 'error', 'no_items'); end if;

  -- authorized_requester مع اشتراط اعتماد PM ⇒ لا يصل للفريق: يبقى draft + pending_project_manager.
  if v_role = 'authorized_requester' and v_s.require_project_manager_approval then
    update public.requests
      set portal_approval_status = 'pending_project_manager',
          portal_approval_requested_by = v_uid, portal_approval_requested_at = now()
      where id = p_request_id;
    perform public._request_add_event(p_request_id, 'portal_pm_approval_requested', 'portal', null, '{}'::jsonb);
    return json_build_object('ok', true, 'pending_pm', true);
  end if;

  -- project_manager (أو authorized_requester بلا اشتراط) ⇒ إرسال مباشر للفريق (draft→under_review).
  if v_role = 'project_manager' and v_s.require_project_manager_approval then
    update public.requests
      set status = 'under_review',
          portal_approval_status = 'approved_by_project_manager',
          portal_approved_by = v_uid, portal_approved_at = now()
      where id = p_request_id;
  else
    update public.requests set status = 'under_review' where id = p_request_id;
  end if;
  perform public._request_add_event(p_request_id, 'submitted', 'portal', null, '{}'::jsonb);
  return json_build_object('ok', true, 'pending_pm', false);
end $func$;

-- 11) اعتماد مدير المشروع — draft(pending) → under_review (يظهر للفريق).
create or replace function public.portal_pm_approve_request(p_request_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role is distinct from 'project_manager' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' or v_req.portal_approval_status <> 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests
    set status = 'under_review',
        portal_approval_status = 'approved_by_project_manager',
        portal_approved_by = v_uid, portal_approved_at = now()
    where id = p_request_id;
  perform public._request_add_event(p_request_id, 'portal_pm_approved', 'portal', null, '{}'::jsonb);
  perform public._request_add_event(p_request_id, 'submitted', 'portal', null, '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

-- 12) رفض مدير المشروع — draft(pending) → cancelled (لا يظهر للفريق) + سبب.
create or replace function public.portal_pm_reject_request(p_request_id uuid, p_reason text)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_req public.requests%rowtype; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role is distinct from 'project_manager' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' or v_req.portal_approval_status <> 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests
    set status = 'cancelled',
        portal_approval_status = 'rejected_by_project_manager',
        portal_rejected_by = v_uid, portal_rejected_at = now(),
        portal_rejection_reason = nullif(btrim(p_reason),'')
    where id = p_request_id;
  perform public._request_add_event(p_request_id, 'portal_pm_rejected', 'portal', nullif(btrim(p_reason),''), '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

-- ###########################################################################
--  د) دوال البوابة — القراءة (تُضيف حالة اعتماد PM؛ تبقى مُبيّضة تمامًا)
-- ###########################################################################

-- 13) قائمة الطلبات — تضيف portal_approval_status.
create or replace function public.portal_list_requests()
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  return json_build_object('ok', true, 'requests', coalesce((
    select json_agg(json_build_object(
      'id', r.id, 'request_number', r.request_number, 'status', r.status,
      'portal_approval_status', r.portal_approval_status,
      'request_type', r.request_type, 'project_name', r.project_name, 'project_city', r.project_city,
      'pickup_date', r.pickup_date, 'return_date', r.return_date, 'created_at', r.created_at,
      'item_count', (select count(*) from public.request_items ri where ri.request_id = r.id)
    ) order by r.created_at desc)
    from public.requests r
    where r.customer_id = v_cid
      and (v_role in ('project_manager','viewer') or r.submitted_by = auth.uid())
  ), '[]'::json));
end $func$;

-- 14) تفاصيل طلب — تضيف portal_approval_status + سبب رفض PM + can_pm_approve.
create or replace function public.portal_get_request(p_request_id uuid)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;

  return json_build_object('ok', true,
    'request', json_build_object(
      'id', v_req.id, 'request_number', v_req.request_number, 'status', v_req.status,
      'portal_approval_status', v_req.portal_approval_status,
      'portal_rejection_reason', v_req.portal_rejection_reason,
      'can_pm_approve', (v_role = 'project_manager'
                         and v_req.status = 'draft'
                         and v_req.portal_approval_status = 'pending_project_manager'),
      'request_type', v_req.request_type, 'project_name', v_req.project_name, 'project_city', v_req.project_city,
      'contact_phone', v_req.contact_phone_snapshot, 'contact_email', v_req.contact_email_snapshot,
      'pickup_date', v_req.pickup_date, 'return_date', v_req.return_date,
      'notes', v_req.notes, 'created_at', v_req.created_at, 'rejection_reason', v_req.rejection_reason
    ),
    'items', coalesce((
      select json_agg(json_build_object(
        'id', ri.id, 'requested_kind', ri.requested_kind, 'requested_description', ri.requested_description,
        'requested_category', ri.requested_category, 'preferred_model', ri.preferred_model,
        'accept_alternative', ri.accept_alternative, 'needs_purchase', ri.needs_purchase, 'quantity', ri.quantity,
        'fulfillment', case
          when ri.delivered_quantity > 0 then 'delivered'
          when ri.item_kind in ('asset','consumable') then 'preparing'
          when ri.needs_purchase then 'procuring'
          else 'reviewing' end
      ) order by ri.created_at)
      from public.request_items ri where ri.request_id = p_request_id
    ), '[]'::json),
    'events', coalesce((
      select json_agg(json_build_object(
        'event_type', e.event_type,
        'to_status', case when e.event_type = 'status_changed' then e.metadata->>'to' else null end,
        'message', case when e.event_type in ('clarification_requested','clarification_reply','portal_pm_rejected') then e.message else null end,
        'created_at', e.created_at
      ) order by e.created_at)
      from public.request_events e
      where e.request_id = p_request_id
        and e.event_type in ('status_changed','clarification_requested','clarification_reply','submitted',
                             'portal_pm_approval_requested','portal_pm_approved','portal_pm_rejected')
    ), '[]'::json)
  );
end $func$;

-- ###########################################################################
--  هـ) بوابة المرفقات — بوابة إعداد allow_attachments (Phase 5) — حارس واحد فقط.
--      (لا تغيير في سلوك المرفقات؛ فقط منع الرفع إن كانت المرفقات معطّلة للعميل.)
-- ###########################################################################
create or replace function public.portal_register_request_attachment(
  p_request_id uuid, p_file_name text, p_storage_path text
) returns json language plpgsql security definer set search_path = public as $func$
declare
  v_cid  uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_s    public.customer_portal_settings;
  v_req  public.requests%rowtype;
  v_mime text; v_size bigint; v_id uuid;
  v_allowed text[] := array[
    'application/pdf','image/png','image/jpeg','image/webp','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  -- حارس Phase 5: المرفقات معطّلة لهذا العميل ⇒ رفض الرفع (لا يكفي إخفاء الواجهة).
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  if not v_s.allow_attachments then return json_build_object('ok', false, 'error', 'attachments_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','needs_clarification') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  if p_storage_path !~ ('^requests/' || p_request_id::text || '/portal/[A-Za-z0-9._-]{1,150}$') then
    return json_build_object('ok', false, 'error', 'invalid_path'); end if;
  if coalesce(length(trim(p_file_name)),0) = 0 or length(p_file_name) > 200 then
    return json_build_object('ok', false, 'error', 'invalid_name'); end if;

  select nullif(o.metadata->>'mimetype',''), coalesce((o.metadata->>'size')::bigint, 0)
    into v_mime, v_size
    from storage.objects o
    where o.bucket_id = 'request-attachments' and o.name = p_storage_path and o.owner_id = auth.uid()::text;
  if not found then return json_build_object('ok', false, 'error', 'object_not_found'); end if;
  if v_mime is not null and v_mime <> all(v_allowed) then return json_build_object('ok', false, 'error', 'bad_type'); end if;
  if v_size > 10485760 then return json_build_object('ok', false, 'error', 'too_large'); end if;

  insert into public.request_attachments (
    request_id, uploaded_by_kind, uploaded_by, visible_to_customer,
    file_name, storage_path, mime_type, size_bytes
  ) values (
    p_request_id, 'portal', auth.uid(), true,
    p_file_name, p_storage_path, coalesce(v_mime,'application/octet-stream'), v_size
  )
  on conflict (storage_path) do nothing
  returning id into v_id;
  if v_id is null then return json_build_object('ok', false, 'error', 'already_registered'); end if;

  perform public._request_add_event(p_request_id, 'attachment_added', 'portal', p_file_name,
    jsonb_build_object('attachment_id', v_id));
  return json_build_object('ok', true, 'id', v_id);
end $func$;

-- ###########################################################################
--  و) حارس داخلي: منع اعتماد الفريق لطلب ما زال بانتظار مدير المشروع (defense-in-depth).
--      نسخة مطابقة للحالية (capability + ختم المسؤول) + شرط استبعاد pending_project_manager.
-- ###########################################################################
create or replace function public.request_approve(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_uid uuid := auth.uid();
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'approved',
      responsible_employee_id = coalesce(responsible_employee_id, v_uid)
  where id = p_id and status in ('draft','under_review','needs_clarification')
    and portal_approval_status <> 'pending_project_manager';
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  return json_build_object('ok', true);
end $func$;

-- ###########################################################################
--  ز) الصلاحيات — authenticated فقط (الحُرّاس داخل الدوال). لا anon.
-- ###########################################################################
do $do$
declare fn text;
begin
  foreach fn in array array[
    'get_customer_portal_settings(uuid)',
    'update_customer_portal_settings(uuid, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean)',
    'set_customer_allowed_companies(uuid, uuid[])',
    'set_customer_allowed_categories(uuid, jsonb)',
    'portal_get_context()',
    'portal_list_allowed_companies()',
    'portal_list_allowed_categories()',
    'portal_create_request(text, text, text, text, text, date, date, text)',
    'portal_add_item(uuid, text, text, text, numeric, text, boolean, boolean, uuid, text)',
    'portal_submit_request(uuid)',
    'portal_pm_approve_request(uuid)',
    'portal_pm_reject_request(uuid, text)',
    'portal_list_requests()',
    'portal_get_request(uuid)',
    'portal_register_request_attachment(uuid, text, text)',
    'request_approve(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $do$;
