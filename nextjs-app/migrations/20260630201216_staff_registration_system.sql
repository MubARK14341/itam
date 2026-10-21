-- ============================================================================
--  المرحلة: نظام تسجيل الموظفين + موافقة المدير + إغلاق/فتح التسجيل
--  إضافي وآمن بالكامل: لا DROP TABLE · لا حذف بيانات · لا فتح RLS للـ anon
--  المستخدمون الحاليون يبقون approved ولا تتغيّر أدوارهم.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) أعمدة التسجيل على app_users (إضافية فقط)
--    نُضيف العمود بلا default ثم نملأ الموجود = approved ثم نضبط default='pending'
--    حتى لا يُقفل النظام على المستخدمين الحاليين.
-- ---------------------------------------------------------------------------
alter table public.app_users add column if not exists approval_status text;
alter table public.app_users add column if not exists approved_at timestamptz;
alter table public.app_users add column if not exists approved_by uuid;
alter table public.app_users add column if not exists rejected_at timestamptz;
alter table public.app_users add column if not exists rejected_by uuid;
alter table public.app_users add column if not exists rejection_reason text;
alter table public.app_users add column if not exists phone text;
alter table public.app_users add column if not exists department_id uuid;
alter table public.app_users add column if not exists registration_note text;
alter table public.app_users add column if not exists requested_role text;
alter table public.app_users add column if not exists last_approval_action_at timestamptz;

-- ربط القسم (اختياري) بجدول الأقسام دون كسر البيانات
do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_users_department_id_fkey'
  ) then
    alter table public.app_users
      add constraint app_users_department_id_fkey
      foreign key (department_id) references public.departments(id) on delete set null;
  end if;
end $do$;

-- backfill: كل المستخدمين الحاليين = approved (وإلا يُقفلون خارج النظام)
update public.app_users
set approval_status = 'approved',
    approved_at = coalesce(approved_at, now())
where approval_status is null;

-- التسجيلات الجديدة افتراضيًا pending
alter table public.app_users alter column approval_status set default 'pending';

-- قيد القيم المسموحة
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_users_approval_status_chk') then
    alter table public.app_users
      add constraint app_users_approval_status_chk
      check (approval_status in ('pending','approved','rejected'));
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- 2) جدول إعدادات التسجيل (صف وحيد id='main')
-- ---------------------------------------------------------------------------
create table if not exists public.registration_settings (
  id text primary key default 'main',
  mode text not null default 'closed'
    check (mode in ('closed','open_with_approval','gradual','invite_only')),
  require_email_verification boolean not null default true,
  remaining_slots integer not null default 0,
  allowed_domains text[] null,
  default_requested_role text not null default 'viewer',
  message_ar text null,
  message_en text null,
  updated_at timestamptz not null default now(),
  updated_by uuid null
);
insert into public.registration_settings (id, mode) values ('main','closed')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3) رموز الدعوة + سجل استخدامها (لا حذف — is_active=false)
-- ---------------------------------------------------------------------------
create table if not exists public.registration_invites (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  label text null,
  default_role text not null default 'viewer',
  max_uses integer null,
  used_count integer not null default 0,
  expires_at timestamptz null,
  is_active boolean not null default true,
  created_by uuid null,
  created_at timestamptz not null default now()
);

create table if not exists public.registration_invite_uses (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid references public.registration_invites(id),
  user_id uuid null,
  email text not null,
  used_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4) صلاحيات الجداول: authenticated فقط (RLS يبقى الحارس) — لا anon إطلاقًا
-- ---------------------------------------------------------------------------
revoke all on public.registration_settings from anon;
revoke all on public.registration_invites from anon;
revoke all on public.registration_invite_uses from anon;
grant select, insert, update, delete on public.registration_settings to authenticated;
grant select, insert, update, delete on public.registration_invites to authenticated;
grant select, insert, update, delete on public.registration_invite_uses to authenticated;

alter table public.registration_settings enable row level security;
alter table public.registration_invites enable row level security;
alter table public.registration_invite_uses enable row level security;

-- ---------------------------------------------------------------------------
-- 5) الدوال الأمنية
-- ---------------------------------------------------------------------------

-- 5-أ) هل المستخدم الحالي معتمد؟ (يحرس قراءة بيانات النظام)
create or replace function public.is_approved()
returns boolean
language sql security definer set search_path = public stable
as $func$
  select exists (
    select 1 from public.app_users u
    where u.id = auth.uid()
      and coalesce(u.approval_status, 'approved') = 'approved'
  )
