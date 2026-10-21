-- Purpose: F-001 — make staff request creation a single server-controlled
-- transaction and remove direct Data API mutations on requests/request_items.
-- Security impact: actor/source/status and all workflow/financial stamps are
-- server authoritative. Only approved operational staff can call the RPC.
-- Risk: callers that still INSERT directly will receive permission denied and
-- must use request_create_staff. Portal SECURITY DEFINER entrypoints are
-- intentionally unchanged.
-- Rollback consideration: restore the previous grants/policies only together
-- with removal of request_create_staff; doing so reopens the forged-field and
-- partial-header vulnerabilities and is not recommended.

begin;

create or replace function public.request_create_staff(
  p_status text,
  p_customer_id uuid,
  p_customer_name text,
  p_contact_phone text,
  p_project_name text,
  p_project_city text,
  p_request_type text,
  p_pickup_date date,
  p_return_date date,
  p_notes text,
  p_internal_notes text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public.app_user_role();
  v_status text := nullif(btrim(p_status), '');
  v_customer public.customers%rowtype;
  v_customer_name text;
  v_contact_phone text;
  v_item jsonb;
  v_item_kind text;
  v_requested_kind text;
  v_quantity numeric;
  v_consumable_id uuid;
  v_preferred_company_id uuid;
  v_available numeric;
  v_request_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_status not in ('draft', 'under_review') then
    return jsonb_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if p_request_type is null
     or p_request_type not in ('rental', 'sale', 'service', 'mixed') then
    return jsonb_build_object('ok', false, 'error', 'invalid_request_type');
  end if;
  if p_pickup_date is not null
     and p_return_date is not null
     and p_return_date < p_pickup_date then
    return jsonb_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_items) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_items');
  end if;

  if p_customer_id is not null then
    select * into v_customer
    from public.customers
    where id = p_customer_id and is_active;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'customer_not_found');
    end if;
    v_customer_name := nullif(btrim(v_customer.name), '');
    v_contact_phone := nullif(btrim(v_customer.phone), '');
  else
    v_customer_name := nullif(btrim(p_customer_name), '');
    v_contact_phone := nullif(btrim(p_contact_phone), '');
    if v_customer_name is null then
      return jsonb_build_object('ok', false, 'error', 'customer_required');
    end if;
  end if;

  -- Validate the complete payload before inserting the header. This keeps
  -- validation failures atomic without relying on compensating deletes.
  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('ok', false, 'error', 'invalid_item');
    end if;
    if v_item ?| array[
      'unit_price', 'total_price', 'approved_quantity',
      'delivered_quantity', 'returned_quantity', 'needs_purchase',
      'asset_id'
    ] then
      return jsonb_build_object('ok', false, 'error', 'server_fields_forbidden');
    end if;
    if jsonb_typeof(v_item->'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity <= 0
       or v_quantity > 1000000
       or v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_item_kind := nullif(btrim(v_item->>'item_kind'), '');
    if v_item_kind not in ('custom', 'consumable') then
      -- Physical assets are selected internally during fulfillment, never by
      -- the requester through a serial/asset identifier.
      return jsonb_build_object('ok', false, 'error', 'invalid_item_kind');
    end if;

    if v_item_kind = 'consumable' then
      begin
        v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end;
      if v_consumable_id is null then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      select quantity_on_hand into v_available
      from public.consumables
      where id = v_consumable_id and is_active;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      if v_quantity > v_available then
        return jsonb_build_object('ok', false, 'error', 'insufficient_stock');
      end if;
    else
      if nullif(btrim(v_item->>'requested_description'), '') is null then
        return jsonb_build_object('ok', false, 'error', 'description_required');
      end if;
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      if v_requested_kind not in ('existing_asset', 'custom') then
        return jsonb_build_object('ok', false, 'error', 'invalid_requested_kind');
      end if;
      begin
        v_preferred_company_id :=
          nullif(v_item->>'preferred_company_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end;
      if v_preferred_company_id is not null
         and not exists (
           select 1 from public.companies
           where id = v_preferred_company_id and is_active
         ) then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end if;
    end if;
  end loop;

  insert into public.requests (
    status,
    customer_id,
    customer_name_snapshot,
    contact_phone_snapshot,
    project_name,
    project_city,
    request_type,
    beneficiary_type,
    beneficiary_employee_id,
    pickup_date,
    return_date,
    notes,
    internal_notes,
    submitted_by,
    created_by,
    request_source,
    portal_approval_status
  ) values (
    v_status,
    p_customer_id,
    v_customer_name,
    v_contact_phone,
    nullif(btrim(p_project_name), ''),
    nullif(btrim(p_project_city), ''),
    p_request_type,
    'customer',
    null,
    p_pickup_date,
    p_return_date,
    nullif(btrim(p_notes), ''),
    nullif(btrim(p_internal_notes), ''),
    v_uid,
    v_uid,
    'internal',
    'not_required'
  ) returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    v_item_kind := v_item->>'item_kind';
    v_quantity := (v_item->>'quantity')::numeric;

    if v_item_kind = 'consumable' then
      v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        consumable_id,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        preferred_company_id,
        preferred_model,
        accept_alternative,
        needs_purchase
      ) values (
        v_request_id,
        'consumable',
        v_consumable_id,
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        'consumable',
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        null,
        null,
        coalesce((v_item->>'accept_alternative')::boolean, true),
        false
      );
    else
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      v_preferred_company_id :=
        nullif(v_item->>'preferred_company_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        preferred_company_id,
        preferred_model,
        accept_alternative,
        needs_purchase
      ) values (
        v_request_id,
        'custom',
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        v_requested_kind,
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        v_preferred_company_id,
        nullif(btrim(v_item->>'preferred_model'), ''),
        coalesce((v_item->>'accept_alternative')::boolean, true),
        false
      );
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'id', v_request_id);
end
$function$;

