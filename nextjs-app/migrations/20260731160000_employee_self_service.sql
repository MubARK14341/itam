begin;

-- P1-04: real employee self-service boundary.
-- Employee identities are approved staff identities linked explicitly to an
-- active employees row. No RPC in this boundary creates or guesses that link.

insert into public.roles (key, name, name_ar, description, is_system)
values (
  'employee',
  'Employee',
  'موظف',
  'Self-service employee with access only to their own requests and custody.',
  true
)
on conflict (key) do update
set name = excluded.name,
    name_ar = excluded.name_ar,
    description = excluded.description,
    is_system = true;

insert into public.permissions (key, grp, description) values
  ('request.self.create', 'employee_self_service', 'Create an own employee request'),
  ('request.self.read', 'employee_self_service', 'Read own employee requests'),
  ('request.self.reply', 'employee_self_service', 'Reply to clarification on an own request'),
  ('custody.self.read', 'employee_self_service', 'Read own active and historical custody'),
  ('maintenance.self.report', 'employee_self_service', 'Report an issue on an own assigned asset'),
  ('custody.self.return_request', 'employee_self_service', 'Request return of an own assigned asset')
on conflict (key) do update
set grp = excluded.grp,
    description = excluded.description;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in (
  'request.self.create',
  'request.self.read',
  'request.self.reply',
  'custody.self.read',
  'maintenance.self.report',
  'custody.self.return_request'
)
where r.key = 'employee'
on conflict do nothing;

create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
  select u.employee_id
  from public.app_users u
  join public.roles r on r.id = u.role_id
  join public.employees e on e.id = u.employee_id
  where u.id = auth.uid()
    and u.is_active
    and u.approval_status = 'approved'
    and r.key = 'employee'
    and e.is_active
$function$;

revoke all on function public.current_employee_id() from public, anon;
grant execute on function public.current_employee_id() to authenticated;

-- Existing permissive policies exposed all rows to every approved identity.
-- Replace them so employee access is self-scoped at the row boundary. Other
-- staff roles retain the established behavior.
drop policy if exists sel_auth on public.assets;
create policy sel_auth on public.assets
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.assets;
create policy sel_employee_self on public.assets
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and assigned_to_employee_id = public.current_employee_id()
);

drop policy if exists sel_auth on public.asset_assignments;
create policy sel_auth on public.asset_assignments
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.asset_assignments;
create policy sel_employee_self on public.asset_assignments
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and employee_id = public.current_employee_id()
);

drop policy if exists sel_auth on public.employees;
create policy sel_auth on public.employees
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.employees;
create policy sel_employee_self on public.employees
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and id = public.current_employee_id()
);

drop policy if exists sel_auth on public.requests;
create policy sel_auth on public.requests
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.requests;
create policy sel_employee_self on public.requests
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and beneficiary_type = 'employee'
  and beneficiary_employee_id = public.current_employee_id()
);

drop policy if exists sel_auth on public.request_items;
create policy sel_auth on public.request_items
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.request_items;
create policy sel_employee_self on public.request_items
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and exists (
    select 1
    from public.requests r
    where r.id = request_items.request_id
      and r.beneficiary_type = 'employee'
      and r.beneficiary_employee_id = public.current_employee_id()
  )
);

drop policy if exists sel_auth on public.request_events;
create policy sel_auth on public.request_events
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.request_events;
create policy sel_employee_self on public.request_events
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and exists (
    select 1
    from public.requests r
    where r.id = request_events.request_id
      and r.beneficiary_type = 'employee'
      and r.beneficiary_employee_id = public.current_employee_id()
  )
);

drop policy if exists sel_auth on public.maintenance_records;
create policy sel_auth on public.maintenance_records
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.maintenance_records;
create policy sel_employee_self on public.maintenance_records
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and exists (
    select 1
    from public.assets a
    where a.id = maintenance_records.asset_id
      and a.assigned_to_employee_id = public.current_employee_id()
  )
);

-- Employee self-service does not include catalogs, customers, locations,
-- inventory balances, movements, purchasing, or organization directories.
-- These are direct Data API boundaries, independent of the navigation UI.
do $policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'asset_movements',
    'asset_pools',
    'categories',
    'companies',
    'consumable_transactions',
    'consumables',
    'customers',
    'departments',
    'depreciation_rules',
    'locations',
    'models',
    'notification_settings',
    'suppliers'
  ]
  loop
    if to_regclass('public.' || v_table) is not null then
      execute format('drop policy if exists sel_auth on public.%I', v_table);
      execute format(
        'create policy sel_auth on public.%I for select to authenticated using (public.is_approved() and public.app_user_role() <> %L)',
        v_table,
        'employee'
      );
    end if;
  end loop;