$func$;
revoke all on function public.is_approved() from public;
grant execute on function public.is_approved() to authenticated;

-- 5-ب) دور المستخدم — لا يُرجع دورًا إلا للمعتمدين (pending/rejected = لا دور = لا صلاحيات)
create or replace function public.app_user_role()
returns text
language sql security definer set search_path = public stable
as $func$
  select r.key
  from public.app_users u
  join public.roles r on r.id = u.role_id
  where u.id = auth.uid()
    and coalesce(u.approval_status, 'approved') = 'approved'
$func$;
revoke all on function public.app_user_role() from public;
grant execute on function public.app_user_role() to authenticated;

-- 5-ج) حالة التسجيل العامة — anon يستدعيها لمعرفة هل التسجيل مفتوح (بلا أسرار/رموز)
create or replace function public.registration_status()
returns json
language sql security definer set search_path = public stable
as $func$
  select json_build_object(
    'mode', s.mode,
    'require_email_verification', s.require_email_verification,
    'has_slots', (s.mode <> 'gradual' or s.remaining_slots > 0),
    'remaining_slots', case when s.mode = 'gradual' then s.remaining_slots else null end,
    'default_requested_role', s.default_requested_role,
    'message_ar', s.message_ar,
    'message_en', s.message_en,
    'departments', coalesce((
      select json_agg(json_build_object('id', d.id, 'name', d.name, 'name_ar', d.name_ar) order by d.name)
      from public.departments d
    ), '[]'::json)
  )
  from public.registration_settings s
  where s.id = 'main'
$func$;
revoke all on function public.registration_status() from public;
grant execute on function public.registration_status() to anon, authenticated;

-- 5-د) التحقق من رمز الدعوة (لا يكشف الرمز ولا قائمة الرموز — يُرجع صلاحية + دور افتراضي)
create or replace function public.validate_registration_invite(p_code text)
returns json
language sql security definer set search_path = public stable
as $func$
  select json_build_object(
    'valid', (i.id is not null),
    'default_role', i.default_role
  )
  from (select 1) dummy
  left join public.registration_invites i
    on lower(i.code) = lower(p_code)
   and i.is_active = true
   and (i.expires_at is null or i.expires_at > now())
   and (i.max_uses is null or i.used_count < i.max_uses)
$func$;
revoke all on function public.validate_registration_invite(text) from public;
grant execute on function public.validate_registration_invite(text) to anon, authenticated;

-- 5-هـ) إنشاء سجل app_user للموظف الجديد بحالة pending + التقاط بيانات التسجيل من user_metadata
--       لا يرفع استثناءً حتى لا يكسر التسجيل؛ الحاجز الفعلي هو approval_status.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $func$
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
begin
  begin v_dept := (meta->>'department_id')::uuid; exception when others then v_dept := null; end;

  select mode, default_requested_role into v_mode, v_default_role
  from public.registration_settings where id = 'main';
  v_default_role := coalesce(v_default_role, 'viewer');

  -- رمز الدعوة: تحقّق + استهلاك + تسجيل الاستخدام
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

  -- الفتح التدريجي: استهلاك مقعد واحد (أفضل جهد، لا ينزل تحت الصفر)
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5-و) قائمة طلبات التسجيل — admin/it_manager فقط (تشمل حالة تأكيد البريد من auth.users)
create or replace function public.list_registration_requests(p_status text default null)
returns table (
  id uuid, email text, full_name text, phone text,
  department_id uuid, department_name text,
  registration_note text, requested_role text, assigned_role text,
  approval_status text, created_at timestamptz,
  approved_at timestamptz, rejected_at timestamptz, rejection_reason text,
  email_confirmed boolean
)
language sql security definer set search_path = public stable
as $func$
  select u.id, u.email, u.full_name, u.phone,
         u.department_id, coalesce(d.name_ar, d.name),
         u.registration_note, u.requested_role, r.key,
         coalesce(u.approval_status, 'approved'), u.created_at,
         u.approved_at, u.rejected_at, u.rejection_reason,
         (au.email_confirmed_at is not null)
  from public.app_users u
  left join public.departments d on d.id = u.department_id
  left join public.roles r on r.id = u.role_id
  left join auth.users au on au.id = u.id
  where public.app_user_role() in ('admin','it_manager')
    and (p_status is null or coalesce(u.approval_status,'approved') = p_status)
  order by u.created_at desc
$func$;
revoke all on function public.list_registration_requests(text) from public;
grant execute on function public.list_registration_requests(text) to authenticated;

