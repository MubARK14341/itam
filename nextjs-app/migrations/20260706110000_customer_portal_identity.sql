-- ============================================================================
--  Client Portal — Phase 2 (1/2): هوية بوابة العميل (منفصلة تمامًا عن app_users)
--  • customer_portal_users: مستخدم بوابة = auth user مرتبط بعميل (customers) بدور بوابة.
--  • customer_portal_invites: دعوة برمز (نمط registration_invites) — الإنشاء من الإدارة فقط.
--  • دوال fail-closed: is_portal_user / portal_customer_id / portal_user_role.
--  • تفريع handle_new_user على user_type='portal' — لا يُدخل app_users إطلاقاً
--    (فمستخدم البوابة لا يظهر في طابور موافقات الموظفين ولا يرى أي شيء داخلي عبر RLS).
--  ✅ إضافي وآمن: لا DROP/DELETE بيانات · مسار تسجيل الموظفين يبقى حرفياً كما هو.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) الجداول
-- ---------------------------------------------------------------------------
create table if not exists public.customer_portal_users (
  id uuid primary key references auth.users(id) on delete cascade,
  customer_id uuid not null references public.customers(id),
  contact_name text not null,
  phone text null,
  portal_role text not null default 'authorized_requester'
    check (portal_role in ('project_manager','authorized_requester','viewer')),
  is_active boolean not null default true,
  invited_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_portal_users_customer on public.customer_portal_users(customer_id);

create table if not exists public.customer_portal_invites (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  customer_id uuid not null references public.customers(id),
  portal_role text not null default 'authorized_requester'
    check (portal_role in ('project_manager','authorized_requester','viewer')),
  expires_at timestamptz not null,
  max_uses int not null default 1,
  used_count int not null default 0,
  is_active boolean not null default true,
  created_by uuid null,
  created_at timestamptz not null default now()
);
create index if not exists idx_portal_invites_customer on public.customer_portal_invites(customer_id);

drop trigger if exists trg_portal_users_updated on public.customer_portal_users;
create trigger trg_portal_users_updated before update on public.customer_portal_users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) RLS — قراءة للمدراء فقط (للإدارة)، وكل عمليات البوابة عبر دوال SECURITY DEFINER.
--    لا إدراج/تعديل/حذف مباشر (يتم داخل handle_new_user والـ RPCs الإدارية).
-- ---------------------------------------------------------------------------
alter table public.customer_portal_users enable row level security;
alter table public.customer_portal_invites enable row level security;
revoke all on public.customer_portal_users from anon;
revoke all on public.customer_portal_invites from anon;
grant select on public.customer_portal_users to authenticated;
grant select on public.customer_portal_invites to authenticated;

drop policy if exists sel_mgr on public.customer_portal_users;
create policy sel_mgr on public.customer_portal_users for select to authenticated
  using (public.app_user_role() in ('admin','it_manager'));
drop policy if exists sel_mgr on public.customer_portal_invites;
create policy sel_mgr on public.customer_portal_invites for select to authenticated
  using (public.app_user_role() in ('admin','it_manager'));

-- ---------------------------------------------------------------------------
-- 3) دوال الهوية — fail-closed (null/false لغير مستخدم بوابة نشط)
-- ---------------------------------------------------------------------------
create or replace function public.is_portal_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.customer_portal_users where id = auth.uid() and is_active = true);
$$;

create or replace function public.portal_customer_id()
returns uuid language sql stable security definer set search_path = public as $$
  select customer_id from public.customer_portal_users where id = auth.uid() and is_active = true;
$$;

create or replace function public.portal_user_role()
returns text language sql stable security definer set search_path = public as $$
  select portal_role from public.customer_portal_users where id = auth.uid() and is_active = true;
$$;

revoke all on function public.is_portal_user() from public, anon;
revoke all on function public.portal_customer_id() from public, anon;
revoke all on function public.portal_user_role() from public, anon;
grant execute on function public.is_portal_user() to authenticated;
grant execute on function public.portal_customer_id() to authenticated;
grant execute on function public.portal_user_role() to authenticated;

