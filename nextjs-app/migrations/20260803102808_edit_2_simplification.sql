-- Edit 2: simplify customer-facing workflows, retire active use of the legacy
-- lost status, and add an idempotent, audited smart warehouse scan operation.
-- Risk: additive functions/table plus a transactional remediation of active rows.
-- Rollback: retain the audit/movement evidence; restore a prior application only
-- after an explicit data review. No records, audit rows, or enum values are dropped.
begin;

-- Keep the old enum label only because historical audit/movement columns use it.
-- Active assets cannot retain it: unresolved custody is deliberately fail-closed.
do $$
declare
  v_unsafe integer;
begin
  select count(*) into v_unsafe
  from public.assets a
  where a.status = 'lost'::public.asset_status
    and (
      exists (select 1 from public.asset_assignments aa where aa.asset_id = a.id and aa.status = 'active')
      or exists (
        select 1 from public.request_items ri
        join public.requests r on r.id = ri.request_id
        where ri.asset_id = a.id
          and r.status not in ('completed', 'cancelled', 'rejected')
          and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0)
      )
    );
  if v_unsafe > 0 then
    raise exception 'edit_2_lost_remediation_requires_custody_review:%', v_unsafe;
  end if;
end $$;

insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
select a.id, 'status_change', a.status, 'available'::public.asset_status, auth.uid(),
  'Edit 2 remediation: legacy missing status reviewed and returned to available stock'
from public.assets a
where a.status = 'lost'::public.asset_status;

update public.assets
set status = 'available'::public.asset_status,
    assigned_to_employee_id = null
where status = 'lost'::public.asset_status;

create or replace function public.asset_status_allowed(p_old public.asset_status, p_new public.asset_status)
returns boolean
language plpgsql
immutable
set search_path = public
as $function$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'available'      then p_new in ('assigned','reserved','in_maintenance','damaged','retired','rented','sold')
    when 'assigned'       then p_new in ('available','in_maintenance','damaged','retired','rented','sold')
    when 'reserved'       then p_new in ('available','assigned','in_maintenance','retired','rented','sold')
    when 'in_maintenance' then p_new in ('available','assigned','damaged','retired')
    when 'damaged'        then p_new in ('in_maintenance','retired','disposed')
    when 'retired'        then p_new in ('disposed')
    when 'rented'         then p_new in ('available','reserved','in_maintenance','damaged','retired','sold')
    when 'sold'           then p_new in ('available')
    when 'disposed'       then false
    else false
  end;
end
$function$;