-- 5-ز) قبول موظف — admin/it_manager؛ it_manager لا يستطيع منح admin
--      (ملاحظة: حُصِّن لاحقًا ضد NULL في migration fix_null_role_guard_privilege_escalation)
create or replace function public.approve_user(p_user_id uuid, p_role_key text)
returns json
language plpgsql security definer set search_path = public
as $func$
declare
  v_caller text := public.app_user_role();
  v_role_id uuid;
begin
  if v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_role_key = 'admin' and v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_grant_admin');
  end if;
  if p_role_key not in ('admin','it_manager','technician','auditor','viewer') then
    return json_build_object('ok', false, 'error', 'invalid_role');
  end if;
  select id into v_role_id from public.roles where key = p_role_key;
  if v_role_id is null then
    return json_build_object('ok', false, 'error', 'role_not_found');
  end if;
  update public.app_users
  set role_id = v_role_id,
      approval_status = 'approved',
      approved_at = now(),
      approved_by = auth.uid(),
      rejected_at = null, rejected_by = null, rejection_reason = null,
      last_approval_action_at = now(),
      updated_at = now()
  where id = p_user_id;
  return json_build_object('ok', true);
end $func$;
revoke all on function public.approve_user(uuid, text) from public;
grant execute on function public.approve_user(uuid, text) to authenticated;

-- 5-ح) رفض موظف — admin/it_manager (لا حذف؛ status=rejected فقط)
create or replace function public.reject_user(p_user_id uuid, p_reason text default null)
returns json
language plpgsql security definer set search_path = public
as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.app_users
  set approval_status = 'rejected',
      rejected_at = now(),
      rejected_by = auth.uid(),
      rejection_reason = nullif(p_reason,''),
      last_approval_action_at = now(),
      updated_at = now()
  where id = p_user_id;
  return json_build_object('ok', true);
end $func$;
revoke all on function public.reject_user(uuid, text) from public;
grant execute on function public.reject_user(uuid, text) to authenticated;

-- 5-ط) إعادة طلب إلى pending (اختياري للمدير)
create or replace function public.reset_user_pending(p_user_id uuid)
returns json
language plpgsql security definer set search_path = public
as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.app_users
  set approval_status = 'pending',
      rejected_at = null, rejected_by = null, rejection_reason = null,
      approved_at = null, approved_by = null,
      last_approval_action_at = now(), updated_at = now()
  where id = p_user_id;
  return json_build_object('ok', true);
end $func$;
revoke all on function public.reset_user_pending(uuid) from public;
grant execute on function public.reset_user_pending(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) سياسات RLS للجداول الجديدة (admin/it_manager فقط؛ لا anon)
-- ---------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array['registration_settings','registration_invites','registration_invite_uses'] loop
    execute format('drop policy if exists sel_mgr on public.%I;', t);
    execute format('drop policy if exists ins_mgr on public.%I;', t);
    execute format('drop policy if exists upd_mgr on public.%I;', t);
    execute format('drop policy if exists del_mgr on public.%I;', t);
    execute format($f$create policy sel_mgr on public.%I for select to authenticated
      using (public.app_user_role() in ('admin','it_manager'));$f$, t);
    execute format($f$create policy ins_mgr on public.%I for insert to authenticated
      with check (public.app_user_role() in ('admin','it_manager'));$f$, t);
    execute format($f$create policy upd_mgr on public.%I for update to authenticated
      using (public.app_user_role() in ('admin','it_manager'))
      with check (public.app_user_role() in ('admin','it_manager'));$f$, t);
    execute format($f$create policy del_mgr on public.%I for delete to authenticated
      using (public.app_user_role() = 'admin');$f$, t);
  end loop;
end $do$;

-- ---------------------------------------------------------------------------
-- 7) تشديد قراءة بيانات النظام: لا يقرأها إلا المعتمدون (pending/rejected = لا قراءة)
--    نعيد تعريف كل سياسات sel_auth القائمة (true) لتشترط is_approved().
--    app_users تبقى على سياستها الخاصة (يقرأ المستخدم سجله فقط) حتى تعمل صفحة الانتظار.
-- ---------------------------------------------------------------------------
do $do$
declare r record;
begin
  for r in select tablename from pg_policies
           where schemaname = 'public' and policyname = 'sel_auth' loop
    execute format('drop policy if exists sel_auth on public.%I;', r.tablename);
    execute format('create policy sel_auth on public.%I for select to authenticated using (public.is_approved());', r.tablename);
  end loop;
end $do$;
