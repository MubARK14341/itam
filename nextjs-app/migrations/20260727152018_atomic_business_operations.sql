-- F-005: move each browser-orchestrated business transaction into one database
-- transaction.  Storage remains intentionally outside Postgres and is handled
-- with compensating cleanup in the application.

begin;

-- A purchase request is an operational workflow of its own.  Making the
-- capability explicit removes the former accidental dependency on table RLS.
insert into public.permissions (key, grp, description)
values ('purchase.manage', 'purchasing', 'إدارة طلبات الشراء')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'purchase.manage'
where r.key in ('admin', 'it_manager', 'technician')
on conflict do nothing;

create or replace function public.asset_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_id uuid;
  v_status public.asset_status;
  v_employee uuid;
  v_cost numeric;
begin
  if not public.current_user_has_capability('asset.create') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  begin
    v_status := coalesce(nullif(p_input->>'status', ''), 'available')::public.asset_status;
  exception when invalid_text_representation then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end;
  if v_status not in ('available', 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if nullif(btrim(p_input->>'category_id'), '') is null
     or nullif(btrim(p_input->>'location_id'), '') is null
     or nullif(btrim(p_input->>'company_id'), '') is null
     or nullif(btrim(p_input->>'serial_number'), '') is null then
    return json_build_object('ok', false, 'error', 'required_asset_fields');
  end if;

  begin
    v_employee := nullif(p_input->>'assigned_to_employee_id', '')::uuid;
    v_cost := nullif(p_input->>'purchase_cost', '')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_numeric_or_id');
  end;
  if v_status = 'assigned' and v_employee is null then
    return json_build_object('ok', false, 'error', 'assigned_employee_required');
  end if;
  if v_cost is not null and (not public.is_financial_viewer() or v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_financial_value');
  end if;
  if coalesce(p_input->'special_attributes', '{}'::jsonb) is not null
     and jsonb_typeof(coalesce(p_input->'special_attributes', '{}'::jsonb)) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_special_attributes');
  end if;

  insert into public.assets (
    category_id, model_id, serial_number, name, status, location_id,
    department_id, assigned_to_employee_id, purchase_date, purchase_cost,
    warranty_end, supplier_id, company_id, pool_id, rfid_tag, notes,
    special_attributes, created_by
  ) values (
    (p_input->>'category_id')::uuid,
    nullif(p_input->>'model_id', '')::uuid,
    btrim(p_input->>'serial_number'),
    nullif(btrim(p_input->>'name'), ''),
    v_status,
    (p_input->>'location_id')::uuid,
    nullif(p_input->>'department_id', '')::uuid,
    case when v_status = 'assigned' then v_employee else null end,
    nullif(p_input->>'purchase_date', '')::date,
    v_cost,
    nullif(p_input->>'warranty_end', '')::date,
    nullif(p_input->>'supplier_id', '')::uuid,
    (p_input->>'company_id')::uuid,
    nullif(p_input->>'pool_id', '')::uuid,
    nullif(btrim(p_input->>'rfid_tag'), ''),
    nullif(btrim(p_input->>'notes'), ''),
    coalesce(p_input->'special_attributes', '{}'::jsonb),
    auth.uid()
  )
  returning id into v_id;

  insert into public.asset_movements (
    asset_id, movement_type, to_status, to_location_id, to_employee_id,
    performed_by, note
  ) values (
    v_id, 'create', v_status, (p_input->>'location_id')::uuid,
    case when v_status = 'assigned' then v_employee else null end,
    auth.uid(), 'إنشاء أصل'
  );

  if v_status = 'assigned' then
    insert into public.asset_assignments (
      asset_id, employee_id, assigned_by, status
    ) values (v_id, v_employee, auth.uid(), 'active');
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$func$;

create or replace function public.asset_move_atomic(
  p_asset_id uuid,
  p_to_location_id uuid,
  p_to_department_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_from_location uuid;
begin
  if not public.current_user_has_capability('asset.update') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_to_location_id is null
     or not exists (select 1 from public.locations where id = p_to_location_id) then
    return json_build_object('ok', false, 'error', 'invalid_location');
  end if;

  select location_id into v_from_location
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  update public.assets
  set location_id = p_to_location_id,
      department_id = coalesce(p_to_department_id, department_id)
  where id = p_asset_id;

  insert into public.asset_movements (
    asset_id, movement_type, from_location_id, to_location_id, performed_by, note
  ) values (
    p_asset_id, 'transfer', v_from_location, p_to_location_id, auth.uid(), 'نقل موقع'
  );
  return json_build_object('ok', true);
end
$func$;

create or replace function public.asset_update_atomic(p_asset_id uuid, p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_old public.assets%rowtype;
  v_status public.asset_status;
  v_cost numeric;
begin
  if not public.current_user_has_capability('asset.update') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  select * into v_old from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  begin
    v_status := coalesce(nullif(p_input->>'status', ''), v_old.status::text)::public.asset_status;
    v_cost := case when p_input ? 'purchase_cost'
      then nullif(p_input->>'purchase_cost', '')::numeric
      else v_old.purchase_cost end;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_numeric_or_status');
  end;
  if p_input ? 'purchase_cost' and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_financial_value');
  end if;
  if not public.asset_status_allowed(v_old.status, v_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  if nullif(btrim(p_input->>'category_id'), '') is null
     or nullif(btrim(p_input->>'location_id'), '') is null
     or nullif(btrim(p_input->>'company_id'), '') is null then
    return json_build_object('ok', false, 'error', 'required_asset_fields');
  end if;

  if v_status in ('available', 'retired', 'disposed', 'lost') then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = p_asset_id and status = 'active';
  end if;

  update public.assets set
    name = nullif(btrim(p_input->>'name'), ''),
    category_id = (p_input->>'category_id')::uuid,
    model_id = nullif(p_input->>'model_id', '')::uuid,
    serial_number = nullif(btrim(p_input->>'serial_number'), ''),
    status = v_status,
    location_id = (p_input->>'location_id')::uuid,
    department_id = nullif(p_input->>'department_id', '')::uuid,
    supplier_id = nullif(p_input->>'supplier_id', '')::uuid,
    company_id = (p_input->>'company_id')::uuid,
    pool_id = nullif(p_input->>'pool_id', '')::uuid,
    rfid_tag = nullif(btrim(p_input->>'rfid_tag'), ''),
    purchase_date = nullif(p_input->>'purchase_date', '')::date,
    purchase_cost = v_cost,
    warranty_end = nullif(p_input->>'warranty_end', '')::date,
    condition_grade = nullif(p_input->>'condition_grade', ''),
    notes = nullif(btrim(p_input->>'notes'), ''),
    special_attributes = coalesce(p_input->'special_attributes', '{}'::jsonb),
    assigned_to_employee_id = case
      when v_status in ('available', 'retired', 'disposed', 'lost') then null
      else assigned_to_employee_id
    end
  where id = p_asset_id;

  if v_status is distinct from v_old.status then
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      p_asset_id, 'status_change', v_old.status, v_status, auth.uid(), 'تعديل بيانات الأصل'
    );
  end if;
  return json_build_object('ok', true);
end
$func$;

create or replace function public.maintenance_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_id uuid;
  v_asset public.assets%rowtype;
  v_stage text;
  v_done boolean;
  v_cost numeric;
begin
  if not public.current_user_has_capability('maintenance.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  v_stage := coalesce(nullif(p_input->>'workflow_stage', ''), 'open');
  if v_stage not in ('open', 'investigating', 'awaiting_parts', 'at_vendor', 'completed', 'unrepairable') then
    return json_build_object('ok', false, 'error', 'invalid_maintenance_stage');
  end if;
  begin
    v_cost := nullif(p_input->>'cost', '')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end;
  if (v_cost is not null or nullif(p_input->>'invoice_number', '') is not null
      or nullif(p_input->>'invoice_date', '') is not null)
     and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end if;

  select * into v_asset
  from public.assets
  where id = (p_input->>'asset_id')::uuid
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  v_done := v_stage in ('completed', 'unrepairable');
  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance'
     and not public.asset_status_allowed(v_asset.status, 'in_maintenance') then
    return json_build_object('ok', false, 'error', 'invalid_asset_transition');
  end if;

  insert into public.maintenance_records (
    asset_id, type, status, workflow_stage, priority, problem_type,
    problem_description, action_taken, cost, invoice_number, invoice_date,
    reported_by, technician_id, reported_by_employee_id, final_summary,
    next_due_date, completed_at, vendor_supplier_id, vendor_name, vendor_phone,
    vendor_location, vendor_map_link, handoff_notes, receiver_name
  ) values (
    v_asset.id,
    coalesce(nullif(p_input->>'type', ''), 'corrective')::public.maintenance_type,
    case when v_done then 'completed'::public.maintenance_status
         when v_stage = 'open' then 'open'::public.maintenance_status
         else 'in_progress'::public.maintenance_status end,
    v_stage, nullif(p_input->>'priority', ''), nullif(p_input->>'problem_type', ''),
    nullif(p_input->>'problem_description', ''), nullif(p_input->>'action_taken', ''),
    coalesce(v_cost, 0), nullif(p_input->>'invoice_number', ''),
    nullif(p_input->>'invoice_date', '')::date, auth.uid(), auth.uid(),
    nullif(p_input->>'reported_by_employee_id', '')::uuid,
    nullif(p_input->>'final_summary', ''), nullif(p_input->>'next_due_date', '')::date,
    case when v_done then now() else null end,
    nullif(p_input->>'vendor_supplier_id', '')::uuid,
    nullif(p_input->>'vendor_name', ''), nullif(p_input->>'vendor_phone', ''),
    nullif(p_input->>'vendor_location', ''), nullif(p_input->>'vendor_map_link', ''),
    nullif(p_input->>'handoff_notes', ''), nullif(p_input->>'receiver_name', '')
  )
  returning id into v_id;

  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance' then
    update public.assets set status = 'in_maintenance' where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', v_asset.status, 'in_maintenance', auth.uid(), 'إدخال صيانة'
    );
  elsif v_done and v_asset.status = 'in_maintenance' then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = v_asset.id and status = 'active';
    update public.assets
    set status = 'available', assigned_to_employee_id = null
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', 'in_maintenance', 'available', auth.uid(), 'انتهاء صيانة'
    );
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$func$;

create or replace function public.maintenance_update_atomic(
  p_id uuid,
  p_input jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_record public.maintenance_records%rowtype;
  v_asset public.assets%rowtype;
  v_stage text;
  v_done boolean;
  v_cost numeric;
begin
  if not public.current_user_has_capability('maintenance.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_record
  from public.maintenance_records
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'maintenance_not_found');
  end if;
  select * into v_asset from public.assets where id = v_record.asset_id for update;

  v_stage := coalesce(nullif(p_input->>'workflow_stage', ''), v_record.workflow_stage, 'open');
  if v_stage not in ('open', 'investigating', 'awaiting_parts', 'at_vendor', 'completed', 'unrepairable') then
    return json_build_object('ok', false, 'error', 'invalid_maintenance_stage');
  end if;
  begin
    v_cost := case when p_input ? 'cost'
      then nullif(p_input->>'cost', '')::numeric else v_record.cost end;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end;
  if (p_input ? 'cost' or p_input ? 'invoice_number' or p_input ? 'invoice_date')
     and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end if;
  v_done := v_stage in ('completed', 'unrepairable');
  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance'
     and not public.asset_status_allowed(v_asset.status, 'in_maintenance') then
    return json_build_object('ok', false, 'error', 'invalid_asset_transition');
  end if;

  update public.maintenance_records set
    type = coalesce(nullif(p_input->>'type', ''), type::text)::public.maintenance_type,
    status = case when v_done then 'completed'::public.maintenance_status
      when v_stage = 'open' then 'open'::public.maintenance_status
      else 'in_progress'::public.maintenance_status end,
    workflow_stage = v_stage,
    priority = nullif(p_input->>'priority', ''),
    problem_type = nullif(p_input->>'problem_type', ''),
    problem_description = nullif(p_input->>'problem_description', ''),
    action_taken = nullif(p_input->>'action_taken', ''),
    cost = v_cost,
    invoice_number = case when p_input ? 'invoice_number'
      then nullif(p_input->>'invoice_number', '') else invoice_number end,
    invoice_date = case when p_input ? 'invoice_date'
      then nullif(p_input->>'invoice_date', '')::date else invoice_date end,
    final_summary = nullif(p_input->>'final_summary', ''),
    next_due_date = nullif(p_input->>'next_due_date', '')::date,
    technician_id = auth.uid(),
    completed_at = case when v_done then coalesce(completed_at, now()) else null end,
    vendor_supplier_id = nullif(p_input->>'vendor_supplier_id', '')::uuid,
    vendor_name = nullif(p_input->>'vendor_name', ''),
    vendor_phone = nullif(p_input->>'vendor_phone', ''),
    vendor_location = nullif(p_input->>'vendor_location', ''),
    vendor_map_link = nullif(p_input->>'vendor_map_link', ''),
    handoff_notes = nullif(p_input->>'handoff_notes', ''),
    receiver_name = nullif(p_input->>'receiver_name', '')
  where id = p_id;

  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance' then
    update public.assets set status = 'in_maintenance' where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', v_asset.status, 'in_maintenance', auth.uid(), 'إدخال صيانة'
    );
  elsif v_done and v_asset.status = 'in_maintenance' then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = v_asset.id and status = 'active';
    update public.assets set status = 'available', assigned_to_employee_id = null
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', 'in_maintenance', 'available', auth.uid(), 'انتهاء صيانة'
    );
  end if;
  return json_build_object('ok', true);
end
$func$;

create or replace function public.consumable_create_with_opening_stock(p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_id uuid;
  v_qty integer;
  v_reorder integer;
  v_cost numeric;
begin
  if not public.current_user_has_capability('consumable.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or nullif(btrim(p_input->>'category_id'), '') is null
     or nullif(btrim(p_input->>'name'), '') is null then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  if coalesce(p_input->>'quantity_on_hand', '0') !~ '^[0-9]+$'
     or coalesce(p_input->>'reorder_level', '0') !~ '^[0-9]+$' then
    return json_build_object('ok', false, 'error', 'invalid_quantity');
  end if;
  begin
    v_qty := coalesce((p_input->>'quantity_on_hand')::integer, 0);
    v_reorder := coalesce((p_input->>'reorder_level')::integer, 0);
    v_cost := nullif(p_input->>'unit_cost', '')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_numeric');
  end;
  if v_qty > 1000000 or v_reorder > 1000000 then
    return json_build_object('ok', false, 'error', 'quantity_too_large');
  end if;
  if v_cost is not null and (not public.is_financial_viewer() or v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_financial_value');
  end if;

  insert into public.consumables (
    category_id, name, sku, brand, unit, quantity_on_hand, reorder_level,
    company_id, supplier_id, location_id, unit_cost, rfid_tag, notes
  ) values (
    (p_input->>'category_id')::uuid, btrim(p_input->>'name'),
    nullif(btrim(p_input->>'sku'), ''), nullif(btrim(p_input->>'brand'), ''),
    coalesce(nullif(p_input->>'unit', ''), 'piece'), 0, v_reorder,
    nullif(p_input->>'company_id', '')::uuid,
    nullif(p_input->>'supplier_id', '')::uuid,
    nullif(p_input->>'location_id', '')::uuid,
    v_cost, nullif(btrim(p_input->>'rfid_tag'), ''), nullif(btrim(p_input->>'notes'), '')
  ) returning id into v_id;

  if v_qty > 0 then
    insert into public.consumable_transactions (
      consumable_id, txn_type, quantity, previous_quantity, balance_after,
      unit_cost, total_cost, supplier_id, reason, performed_by
    ) values (
      v_id, 'in', v_qty, 0, v_qty, v_cost,
      case when v_cost is not null then v_cost * v_qty else null end,
      nullif(p_input->>'supplier_id', '')::uuid, 'رصيد افتتاحي', auth.uid()
    );
    update public.consumables set quantity_on_hand = v_qty where id = v_id;
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$func$;

create or replace function public.purchase_requests_create_from_shortages(p_items jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_item jsonb;
  v_supplier uuid;
  v_pr_id uuid;
  v_number text;
  v_qty integer;
  v_numbers text[] := array[]::text[];
begin
  if not public.current_user_has_capability('purchase.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    return json_build_object('ok', false, 'error', 'invalid_items');
  end if;

  -- Validate the complete payload before the first header is created.
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or nullif(v_item->>'consumable_id', '') is null
       or coalesce(v_item->>'quantity', '') !~ '^[1-9][0-9]*$' then
      return json_build_object('ok', false, 'error', 'invalid_item');
    end if;
    begin
      v_qty := (v_item->>'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      return json_build_object('ok', false, 'error', 'invalid_quantity');
    end;
    if v_qty > 1000000
       or not exists (
         select 1 from public.consumables
         where id = (v_item->>'consumable_id')::uuid and is_active
       ) then
      return json_build_object('ok', false, 'error', 'invalid_item');
    end if;
    if nullif(v_item->>'supplier_id', '') is not null
       and not exists (
         select 1 from public.suppliers where id = (v_item->>'supplier_id')::uuid and is_active
       ) then
      return json_build_object('ok', false, 'error', 'invalid_supplier');
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(p_items) x
    group by nullif(x->>'supplier_id', ''), x->>'consumable_id'
    having count(*) > 1
  ) then
    return json_build_object('ok', false, 'error', 'duplicate_item');
  end if;

  for v_supplier in
    select distinct nullif(value->>'supplier_id', '')::uuid
    from jsonb_array_elements(p_items)
  loop
    insert into public.purchase_requests (supplier_id)
    values (v_supplier)
    returning id, request_number into v_pr_id, v_number;

    insert into public.purchase_request_items (
      purchase_request_id, consumable_id, requested_quantity, suggested_quantity
    )
    select
      v_pr_id, (value->>'consumable_id')::uuid,
      (value->>'quantity')::integer, (value->>'quantity')::integer
    from jsonb_array_elements(p_items)
    where nullif(value->>'supplier_id', '')::uuid is not distinct from v_supplier;

    v_numbers := array_append(v_numbers, v_number);
  end loop;
  return json_build_object('ok', true, 'numbers', to_jsonb(v_numbers));
end
$func$;

revoke all on function public.asset_create_atomic(jsonb) from public, anon;
revoke all on function public.asset_move_atomic(uuid, uuid, uuid) from public, anon;
revoke all on function public.asset_update_atomic(uuid, jsonb) from public, anon;
revoke all on function public.maintenance_create_atomic(jsonb) from public, anon;
revoke all on function public.maintenance_update_atomic(uuid, jsonb) from public, anon;
revoke all on function public.consumable_create_with_opening_stock(jsonb) from public, anon;
revoke all on function public.purchase_requests_create_from_shortages(jsonb) from public, anon;

grant execute on function public.asset_create_atomic(jsonb) to authenticated;
grant execute on function public.asset_move_atomic(uuid, uuid, uuid) to authenticated;
grant execute on function public.asset_update_atomic(uuid, jsonb) to authenticated;
grant execute on function public.maintenance_create_atomic(jsonb) to authenticated;
grant execute on function public.maintenance_update_atomic(uuid, jsonb) to authenticated;
grant execute on function public.consumable_create_with_opening_stock(jsonb) to authenticated;
grant execute on function public.purchase_requests_create_from_shortages(jsonb) to authenticated;

-- SECURITY DEFINER entrypoints above are now the only browser creation paths.
revoke insert on public.assets, public.asset_movements, public.asset_assignments,
  public.maintenance_records, public.consumables, public.purchase_requests,
  public.purchase_request_items
from authenticated;

commit;
