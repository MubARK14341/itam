-- إصلاح ثغرة تصعيد صلاحيات (BLOCKER):
-- الحارس «if v_caller not in (...)» يفشل عندما v_caller = NULL (مستخدم pending بلا دور)
-- لأن «NULL not in (...)» يساوي NULL وتعتبره IF كـ false فيتجاوز الحارس.
-- الإصلاح: فحص NULL صراحةً في الدوال الثلاث.

create or replace function public.approve_user(p_user_id uuid, p_role_key text)
returns json
language plpgsql security definer set search_path = public
as $func$
declare
  v_caller text := public.app_user_role();
  v_role_id uuid;
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
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

create or replace function public.reject_user(p_user_id uuid, p_reason text default null)
returns json
language plpgsql security definer set search_path = public
as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
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

create or replace function public.reset_user_pending(p_user_id uuid)
returns json
language plpgsql security definer set search_path = public
as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
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

-- إعادة سحب صلاحية anon (إعادة التعريف تُعيد المنح الافتراضي من Supabase)
revoke execute on function public.approve_user(uuid, text) from anon;
revoke execute on function public.reject_user(uuid, text) from anon;
revoke execute on function public.reset_user_pending(uuid) from anon;
