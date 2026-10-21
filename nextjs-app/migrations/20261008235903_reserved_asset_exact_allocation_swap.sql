-- Purpose: keep a reserved-device replacement and its canonical exact-asset
-- allocations in the same existing locked/idempotent request transaction.
-- Evidence: the prior RPC reserved the replacement without an allocation and
-- failed reserved_asset_requires_active_relationship (23514). INSERT-only
-- auto-provision allocation evidence cannot synchronize request-item UPDATEs.
-- Risk: trusted RPC body only. No direct table grants, RLS, state constraints,
-- custody or role resolver changes; signatures and idempotent cache stay intact.
-- Rollback: restore the reviewed request_change_reserved_asset definition;
-- retain allocation/event evidence already created by successful operations.

begin;

do $migration$
declare
  v_definition text := pg_get_functiondef('public.request_change_reserved_asset(uuid,uuid,uuid)'::regprocedure);
  v_anchor text := '  update public.assets set status = ''available'' where id = v_old.id;';
  v_replacement text := $body$
  -- Preserve exact allocation history before changing either physical state.
  perform 1 from public.request_asset_allocations
  where request_item_id = v_item.id and state in ('selected', 'prepared', 'delivered')
  order by asset_id for update;
  if (select count(*) from public.request_asset_allocations
      where request_item_id = v_item.id and state in ('selected', 'prepared', 'delivered')) <> 1
     or not exists (select 1 from public.request_asset_allocations
       where request_id = v_request.id and request_item_id = v_item.id
         and asset_id = v_old.id and state in ('selected', 'prepared'))
     or exists (select 1 from public.request_asset_allocations
       where asset_id = v_new.id and state in ('selected', 'prepared', 'delivered')) then
    return jsonb_build_object('ok', false, 'error', 'reserved_device_change_invalid');
  end if;
  update public.request_asset_allocations
  set state = 'released', released_at = now(), released_by = v_uid, updated_at = now()
  where request_id = v_request.id and request_item_id = v_item.id
    and asset_id = v_old.id and state in ('selected', 'prepared');
  insert into public.request_asset_allocations
    (request_id, request_item_id, asset_id, state, selected_by, selected_at)
  values (v_request.id, v_item.id, v_new.id, 'selected', v_uid, now())
  on conflict (request_item_id, asset_id) do update
  set state = 'selected', selected_by = v_uid, selected_at = now(),
      prepared_by = null, prepared_at = null, verified_by = null, verified_at = null,
      released_at = null, released_by = null, updated_at = now()
  where request_asset_allocations.request_id = v_request.id
    and request_asset_allocations.state = 'released';
  if not found then
    raise exception 'reserved_device_change_invalid' using errcode = '23514';
  end if;
  update public.assets set status = 'available' where id = v_old.id;
$body$;
begin
  if position('-- Preserve exact allocation history' in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0 then
      raise exception 'request reserved-device change differs from reviewed definition';
    end if;
    execute replace(v_definition, v_anchor, trim(trailing E'\n' from v_replacement));
  end if;
end;
$migration$;

commit;