-- Keep the employee self-service path, but apply the same creator role and
-- payload invariants. The beneficiary remains derived exclusively from
-- auth.uid(); callers cannot nominate another employee.
create or replace function public.request_create_employee_self(
  p_status text,
  p_project_name text,
  p_pickup_date date,
  p_return_date date,
  p_notes text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public.app_user_role();
  v_employee_id uuid;
  v_email text;
  v_name text;
  v_request_id uuid;
  v_item jsonb;
  v_item_kind text;
  v_requested_kind text;
  v_quantity numeric;
  v_consumable_id uuid;
  v_preferred_company_id uuid;
  v_available numeric;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_status is null or btrim(p_status) not in ('draft', 'under_review') then
    return jsonb_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if p_pickup_date is not null
     and p_return_date is not null
     and p_return_date < p_pickup_date then
    return jsonb_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_items) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_items');
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('ok', false, 'error', 'invalid_item');
    end if;
    if v_item ?| array[
      'unit_price', 'total_price', 'approved_quantity',
      'delivered_quantity', 'returned_quantity', 'needs_purchase',
      'asset_id', 'beneficiary_employee_id'
    ] then
      return jsonb_build_object('ok', false, 'error', 'server_fields_forbidden');
    end if;
    if jsonb_typeof(v_item->'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity <= 0
       or v_quantity > 1000000
       or v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_item_kind := nullif(btrim(v_item->>'item_kind'), '');
    if v_item_kind not in ('custom', 'consumable') then
      return jsonb_build_object('ok', false, 'error', 'invalid_item_kind');
    end if;

    if v_item_kind = 'consumable' then
      begin
        v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end;
      if v_consumable_id is null then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      select quantity_on_hand into v_available
      from public.consumables
      where id = v_consumable_id and is_active;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      if v_quantity > v_available then
        return jsonb_build_object('ok', false, 'error', 'insufficient_stock');
      end if;
    else
      if nullif(btrim(v_item->>'requested_description'), '') is null then
        return jsonb_build_object('ok', false, 'error', 'description_required');
      end if;
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      if v_requested_kind not in ('existing_asset', 'custom') then
        return jsonb_build_object('ok', false, 'error', 'invalid_requested_kind');
      end if;
      begin
        v_preferred_company_id :=
          nullif(v_item->>'preferred_company_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end;
      if v_preferred_company_id is not null
         and not exists (
           select 1 from public.companies
           where id = v_preferred_company_id and is_active
         ) then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end if;
    end if;
  end loop;

  select employee_id, email, full_name
  into v_employee_id, v_email, v_name
  from public.app_users
  where id = v_uid;

  if v_employee_id is null then
    if v_email is not null then
      select id into v_employee_id
      from public.employees
      where lower(email) = lower(v_email) and is_active
      order by created_at
      limit 1;
    end if;
    if v_employee_id is null then
      insert into public.employees (full_name, email)
      values (
        coalesce(
          nullif(btrim(v_name), ''),
          nullif(split_part(coalesce(v_email, ''), '@', 1), ''),
          'موظف'
        ),
        v_email
      )
      returning id into v_employee_id;
    end if;
    update public.app_users
    set employee_id = v_employee_id
    where id = v_uid;
  end if;

  insert into public.requests (
    status,
    request_type,
    beneficiary_type,
    beneficiary_employee_id,
    customer_id,
    submitted_by,
    created_by,
    request_source,
    project_name,
    pickup_date,
    return_date,
    notes,
    portal_approval_status
  ) values (
    btrim(p_status),
    'internal',
    'employee',
    v_employee_id,
    null,
    v_uid,
    v_uid,
    'internal',
    nullif(btrim(p_project_name), ''),
    p_pickup_date,
    p_return_date,
    nullif(btrim(p_notes), ''),
    'not_required'
  ) returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    v_item_kind := v_item->>'item_kind';
    v_quantity := (v_item->>'quantity')::numeric;
    if v_item_kind = 'consumable' then
      v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        consumable_id,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        needs_purchase
      ) values (
        v_request_id,
        'consumable',
        v_consumable_id,
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        'consumable',
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        false
      );
    else
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      v_preferred_company_id :=
        nullif(v_item->>'preferred_company_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        preferred_company_id,
        preferred_model,
        needs_purchase
      ) values (
        v_request_id,
        'custom',
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        v_requested_kind,
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        v_preferred_company_id,
        nullif(btrim(v_item->>'preferred_model'), ''),
        false
      );
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'id', v_request_id);
end
$function$;

revoke all on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) from public, anon;
grant execute on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) to authenticated;

revoke all on function public.request_create_staff(
  text, uuid, text, text, text, text, text, date, date, text, text, jsonb
) from public, anon;
grant execute on function public.request_create_staff(
  text, uuid, text, text, text, text, text, date, date, text, text, jsonb
) to authenticated;

-- RLS is retained as defense in depth, but the Data API no longer has a direct
-- mutation privilege. SECURITY DEFINER workflow entrypoints remain functional.
revoke insert, update, delete, truncate, references, trigger
  on public.requests from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.request_items from authenticated;

-- HIGH-1 column grants intentionally omit financial unit_price/total_price.
-- Re-expose every request-item field required by the operational workflow.
grant select (
  requested_kind,
  requested_description,
  requested_category,
  preferred_company_id,
  preferred_model,
  accept_alternative,
  needs_purchase
) on public.request_items to authenticated;

drop policy if exists ins_ops on public.requests;
drop policy if exists upd_ops on public.requests;
drop policy if exists del_admin on public.requests;
drop policy if exists ins_ops on public.request_items;
drop policy if exists upd_ops on public.request_items;
drop policy if exists del_ops on public.request_items;

commit;
