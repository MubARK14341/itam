-- Purpose: F-004 — cap purchase receiving under row locks, derive header
-- receipt status from item state, and reconnect fulfilled procurement items to
-- their source request workflow.
-- Security impact: callers cannot over-receive or forge a received header.
-- Physical procurement remains pending until a real asset is registered and
-- explicitly fulfilled; consumables still use consumable_stock_move.
-- Risk: restrictive only. Existing quantity integrity was checked before this
-- migration was authored (no over-received/fractional/invalid rows).
-- Rollback consideration: removing the constraints or derived-status logic
-- would reopen quantity inflation and false completion.

begin;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pr_items_receipt_bounds'
      and conrelid = 'public.purchase_request_items'::regclass
  ) then
    alter table public.purchase_request_items
      add constraint pr_items_receipt_bounds
      check (
        requested_quantity > 0
        and requested_quantity <= 1000000
        and requested_quantity = trunc(requested_quantity)
        and received_quantity >= 0
        and received_quantity <= requested_quantity
        and received_quantity = trunc(received_quantity)
      );
  end if;
end
$do$;

create or replace function public.purchase_request_set_status(
  p_id uuid,
  p_to text
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_current text;
  v_requested_by uuid;
  v_allowed boolean := false;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician'
  ) then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;

  select status, requested_by
  into v_current, v_requested_by
  from public.purchase_requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_to = 'submitted' and v_current = 'draft' then
    if not exists (
      select 1
      from public.purchase_request_items
      where purchase_request_id = p_id
    ) then
      return json_build_object('ok', false, 'error', 'items_required');
    end if;
    v_allowed := true;
    update public.purchase_requests
    set status = 'submitted',
        submitted_at = now()
    where id = p_id;
  elsif p_to = 'approved'
        and v_current = 'submitted'
        and v_role in ('admin', 'it_manager') then
    v_allowed := true;
    update public.purchase_requests
    set status = 'approved',
        approved_by = auth.uid(),
        approved_at = now()
    where id = p_id;
  elsif p_to = 'ordered' and v_current = 'approved' then
    v_allowed := true;
    update public.purchase_requests
    set status = 'ordered'
    where id = p_id;
  elsif p_to in ('partially_received', 'received') then
    -- Receipt states are derived exclusively by item receiving.
    return json_build_object(
      'ok', false, 'error', 'receipt_status_is_derived'
    );
  elsif p_to = 'cancelled'
        and v_current in ('draft', 'submitted', 'approved', 'ordered') then
    if v_role in ('admin', 'it_manager')
       or (v_current = 'draft' and v_requested_by = auth.uid()) then
      v_allowed := true;
      update public.purchase_requests
      set status = 'cancelled',
          cancelled_by = auth.uid(),
          cancelled_at = now()
      where id = p_id;
    end if;
  end if;

  if not v_allowed then
    return json_build_object('ok', false, 'error', 'bad_transition');
  end if;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.purchase_request_item_receive(
  p_item_id uuid,
  p_qty numeric
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.purchase_request_items%rowtype;
  v_header public.purchase_requests%rowtype;
  v_remaining numeric;
  v_new_received numeric;
  v_all_received boolean;
  v_source_request_id uuid;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician'
  ) then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_qty is null
     or p_qty <= 0
     or p_qty > 1000000
     or p_qty <> trunc(p_qty) then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;

  select * into v_item
  from public.purchase_request_items
  where id = p_item_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_header
  from public.purchase_requests
  where id = v_item.purchase_request_id
  for update;
  if v_header.status not in ('ordered', 'partially_received') then
    return json_build_object('ok', false, 'error', 'bad_status');
  end if;

  v_remaining := v_item.requested_quantity - v_item.received_quantity;
  if v_remaining <= 0 then
    return json_build_object('ok', false, 'error', 'already_received');
  end if;
  if p_qty > v_remaining then
    return json_build_object(
      'ok', false, 'error', 'quantity_exceeds_remaining',
      'remaining', v_remaining
    );
  end if;

  v_new_received := v_item.received_quantity + p_qty;
  update public.purchase_request_items
  set received_quantity = v_new_received,
      updated_at = now()
  where id = p_item_id;

  select bool_and(received_quantity = requested_quantity)
  into v_all_received
  from public.purchase_request_items
  where purchase_request_id = v_item.purchase_request_id;

  update public.purchase_requests
  set status = case
    when coalesce(v_all_received, false) then 'received'
    else 'partially_received'
  end
  where id = v_item.purchase_request_id;

  if v_item.source_request_item_id is not null
     and v_new_received = v_item.requested_quantity then
    select request_id into v_source_request_id
    from public.request_items
    where id = v_item.source_request_item_id;
    if v_source_request_id is not null then
      perform public._request_add_event(
        v_source_request_id,
        'purchase_received_awaiting_fulfillment',
        'staff',
        null,
        jsonb_build_object(
          'request_item_id', v_item.source_request_item_id,
          'purchase_request_id', v_item.purchase_request_id,
          'purchase_request_item_id', v_item.id
        )
      );
    end if;
  end if;

  return json_build_object(
    'ok', true,
    'received_quantity', v_new_received,
    'remaining', v_remaining - p_qty,
    'header_status', case
      when coalesce(v_all_received, false) then 'received'
      else 'partially_received'
    end
  );
