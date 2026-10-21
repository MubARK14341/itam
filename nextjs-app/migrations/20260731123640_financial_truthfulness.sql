-- P0-04: distinguish a real zero from missing and forbidden financial data.
-- LOCAL-ONLY proposal. It does not backfill amounts or infer historical values.

begin;

-- The previous schema forced unpriced maintenance to zero. Make absence
-- representable and add explicit provenance for future zero-cost records.
alter table public.maintenance_records
  alter column cost drop not null,
  alter column cost drop default;

alter table public.maintenance_records
  add column if not exists cost_recorded boolean not null default false;

comment on column public.maintenance_records.cost_recorded is
  'True only when an authorized financial actor or trusted service explicitly supplied cost; historical zero remains unconfirmed.';

create or replace function public.maintenance_guard_financial()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() = 'service_role' then
    if tg_op = 'INSERT' or new.cost is distinct from old.cost then
      new.cost_recorded := new.cost is not null;
    end if;
  elsif public.is_financial_viewer() then
    if tg_op = 'INSERT' or new.cost is distinct from old.cost then
      new.cost_recorded := new.cost is not null;
    end if;
  elsif tg_op = 'INSERT' then
    new.cost := null;
    new.cost_recorded := false;
    new.invoice_number := null;
    new.invoice_date := null;
  else
    new.cost := old.cost;
    new.cost_recorded := old.cost_recorded;
    new.invoice_number := old.invoice_number;
    new.invoice_date := old.invoice_date;
  end if;
  return new;
end
$function$;

revoke execute on function public.maintenance_guard_financial()
from public, anon, authenticated;

-- Final create definition: absence remains NULL instead of being coerced to 0.
create or replace function public.maintenance_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  if v_stage not in (
    'open', 'investigating', 'awaiting_parts', 'at_vendor',
    'completed', 'unrepairable'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_maintenance_stage');
  end if;
  begin
    v_cost := nullif(p_input->>'cost', '')::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      return json_build_object('ok', false, 'error', 'invalid_cost');
  end;
  if (
    v_cost is not null
    or nullif(p_input->>'invoice_number', '') is not null
    or nullif(p_input->>'invoice_date', '') is not null
  ) and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end if;

  select *
  into v_asset
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
    asset_id,
    type,
    status,
    workflow_stage,
    priority,
    problem_type,
    problem_description,
    action_taken,
    cost,
    invoice_number,
    invoice_date,
    reported_by,
    technician_id,
    reported_by_employee_id,
    final_summary,
    next_due_date,
    completed_at,
    vendor_supplier_id,
    vendor_name,
    vendor_phone,
    vendor_location,
    vendor_map_link,
    handoff_notes,
    receiver_name
  ) values (
    v_asset.id,
    coalesce(nullif(p_input->>'type', ''), 'corrective')::public.maintenance_type,
    case
      when v_done then 'completed'::public.maintenance_status
      when v_stage = 'open' then 'open'::public.maintenance_status
      else 'in_progress'::public.maintenance_status
    end,
    v_stage,
    nullif(p_input->>'priority', ''),
    nullif(p_input->>'problem_type', ''),
    nullif(p_input->>'problem_description', ''),
    nullif(p_input->>'action_taken', ''),
    v_cost,
    nullif(p_input->>'invoice_number', ''),
    nullif(p_input->>'invoice_date', '')::date,
    auth.uid(),
    auth.uid(),
    nullif(p_input->>'reported_by_employee_id', '')::uuid,
    nullif(p_input->>'final_summary', ''),
    nullif(p_input->>'next_due_date', '')::date,
    case when v_done then statement_timestamp() else null end,
    nullif(p_input->>'vendor_supplier_id', '')::uuid,
    nullif(p_input->>'vendor_name', ''),
    nullif(p_input->>'vendor_phone', ''),
    nullif(p_input->>'vendor_location', ''),
    nullif(p_input->>'vendor_map_link', ''),
    nullif(p_input->>'handoff_notes', ''),
    nullif(p_input->>'receiver_name', '')
  )
  returning id into v_id;

  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance' then
    update public.assets
    set status = 'in_maintenance'
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id,
      'status_change',
      v_asset.status,
      'in_maintenance',
      auth.uid(),
      'إدخال صيانة'
    );
  elsif v_done and v_asset.status = 'in_maintenance' then
    update public.asset_assignments
    set status = 'returned', returned_at = statement_timestamp()
    where asset_id = v_asset.id and status = 'active';
    update public.assets
    set status = 'available', assigned_to_employee_id = null
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id,
      'status_change',
      'in_maintenance',
      'available',
      auth.uid(),
      'انتهاء صيانة'
    );
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$function$;

