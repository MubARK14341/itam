-- =====================================================================
-- Purpose: تسجيل ذاتي مفتوح للعميل الخارجي + موافقة إدارية.
--   • customers.approval_status (pending/approved/rejected؛ العملاء الحاليون approved).
--   • handle_new_user: تسجيل بوابة بلا دعوة ⇒ ينشئ عميلًا pending + مستخدم بوابة project_manager.
--     (مسار الدعوة يبقى كما هو بالتوازي.)
--   • _portal_settings: بوابة العميل غير المعتمد مغلقة (fail-closed) — لا يصل طلبه للفريق.
--   • approve_customer(uuid, boolean): اعتماد/رفض العميل (admin/it_manager) + تفعيل/تعطيل البوابة.
-- Risk:    متوسط — عمود إضافي + تعديل trigger/دالتين + دالة جديدة. anon يبقى محظورًا؛ الإنشاء
--          عبر trigger فقط؛ العميل المعلّق لا يرى/يرسل شيئًا (بوابة مغلقة). لا مالي.
-- Rollback: حذف approval_status + approve_customer؛ إعادة handle_new_user/_portal_settings.
-- =====================================================================

-- 1) حالة اعتماد العميل ----------------------------------------------------
alter table public.customers add column if not exists approval_status text not null default 'approved';
alter table public.customers drop constraint if exists customers_approval_status_check;
alter table public.customers add constraint customers_approval_status_check
  check (approval_status in ('pending','approved','rejected'));

-- 2) بوابة العميل غير المعتمد مغلقة مهما كانت الإعدادات ---------------------
create or replace function public._portal_settings(p_customer_id uuid)
returns customer_portal_settings language plpgsql stable security definer set search_path to 'public' as $func$
declare v public.customer_portal_settings;
begin
  select * into v from public.customer_portal_settings where customer_id = p_customer_id;
  if not found then
    v.customer_id                      := p_customer_id;
    v.portal_enabled                   := false;
    v.allow_rental_requests            := true;
    v.allow_purchase_requests          := true;
    v.allow_maintenance_requests       := true;
    v.allow_custom_requests            := true;
    v.allow_custom_item_requests       := true;
    v.allow_attachments                := true;
    v.require_project_manager_approval := false;
  end if;
  -- العميل غير المعتمد: البوابة مغلقة (لا يصل طلبه للفريق حتى الاعتماد)
  if not exists (select 1 from public.customers c
                 where c.id = p_customer_id and coalesce(c.approval_status,'approved') = 'approved') then
    v.portal_enabled := false;
  end if;
  return v;
end $func$;

-- 3) handle_new_user: تسجيل بوابة مفتوح (بلا دعوة) -------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $func$
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
    if v_code is not null then
      -- مسار الدعوة (كما هو)
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
      -- تسجيل ذاتي مفتوح: عميل جديد pending + مستخدم بوابة (مدير مشروع) — بوابته مغلقة حتى الاعتماد
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
end $func$;

-- 4) اعتماد/رفض العميل (admin/it_manager) ----------------------------------
create or replace function public.approve_customer(p_customer_id uuid, p_approve boolean)
returns json language plpgsql security definer set search_path to 'public' as $func$
declare v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_approve then
    update public.customers set approval_status = 'approved', is_active = true where id = p_customer_id;
    insert into public.customer_portal_settings (customer_id, portal_enabled)
      values (p_customer_id, true)
      on conflict (customer_id) do update set portal_enabled = true, updated_at = now();
  else
    update public.customers set approval_status = 'rejected' where id = p_customer_id;
    update public.customer_portal_settings set portal_enabled = false, updated_at = now()
      where customer_id = p_customer_id;
  end if;
  return json_build_object('ok', true);
end $func$;

revoke all on function public.approve_customer(uuid, boolean) from public;
grant execute on function public.approve_customer(uuid, boolean) to authenticated;
