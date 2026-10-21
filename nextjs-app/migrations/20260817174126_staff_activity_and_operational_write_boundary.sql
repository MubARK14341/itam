-- Make staff deactivation part of the canonical authorization boundary and
-- finish moving asset/maintenance browser mutations behind narrow RPCs.

begin;

-- `is_active` is the explicit account kill switch.  Approval, MFA and activity
-- must all pass before any RLS policy or self-authorizing RPC can admit a user.
create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.app_users u
    left join public.roles r on r.id = u.role_id
    cross join public.auth_security_policy p
    where u.id = auth.uid()
      and u.is_active
      and u.approval_status = 'approved'
      and (
        not p.admin_mfa_required
        or coalesce(r.key, '') not in ('admin', 'it_manager')
        or public._auth_current_aal() = 'aal2'
      )
  )
$function$;

-- Keep the lower-level resolver fail-closed as well.  This protects privileged
-- server-side callers that intentionally check another user's capability.
create or replace function public.has_capability(p_user uuid, p_key text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role text;
  v_role_id uuid;
  v_override boolean;
begin
  select r.key, u.role_id
  into v_role, v_role_id
  from public.app_users u
  join public.roles r on r.id = u.role_id
  where u.id = p_user
    and u.is_active
    and u.approval_status = 'approved';

  if v_role is null then return false; end if;
  if v_role = 'admin' then return true; end if;

  select up.allow
  into v_override
  from public.user_permissions up
  join public.permissions p on p.id = up.permission_id
  where up.user_id = p_user and p.key = p_key;
  if found then return v_override; end if;

  return exists (
    select 1
    from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = v_role_id and p.key = p_key
  );
end
$function$;

-- Pending/rejected accounts are inactive by definition.  Approval transitions
-- reactivate the account; an explicitly inactive approved account stays off.
create or replace function public.app_users_enforce_access_state()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.approval_status is distinct from 'approved' then
    new.is_active := false;
  elsif tg_op = 'UPDATE'
        and old.approval_status is distinct from 'approved'
        and new.approval_status = 'approved' then
    new.is_active := true;
  end if;
  return new;
end
$function$;

drop trigger if exists trg_app_users_enforce_access_state on public.app_users;
create trigger trg_app_users_enforce_access_state
before insert or update of approval_status, is_active on public.app_users
for each row execute function public.app_users_enforce_access_state();

update public.app_users
set is_active = false,
    updated_at = now()
where approval_status is distinct from 'approved'
  and is_active;

create or replace function public.asset_set_serial(
  p_asset_id uuid,
  p_serial text
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_serial text := nullif(btrim(p_serial), '');
begin
  if not public.current_user_has_capability('asset.update') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_serial is null then
    return json_build_object('ok', false, 'error', 'empty');
  end if;

  perform 1 from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  update public.assets set serial_number = v_serial where id = p_asset_id;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_set_serial_exempt(
  p_asset_id uuid,
  p_exempt boolean,
  p_reason text default null
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reason text := nullif(btrim(p_reason), '');
begin
  if not public.current_user_has_capability('asset.update')
     or public.app_user_role() not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_exempt is null then
    return json_build_object('ok', false, 'error', 'invalid_exemption');
  end if;
  if p_exempt and v_reason is null then
    return json_build_object('ok', false, 'error', 'serial_exempt_reason_required');
  end if;

  perform 1 from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  update public.assets
  set serial_exempt = p_exempt,
      serial_exempt_reason = case when p_exempt then v_reason else null end
  where id = p_asset_id;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.maintenance_assign_technician(
  p_id uuid,
  p_technician_id uuid default null
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_technician uuid := coalesce(p_technician_id, auth.uid());
  v_status public.maintenance_status;
begin
  if not public.current_user_has_capability('maintenance.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_technician is null
     or not public.has_capability(v_technician, 'maintenance.manage') then
    return json_build_object('ok', false, 'error', 'invalid_technician');
  end if;

  select status into v_status
  from public.maintenance_records
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'maintenance_not_found');
  end if;
  if v_status in ('completed', 'cancelled') then
    return json_build_object('ok', false, 'error', 'maintenance_closed');
  end if;

  update public.maintenance_records
  set technician_id = v_technician
  where id = p_id;
  return json_build_object('ok', true);
end
$function$;

revoke all on function public.asset_set_serial(uuid, text)
from public, anon;
revoke all on function public.asset_set_serial_exempt(uuid, boolean, text)
from public, anon;
revoke all on function public.maintenance_assign_technician(uuid, uuid)
from public, anon;

grant execute on function public.asset_set_serial(uuid, text)
to authenticated, service_role;
grant execute on function public.asset_set_serial_exempt(uuid, boolean, text)
to authenticated, service_role;
grant execute on function public.maintenance_assign_technician(uuid, uuid)
to authenticated, service_role;

-- These aggregates are RPC-only for every browser mutation.  Removing both
-- grants and write policies prevents a future client from silently bypassing
-- row locks, transition checks, audit triggers, or capability checks.
revoke insert, update, delete on public.assets, public.maintenance_records
from anon, authenticated;

drop policy if exists ins_ops on public.assets;
drop policy if exists ins_managers on public.assets;
drop policy if exists assets_insert_managers_restrictive on public.assets;
drop policy if exists ins_capability on public.assets;
drop policy if exists upd_ops on public.assets;
drop policy if exists upd_managers on public.assets;
drop policy if exists upd_capability on public.assets;
drop policy if exists del_admin on public.assets;

drop policy if exists ins_ops on public.maintenance_records;
drop policy if exists ins_capability on public.maintenance_records;
drop policy if exists upd_ops on public.maintenance_records;
drop policy if exists upd_capability on public.maintenance_records;
drop policy if exists del_admin on public.maintenance_records;

commit;
