-- F-006 / F-014: capability/RLS/RPC consistency.
-- Financial access and admin-account protection intentionally remain explicit
-- invariants rather than configurable capabilities.

begin;

insert into public.permissions (key, grp, description)
values ('asset.move', 'assets', 'نقل أصل بين المواقع')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'asset.move'
where r.key in ('admin', 'it_manager', 'technician')
on conflict do nothing;

-- Match the established UI/business rule: catalog/detail changes and CSV
-- imports are manager operations; technicians retain explicit move/custody
-- operations rather than the broad asset.update/import capabilities.
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and (
    (p.key = 'asset.update' and r.key in ('technician', 'warehouse_manager'))
    or (p.key = 'asset.import' and r.key in ('technician', 'warehouse_manager'))
  );

-- Stocktake policy previously allowed operational roles while the matrix
-- omitted them, and listed auditors even though auditors are read-only
-- everywhere else.
-- Align metadata with the intended runtime policy before making the capability
-- the RLS source of truth.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'stocktake.manage'
where r.key in ('technician', 'warehouse_manager')
on conflict do nothing;

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key = 'auditor'
  and p.key = 'stocktake.manage';

-- has_capability(user,key) is an internal primitive, not a public directory of
-- other users' permissions.  Self checks use current_user_has_capability.
revoke all on function public.has_capability(uuid, text)
from public, anon, authenticated;

