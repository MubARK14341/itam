-- Purpose: F-003 — establish one request transition matrix, enforce the
-- clarification/review path, require preparation readiness before delivery,
-- and release reservations when a request is unfulfilled/rejected/cancelled.
-- Security impact: direct state jumps now fail in the existing status trigger;
-- workflow RPCs also validate their own preconditions under row locks.
-- Risk: intentionally restrictive. Drafts must be submitted before approval
-- and delivery must pass through ready_for_pickup.
-- Rollback consideration: restoring the permissive matrix would reopen unsafe
-- transitions and ghost reservations. No historical rows are rewritten.

begin;

create or replace function public.request_transition_allowed(
  p_from text,
  p_to text
) returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select p_from = p_to or exists (
    select 1
    from (values
      ('draft', 'under_review'),
      ('draft', 'cancelled'),

      ('under_review', 'needs_clarification'),
      ('under_review', 'approved'),
      ('under_review', 'rejected'),
      ('under_review', 'cancelled'),

      ('needs_clarification', 'under_review'),
      ('needs_clarification', 'rejected'),
      ('needs_clarification', 'cancelled'),

      ('approved', 'auto_provisioning'),
      ('approved', 'provisioned'),
      ('approved', 'stock_shortage'),
      ('approved', 'preparing'),
      ('approved', 'cancelled'),

      ('auto_provisioning', 'approved'),
      ('auto_provisioning', 'provisioned'),
      ('auto_provisioning', 'stock_shortage'),
      ('auto_provisioning', 'cancelled'),

      ('provisioned', 'auto_provisioning'),
      ('provisioned', 'preparing'),
      ('provisioned', 'stock_shortage'),
      ('provisioned', 'cancelled'),

      ('stock_shortage', 'auto_provisioning'),
      ('stock_shortage', 'provisioned'),
      ('stock_shortage', 'cancelled'),

      ('preparing', 'auto_provisioning'),
      ('preparing', 'provisioned'),
      ('preparing', 'stock_shortage'),
      ('preparing', 'ready_for_pickup'),
      ('preparing', 'cancelled'),

      ('ready_for_pickup', 'delivered'),
      -- Sale and internal custody requests intentionally complete on delivery.
      ('ready_for_pickup', 'completed'),
      ('ready_for_pickup', 'cancelled'),

      ('delivered', 'partially_returned'),
      ('delivered', 'returned'),
      ('delivered', 'completed'),
      ('delivered', 'overdue'),

      ('partially_returned', 'returned'),
      ('partially_returned', 'overdue'),

      ('returned', 'completed'),

      ('overdue', 'partially_returned'),
      ('overdue', 'returned')
    ) as allowed(from_status, to_status)
    where allowed.from_status = p_from
      and allowed.to_status = p_to
  );
$function$;

-- Compatibility boundary for the existing status trigger. The matrix above is
-- the only place where transition pairs are defined.
create or replace function public.request_status_allowed(
  p_old text,
  p_new text
) returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select public.request_transition_allowed(p_old, p_new);
$function$;

revoke all on function public.request_transition_allowed(text, text)
  from public, anon;
revoke all on function public.request_status_allowed(text, text)
  from public, anon;
grant execute on function public.request_transition_allowed(text, text)
  to authenticated;
grant execute on function public.request_status_allowed(text, text)
  to authenticated;