-- A missing condition is never silently accepted as normal stock: it goes to
-- maintenance for authorized review, preserving the return inspection evidence.
create or replace function public.request_inspect_return(p_id uuid, p_lines jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role text := public.app_user_role();
  v_req public.requests%rowtype;
  v_line jsonb;
  v_asset uuid;
  v_cond text;
  v_notes text;
  v_cur public.asset_status;
  v_new public.asset_status;
  v_assignment_grade text;
  v_seen uuid[] := array[]::uuid[];
  v_processed integer := 0;
  v_issues integer := 0;
  v_remaining integer;
begin
  if v_role is null or v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return json_build_object('ok', false, 'error', 'invalid_return_inspection');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered', 'partially_returned', 'overdue') then
    return json_build_object('ok', false, 'error', 'state_not_returnable');
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_asset := nullif(v_line->>'asset_id', '')::uuid;
    v_cond := nullif(v_line->>'condition', '');
    v_notes := nullif(btrim(v_line->>'notes'), '');
    if v_asset is null or v_asset = any(v_seen) or v_cond not in ('sound', 'unsound', 'missing', 'needs_maintenance') then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
    if v_cond in ('unsound', 'missing', 'needs_maintenance') and v_notes is null then
      return json_build_object('ok', false, 'error', 'return_notes_required');
    end if;
    if not exists (select 1 from public.request_items ri where ri.request_id = p_id and ri.item_kind = 'asset' and ri.asset_id = v_asset and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0)) then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
    select status into v_cur from public.assets where id = v_asset for update;
    if v_cur not in ('rented', 'assigned') then return json_build_object('ok', false, 'error', 'invalid_return_inspection'); end if;
    v_seen := array_append(v_seen, v_asset);
  end loop;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_asset := (v_line->>'asset_id')::uuid;
    v_cond := v_line->>'condition';
    v_notes := nullif(btrim(v_line->>'notes'), '');
    select status into v_cur from public.assets where id = v_asset;
    v_new := case when v_cond = 'sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end;
    v_assignment_grade := case when v_cond = 'sound' then 'good' when v_cond = 'needs_maintenance' then 'fair' else 'poor' end;
    update public.assets set status = v_new, assigned_to_employee_id = null, last_return_condition = v_cond,
      last_return_at = now(), last_request_id = p_id,
      unsound_return_count = coalesce(unsound_return_count, 0) + case when v_cond in ('unsound', 'needs_maintenance') then 1 else 0 end
    where id = v_asset;
    insert into public.asset_movements(asset_id, movement_type, from_status, to_status, performed_by, note)
    values (v_asset, 'status_change', v_cur, v_new, auth.uid(), 'Request return inspection ' || v_req.request_number || ' — ' || v_cond || coalesce(' · ' || v_notes, ''));
    update public.asset_assignments set status = 'returned', returned_at = now(), return_condition = v_assignment_grade where asset_id = v_asset and status = 'active';
    if v_cond in ('unsound', 'missing', 'needs_maintenance') then
      insert into public.maintenance_records(asset_id, reported_by, problem_description)
      values (v_asset, auth.uid(), 'Returned device requires review for request ' || v_req.request_number || coalesce(' · ' || v_notes, ''));
    end if;
    update public.request_items set returned_quantity = quantity where request_id = p_id and item_kind = 'asset' and asset_id = v_asset;
    v_processed := v_processed + 1;
    if v_cond <> 'sound' then v_issues := v_issues + 1; end if;
  end loop;
  select count(*) into v_remaining from public.request_items ri where ri.request_id = p_id and ri.item_kind = 'asset' and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0);
  if v_remaining > 0 then update public.requests set status = 'partially_returned' where id = p_id;
  else update public.requests set status = 'returned', returned_at = now() where id = p_id; end if;
  perform public._request_add_event(p_id, 'inspected_return', 'staff', null, jsonb_build_object('processed', v_processed, 'issues', v_issues, 'remaining', v_remaining));
  return json_build_object('ok', true, 'processed', v_processed, 'issues', v_issues, 'remaining', v_remaining);
exception when invalid_text_representation then
  return json_build_object('ok', false, 'error', 'invalid_return_inspection');
end
$function$;
revoke all on function public.request_inspect_return(uuid, jsonb) from public, anon;
grant execute on function public.request_inspect_return(uuid, jsonb) to authenticated;

insert into public.permissions (key, grp, description)
values ('scan.warehouse_move', 'inventory', 'Move an eligible asset into or out of the warehouse by confirmed scan')
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'scan.warehouse_move'
where r.key in ('admin', 'it_manager', 'technician', 'warehouse_manager')
on conflict do nothing;

create table if not exists public.scan_warehouse_operations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  asset_id uuid not null references public.assets(id),
  action text not null check (action in ('entry', 'exit')),
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_id, operation_id)
);
alter table public.scan_warehouse_operations enable row level security;
revoke all on public.scan_warehouse_operations from public, anon, authenticated;

