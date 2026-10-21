-- Purpose: approve an office identity with an explicitly selected active employee.
-- No record is created or matched by email/name. approve_user(uuid,text) is unchanged.
-- Local-only until separately authorized. Row locks serialize this linking path;
-- no data backfill or global uniqueness constraint is introduced.
-- Rollback: remove the UI/helper and revoke/drop this RPC; retain approved links.
begin;
create or replace function public.approve_employee_user(p_user_id uuid, p_employee_id uuid)
returns json language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_caller text;
  v_target text;
  v_link uuid;
  v_active boolean;
  v_role_id uuid;
begin
  -- Hold the actor row against concurrent administrative deactivation; the
  -- identity resolver may retain a blocked staff role for the login UI;
  -- is_approved is the independent active/approval/MFA authorization gate.
  perform 1 from public.app_users where id = auth.uid() for share;
  v_caller := public.app_user_role();
  if public.is_approved() is distinct from true
     or v_caller is null or v_caller not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user_id = auth.uid() then
    return json_build_object('ok', false, 'error', 'cannot_manage_self');
  end if;
  select r.key, u.employee_id into v_target, v_link
  from public.app_users u left join public.roles r on r.id = u.role_id
  where u.id = p_user_id for update of u;
  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;
  if v_target = 'admin' and v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_manage_admin');
  end if;
  if p_employee_id is null then
    return json_build_object('ok', false, 'error', 'employee_required');
  end if;
  select is_active into v_active from public.employees where id = p_employee_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'employee_not_found');
  end if;
  if not coalesce(v_active, false) then
    return json_build_object('ok', false, 'error', 'employee_inactive');
  end if;
  if v_link is not null and v_link <> p_employee_id then
    return json_build_object('ok', false, 'error', 'user_already_linked');
  end if;
  if exists (select 1 from public.app_users where employee_id = p_employee_id and id <> p_user_id) then
    return json_build_object('ok', false, 'error', 'employee_already_linked');
  end if;
  select id into v_role_id from public.roles where key = 'employee';
  if v_role_id is null then
    return json_build_object('ok', false, 'error', 'role_not_found');
  end if;
  update public.app_users set employee_id = p_employee_id, role_id = v_role_id,
      approval_status = 'approved', is_active = true, approved_at = now(), approved_by = auth.uid(),
      rejected_at = null, rejected_by = null, rejection_reason = null,
      last_approval_action_at = now(), updated_at = now()
  where id = p_user_id;
  return json_build_object('ok', true);
end
$function$;
revoke all on function public.approve_employee_user(uuid, uuid) from public, anon;
grant execute on function public.approve_employee_user(uuid, uuid) to authenticated;
comment on function public.approve_employee_user(uuid, uuid) is
  'Atomic administrative approval with an explicit active employee link; no automatic matching or creation.';
commit;