create or replace function public.admin_user_has_capability(
  p_user uuid,
  p_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
  if public.app_user_role() <> 'admin'
     or not public.current_user_has_capability('user.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return public.has_capability(p_user, p_key);
end
$function$;

revoke all on function public.admin_user_has_capability(uuid, text)
from public, anon;
grant execute on function public.admin_user_has_capability(uuid, text)
to authenticated;

-- Existing asset RLS used manager role literals.  Keep direct catalog writes
-- manager-only, but make the matrix authoritative (user deny overrides work).
drop policy if exists upd_ops on public.assets;
drop policy if exists upd_managers on public.assets;
drop policy if exists upd_capability on public.assets;
create policy upd_capability on public.assets
for update to authenticated
using (public.current_user_has_capability('asset.update'))
with check (public.current_user_has_capability('asset.update'));

drop policy if exists ins_ops on public.assets;
drop policy if exists ins_managers on public.assets;
drop policy if exists assets_insert_managers_restrictive on public.assets;
drop policy if exists ins_capability on public.assets;
create policy ins_capability on public.assets
for insert to authenticated
with check (public.current_user_has_capability('asset.create'));

drop policy if exists upd_ops on public.maintenance_records;
drop policy if exists upd_capability on public.maintenance_records;
create policy upd_capability on public.maintenance_records
for update to authenticated
using (public.current_user_has_capability('maintenance.manage'))
with check (public.current_user_has_capability('maintenance.manage'));

drop policy if exists ins_ops on public.stocktakes;
drop policy if exists upd_ops on public.stocktakes;
drop policy if exists ins_capability on public.stocktakes;
drop policy if exists upd_capability on public.stocktakes;
create policy ins_capability on public.stocktakes
for insert to authenticated
with check (public.current_user_has_capability('stocktake.manage'));
create policy upd_capability on public.stocktakes
for update to authenticated
using (public.current_user_has_capability('stocktake.manage'))
with check (public.current_user_has_capability('stocktake.manage'));

drop policy if exists ins_ops on public.stocktake_items;
drop policy if exists upd_ops on public.stocktake_items;
drop policy if exists ins_capability on public.stocktake_items;
drop policy if exists upd_capability on public.stocktake_items;
create policy ins_capability on public.stocktake_items
for insert to authenticated
with check (public.current_user_has_capability('stocktake.manage'));
create policy upd_capability on public.stocktake_items
for update to authenticated
using (public.current_user_has_capability('stocktake.manage'))
with check (public.current_user_has_capability('stocktake.manage'));

-- The atomic move entrypoint has a narrower capability than full record edit.
create or replace function public.asset_move_atomic(
  p_asset_id uuid,
  p_to_location_id uuid,
  p_to_department_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from_location uuid;
begin
  if not public.current_user_has_capability('asset.move') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_to_location_id is null
     or not exists (select 1 from public.locations where id = p_to_location_id) then
    return json_build_object('ok', false, 'error', 'invalid_location');
  end if;
  if p_to_department_id is not null
     and not exists (select 1 from public.departments where id = p_to_department_id) then
    return json_build_object('ok', false, 'error', 'invalid_department');
  end if;

  select location_id into v_from_location
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  update public.assets
  set location_id = p_to_location_id,
      department_id = coalesce(p_to_department_id, department_id)
  where id = p_asset_id;
  insert into public.asset_movements (
    asset_id, movement_type, from_location_id, to_location_id, performed_by, note
  ) values (
    p_asset_id, 'transfer', v_from_location, p_to_location_id, auth.uid(), 'نقل موقع'
  );
  return json_build_object('ok', true);
end
$function$;

-- Custody uses the dedicated asset.assign capability; technician is the
-- established operational default, warehouse remains limited to request flows.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'asset.assign'
where r.key = 'technician'
on conflict do nothing;

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and p.key = 'asset.assign' and r.key = 'warehouse_manager';

create or replace function public.asset_assign(
  p_asset_id uuid,
  p_employee_id uuid,
  p_due_date date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_employee_id is null
     or not exists (
       select 1 from public.employees where id = p_employee_id and is_active
     ) then
    return json_build_object('ok', false, 'error', 'employee_not_found');
  end if;
  select status into v_from
  from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if exists (
    select 1 from public.asset_assignments
    where asset_id = p_asset_id and status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'already_assigned');
  end if;
  if not public.asset_status_allowed(v_from, 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  insert into public.asset_assignments (
    asset_id, employee_id, assigned_by, due_return_date, status
  ) values (
    p_asset_id, p_employee_id, auth.uid(), p_due_date, 'active'
  );
  update public.assets
  set status = 'assigned', assigned_to_employee_id = p_employee_id
  where id = p_asset_id;
  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, to_employee_id,
    performed_by, note
  ) values (
    p_asset_id, 'assign', v_from, 'assigned', p_employee_id,
    auth.uid(), 'تسليم عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_return(
  p_asset_id uuid,
  p_condition text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select status into v_from
  from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.asset_status_allowed(v_from, 'available') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  update public.asset_assignments
  set status = 'returned', returned_at = now(),
      return_condition = nullif(p_condition, '')
  where asset_id = p_asset_id and status = 'active';
  update public.assets
  set status = 'available', assigned_to_employee_id = null
  where id = p_asset_id;
  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    p_asset_id, 'return', v_from, 'available', auth.uid(), 'إرجاع عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_change_status(
  p_asset_id uuid,
  p_to_status public.asset_status,
  p_note text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.update') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_to_status in ('retired', 'disposed')
     and not public.current_user_has_capability('asset.retire') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select status into v_from
  from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.asset_status_allowed(v_from, p_to_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  if p_to_status in ('available', 'retired', 'disposed', 'lost') then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = p_asset_id and status = 'active';
    update public.assets
    set status = p_to_status, assigned_to_employee_id = null
    where id = p_asset_id;
  else
    update public.assets set status = p_to_status where id = p_asset_id;
  end if;
  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    p_asset_id, 'status_change', v_from, p_to_status, auth.uid(),
    coalesce(nullif(p_note, ''), 'تغيير حالة')
  );
  return json_build_object('ok', true);
end
$function$;

revoke all on function public.admin_user_has_capability(uuid, text) from public, anon;
revoke all on function public.asset_move_atomic(uuid, uuid, uuid) from public, anon;
revoke all on function public.asset_assign(uuid, uuid, date) from public, anon;
revoke all on function public.asset_return(uuid, text) from public, anon;
revoke all on function public.asset_change_status(uuid, public.asset_status, text) from public, anon;
grant execute on function public.admin_user_has_capability(uuid, text) to authenticated;
grant execute on function public.asset_move_atomic(uuid, uuid, uuid) to authenticated;
grant execute on function public.asset_assign(uuid, uuid, date) to authenticated;
grant execute on function public.asset_return(uuid, text) to authenticated;
grant execute on function public.asset_change_status(uuid, public.asset_status, text) to authenticated;

commit;