create or replace function public.scan_warehouse_move(p_asset_id uuid, p_action text, p_warehouse_id uuid, p_operation_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_asset public.assets%rowtype;
  v_result jsonb;
begin
  if not public.current_user_has_capability('scan.warehouse_move') then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_operation_id is null or p_action not in ('entry', 'exit') or p_warehouse_id is null then return jsonb_build_object('ok', false, 'error', 'invalid_scan_operation'); end if;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || ':' || p_operation_id::text, 0));
  select result into v_result from public.scan_warehouse_operations where actor_id = auth.uid() and operation_id = p_operation_id;
  if found then return v_result || jsonb_build_object('idempotent', true); end if;
  if not exists (select 1 from public.locations where id = p_warehouse_id) then return jsonb_build_object('ok', false, 'error', 'invalid_location'); end if;
  select * into v_asset from public.assets where id = p_asset_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'asset_not_found'); end if;
  if v_asset.status not in ('available', 'reserved') then return jsonb_build_object('ok', false, 'error', 'asset_state_blocks_movement'); end if;
  if p_action = 'entry' and v_asset.location_id = p_warehouse_id then return jsonb_build_object('ok', false, 'error', 'already_in_warehouse'); end if;
  if p_action = 'exit' and v_asset.location_id is distinct from p_warehouse_id then return jsonb_build_object('ok', false, 'error', 'not_in_warehouse'); end if;
  update public.assets set location_id = case when p_action = 'entry' then p_warehouse_id else null end where id = p_asset_id;
  insert into public.asset_movements(asset_id, movement_type, from_location_id, to_location_id, from_status, to_status, performed_by, note)
  values (p_asset_id, 'transfer', v_asset.location_id, case when p_action = 'entry' then p_warehouse_id else null end, v_asset.status, v_asset.status, auth.uid(), 'Confirmed smart warehouse scan: ' || p_action);
  v_result := jsonb_build_object('ok', true, 'asset_id', p_asset_id, 'action', p_action, 'status', v_asset.status, 'location_after', case when p_action = 'entry' then p_warehouse_id else null end);
  insert into public.scan_warehouse_operations(actor_id, operation_id, asset_id, action, result) values (auth.uid(), p_operation_id, p_asset_id, p_action, v_result);
  return v_result;
end
$function$;
revoke all on function public.scan_warehouse_move(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.scan_warehouse_move(uuid, text, uuid, uuid) to authenticated;

-- The Action Center contains only current operational queues. Legacy alerts are
-- auto-resolved by the next source-driven sync; no alert evidence is deleted.
create or replace function public.action_alerts_sync(p_candidates jsonb)
returns json language plpgsql security definer set search_path = public as $function$
declare
  v_role text := public.app_user_role(); v_keys text[]; c jsonb; v_id uuid; v_status text;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician','warehouse_manager') then return json_build_object('ok', false, 'error', 'not_allowed'); end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then return json_build_object('ok', false, 'error', 'bad_input'); end if;
  select coalesce(array_agg(x->>'stable_key'), '{}') into v_keys from jsonb_array_elements(p_candidates) x;
  for c in select * from jsonb_array_elements(p_candidates) loop
    if coalesce(c->>'stable_key','') = '' or c->>'alert_type' not in ('request_pending','request_preparing','request_ready_delivery','maint_overdue','maint_no_technician','consumable_below_threshold','stocktake_review') then continue; end if;
    select id, status into v_id, v_status from public.action_alert_instances where stable_key = c->>'stable_key';
    if v_id is null then
      insert into public.action_alert_instances (stable_key, alert_type, entity_type, entity_id, severity, metadata)
      values (c->>'stable_key', c->>'alert_type', coalesce(c->>'entity_type','general'), nullif(c->>'entity_id','')::uuid,
        case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else 'medium' end,
        jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int, 'due_at', c->'metadata'->>'due_at'))) returning id into v_id;
      insert into public.action_alert_events (alert_instance_id, event_type, actor_id) values (v_id, 'created', auth.uid());
    else
      update public.action_alert_instances set last_seen_at = now(), updated_at = now(), severity = case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else severity end,
        metadata = jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int, 'due_at', c->'metadata'->>'due_at')),
        status = case when status = 'auto_resolved' then 'reopened' else status end, reopened_at = case when status = 'auto_resolved' then now() else reopened_at end,
        auto_resolved_at = case when status = 'auto_resolved' then null else auto_resolved_at end, occurrence_count = case when status = 'auto_resolved' then occurrence_count + 1 else occurrence_count end where id = v_id;
      if v_status = 'auto_resolved' then insert into public.action_alert_events (alert_instance_id, event_type, actor_id) values (v_id, 'reopened', auth.uid()); end if;
    end if;
  end loop;
  insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
    select i.id, 'auto_resolved', auth.uid() from public.action_alert_instances i where i.status in ('open','in_progress','reopened') and not (i.stable_key = any(v_keys));
  update public.action_alert_instances set status = 'auto_resolved', auto_resolved_at = now(), updated_at = now() where status in ('open','in_progress','reopened') and not (stable_key = any(v_keys));
  return json_build_object('ok', true);