end
$policies$;

create table if not exists public.employee_asset_return_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  asset_id uuid not null references public.assets(id),
  assignment_id uuid not null references public.asset_assignments(id),
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'acknowledged', 'completed', 'rejected')),
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  resolved_by uuid null references auth.users(id),
  resolved_at timestamptz null,
  resolution_note text null,
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requested_by, operation_id)
);
create unique index if not exists uq_employee_asset_return_pending
  on public.employee_asset_return_requests(employee_id, asset_id)
  where status in ('pending', 'acknowledged');
create index if not exists idx_employee_asset_return_employee
  on public.employee_asset_return_requests(employee_id, requested_at desc);

alter table public.employee_asset_return_requests enable row level security;
revoke all on public.employee_asset_return_requests from public, anon, authenticated;
grant select on public.employee_asset_return_requests to authenticated;
grant select, insert, update, delete on public.employee_asset_return_requests to service_role;

drop policy if exists sel_employee_self on public.employee_asset_return_requests;
create policy sel_employee_self on public.employee_asset_return_requests
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and employee_id = public.current_employee_id()
  and requested_by = auth.uid()
);
drop policy if exists sel_employee_ops on public.employee_asset_return_requests;
create policy sel_employee_ops on public.employee_asset_return_requests
for select to authenticated
using (
  public.app_user_role() in ('admin', 'it_manager', 'technician', 'warehouse_manager', 'auditor')
);

create table if not exists public.employee_self_operations (
  user_id uuid not null references auth.users(id),
  operation_id uuid not null,
  operation_type text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id, operation_type)
);
alter table public.employee_self_operations enable row level security;
revoke all on public.employee_self_operations from public, anon, authenticated;
grant select, insert, update, delete on public.employee_self_operations to service_role;

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
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_request_id uuid;
  v_item jsonb;
  v_quantity numeric;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('request.self.create') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'employee_link_required');
  end if;
  if p_status is null or btrim(p_status) not in ('draft', 'under_review') then
    return jsonb_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if p_pickup_date is not null and p_return_date is not null
     and p_return_date < p_pickup_date then
    return jsonb_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_items) > 50 then
    return jsonb_build_object('ok', false, 'error', 'too_many_items');
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or v_item ?| array[
         'asset_id', 'serial_number', 'qr_token', 'rfid_tag', 'asset_tag',
         'consumable_id', 'preferred_company_id', 'preferred_model',
         'unit_price', 'total_price', 'approved_quantity',
         'delivered_quantity', 'returned_quantity', 'needs_purchase',
         'beneficiary_employee_id', 'customer_id'
       ] then
      return jsonb_build_object('ok', false, 'error', 'server_fields_forbidden');
    end if;
    if coalesce(nullif(btrim(v_item->>'item_kind'), ''), 'custom') <> 'custom'
       or nullif(btrim(v_item->>'requested_description'), '') is null
       or jsonb_typeof(v_item->'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'error', 'invalid_item');
    end if;
    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity <= 0 or v_quantity > 1000 or v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;
  end loop;

  insert into public.requests (
    status, request_type, beneficiary_type, beneficiary_employee_id,
    customer_id, submitted_by, created_by, request_source, project_name,
    pickup_date, return_date, notes, portal_approval_status
  ) values (
    btrim(p_status), 'internal', 'employee', v_employee_id,
    null, v_uid, v_uid, 'internal', nullif(btrim(p_project_name), ''),
    p_pickup_date, p_return_date, nullif(btrim(p_notes), ''), 'not_required'
  )
  returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    insert into public.request_items (
      request_id, item_kind, quantity, notes, requested_kind,
      requested_description, requested_category, accept_alternative,
      needs_purchase
    ) values (
      v_request_id, 'custom', (v_item->>'quantity')::numeric,
      nullif(btrim(v_item->>'notes'), ''), 'existing_asset',
      nullif(btrim(v_item->>'requested_description'), ''),
      nullif(btrim(v_item->>'requested_category'), ''),
      coalesce((v_item->>'accept_alternative')::boolean, true), false
    );
  end loop;

  perform public._request_add_event(
    v_request_id,
    'employee_request_created',
    'staff',
    null,
    jsonb_build_object('actor_scope', 'employee')
  );
  return jsonb_build_object('ok', true, 'id', v_request_id);
end
$function$;

create or replace function public.employee_my_requests()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() <> 'employee'
      or not public.current_user_has_capability('request.self.read')
      or public.current_employee_id() is null
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'request_number', r.request_number,
        'status', r.status,
        'project_name', r.project_name,
        'pickup_date', r.pickup_date,
        'return_date', r.return_date,
        'notes', r.notes,
        'created_at', r.created_at,
        'updated_at', r.updated_at,
        'item_count', (
          select count(*) from public.request_items ri where ri.request_id = r.id
        )
      ) order by r.created_at desc)
      from public.requests r
      where r.beneficiary_type = 'employee'
        and r.beneficiary_employee_id = public.current_employee_id()
    ), '[]'::jsonb)
  end
