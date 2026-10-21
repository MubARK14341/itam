-- Purpose: complete the employee-return loop with a warehouse-only, idempotent
-- intake contract, and align stocktake read visibility to stocktake.manage.
-- Risk: additive tables/functions plus narrowly-scoped policy adjustment.
-- Rollback: revoke the two new function grants; retain completed-return and
-- movement/audit evidence. No existing asset, custody, or audit data is removed.

begin;

create table if not exists public.employee_return_intake_operations (
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  return_request_id uuid not null references public.employee_asset_return_requests(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation_id)
);
alter table public.employee_return_intake_operations enable row level security;
revoke all on public.employee_return_intake_operations from public, anon, authenticated;

create or replace function public.warehouse_employee_return_queue()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rr.id,
        'asset_id', rr.asset_id,
        'asset_tag', a.asset_tag,
        'asset_name', a.name,
        'employee_name', coalesce(e.full_name_ar, e.full_name),
        'reason', rr.reason,
        'status', rr.status,
        'requested_at', rr.requested_at
      ) order by rr.requested_at asc)
      from public.employee_asset_return_requests rr
      join public.assets a on a.id = rr.asset_id
      join public.employees e on e.id = rr.employee_id
      where rr.status in ('pending', 'acknowledged')
    ), '[]'::jsonb)
  end
$function$;

create or replace function public.warehouse_receive_employee_return(
  p_return_request_id uuid,
  p_condition text,
  p_note text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role text := public.app_user_role();
  v_actor uuid := auth.uid();
  v_return public.employee_asset_return_requests%rowtype;
  v_asset public.assets%rowtype;
  v_existing jsonb;
  v_result jsonb;
  v_next_status public.asset_status;
  v_grade text;
begin
  if v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_return_request_id is null or p_operation_id is null
    or p_condition not in ('sound', 'needs_maintenance', 'unsound') then
    return jsonb_build_object('ok', false, 'error', 'invalid_return_intake');
  end if;
  if p_condition <> 'sound' and nullif(btrim(coalesce(p_note, '')), '') is null then
    return jsonb_build_object('ok', false, 'error', 'return_notes_required');
  end if;

  select result into v_existing
  from public.employee_return_intake_operations
  where actor_id = v_actor and operation_id = p_operation_id;
  if found then return v_existing; end if;

  select * into v_return
  from public.employee_asset_return_requests
  where id = p_return_request_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_return.status not in ('pending', 'acknowledged') then
    return jsonb_build_object('ok', false, 'error', 'return_already_processed');
  end if;

  select * into v_asset from public.assets where id = v_return.asset_id for update;
  if not found or v_asset.assigned_to_employee_id is distinct from v_return.employee_id then
    return jsonb_build_object('ok', false, 'error', 'custody_mismatch');
  end if;
  perform 1 from public.asset_assignments aa
  where aa.id = v_return.assignment_id and aa.asset_id = v_return.asset_id
    and aa.employee_id = v_return.employee_id and aa.status = 'active'
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'custody_mismatch'); end if;

  v_next_status := case when p_condition = 'sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end;
  v_grade := case when p_condition = 'sound' then 'good' when p_condition = 'needs_maintenance' then 'fair' else 'poor' end;
  update public.assets
  set status = v_next_status,
      assigned_to_employee_id = null,
      last_return_condition = p_condition,
      last_return_at = now()
  where id = v_asset.id;
  update public.asset_assignments
  set status = 'returned', returned_at = now(), return_condition = v_grade
  where id = v_return.assignment_id;
  update public.employee_asset_return_requests
  set status = 'completed', resolved_by = v_actor, resolved_at = now(), resolution_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = v_return.id;
  insert into public.asset_movements(asset_id, movement_type, from_status, to_status, performed_by, note)
  values (v_asset.id, 'status_change', v_asset.status, v_next_status, v_actor,
    'Employee return intake' || case when nullif(btrim(coalesce(p_note, '')), '') is null then '' else ' · ' || btrim(p_note) end);
  if p_condition <> 'sound' then
    insert into public.maintenance_records(asset_id, reported_by, problem_description)
    values (v_asset.id, v_actor, 'Employee return intake requires maintenance' || coalesce(' · ' || nullif(btrim(p_note), ''), ''));
  end if;
  v_result := jsonb_build_object('ok', true, 'id', v_return.id, 'asset_id', v_asset.id);
  insert into public.employee_return_intake_operations(actor_id, operation_id, return_request_id, result)
  values (v_actor, p_operation_id, v_return.id, v_result);
  return v_result;
end
$function$;

revoke all on function public.warehouse_employee_return_queue() from public, anon;
revoke all on function public.warehouse_receive_employee_return(uuid, text, text, uuid) from public, anon;
grant execute on function public.warehouse_employee_return_queue() to authenticated;
grant execute on function public.warehouse_receive_employee_return(uuid, text, text, uuid) to authenticated;

do $policy$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stocktakes' and policyname = 'sel_stocktake_roles') then
    execute $sql$alter policy sel_stocktake_roles on public.stocktakes
      using (public.is_approved() and (public.app_user_role() = 'auditor' or public.current_user_has_capability('stocktake.manage')))$sql$;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stocktake_items' and policyname = 'sel_stocktake_roles') then
    execute $sql$alter policy sel_stocktake_roles on public.stocktake_items
      using (public.is_approved() and (public.app_user_role() = 'auditor' or public.current_user_has_capability('stocktake.manage')))$sql$;
  end if;
end
$policy$;

commit;