end
$function$;

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
    if v_asset.status not in ('available', 'reserved') then
      return json_build_object(
        'ok', false, 'error', 'asset_not_available'
      );
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
    ) then
      return json_build_object('ok', false, 'error', 'asset_already_reserved');
    end if;

    if v_asset.status = 'available' then
      update public.assets
      set status = 'reserved'
      where id = p_asset_id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        p_asset_id,
        'status_change',
        'available',
        'reserved',
        auth.uid(),
        'تلبية شراء للطلب ' || v_request.request_number
      );
    end if;

    update public.request_items
    set item_kind = 'asset',
        asset_id = p_asset_id,
        consumable_id = null,
        needs_purchase = false
    where id = p_item_id;
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
      'kind', case
        when p_asset_id is not null then 'asset'
        else 'consumable'
      end,
      'procurement_resolved', v_item.needs_purchase,
      'request_status', case
        when v_request.status = 'stock_shortage' and v_all_fulfilled
          then 'provisioned'
        else v_request.status
      end
    )
  );
  return json_build_object(
    'ok', true,
    'request_status', case
      when v_request.status = 'stock_shortage' and v_all_fulfilled
        then 'provisioned'
      else v_request.status
    end
  );
end
$function$;

create or replace function public.request_item_convert_to_pr(
  p_item_id uuid,
  p_pr_id uuid default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.request_items%rowtype;
  v_request public.requests%rowtype;
  v_pr_id uuid;
  v_pr_number text;
  v_pr_status text;
  v_description text;
  v_company text;
  v_notes text;
  v_parts text[] := array[]::text[];
begin
  if not (
    public.current_user_has_capability('request.approve')
    or v_role in ('admin', 'it_manager')
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
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
    return json_build_object('ok', false, 'error', 'not_custom');
  end if;
  if v_item.quantity <= 0
     or v_item.quantity > 1000000
     or v_item.quantity <> trunc(v_item.quantity) then
    return json_build_object('ok', false, 'error', 'invalid_quantity');
  end if;
  if exists (
    select 1
    from public.purchase_request_items
    where source_request_item_id = p_item_id
  ) then
    return json_build_object('ok', false, 'error', 'already_converted');
  end if;

  select * into v_request
  from public.requests
  where id = v_item.request_id
  for update;
  if v_request.status not in (
    'under_review',
    'needs_clarification',
    'approved',
    'provisioned',
    'stock_shortage',
    'preparing'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  if p_pr_id is null then
    insert into public.purchase_requests (supplier_id, notes)
    values (
      null,
      'طلب شراء مرتبط بالطلب ' || v_request.request_number
    )
    returning id, request_number into v_pr_id, v_pr_number;
  else
    select id, request_number, status
    into v_pr_id, v_pr_number, v_pr_status
    from public.purchase_requests
    where id = p_pr_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'pr_not_found');
    end if;
    if v_pr_status <> 'draft' then
      return json_build_object('ok', false, 'error', 'pr_not_draft');
    end if;
  end if;

  v_description := coalesce(
    nullif(btrim(v_item.requested_description), ''),
    nullif(btrim(v_item.requested_category), ''),
    'عنصر مطلوب'
  );
  if nullif(btrim(v_item.preferred_model), '') is not null then
    v_parts := v_parts || (
      'الموديل: ' || btrim(v_item.preferred_model)
    );
  end if;
  if v_item.preferred_company_id is not null then
    select name into v_company
    from public.companies
    where id = v_item.preferred_company_id;
    if v_company is not null then
      v_parts := v_parts || ('الشركة المفضلة: ' || v_company);
    end if;
  end if;
  v_parts := v_parts || ('من الطلب ' || v_request.request_number);
  v_notes := array_to_string(v_parts, ' · ');

  insert into public.purchase_request_items (
    purchase_request_id,
    consumable_id,
    description,
    requested_quantity,
    notes,
    source_request_item_id
  ) values (
    v_pr_id,
    null,
    v_description,
    v_item.quantity,
    v_notes,
    p_item_id
  );

  update public.request_items
  set needs_purchase = true
  where id = p_item_id;
  if v_request.status in ('approved', 'provisioned', 'preparing') then
    update public.requests
    set status = 'stock_shortage'
    where id = v_item.request_id;
  end if;

  perform public._request_add_event(
    v_item.request_id,
    'purchase_requested',
    'staff',
    null,
    jsonb_build_object(
      'item_id', p_item_id,
      'pr_id', v_pr_id,
      'pr_number', v_pr_number
    )
  );
  return json_build_object(
    'ok', true,
    'pr_id', v_pr_id,
    'pr_number', v_pr_number
  );
end
$function$;

do $do$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'purchase_request_set_status(uuid, text)',
    'purchase_request_item_receive(uuid, numeric)',
    'request_item_fulfill(uuid, uuid, uuid)',
    'request_item_convert_to_pr(uuid, uuid)'
  ] loop
    execute format(
      'revoke all on function public.%s from public, anon;',
      v_signature
    );
    execute format(
      'grant execute on function public.%s to authenticated;',
      v_signature
    );
  end loop;
end
$do$;

commit;