$function$;

create or replace function public.employee_my_request(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_employee_id uuid := public.current_employee_id();
  v_result jsonb;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('request.self.read')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select jsonb_build_object(
    'ok', true,
    'request', jsonb_build_object(
      'id', r.id,
      'request_number', r.request_number,
      'status', r.status,
      'project_name', r.project_name,
      'pickup_date', r.pickup_date,
      'return_date', r.return_date,
      'notes', r.notes,
      'created_at', r.created_at,
      'updated_at', r.updated_at
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id,
        'quantity', ri.quantity,
        'requested_description', ri.requested_description,
        'requested_category', ri.requested_category,
        'notes', ri.notes
      ) order by ri.created_at)
      from public.request_items ri where ri.request_id = r.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', re.id,
        'event_type', re.event_type,
        'message', re.message,
        'created_at', re.created_at
      ) order by re.created_at)
      from public.request_events re where re.request_id = r.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.requests r
  where r.id = p_request_id
    and r.beneficiary_type = 'employee'
    and r.beneficiary_employee_id = v_employee_id;

  return coalesce(v_result, jsonb_build_object('ok', false, 'error', 'not_found'));
end
$function$;

create or replace function public.employee_reply_request_clarification(
  p_request_id uuid,
  p_message text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_existing jsonb;
  v_result jsonb;
  v_request public.requests%rowtype;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('request.self.reply')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or nullif(btrim(p_message), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  select result into v_existing
  from public.employee_self_operations
  where user_id = v_uid
    and operation_id = p_operation_id
    and operation_type = 'clarification_reply';
  if found then return v_existing; end if;

  select * into v_request
  from public.requests
  where id = p_request_id
    and beneficiary_type = 'employee'
    and beneficiary_employee_id = v_employee_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'needs_clarification' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;

  update public.requests set status = 'under_review' where id = p_request_id;
  perform public._request_add_event(
    p_request_id,
    'clarification_reply',
    'staff',
    btrim(p_message),
    jsonb_build_object('actor_scope', 'employee')
  );
  v_result := jsonb_build_object('ok', true, 'id', p_request_id);
  insert into public.employee_self_operations(user_id, operation_id, operation_type, result)
  values (v_uid, p_operation_id, 'clarification_reply', v_result);
  return v_result;
end
$function$;

create or replace function public.employee_my_assets()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() <> 'employee'
      or not public.current_user_has_capability('custody.self.read')
      or public.current_employee_id() is null
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'asset_id', a.id,
        'asset_tag', a.asset_tag,
        'name', a.name,
        'status', a.status,
        'condition_grade', a.condition_grade,
        'assigned_at', aa.assigned_at,
        'due_return_date', aa.due_return_date,
        'assignment_status', aa.status,
        'return_requested', exists (
          select 1 from public.employee_asset_return_requests rr
          where rr.assignment_id = aa.id
            and rr.status in ('pending', 'acknowledged')
        ),
        'open_issue_count', (
          select count(*) from public.maintenance_records mr
          where mr.asset_id = a.id and mr.status not in ('completed', 'cancelled')
        )
      ) order by aa.assigned_at desc)
      from public.asset_assignments aa
      join public.assets a on a.id = aa.asset_id
      where aa.employee_id = public.current_employee_id()
        and aa.status = 'active'
        and a.assigned_to_employee_id = public.current_employee_id()
    ), '[]'::jsonb)
  end
$function$;