-- تحديث محدِّد نوع الفاعل ليشمل portal (المحفّز نفسه لا يتغيّر — المرحلة 1 صمّمته هكذا).
create or replace function public._request_actor_kind()
returns text language sql stable security definer set search_path = public as $$
  select case
    when public.is_portal_user() then 'portal'
    when public.app_user_role() is not null then 'staff'
    else 'system' end;
$$;
revoke all on function public._request_actor_kind() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) تفريع handle_new_user — فرع البوابة أولاً (لا يمسّ مسار الموظفين)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
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
begin
  -- ===== بوابة العميل: مستخدم بوابة (لا يدخل app_users إطلاقاً) =====
  if coalesce(meta->>'user_type','') = 'portal' then
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
    return new;  -- مهم: لا ننشئ صف موظف
  end if;

  -- ===== السلوك الحالي للموظفين (حرفياً كما كان) =====
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
-- 5) تحقّق الدعوة (anon) — يُرجع اسم العميل فقط (بلا customer_id ولا بيانات داخلية)
-- ---------------------------------------------------------------------------
create or replace function public.validate_portal_invite(p_code text)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v record;
begin
  select i.portal_role, i.expires_at, c.name as customer_name into v
  from public.customer_portal_invites i join public.customers c on c.id = i.customer_id
  where lower(i.code) = lower(coalesce(p_code,'')) and i.is_active = true
    and i.expires_at > now() and i.used_count < i.max_uses
  limit 1;
  if not found then return json_build_object('valid', false); end if;
  return json_build_object('valid', true, 'customer_name', v.customer_name, 'portal_role', v.portal_role, 'expires_at', v.expires_at);
end $func$;
revoke all on function public.validate_portal_invite(text) from public;
grant execute on function public.validate_portal_invite(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPCs إدارية — admin/it_manager فقط (إنشاء/إبطال دعوة، تفعيل/تعطيل مستخدم، سرد)
-- ---------------------------------------------------------------------------
create or replace function public.create_customer_portal_invite(
  p_customer_id uuid, p_portal_role text default 'authorized_requester',
  p_valid_days int default 14, p_max_uses int default 1
) returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_code text; v_id uuid;
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists(select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  if p_portal_role not in ('project_manager','authorized_requester','viewer') then
    return json_build_object('ok', false, 'error', 'invalid_role'); end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.customer_portal_invites (code, customer_id, portal_role, expires_at, max_uses, created_by)
  values (v_code, p_customer_id, p_portal_role, now() + make_interval(days => greatest(p_valid_days, 1)), greatest(p_max_uses, 1), auth.uid())
  returning id into v_id;
  return json_build_object('ok', true, 'code', v_code, 'invite_id', v_id);
end $func$;

create or replace function public.revoke_customer_portal_invite(p_invite_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  update public.customer_portal_invites set is_active = false where id = p_invite_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true);
end $func$;

create or replace function public.set_customer_portal_user_active(p_user_id uuid, p_active boolean)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  update public.customer_portal_users set is_active = coalesce(p_active, true), updated_at = now() where id = p_user_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true);
end $func$;

-- سرد مستخدمي/دعوات بوابة عميل محدد (للإدارة) — بيانات إدارية غير حساسة.
create or replace function public.list_customer_portal_users(p_customer_id uuid)
returns setof public.customer_portal_users language sql stable security definer set search_path = public as $func$
  select * from public.customer_portal_users
  where public.app_user_role() in ('admin','it_manager') and customer_id = p_customer_id
  order by created_at desc;
$func$;

create or replace function public.list_customer_portal_invites(p_customer_id uuid)
returns setof public.customer_portal_invites language sql stable security definer set search_path = public as $func$
  select * from public.customer_portal_invites
  where public.app_user_role() in ('admin','it_manager') and customer_id = p_customer_id and is_active = true
  order by created_at desc;
$func$;

do $do$
declare fn text;
begin
  foreach fn in array array[
    'create_customer_portal_invite(uuid, text, int, int)',
    'revoke_customer_portal_invite(uuid)',
    'set_customer_portal_user_active(uuid, boolean)',
    'list_customer_portal_users(uuid)',
    'list_customer_portal_invites(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $do$;
