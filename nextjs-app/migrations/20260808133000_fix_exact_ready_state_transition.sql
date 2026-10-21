-- Purpose: preserve the legal approved -> preparing -> ready_for_pickup
-- transition required by the exact-allocation readiness workflow.
-- Security impact: retains the existing SECURITY DEFINER role, exact-selection,
-- and idempotent-dispatch guards; no grants, RLS policies, or data are broadened.

begin;

create or replace function public.request_confirm_ready(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to public
as $function$
declare
  v_role text := public.app_user_role();
  v_req public.requests%rowtype;
  v_bad boolean;
begin
  if v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select * into v_req from public.requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('approved', 'provisioned', 'preparing') then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if exists (
    select 1 from public.request_items ri
    where ri.request_id = p_id
      and ri.item_kind = 'custom'
      and ri.requested_kind <> 'existing_asset'
      and not coalesce(ri.needs_purchase, false)
  ) then
    return jsonb_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;

  select exists(
    select 1 from public.request_items ri
    where ri.request_id = p_id
      and (ri.item_kind = 'asset' or (ri.item_kind = 'custom' and ri.requested_kind = 'existing_asset'))
      and (select count(*) from public.request_asset_allocations a
           where a.request_item_id = ri.id and a.state in ('selected', 'prepared')) <> ri.quantity
  ) into v_bad;
  if v_bad then return jsonb_build_object('ok', false, 'error', 'exact_assets_required'); end if;

  update public.request_asset_allocations
  set state = 'prepared', prepared_by = auth.uid(), prepared_at = now(), updated_at = now()
  where request_id = p_id and state = 'selected';

  -- The authoritative state machine disallows approved -> ready_for_pickup.
  -- Keep this intermediate transition explicit, including provisioned requests.
  if v_req.status <> 'preparing' then
    update public.requests set status = 'preparing' where id = p_id;
  end if;
  update public.requests
  set status = 'ready_for_pickup',
      prepared_by = coalesce(prepared_by, auth.uid()),
      prepared_at = coalesce(prepared_at, now())
  where id = p_id;

  perform public._request_add_event(p_id, 'devices_ready_confirmed', 'staff', null, jsonb_build_object('exact_assets', true));
  return jsonb_build_object('ok', true, 'status', 'ready_for_pickup');
end
$function$;

revoke all on function public.request_confirm_ready(uuid) from public, anon;
grant execute on function public.request_confirm_ready(uuid) to authenticated;

commit;