create or replace function public.request_submit(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'draft' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if v_request.request_source <> 'internal'
     or v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  update public.requests
  set status = 'under_review',
      submitted_by = coalesce(submitted_by, auth.uid())
  where id = p_id;
  perform public._request_add_event(
    p_id,
    'submitted',
    'staff',
    null,
    '{}'::jsonb
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.request_approve(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_request public.requests%rowtype;
  v_provision jsonb;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'under_review'
     or v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  update public.requests
  set status = 'approved',
      responsible_employee_id = coalesce(responsible_employee_id, v_uid)
  where id = p_id;
  v_provision := public._request_auto_provision(p_id);
  return json_build_object(
    'ok', true,
    'provision', v_provision
  );
end
$function$;

create or replace function public._request_release_reservations(
  p_id uuid,
  p_reason text
) returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item record;
  v_released integer := 0;
begin
  for v_item in
    select
      ri.id,
      ri.asset_id,
      ri.delivered_quantity,
      a.status,
      a.asset_tag,
      a.name
    from public.request_items ri
    join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
    order by a.id
    for update of ri, a
  loop
    if coalesce(v_item.delivered_quantity, 0) > 0 then
      continue;
    end if;
    if v_item.status = 'reserved' then
      update public.assets
      set status = 'available'
      where id = v_item.asset_id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        v_item.asset_id,
        'status_change',
        'reserved',
        'available',
        auth.uid(),
        p_reason
      );
      v_released := v_released + 1;
    end if;
    update public.request_items
    set item_kind = 'custom',
        asset_id = null,
        consumable_id = null,
        requested_kind = 'existing_asset',
        requested_description = coalesce(
          requested_description,
          v_item.name,
          v_item.asset_tag
        ),
        needs_purchase = false
    where id = v_item.id;
  end loop;
  return v_released;
end
$function$;

revoke all on function public._request_release_reservations(uuid, text)
  from public, anon, authenticated;

create or replace function public.request_reject(
  p_id uuid,
  p_reason text default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request public.requests%rowtype;
  v_released integer;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if not public.request_transition_allowed(v_request.status, 'rejected')
     or v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  v_released := public._request_release_reservations(
    p_id,
    'رفض طلب ' || v_request.request_number
  );
  update public.requests
  set status = 'rejected',
      rejection_reason = nullif(btrim(p_reason), '')
  where id = p_id;
  return json_build_object('ok', true, 'released', v_released);
end
$function$;

create or replace function public.request_cancel(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_released integer;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if not public.request_transition_allowed(v_request.status, 'cancelled') then
    return json_build_object(
      'ok', false, 'error', 'cannot_cancel_after_deliver'
    );
  end if;
  if v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  v_released := public._request_release_reservations(
    p_id,
    'إلغاء طلب ' || v_request.request_number
  );
  update public.requests
  set status = 'cancelled'
  where id = p_id;
  return json_build_object('ok', true, 'released', v_released);
end
$function$;

create or replace function public.request_item_unfulfill(p_item_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.request_items%rowtype;
  v_request public.requests%rowtype;
  v_asset public.assets%rowtype;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
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
  select * into v_request
  from public.requests
  where id = v_item.request_id
  for update;
  if v_request.status not in (
    'under_review',
    'needs_clarification',
    'approved',
    'auto_provisioning',
    'provisioned',
    'stock_shortage',
    'preparing'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if coalesce(v_item.delivered_quantity, 0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered');
  end if;

  if v_item.asset_id is not null then
    select * into v_asset
    from public.assets
    where id = v_item.asset_id
    for update;
    if found and v_asset.status = 'reserved' then
      update public.assets
      set status = 'available'
      where id = v_asset.id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        v_asset.id,
        'status_change',
        'reserved',
        'available',
        auth.uid(),
        'فك ربط من طلب ' || v_request.request_number
      );
    end if;
  end if;

  update public.request_items
  set item_kind = 'custom',
      asset_id = null,
      consumable_id = null,
      requested_kind = case
        when v_item.item_kind = 'consumable' then 'consumable'
        else coalesce(v_item.requested_kind, 'existing_asset')
      end,
      needs_purchase = false
  where id = p_item_id;
  perform public._request_add_event(
    v_item.request_id,
    'item_unfulfilled',
    'staff',
    null,
    jsonb_build_object('item_id', p_item_id)
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.request_start_preparing(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_item record;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in ('approved', 'provisioned') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and (item_kind = 'custom' or needs_purchase)
  ) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;
  if exists (
    select 1
    from public.request_items ri
    join public.consumables c on c.id = ri.consumable_id
    where ri.request_id = p_id
      and ri.item_kind = 'consumable'
    group by ri.consumable_id, c.quantity_on_hand
    having sum(ri.quantity) > c.quantity_on_hand
  ) then
    return json_build_object('ok', false, 'error', 'insufficient_stock');
  end if;

  for v_item in
    select ri.asset_id, a.status
    from public.request_items ri
    join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
    order by a.id
    for update of a
  loop
    if v_item.status not in ('available', 'reserved') then
      return json_build_object(
        'ok', false, 'error', 'asset_not_available'
      );
    end if;
    if v_item.status = 'available' then
      update public.assets
      set status = 'reserved'
      where id = v_item.asset_id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        v_item.asset_id,
        'status_change',
        'available',
        'reserved',
        auth.uid(),
        'حجز لطلب ' || v_request.request_number
      );
    end if;
  end loop;

  update public.requests
  set status = 'preparing'
  where id = p_id;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.request_ready_issue(p_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from public.request_items where request_id = p_id
  ) then
    return 'items_required';
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and (item_kind = 'custom' or needs_purchase)
  ) then
    return 'unfulfilled_items';
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and (
        quantity <= 0
        or quantity <> trunc(quantity)
        or coalesce(delivered_quantity, 0) <> 0
        or coalesce(returned_quantity, 0) <> 0
      )
  ) then
    return 'invalid_quantities';
  end if;
  if exists (
    select asset_id
    from public.request_items
    where request_id = p_id
      and item_kind = 'asset'
    group by asset_id
    having asset_id is null or count(*) > 1
  ) then
    return 'invalid_asset_selection';
  end if;
  if exists (
    select 1
    from public.request_items ri
    left join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
      and (a.id is null or a.status <> 'reserved')
  ) then
    return 'asset_not_reserved';
  end if;
  if exists (
    select 1
    from public.request_items ri
    join public.consumables c on c.id = ri.consumable_id
    where ri.request_id = p_id
      and ri.item_kind = 'consumable'
    group by ri.consumable_id, c.quantity_on_hand
    having sum(ri.quantity) > c.quantity_on_hand
  ) then
    return 'insufficient_stock';
  end if;
  return null;
end
$function$;

revoke all on function public.request_ready_issue(uuid)
  from public, anon, authenticated;

create or replace function public.request_mark_ready(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_issue text;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'preparing' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  perform 1
  from public.assets a
  join public.request_items ri on ri.asset_id = a.id
  where ri.request_id = p_id
  order by a.id
  for update of a;
  perform 1
  from public.consumables c
  join public.request_items ri on ri.consumable_id = c.id
  where ri.request_id = p_id
  order by c.id
  for update of c;

  v_issue := public.request_ready_issue(p_id);
  if v_issue is not null then
    return json_build_object('ok', false, 'error', v_issue);
  end if;
  update public.requests
  set status = 'ready_for_pickup'
  where id = p_id;
  return json_build_object('ok', true);
end
$function$;

-- Legacy request_return used to mark asset lines returned and release the asset
-- before request_inspect_return recorded a condition. The completion guard then
-- correctly rejected the request, but the inspection RPC could no longer see an
-- outstanding rented asset, leaving the workflow stuck. Asset-bearing returns
-- must go through request_inspect_return, which performs return + condition
-- inspection atomically. Consumable-only rentals retain a no-asset return path.
create or replace function public.request_return(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in ('delivered', 'partially_returned', 'overdue') then
    return json_build_object('ok', false, 'error', 'state_not_returnable');
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and item_kind = 'asset'
      and coalesce(delivered_quantity, 0) > coalesce(returned_quantity, 0)
  ) then
    return json_build_object('ok', false, 'error', 'inspection_required');
  end if;

  update public.requests
  set status = 'returned',
      returned_at = now()
  where id = p_id;
  return json_build_object('ok', true);
end
$function$;

do $do$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'request_submit(uuid)',
    'request_approve(uuid)',
    'request_reject(uuid, text)',
    'request_cancel(uuid)',
    'request_item_unfulfill(uuid)',
    'request_start_preparing(uuid)',
    'request_mark_ready(uuid)',
    'request_return(uuid)'
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