create or replace function public.maintenance_financial_truth(p_ids uuid[])
returns table (
  id uuid,
  cost numeric,
  cost_recorded boolean,
  currency text,
  invoice_number text,
  invoice_date date
)
language sql
stable
security definer
set search_path to ''
as $function$
  select
    m.id,
    case when m.cost_recorded then m.cost else null end,
    m.cost_recorded,
    m.currency,
    m.invoice_number,
    m.invoice_date
  from public.maintenance_records m
  where public.is_financial_viewer()
    and m.id = any(p_ids);
$function$;

revoke all on function public.maintenance_financial_truth(uuid[])
from public, anon;
grant execute on function public.maintenance_financial_truth(uuid[])
to authenticated;

-- Current work queue. It deliberately exposes only which facts are missing,
-- never a partial amount.
create or replace view public.financial_asset_data_quality
with (security_invoker = true)
as
select
  a.id as asset_id,
  a.asset_tag,
  a.name as asset_name,
  array_remove(array[
    case when a.purchase_cost is null then 'purchase_cost' end,
    case when a.purchase_date is null then 'purchase_date' end,
    case when a.warranty_end is null then 'warranty_end' end,
    case when a.company_id is null then 'manufacturer' end,
    case when a.model_id is null then 'model' end
  ], null)::text[] as missing_fields,
  a.updated_at
from public.assets a
where a.is_active
  and (
    a.purchase_cost is null
    or a.purchase_date is null
    or a.warranty_end is null
    or a.company_id is null
    or a.model_id is null
  );

revoke all on public.financial_asset_data_quality
from public, anon, authenticated;

create or replace function public.financial_data_quality_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_total bigint;
  v_missing_cost bigint;
  v_missing_purchase_date bigint;
  v_missing_warranty bigint;
  v_missing_manufacturer bigint;
  v_missing_model bigint;
begin
  if not public.is_financial_viewer() then
    raise exception 'financial_fields_forbidden' using errcode = '42501';
  end if;

  select
    count(*),
    count(*) filter (where a.purchase_cost is null),
    count(*) filter (where a.purchase_date is null),
    count(*) filter (where a.warranty_end is null),
    count(*) filter (where a.company_id is null),
    count(*) filter (where a.model_id is null)
  into
    v_total,
    v_missing_cost,
    v_missing_purchase_date,
    v_missing_warranty,
    v_missing_manufacturer,
    v_missing_model
  from public.assets a
  where a.is_active;

  return jsonb_build_object(
    'as_of', statement_timestamp(),
    'coverage_threshold_pct', 100,
    'total_assets', v_total,
    'missing_purchase_cost', v_missing_cost,
    'missing_purchase_date', v_missing_purchase_date,
    'missing_warranty_end', v_missing_warranty,
    'missing_manufacturer', v_missing_manufacturer,
    'missing_model', v_missing_model
  );
end
$function$;

create or replace function public.financial_data_quality_list(
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  asset_id uuid,
  asset_tag text,
  asset_name text,
  missing_fields text[],
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.is_financial_viewer() then
    raise exception 'financial_fields_forbidden' using errcode = '42501';
  end if;
  if p_limit < 1 or p_limit > 500 or p_offset < 0 then
    raise exception 'invalid_pagination' using errcode = '22023';
  end if;

  return query
  select
    q.asset_id,
    q.asset_tag,
    q.asset_name,
    q.missing_fields,
    q.updated_at
  from public.financial_asset_data_quality q
  order by q.updated_at, q.asset_id
  limit p_limit
  offset p_offset;
end
$function$;

revoke all on function public.financial_data_quality_summary()
from public, anon;
revoke all on function public.financial_data_quality_list(integer, integer)
from public, anon;
grant execute on function public.financial_data_quality_summary()
to authenticated;
grant execute on function public.financial_data_quality_list(integer, integer)
to authenticated;

commit;
