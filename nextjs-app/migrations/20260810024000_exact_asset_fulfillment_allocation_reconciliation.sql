-- Purpose: Keep legacy custom-item asset fulfillment aligned with the exact
-- allocation workflow by recording the canonical allocation atomically.
-- Risk: additive allocation evidence only for already-reserved, single-asset
-- active request items; RLS, role checks, financial grants, and custody rules
-- are unchanged. Rollback: retain immutable evidence; restore the prior
-- function only if the exact-allocation workflow itself is rolled back.

begin;

-- A prior fulfillment path could convert a custom item into an asset and
-- reserve the physical asset without creating its required exact-allocation
-- record. Reconcile only deterministic, active one-to-one cases. Do not infer
-- allocations for multi-quantity items, completed history, or non-reserved
-- assets.
insert into public.request_asset_allocations (
  request_id, request_item_id, asset_id, state, selected_by, selected_at
)
select
  ri.request_id,
  ri.id,
  ri.asset_id,
  'selected',
  coalesce(r.prepared_by, r.created_by),
  coalesce(r.prepared_at, ri.created_at)
from public.request_items ri
join public.requests r on r.id = ri.request_id
join public.assets a on a.id = ri.asset_id
where ri.item_kind = 'asset'
  and ri.asset_id is not null
  and ri.quantity = 1
  and r.status in ('approved', 'provisioned', 'preparing')
  and a.status = 'reserved'
  and coalesce(r.prepared_by, r.created_by) is not null
  and not exists (
    select 1
    from public.request_asset_allocations allocation
    where allocation.request_item_id = ri.id
  )
  and not exists (
    select 1
    from public.request_asset_allocations allocation
    where allocation.asset_id = ri.asset_id
      and allocation.state in ('selected', 'prepared', 'delivered')
  );

create or replace function public.request_item_fulfill(
  p_item_id uuid,
  p_asset_id uuid default null,
  p_consumable_id uuid default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.request_items%rowtype;
  v_request public.requests%rowtype;
  v_asset public.assets%rowtype;
  v_consumable public.consumables%rowtype;
  v_source_pr public.purchase_request_items%rowtype;
  v_all_fulfilled boolean;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if (p_asset_id is null) = (p_consumable_id is null) then
    return json_build_object('ok', false, 'error', 'exactly_one_ref');
  end if;

  select * into v_item
  from public.request_items
  where id = p_item_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_item.item_kind <> 'custom'
     or coalesce(v_item.delivered_quantity, 0) > 0 then
    return json_build_object('ok', false, 'error', 'invalid_item_state');
  end if;

  select * into v_request
  from public.requests
  where id = v_item.request_id
  for update;
  if v_request.status not in (
    'approved', 'provisioned', 'stock_shortage', 'preparing'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  if v_item.needs_purchase then
    select * into v_source_pr
    from public.purchase_request_items
    where source_request_item_id = p_item_id
    for update;
    if not found
       or v_source_pr.received_quantity <> v_source_pr.requested_quantity then
      return json_build_object(
        'ok', false, 'error', 'purchase_not_received'
      );
    end if;
  end if;

  if p_asset_id is not null then
    select * into v_asset
    from public.assets
    where id = p_asset_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'asset_not_found');
    end if;
    if not v_asset.is_active
       or v_asset.archived_at is not null
       or v_asset.status not in ('available', 'reserved')
       or v_asset.assigned_to_employee_id is not null
       or exists (
         select 1 from public.asset_assignments assignment
         where assignment.asset_id = p_asset_id and assignment.status = 'active'
       ) then
      return json_build_object('ok', false, 'error', 'asset_not_available');
    end if;
    if exists (
      select 1
      from public.request_items other_item
      join public.requests other_request
        on other_request.id = other_item.request_id
      where other_item.asset_id = p_asset_id
        and other_item.id <> p_item_id
        and other_request.status not in (
          'rejected', 'cancelled', 'completed', 'returned'
        )
    ) or exists (
      select 1
      from public.request_asset_allocations allocation
      where allocation.asset_id = p_asset_id
        and allocation.state in ('selected', 'prepared', 'delivered')
    ) then
      return json_build_object('ok', false, 'error', 'asset_already_reserved');
    end if;

    if v_asset.status = 'available' then
      update public.assets
      set status = 'reserved'
      where id = p_asset_id;
      insert into public.asset_movements (
        asset_id, movement_type, from_status, to_status, performed_by, note
      ) values (
        p_asset_id, 'status_change', 'available', 'reserved', auth.uid(),
        'Fulfillment reservation for request ' || v_request.request_number
      );
    end if;

    update public.request_items
    set item_kind = 'asset',
        asset_id = p_asset_id,
        consumable_id = null,
        needs_purchase = false
    where id = p_item_id;

    insert into public.request_asset_allocations (
      request_id, request_item_id, asset_id, state, selected_by
    ) values (
      v_request.id, p_item_id, p_asset_id, 'selected', auth.uid()
    );
  else
    select * into v_consumable
    from public.consumables
    where id = p_consumable_id
      and is_active
    for update;
    if not found then
      return json_build_object(
        'ok', false, 'error', 'consumable_not_found'
      );
    end if;
    if v_consumable.quantity_on_hand < v_item.quantity then
      return json_build_object(
        'ok', false, 'error', 'insufficient_stock'
      );
    end if;
    update public.request_items
    set item_kind = 'consumable',
        consumable_id = p_consumable_id,
        asset_id = null,
        needs_purchase = false
    where id = p_item_id;
  end if;

  select not exists (
    select 1
    from public.request_items
    where request_id = v_item.request_id
      and (item_kind = 'custom' or needs_purchase)
  ) into v_all_fulfilled;

  if v_request.status = 'stock_shortage' and v_all_fulfilled then
    update public.requests
    set status = 'provisioned'
    where id = v_item.request_id;
  end if;

  perform public._request_add_event(
    v_item.request_id,
    'item_fulfilled',
    'staff',
    null,
    jsonb_build_object(
      'item_id', p_item_id,
      'kind', case when p_asset_id is not null then 'asset' else 'consumable' end,
      'procurement_resolved', v_item.needs_purchase,
      'request_status', case
        when v_request.status = 'stock_shortage' and v_all_fulfilled then 'provisioned'
        else v_request.status
      end
    )
  );
  return json_build_object(
    'ok', true,
    'request_status', case
      when v_request.status = 'stock_shortage' and v_all_fulfilled then 'provisioned'
      else v_request.status
    end
  );
end
$function$;

revoke all on function public.request_item_fulfill(uuid, uuid, uuid) from public, anon;
grant execute on function public.request_item_fulfill(uuid, uuid, uuid) to authenticated;

commit;
