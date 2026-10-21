-- Purpose: close the remaining request_complete bypass after request_return.
-- The previous guard only compared delivered/returned quantities; request_return
-- can advance returned_quantity without recording a condition inspection.
-- This guard requires request_inspect_return evidence on every delivered asset.
-- Consumable-only and sale requests are unaffected.
-- Risk: restrictive only; no schema/data migration and no role expansion.
-- Rollback: restore request_complete from
-- 20260709150000_request_complete_require_return_inspection.sql.

create or replace function public.request_complete(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered','partially_returned','returned') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;

  if v_req.request_type <> 'sale' and exists (
    select 1
    from public.request_items ri
    join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
      and coalesce(ri.delivered_quantity, 0) > 0
      and not (
        a.last_request_id = p_id
        and a.last_return_at is not null
        and a.last_return_condition in ('sound','unsound','missing','needs_maintenance')
      )
  ) then
    return json_build_object('ok', false, 'error', 'inspection_required');
  end if;

  for r in select ri.id, ri.asset_id, ri.delivered_quantity, a.status
           from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'rented' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'rented', 'available', v_uid, 'إكمال طلب '||v_req.request_number);
    update public.request_items set returned_quantity = delivered_quantity where id = r.id;
  end loop;
  update public.requests set status = 'completed' where id = p_id;
  return json_build_object('ok', true);
end $function$;

revoke all on function public.request_complete(uuid) from public;
grant execute on function public.request_complete(uuid) to authenticated;
