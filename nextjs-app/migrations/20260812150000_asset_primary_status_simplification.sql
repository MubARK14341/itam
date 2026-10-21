-- Purpose: make assets.status a simple, safe three-state operational contract.
-- Risk: assignment, allocation, and sale/archive workflows are updated in one
-- transaction; movement history retains its legacy enum values as evidence.
-- Rollback: restore the prior RPC definitions and drop the canonical check only
-- after a reviewed data migration; do not rewrite movement or audit history.

begin;

-- The shared enum is also used by immutable asset_movements.  Its legacy
-- labels therefore remain valid historical evidence, while this constraint is
-- the authoritative contract for the *current* asset row.
alter table public.assets drop constraint if exists assets_primary_status_canonical;

create or replace function public.asset_status_allowed(
  p_old public.asset_status,
  p_new public.asset_status
) returns boolean
language plpgsql
immutable
set search_path to 'public'
as $function$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'available' then p_new in ('reserved', 'in_maintenance')
    when 'reserved' then p_new in ('available', 'in_maintenance')
    when 'in_maintenance' then p_new in ('available', 'reserved')
    else false
  end;
end
$function$;

create or replace function public.custody_asset_is_consistent(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  with asset_state as (
    select a.status, a.assigned_to_employee_id
    from public.assets a where a.id = p_asset_id
  ), active_state as (
    select count(aa.id)::integer as active_count,
      count(aa.id) filter (where aa.employee_id = s.assigned_to_employee_id)::integer as matching_count,
      count(aa.id) filter (where e.id is null or not e.is_active)::integer as inactive_employee_count
    from asset_state s
    left join public.asset_assignments aa on aa.asset_id = p_asset_id and aa.status = 'active'
    left join public.employees e on e.id = aa.employee_id
  )
  select coalesce((select case
    when s.assigned_to_employee_id is not null then s.status = 'reserved'
      and a.active_count = 1 and a.matching_count = 1 and a.inactive_employee_count = 0
    else a.active_count = 0
  end from asset_state s cross join active_state a), false);
$function$;

-- During this one migration an old assigned row is still a valid, provable
-- custody relationship until its status is remapped to reserved.
create or replace function public.assets_guard_custody_transition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status = 'assigned' then
    if old.assigned_to_employee_id is null or not exists (
      select 1 from public.asset_assignments aa
      where aa.asset_id = old.id and aa.employee_id = old.assigned_to_employee_id and aa.status = 'active'
    ) then raise exception 'custody_reconciliation_required' using errcode = '23514'; end if;
  elsif not public.custody_asset_is_consistent(old.id) then
    raise exception 'custody_reconciliation_required' using errcode = '23514';
  end if;
  return new;
end
$function$;

create or replace function public.assets_guard_status()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.status is distinct from old.status then
    if (old.status in ('assigned','rented') and new.status = 'reserved')
       or (old.status = 'damaged' and new.status = 'in_maintenance')
       or (old.status in ('sold','disposed','lost','retired') and new.status = 'reserved') then
      return new;
    end if;
    if not public.asset_status_allowed(old.status, new.status) then
      raise exception 'asset_status_transition_not_allowed' using errcode = '23514';
    end if;
  end if;
  return new;
end
$function$;

create or replace function public.assets_guard_future_integrity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.created_by is null then raise exception 'asset_creator_required' using errcode = '23514'; end if;
    if new.company_id is null then raise exception 'asset_company_required' using errcode = '23514'; end if;
    if new.location_id is null then raise exception 'asset_location_required' using errcode = '23514'; end if;
    if nullif(btrim(new.serial_number), '') is null and not coalesce(new.serial_exempt, false) then
      raise exception 'asset_serial_required' using errcode = '23514';
    end if;
  else
    if old.company_id is not null and new.company_id is null then raise exception 'asset_company_cannot_be_cleared' using errcode = '23514'; end if;
    if old.location_id is not null and new.location_id is null then raise exception 'asset_location_cannot_be_cleared' using errcode = '23514'; end if;
    if old.created_by is not null and new.created_by is distinct from old.created_by then raise exception 'asset_creator_immutable' using errcode = '23514'; end if;
  end if;
  if new.status not in ('available', 'reserved', 'in_maintenance') then
    raise exception 'asset_primary_status_invalid' using errcode = '23514';
  end if;
  return new;
end
$function$;

create or replace function public.assets_guard_reservation_integrity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.archived_at is null and new.status = 'reserved'
     and not exists (select 1 from public.asset_assignments aa where aa.asset_id = new.id and aa.status = 'active')
     and not exists (select 1 from public.request_asset_allocations ra where ra.asset_id = new.id and ra.state in ('selected', 'prepared', 'delivered')) then
    raise exception 'reserved_asset_requires_active_relationship' using errcode = '23514';
  end if;
  return null;
end
$function$;

-- Custody is a relationship; its simplified primary state is reserved.
create or replace function public.asset_assign(p_asset_id uuid, p_employee_id uuid, p_due_date date default null)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.assign') then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_employee_id is null or not exists (select 1 from public.employees where id=p_employee_id and is_active) then return json_build_object('ok', false, 'error', 'employee_not_found'); end if;
  select status into v_from from public.assets where id=p_asset_id for update;
  if not found then return json_build_object('ok', false, 'error', 'asset_not_found'); end if;
  if not public.custody_asset_is_consistent(p_asset_id) or not public.asset_status_allowed(v_from, 'reserved') then return json_build_object('ok', false, 'error', 'invalid_transition'); end if;
  update public.assets set status='reserved', assigned_to_employee_id=p_employee_id where id=p_asset_id;
  insert into public.asset_assignments(asset_id,employee_id,assigned_by,due_return_date,status) values(p_asset_id,p_employee_id,auth.uid(),p_due_date,'active');
  insert into public.asset_movements(asset_id,movement_type,from_status,to_status,to_employee_id,performed_by,note) values(p_asset_id,'assign',v_from,'reserved',p_employee_id,auth.uid(),'تسليم عهدة');
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_return(p_asset_id uuid, p_condition text default null)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_from public.asset_status; v_employee_id uuid;
begin
  if not public.current_user_has_capability('asset.assign') then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_condition is not null and p_condition not in ('new','good','fair','poor') then return json_build_object('ok', false, 'error', 'invalid_condition'); end if;
  select status,assigned_to_employee_id into v_from,v_employee_id from public.assets where id=p_asset_id for update;
  if not found then return json_build_object('ok', false, 'error', 'asset_not_found'); end if;
  if v_from <> 'reserved' or v_employee_id is null or not public.custody_asset_is_consistent(p_asset_id) then return json_build_object('ok', false, 'error', 'invalid_transition'); end if;
  update public.assets set status='available',assigned_to_employee_id=null,last_return_condition=nullif(p_condition,''),last_return_at=statement_timestamp() where id=p_asset_id;
  update public.asset_assignments set status='returned',returned_at=statement_timestamp(),return_condition=nullif(p_condition,'') where asset_id=p_asset_id and status='active';
  insert into public.asset_movements(asset_id,movement_type,from_employee_id,from_status,to_status,performed_by,note) values(p_asset_id,'return',v_employee_id,v_from,'available',auth.uid(),'إرجاع عهدة');
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_change_status(p_asset_id uuid, p_to_status public.asset_status, p_note text default null)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.update') then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_to_status not in ('available','in_maintenance') then return json_build_object('ok',false,'error','invalid_primary_status'); end if;
  select status into v_from from public.assets where id=p_asset_id for update;
  if not found then return json_build_object('ok',false,'error','asset_not_found'); end if;
  if not public.custody_asset_is_consistent(p_asset_id) or not public.asset_status_allowed(v_from,p_to_status) then return json_build_object('ok',false,'error','invalid_transition'); end if;
  update public.assets set status=p_to_status,assigned_to_employee_id=null where id=p_asset_id;
  insert into public.asset_movements(asset_id,movement_type,from_status,to_status,performed_by,note) values(p_asset_id,'status_change',v_from,p_to_status,auth.uid(),coalesce(nullif(p_note,''),'تغيير حالة'));
  return json_build_object('ok',true);
end
$function$;

-- The delivery workflow is the only path that can create a delivery/custody
-- reservation. Rewrite its legacy primary targets without touching evidence.
do $rewrite_delivery$
declare v_definition text;
begin
  select pg_get_functiondef('public.request_deliver(uuid)'::regprocedure) into v_definition;
  if position($q$v_target := 'assigned'::asset_status;$q$ in v_definition) = 0 then raise exception 'request_deliver_contract_unexpected'; end if;
  v_definition := replace(v_definition, $q$v_target := 'assigned'::asset_status;$q$, $q$v_target := 'reserved'::asset_status;$q$);
  v_definition := replace(v_definition, $q$v_target := case when v_req.request_type = 'sale' then 'sold'::asset_status else 'rented'::asset_status end;$q$, $q$v_target := 'reserved'::asset_status;$q$);
  v_definition := replace(v_definition, $q$v_target = 'assigned'$q$, $q$v_req.beneficiary_type = 'employee'$q$);
  v_definition := replace(v_definition, $q$status = 'assigned'$q$, $q$status = 'reserved'$q$);
  v_definition := replace(v_definition, $q$, 'assigned',$q$, $q$, 'reserved',$q$);
  v_definition := replace(v_definition, $q$  update public.requests
    set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,$q$, $q$  if v_req.request_type = 'sale' then
    update public.assets a set status='reserved', archived_at=coalesce(a.archived_at, now()), is_active=false
    from public.request_items ri where ri.request_id=p_id and ri.item_kind='asset' and ri.asset_id=a.id;
  end if;
  update public.requests
    set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,$q$);
  execute v_definition;
end
$rewrite_delivery$;

do $rewrite_completion$
declare v_definition text;
begin
  select pg_get_functiondef('public.request_complete(uuid)'::regprocedure) into v_definition;
  v_definition := replace(v_definition, $q$a.status = 'rented'$q$, $q$a.status = 'reserved'$q$);
  v_definition := replace(v_definition, $q$'rented', 'available'$q$, $q$'reserved', 'available'$q$);
  execute v_definition;
end
$rewrite_completion$;

-- Existing facts first: custody/rental become reserved; terminal states are
-- safely retained as archived records so they cannot be allocated again.
drop trigger if exists trg_assets_assigned_integrity_insert on public.assets;
drop trigger if exists trg_assets_assigned_integrity_update on public.assets;

update public.assets set status='reserved' where status in ('assigned','rented');
update public.assets set status='in_maintenance' where status='damaged';
update public.assets set status='reserved', archived_at=coalesce(archived_at, now()), is_active=false
where status in ('sold','disposed','lost','retired');

-- Flush the pre-existing deferred custody checks before adding the final
-- canonical check constraint in this same transaction.
set constraints all immediate;

alter table public.assets add constraint assets_primary_status_canonical
  check (status in ('available','reserved','in_maintenance'));

drop trigger if exists trg_assets_reservation_integrity_insert on public.assets;
create constraint trigger trg_assets_reservation_integrity_insert
after insert on public.assets deferrable initially deferred for each row
execute function public.assets_guard_reservation_integrity();
drop trigger if exists trg_assets_reservation_integrity_update on public.assets;
create constraint trigger trg_assets_reservation_integrity_update
after update of status, archived_at on public.assets deferrable initially deferred for each row
execute function public.assets_guard_reservation_integrity();

create or replace function public.dashboard_operational_summary()
returns jsonb language sql stable security definer set search_path to 'public'
as $function$
with guard as (select public.is_approved() as allowed),
asset_counts as (select count(*) as total,count(*) filter(where status='available') as available,count(*) filter(where status='reserved') as reserved,count(*) filter(where status='in_maintenance') as in_maintenance from public.assets,guard where is_active and archived_at is null and guard.allowed),
consumable_counts as (select count(*) filter(where reorder_level>0 and quantity_on_hand<=reorder_level) as at_risk,count(*) filter(where quantity_on_hand=0) as stockout,count(*) filter(where reorder_level<=0) as without_threshold from public.consumables,guard where is_active and guard.allowed),
maintenance_counts as (select count(*) filter(where status in ('open','in_progress') and reported_at<now()-interval '14 days') as long_open,count(*) filter(where status in ('open','in_progress') and nullif(btrim(action_taken),'') is null and technician_id is null) as no_action,count(*) filter(where status in ('open','in_progress') and (reported_at<now()-interval '14 days' or (nullif(btrim(action_taken),'') is null and technician_id is null))) as followup from public.maintenance_records,guard where guard.allowed),
request_counts as (select count(*) filter(where status='under_review') as actionable,count(*) filter(where status='overdue' or (status in ('delivered','partially_returned') and return_date<(now() at time zone 'Asia/Riyadh')::date)) as overdue,count(*) filter(where status in ('approved','auto_provisioning','provisioned','stock_shortage','preparing')) as preparation,count(*) filter(where status='ready_for_pickup') as ready_delivery,count(*) filter(where status in ('delivered','partially_returned','overdue') and return_date<=(now() at time zone 'Asia/Riyadh')::date) as returns_due,count(*) filter(where status='returned') as returned_inspection from public.requests,guard where guard.allowed and portal_approval_status not in ('pending_project_manager','rejected_by_project_manager'))
select jsonb_build_object('assets',jsonb_build_object('total',a.total,'available',a.available,'reserved',a.reserved,'in_maintenance',a.in_maintenance),'consumables',jsonb_build_object('at_risk',c.at_risk,'stockout',c.stockout,'without_threshold',c.without_threshold),'maintenance',jsonb_build_object('long_open',m.long_open,'no_action',m.no_action,'followup',m.followup),'requests',jsonb_build_object('actionable',r.actionable,'overdue',r.overdue,'preparation',r.preparation,'ready_delivery',r.ready_delivery,'returns_due',r.returns_due,'returned_inspection',r.returned_inspection)) from asset_counts a cross join consumable_counts c cross join maintenance_counts m cross join request_counts r;
$function$;

revoke all on function public.assets_guard_reservation_integrity() from public, anon, authenticated;
revoke all on function public.custody_asset_is_consistent(uuid) from public, anon;
grant execute on function public.custody_asset_is_consistent(uuid) to authenticated;
revoke all on function public.dashboard_operational_summary() from public, anon;
grant execute on function public.dashboard_operational_summary() to authenticated;

commit;