end;
$function$;
revoke all on function public.action_alerts_sync(jsonb) from public, anon;
grant execute on function public.action_alerts_sync(jsonb) to authenticated;

create or replace function public.action_alert_operational_counts()
returns jsonb language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'needs_action', count(*) filter (where status in ('open', 'reopened')),
    'high_severity', count(*) filter (where status in ('open', 'reopened') and severity in ('critical', 'high')),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'mine', count(*) filter (where assigned_to = auth.uid() and status <> 'auto_resolved'),
    'resolved', count(*) filter (where status = 'auto_resolved'),
    'resolved_today', count(*) filter (where status = 'auto_resolved' and auto_resolved_at::date = current_date)
  ) from public.action_alert_instances
  where public.is_approved() and alert_type in ('request_pending','request_preparing','request_ready_delivery','maint_overdue','maint_no_technician','consumable_below_threshold','stocktake_review')
$function$;
revoke all on function public.action_alert_operational_counts() from public, anon;
grant execute on function public.action_alert_operational_counts() to authenticated;

create or replace function public.dashboard_operational_summary()
returns jsonb language sql stable security definer set search_path = public as $function$
with guard as (select public.is_approved() as allowed),
asset_counts as (select count(*) as total, count(*) filter (where status = 'available') as available, count(*) filter (where status = 'assigned') as assigned, count(*) filter (where status = 'in_maintenance') as in_maintenance, count(*) filter (where status = 'damaged') as damaged, count(*) filter (where status = 'retired') as retired from public.assets, guard where is_active and guard.allowed),
consumable_counts as (select count(*) filter (where reorder_level > 0 and quantity_on_hand <= reorder_level) as at_risk, count(*) filter (where quantity_on_hand = 0) as stockout, count(*) filter (where reorder_level <= 0) as without_threshold from public.consumables, guard where is_active and guard.allowed),
maintenance_counts as (select count(*) filter (where status in ('open','in_progress') and reported_at < now() - interval '14 days') as long_open, count(*) filter (where status in ('open','in_progress') and nullif(btrim(action_taken),'') is null and technician_id is null) as no_action, count(*) filter (where status in ('open','in_progress') and (reported_at < now() - interval '14 days' or (nullif(btrim(action_taken),'') is null and technician_id is null))) as followup from public.maintenance_records, guard where guard.allowed),
request_counts as (select count(*) filter (where status = 'under_review') as actionable, count(*) filter (where status = 'overdue' or (status in ('delivered','partially_returned') and return_date < (now() at time zone 'Asia/Riyadh')::date)) as overdue, count(*) filter (where status in ('approved','auto_provisioning','provisioned','stock_shortage','preparing')) as preparation, count(*) filter (where status = 'ready_for_pickup') as ready_delivery, count(*) filter (where status in ('delivered','partially_returned','overdue') and return_date <= (now() at time zone 'Asia/Riyadh')::date) as returns_due, count(*) filter (where status = 'returned') as returned_inspection from public.requests, guard where guard.allowed and portal_approval_status not in ('pending_project_manager','rejected_by_project_manager'))
select jsonb_build_object('assets', jsonb_build_object('total',a.total,'available',a.available,'assigned',a.assigned,'in_maintenance',a.in_maintenance,'damaged',a.damaged,'retired',a.retired), 'consumables',jsonb_build_object('at_risk',c.at_risk,'stockout',c.stockout,'without_threshold',c.without_threshold), 'maintenance',jsonb_build_object('long_open',m.long_open,'no_action',m.no_action,'followup',m.followup), 'requests',jsonb_build_object('actionable',r.actionable,'overdue',r.overdue,'preparation',r.preparation,'ready_delivery',r.ready_delivery,'returns_due',r.returns_due,'returned_inspection',r.returned_inspection)) from asset_counts a cross join consumable_counts c cross join maintenance_counts m cross join request_counts r
$function$;
revoke all on function public.dashboard_operational_summary() from public, anon;
grant execute on function public.dashboard_operational_summary() to authenticated;

commit;