create or replace function public.employee_report_asset_issue(
  p_asset_id uuid,
  p_description text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_existing jsonb;
  v_result jsonb;
  v_record_id uuid;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('maintenance.self.report')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or nullif(btrim(p_description), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  select result into v_existing
  from public.employee_self_operations
  where user_id = v_uid
    and operation_id = p_operation_id
    and operation_type = 'asset_issue';
  if found then return v_existing; end if;

  perform 1
  from public.assets a
  join public.asset_assignments aa
    on aa.asset_id = a.id and aa.employee_id = v_employee_id and aa.status = 'active'
  where a.id = p_asset_id
    and a.assigned_to_employee_id = v_employee_id
  for update of a;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.maintenance_records (
    asset_id, type, status, reported_by, reported_by_employee_id,
    problem_description, priority, problem_type, workflow_stage,
    cost, currency
  ) values (
    p_asset_id, 'corrective', 'open', v_uid, v_employee_id,
    btrim(p_description), 'normal', 'employee_reported', 'reported',
    0, 'SAR'
  )
  returning id into v_record_id;

  v_result := jsonb_build_object('ok', true, 'id', v_record_id);
  insert into public.employee_self_operations(user_id, operation_id, operation_type, result)
  values (v_uid, p_operation_id, 'asset_issue', v_result);
  return v_result;
end
$function$;

create or replace function public.employee_request_asset_return(
  p_asset_id uuid,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_assignment_id uuid;
  v_existing jsonb;
  v_result jsonb;
  v_return_id uuid;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('custody.self.return_request')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  select result into v_existing
  from public.employee_self_operations
  where user_id = v_uid
    and operation_id = p_operation_id
    and operation_type = 'asset_return_request';
  if found then return v_existing; end if;

  select aa.id into v_assignment_id
  from public.asset_assignments aa
  join public.assets a on a.id = aa.asset_id
  where aa.asset_id = p_asset_id
    and aa.employee_id = v_employee_id
    and aa.status = 'active'
    and a.assigned_to_employee_id = v_employee_id
  for update of aa;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if exists (
    select 1 from public.employee_asset_return_requests rr
    where rr.assignment_id = v_assignment_id
      and rr.status in ('pending', 'acknowledged')
  ) then
    return jsonb_build_object('ok', false, 'error', 'already_requested');
  end if;

  insert into public.employee_asset_return_requests (
    employee_id, asset_id, assignment_id, reason, requested_by, operation_id
  ) values (
    v_employee_id, p_asset_id, v_assignment_id, btrim(p_reason), v_uid, p_operation_id
  )
  returning id into v_return_id;

  v_result := jsonb_build_object('ok', true, 'id', v_return_id);
  insert into public.employee_self_operations(user_id, operation_id, operation_type, result)
  values (v_uid, p_operation_id, 'asset_return_request', v_result);
  return v_result;
end
$function$;

create or replace function public.employee_my_return_requests()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() <> 'employee'
      or not public.current_user_has_capability('custody.self.read')
      or public.current_employee_id() is null
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rr.id,
        'asset_id', rr.asset_id,
        'asset_tag', a.asset_tag,
        'asset_name', a.name,
        'reason', rr.reason,
        'status', rr.status,
        'requested_at', rr.requested_at,
        'resolution_note', rr.resolution_note,
        'resolved_at', rr.resolved_at
      ) order by rr.requested_at desc)
      from public.employee_asset_return_requests rr
      join public.assets a on a.id = rr.asset_id
      where rr.employee_id = public.current_employee_id()
        and rr.requested_by = auth.uid()
    ), '[]'::jsonb)
  end
$function$;

revoke all on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) from public, anon;
revoke all on function public.employee_my_requests() from public, anon;
revoke all on function public.employee_my_request(uuid) from public, anon;
revoke all on function public.employee_reply_request_clarification(uuid, text, uuid) from public, anon;
revoke all on function public.employee_my_assets() from public, anon;
revoke all on function public.employee_report_asset_issue(uuid, text, uuid) from public, anon;
revoke all on function public.employee_request_asset_return(uuid, text, uuid) from public, anon;
revoke all on function public.employee_my_return_requests() from public, anon;

grant execute on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) to authenticated;
grant execute on function public.employee_my_requests() to authenticated;
grant execute on function public.employee_my_request(uuid) to authenticated;
grant execute on function public.employee_reply_request_clarification(uuid, text, uuid) to authenticated;
grant execute on function public.employee_my_assets() to authenticated;
grant execute on function public.employee_report_asset_issue(uuid, text, uuid) to authenticated;
grant execute on function public.employee_request_asset_return(uuid, text, uuid) to authenticated;
grant execute on function public.employee_my_return_requests() to authenticated;

comment on function public.current_employee_id() is
  'Returns the active employee row linked to the current approved employee-role identity, otherwise null.';
comment on table public.employee_asset_return_requests is
  'Employee-initiated return intent queue. It never mutates custody; warehouse staff complete return through custody workflows.';

commit;
