-- Smart scan exits require a real destination: assets_guard_future_integrity
-- correctly rejects clearing the location of an existing asset.
-- Additive API; entry callers keep their existing contract. No data rewrite.
begin;

create or replace function public.scan_warehouse_exit(
  p_asset_id uuid, p_warehouse_id uuid, p_destination_id uuid, p_operation_id uuid
)
returns json
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_asset public.assets%rowtype;
  v_cached public.scan_warehouse_operations%rowtype;
  v_result jsonb;
begin
  if not public.current_user_has_capability('scan.warehouse_move') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or p_warehouse_id is null then
    return json_build_object('ok', false, 'error', 'invalid_scan_operation');
  end if;
  if p_destination_id is null then
    return json_build_object('ok', false, 'error', 'destination_required');
  end if;
  if p_destination_id = p_warehouse_id then
    return json_build_object('ok', false, 'error', 'invalid_destination');
  end if;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || ':' || p_operation_id::text, 0));
  select * into v_cached from public.scan_warehouse_operations
    where actor_id = auth.uid() and operation_id = p_operation_id;
  if found then
    if v_cached.asset_id is distinct from p_asset_id or v_cached.action <> 'exit'
      or v_cached.result->>'location_after' is distinct from p_destination_id::text
      or v_cached.result->>'warehouse_id' is distinct from p_warehouse_id::text then
      return json_build_object('ok', false, 'error', 'operation_conflict');
    end if;
    return v_cached.result || jsonb_build_object('idempotent', true);
  end if;
  if not exists (select 1 from public.locations where id = p_warehouse_id)
    or not exists (select 1 from public.locations where id = p_destination_id) then
    return json_build_object('ok', false, 'error', 'invalid_location');
  end if;
  select * into v_asset from public.assets where id = p_asset_id for update;
  if not found then return json_build_object('ok', false, 'error', 'asset_not_found'); end if;
  if not v_asset.is_active or v_asset.archived_at is not null
    or v_asset.status not in ('available', 'reserved') or not public.custody_asset_is_consistent(p_asset_id) then
    return json_build_object('ok', false, 'error', 'asset_state_blocks_movement');
  end if;
  if v_asset.location_id is distinct from p_warehouse_id then
    return json_build_object('ok', false, 'error', 'not_in_warehouse');
  end if;
  if exists (
    select 1 from public.request_items i join public.requests r on r.id = i.request_id
    where i.asset_id = p_asset_id and r.status in ('draft', 'under_review', 'approved', 'auto_provisioning', 'provisioned', 'stock_shortage', 'preparing', 'ready_for_pickup', 'delivered', 'partially_returned', 'overdue')
  ) or exists (
    select 1 from public.request_asset_allocations a join public.requests r on r.id = a.request_id
    where a.asset_id = p_asset_id and a.state in ('selected', 'prepared', 'delivered')
      and r.status in ('draft', 'under_review', 'approved', 'auto_provisioning', 'provisioned', 'stock_shortage', 'preparing', 'ready_for_pickup', 'delivered', 'partially_returned', 'overdue')
  ) then return json_build_object('ok', false, 'error', 'asset_in_request'); end if;
  update public.assets set location_id = p_destination_id where id = p_asset_id;
  insert into public.asset_movements(asset_id, movement_type, from_location_id, to_location_id, from_status, to_status, performed_by, note)
  values (p_asset_id, 'transfer', v_asset.location_id, p_destination_id, v_asset.status, v_asset.status, auth.uid(), 'Confirmed smart warehouse scan: exit');
  v_result := jsonb_build_object('ok', true, 'asset_id', p_asset_id, 'action', 'exit', 'status', v_asset.status, 'warehouse_id', p_warehouse_id, 'location_after', p_destination_id);
  insert into public.scan_warehouse_operations(actor_id, operation_id, asset_id, action, result)
  values (auth.uid(), p_operation_id, p_asset_id, 'exit', v_result);
  return v_result;
end;
$function$;
revoke all on function public.scan_warehouse_exit(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.scan_warehouse_exit(uuid, uuid, uuid, uuid) to authenticated;

-- Retain the four-argument API for entry and return an actionable denial for
-- legacy exits. Assert the known implementation before altering its definition.
do $migration$
declare
  v_definition text := pg_get_functiondef('public.scan_warehouse_move(uuid,text,uuid,uuid)'::regprocedure);
  v_anchor text := '  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || '':'' || p_operation_id::text, 0));';
  v_guard text := '  if p_action = ''exit'' then return jsonb_build_object(''ok'', false, ''error'', ''destination_required''); end if;';
  v_cache text := '  if found then return v_result || jsonb_build_object(''idempotent'', true); end if;';
  v_state text := '  if v_asset.status not in (''available'', ''reserved'') then return jsonb_build_object(''ok'', false, ''error'', ''asset_state_blocks_movement''); end if;';
begin
  if position(v_guard || E'\n' || v_anchor in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0 then raise exception 'scan_warehouse_move implementation differs from the reviewed baseline'; end if;
    v_definition := replace(v_definition, v_guard || E'\n', '');
    v_definition := replace(v_definition, v_anchor, v_guard || E'\n' || v_anchor);
  end if;
  if position('operation_conflict' in v_definition) = 0 then
    if position(v_cache in v_definition) = 0 then raise exception 'scan_warehouse_move retry implementation differs from the reviewed baseline'; end if;
    v_definition := replace(v_definition, v_cache,
      '  if found then' || E'\n' ||
      '    if v_result->>''asset_id'' is distinct from p_asset_id::text or v_result->>''action'' is distinct from p_action or v_result->>''location_after'' is distinct from p_warehouse_id::text then return jsonb_build_object(''ok'', false, ''error'', ''operation_conflict''); end if;' || E'\n' ||
      '    return v_result || jsonb_build_object(''idempotent'', true);' || E'\n' || '  end if;');
  end if;
  if position('v_asset.archived_at' in v_definition) = 0 then
    if position(v_state in v_definition) = 0 then raise exception 'scan_warehouse_move state guard differs from the reviewed baseline'; end if;
    v_definition := replace(v_definition, v_state,
      '  if not v_asset.is_active or v_asset.archived_at is not null or v_asset.status not in (''available'', ''reserved'') then return jsonb_build_object(''ok'', false, ''error'', ''asset_state_blocks_movement''); end if;');
  end if;
  execute v_definition;
end;
$migration$;

-- Rollback: remove the new RPC and restore the reviewed prior entry definition.
-- Existing assets, movements, constraints and RLS remain intact.
commit;
