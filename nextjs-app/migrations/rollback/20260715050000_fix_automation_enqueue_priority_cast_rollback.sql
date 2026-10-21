-- Rollback of 20260715050000: restores the pre-fix trigger-function bodies

begin;

create or replace function public.automation_maintenance_opened_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_email text;
  v_asset_tag text;
begin
  if new.status <> 'open' then
    return new;
  end if;

  select au.email
    into v_email
  from public.app_users au
  where au.id = new.technician_id
    and coalesce(au.is_active, false)
    and coalesce(au.approval_status, 'approved') = 'approved';

  select a.asset_tag
    into v_asset_tag
  from public.assets a
  where a.id = new.asset_id;

  perform public.automation_enqueue(
    'maintenance_opened:' || new.id::text,
    'maintenance_opened:' || new.id::text || ':' || coalesce(new.technician_id::text, 'unassigned'),
    'maintenance_opened',
    'technician',
    new.technician_id,
    v_email,
    'maintenance',
    new.id,
    'maintenance_opened',
    'ar',
    jsonb_strip_nulls(jsonb_build_object(
      'maintenance_id', new.id,
      'asset_id', new.asset_id,
      'asset_tag', v_asset_tag,
      'priority', new.priority,
      'workflow_stage', new.workflow_stage,
      'problem_description', new.problem_description,
      'reported_at', new.reported_at,
      'link', '/maintenance?m=' || new.id::text
    )),
    40::smallint,
    now()
  );
  return new;
end;
$function$;

create or replace function public.automation_custody_delivery_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_employee public.employees%rowtype;
  v_asset public.assets%rowtype;
  v_brand text;
  v_model text;
  v_location text;
  v_request_number text;
  v_accessories jsonb;
begin
  if new.status <> 'active' then
    return new;
  end if;

  select * into v_employee
  from public.employees e
  where e.id = new.employee_id and coalesce(e.is_active, false);

  select * into v_asset
  from public.assets a
  where a.id = new.asset_id;

  select m.brand, m.model_name
    into v_brand, v_model
  from public.models m
  where m.id = v_asset.model_id;

  select l.name
    into v_location
  from public.locations l
  where l.id = v_asset.location_id;

  if v_asset.last_request_id is not null then
    select r.request_number
      into v_request_number
    from public.requests r
    where r.id = v_asset.last_request_id;
  end if;

  v_accessories := case
    when jsonb_typeof(v_asset.special_attributes -> 'accessories') in ('array','object','string')
      then v_asset.special_attributes -> 'accessories'
    else '[]'::jsonb
  end;

  perform public.automation_enqueue(
    'custody_delivery_proof:' || new.id::text,
    'custody_delivery_proof:' || new.id::text || ':' || new.employee_id::text,
    'custody_delivery_proof',
    'custody_recipient',
    new.employee_id,
    v_employee.email,
    'asset_assignment',
    new.id,
    'custody_delivery_proof',
    'ar',
    jsonb_strip_nulls(jsonb_build_object(
      'proof_number', new.id,
      'assignment_id', new.id,
      'recipient_name', v_employee.full_name,
      'assigned_by', new.assigned_by,
      'assigned_at', new.assigned_at,
      'asset_id', new.asset_id,
      'asset_tag', v_asset.asset_tag,
      'asset_name', v_asset.name,
      'brand', v_brand,
      'model', v_model,
      'serial_number', v_asset.serial_number,
      'condition', v_asset.condition_grade,
      'accessories', v_accessories,
      'location', v_location,
      'return_date', new.due_return_date,
      'request_number', v_request_number,
      'link', '/assets/' || new.asset_id::text
    )),
    80::smallint,
    now()
  );
  return new;
end;
$function$;

revoke all on function public.automation_maintenance_opened_enqueue() from public, anon, authenticated;
revoke all on function public.automation_custody_delivery_enqueue() from public, anon, authenticated;

commit;
