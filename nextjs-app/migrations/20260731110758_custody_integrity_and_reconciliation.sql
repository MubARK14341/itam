-- Purpose: P0-03 — enforce custody consistency in both directions and expose
-- historical contradictions as an evidence-backed reconciliation workflow.
-- Security impact: browser roles lose direct assignment DML; atomic RPCs remain
-- the only write path. Deferred constraints reject every final state where an
-- asset and its active assignment disagree, including employee deactivation.
-- Data impact: no asset, holder, assignment, or historical event is corrected.
-- Existing contradictions are copied into open reconciliation cases.
-- Rollout: additive tables/functions/triggers plus RPC replacements. Rehearse
-- against a representative restore and export the queue before production.
-- Rollback: do not remove reconciliation evidence. Dropping the new constraint
-- triggers or restoring prior RPCs would reopen silent custody corruption.

begin;

-- ---------------------------------------------------------------------------
-- One authoritative predicate used by guards and atomic RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.custody_asset_is_consistent(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  with asset_state as (
    select a.status, a.assigned_to_employee_id
    from public.assets a
    where a.id = p_asset_id
  ),
  active_state as (
    select
      count(aa.id)::integer as active_count,
      count(aa.id) filter (
        where aa.employee_id = s.assigned_to_employee_id
      )::integer as matching_count,
      count(aa.id) filter (
        where e.id is null or not e.is_active
      )::integer as inactive_employee_count
    from asset_state s
    left join public.asset_assignments aa
      on aa.asset_id = p_asset_id
     and aa.status = 'active'
    left join public.employees e on e.id = aa.employee_id
  )
  select coalesce((
    select
      case
        when s.status = 'assigned' then
          s.assigned_to_employee_id is not null
          and a.active_count = 1
          and a.matching_count = 1
          and a.inactive_employee_count = 0
        else a.active_count = 0
      end
    from asset_state s
    cross join active_state a
  ), false);
$function$;

revoke all on function public.custody_asset_is_consistent(uuid)
from public, anon, authenticated;

-- The immediate guard prevents a normal workflow from silently "repairing" a
-- pre-existing contradiction. A real-world reconciliation must be completed
-- through an approved, evidenced maintenance procedure.
create or replace function public.assets_guard_custody_transition()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.custody_asset_is_consistent(old.id) then
    raise exception 'custody_reconciliation_required' using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_assets_guard_custody_transition on public.assets;
create trigger trg_assets_guard_custody_transition
before update of status, assigned_to_employee_id on public.assets
for each row execute function public.assets_guard_custody_transition();

-- The deferred assertion permits the asset and assignment rows to be written in
-- either order inside one transaction, while enforcing the final committed state.
create or replace function public.assert_asset_custody_consistency()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_asset_id uuid;
begin
  if tg_table_name = 'assets' then
    v_asset_id := new.id;
  elsif tg_op = 'DELETE' then
    v_asset_id := old.asset_id;
  else
    v_asset_id := new.asset_id;
  end if;
  if exists (select 1 from public.assets where id = v_asset_id)
     and not public.custody_asset_is_consistent(v_asset_id) then
    raise exception 'asset_custody_invariant_violation' using errcode = '23514';
  end if;
  return null;
end
$function$;

drop trigger if exists trg_assets_assigned_integrity_insert on public.assets;
drop trigger if exists trg_assets_assigned_integrity_update on public.assets;
drop trigger if exists trg_assets_custody_consistency on public.assets;
create constraint trigger trg_assets_custody_consistency
after insert or update of status, assigned_to_employee_id on public.assets
deferrable initially deferred
for each row execute function public.assert_asset_custody_consistency();

drop trigger if exists trg_assignments_custody_consistency
on public.asset_assignments;
create constraint trigger trg_assignments_custody_consistency
after insert or update or delete on public.asset_assignments
deferrable initially deferred
for each row execute function public.assert_asset_custody_consistency();

create unique index if not exists uq_active_assignment
on public.asset_assignments(asset_id)
where status = 'active';

create or replace function public.assert_employee_has_no_active_custody()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not new.is_active and exists (
    select 1
    from public.asset_assignments aa
    where aa.employee_id = new.id
      and aa.status = 'active'
  ) then
    raise exception 'inactive_employee_has_active_custody' using errcode = '23514';
  end if;
  return null;
end
$function$;

drop trigger if exists trg_employee_active_custody on public.employees;
create constraint trigger trg_employee_active_custody
after update of is_active on public.employees
deferrable initially deferred
for each row
when (old.is_active and not new.is_active)
execute function public.assert_employee_has_no_active_custody();

revoke all on function public.assets_guard_custody_transition()
from public, anon, authenticated;
revoke all on function public.assert_asset_custody_consistency()
from public, anon, authenticated;
revoke all on function public.assert_employee_has_no_active_custody()
from public, anon, authenticated;

drop function if exists public.assets_check_assigned_integrity();

-- Browser clients must use asset_assign/asset_return/request workflow RPCs.
revoke insert, update, delete on public.asset_assignments
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Final custody RPC definitions. Asset-first ordering works with the immediate
-- historical guard and the deferred bidirectional invariant.
-- ---------------------------------------------------------------------------

create or replace function public.asset_assign(
  p_asset_id uuid,
  p_employee_id uuid,
  p_due_date date default null
) returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_employee_id is null or not exists (
    select 1
    from public.employees
    where id = p_employee_id and is_active
  ) then
    return json_build_object('ok', false, 'error', 'employee_not_found');
  end if;

  select status into v_from
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.custody_asset_is_consistent(p_asset_id) then
    return json_build_object(
      'ok', false,
      'error', 'custody_reconciliation_required'
    );
  end if;
  if not public.asset_status_allowed(v_from, 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.assets
  set status = 'assigned',
      assigned_to_employee_id = p_employee_id
  where id = p_asset_id;

  insert into public.asset_assignments (
    asset_id, employee_id, assigned_by, due_return_date, status
  ) values (
    p_asset_id, p_employee_id, auth.uid(), p_due_date, 'active'
  );

  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, to_employee_id,
    performed_by, note
  ) values (
    p_asset_id, 'assign', v_from, 'assigned', p_employee_id,
    auth.uid(), 'تسليم عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_return(
  p_asset_id uuid,
  p_condition text default null
) returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_from public.asset_status;
  v_employee_id uuid;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_condition is not null
     and p_condition not in ('new', 'good', 'fair', 'poor') then
    return json_build_object('ok', false, 'error', 'invalid_condition');
  end if;

  select status, assigned_to_employee_id
  into v_from, v_employee_id
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.custody_asset_is_consistent(p_asset_id) then
    return json_build_object(
      'ok', false,
      'error', 'custody_reconciliation_required'
    );
  end if;
  if v_from <> 'assigned'
     or not public.asset_status_allowed(v_from, 'available') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.assets
  set status = 'available',
      assigned_to_employee_id = null,
      last_return_condition = nullif(p_condition, ''),
      last_return_at = statement_timestamp()
  where id = p_asset_id;

  update public.asset_assignments
  set status = 'returned',
      returned_at = statement_timestamp(),
      return_condition = nullif(p_condition, '')
  where asset_id = p_asset_id
    and status = 'active';

  insert into public.asset_movements (
    asset_id, movement_type, from_employee_id, from_status, to_status,
    performed_by, note
  ) values (
    p_asset_id, 'return', v_employee_id, v_from, 'available',
    auth.uid(), 'إرجاع عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_change_status(
  p_asset_id uuid,
  p_to_status public.asset_status,
  p_note text default null
) returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.update') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_to_status in ('retired', 'disposed')
     and not public.current_user_has_capability('asset.retire') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select status into v_from
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.custody_asset_is_consistent(p_asset_id) then
    return json_build_object(
      'ok', false,
      'error', 'custody_reconciliation_required'
    );
  end if;
  if p_to_status = 'assigned' then
    return json_build_object(
      'ok', false,
      'error', 'custody_assignment_rpc_required'
    );
  end if;
  if not public.asset_status_allowed(v_from, p_to_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.assets
  set status = p_to_status,
      assigned_to_employee_id = null
  where id = p_asset_id;

  update public.asset_assignments
  set status = 'returned',
      returned_at = statement_timestamp()
  where asset_id = p_asset_id
    and status = 'active';

  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    p_asset_id, 'status_change', v_from, p_to_status, auth.uid(),
    coalesce(nullif(p_note, ''), 'تغيير حالة')
  );
  return json_build_object('ok', true);
end
$function$;

revoke all on function public.asset_assign(uuid, uuid, date)
from public, anon;
revoke all on function public.asset_return(uuid, text)
from public, anon;
revoke all on function public.asset_change_status(
  uuid, public.asset_status, text
) from public, anon;
grant execute on function public.asset_assign(uuid, uuid, date)
to authenticated;
grant execute on function public.asset_return(uuid, text)
to authenticated;
grant execute on function public.asset_change_status(
  uuid, public.asset_status, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Read-only anomaly detector and persistent, manually resolved workflow.
-- ---------------------------------------------------------------------------

create or replace view public.custody_current_anomalies
with (security_invoker = true)
as
with custody_state as (
  select
    a.id as asset_id,
    a.asset_tag,
    a.status::text as asset_status,
    a.assigned_to_employee_id as holder_employee_id,
    count(aa.id)::integer as active_assignment_count,
    count(aa.id) filter (
      where aa.employee_id = a.assigned_to_employee_id
    )::integer as matching_assignment_count,
    bool_or(
      aa.id is not null and (e.id is null or not e.is_active)
    ) as has_inactive_employee
  from public.assets a
  left join public.asset_assignments aa
    on aa.asset_id = a.id
   and aa.status = 'active'
  left join public.employees e on e.id = aa.employee_id
  group by
    a.id,
    a.asset_tag,
    a.status,
    a.assigned_to_employee_id
)
select
  s.asset_id,
  s.asset_tag,
  s.asset_status,
  s.holder_employee_id,
  s.active_assignment_count,
  anomaly.anomaly_code
from custody_state s
cross join lateral (
  select 'assigned_without_holder'::text as anomaly_code
  where s.asset_status = 'assigned'
    and s.holder_employee_id is null
  union all
  select 'assigned_without_active'
  where s.asset_status = 'assigned'
    and s.active_assignment_count = 0
  union all
  select 'multiple_active'
  where s.active_assignment_count > 1
  union all
  select 'holder_mismatch'
  where s.asset_status = 'assigned'
    and s.active_assignment_count = 1
    and s.matching_assignment_count <> 1
  union all
  select 'active_on_nonassigned'
  where s.asset_status <> 'assigned'
    and s.active_assignment_count > 0
  union all
  select 'inactive_employee'
  where coalesce(s.has_inactive_employee, false)
) anomaly;

revoke all on public.custody_current_anomalies
from public, anon, authenticated;

create table if not exists public.custody_reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete restrict,
  anomaly_code text not null check (
    anomaly_code in (
      'assigned_without_holder',
      'assigned_without_active',
      'multiple_active',
      'holder_mismatch',
      'active_on_nonassigned',
      'inactive_employee'
    )
  ),
  status text not null default 'open' check (
    status in ('open', 'in_review', 'resolved', 'dismissed')
  ),
  detected_at timestamptz not null default statement_timestamp(),
  last_detected_at timestamptz not null default statement_timestamp(),
  snapshot jsonb not null default '{}'::jsonb,
  assigned_to uuid references public.app_users(id) on delete set null,
  resolution_code text check (
    resolution_code is null or resolution_code in (
      'holder_confirmed',
      'asset_quarantined',
      'asset_not_found',
      'investigation_opened',
      'false_positive'
    )
  ),
  resolution_notes text,
  evidence_ref text,
  resolved_at timestamptz,
  resolved_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create unique index if not exists uq_custody_open_case
on public.custody_reconciliation_cases(asset_id, anomaly_code)
where status in ('open', 'in_review');

create index if not exists idx_custody_cases_work_queue
on public.custody_reconciliation_cases(status, detected_at, id);

alter table public.custody_reconciliation_cases enable row level security;
revoke all on public.custody_reconciliation_cases
from anon, authenticated;
grant select on public.custody_reconciliation_cases
to authenticated;
grant select on public.custody_reconciliation_cases
to service_role;

drop policy if exists custody_cases_select on public.custody_reconciliation_cases;
create policy custody_cases_select
on public.custody_reconciliation_cases
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'auditor')
);

create or replace function public._custody_reconciliation_refresh()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer;
begin
  insert into public.custody_reconciliation_cases (
    asset_id,
    anomaly_code,
    snapshot
  )
  select
    a.asset_id,
    a.anomaly_code,
    jsonb_build_object(
      'asset_tag', a.asset_tag,
      'asset_status', a.asset_status,
      'holder_employee_id', a.holder_employee_id,
      'active_assignment_count', a.active_assignment_count
    )
  from public.custody_current_anomalies a
  on conflict (asset_id, anomaly_code)
    where status in ('open', 'in_review')
  do update
  set last_detected_at = statement_timestamp(),
      snapshot = excluded.snapshot,
      updated_at = statement_timestamp();
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

revoke all on function public._custody_reconciliation_refresh()
from public, anon, authenticated;

create or replace function public.custody_reconciliation_refresh()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
  v_touched integer;
  v_current integer;
begin
  if v_role is null or v_role not in ('admin', 'it_manager', 'auditor') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_touched := public._custody_reconciliation_refresh();
  select count(*) into v_current
  from public.custody_current_anomalies;
  return jsonb_build_object(
    'ok', true,
    'current_anomalies', v_current,
    'cases_touched', v_touched
  );
end
$function$;

create or replace function public.custody_reconciliation_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin', 'it_manager', 'auditor') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'ok', true,
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'asset_id', c.asset_id,
        'anomaly_code', c.anomaly_code,
        'status', c.status,
        'detected_at', c.detected_at,
        'last_detected_at', c.last_detected_at,
        'snapshot', c.snapshot,
        'assigned_to', c.assigned_to,
        'resolution_code', c.resolution_code,
        'resolution_notes', c.resolution_notes,
        'evidence_ref', c.evidence_ref,
        'resolved_at', c.resolved_at,
        'resolved_by', c.resolved_by
      ) order by c.detected_at, c.id)
      from public.custody_reconciliation_cases c
    ), '[]'::jsonb)
  );
end
$function$;

create or replace function public.custody_reconciliation_update_case(
  p_case_id uuid,
  p_status text,
  p_assigned_to uuid default null,
  p_resolution_code text default null,
  p_resolution_notes text default null,
  p_evidence_ref text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
  v_updated integer;
begin
  if v_role is null or v_role not in ('admin', 'it_manager') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_status not in ('in_review', 'resolved', 'dismissed') then
    raise exception 'invalid_case_status' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not exists (
    select 1
    from public.app_users u
    where u.id = p_assigned_to
      and u.is_active
      and u.approval_status = 'approved'
  ) then
    raise exception 'invalid_case_assignee' using errcode = '22023';
  end if;
  if p_status in ('resolved', 'dismissed') and (
    p_resolution_code is null
    or coalesce(length(btrim(p_resolution_notes)), 0) = 0
    or coalesce(length(btrim(p_evidence_ref)), 0) = 0
  ) then
    raise exception 'resolution_evidence_required' using errcode = '22023';
  end if;

  update public.custody_reconciliation_cases
  set status = p_status,
      assigned_to = p_assigned_to,
      resolution_code = p_resolution_code,
      resolution_notes = nullif(btrim(p_resolution_notes), ''),
      evidence_ref = nullif(btrim(p_evidence_ref), ''),
      resolved_at = case
        when p_status in ('resolved', 'dismissed')
          then statement_timestamp()
        else null
      end,
      resolved_by = case
        when p_status in ('resolved', 'dismissed')
          then auth.uid()
        else null
      end,
      updated_at = statement_timestamp()
  where id = p_case_id
    and status in ('open', 'in_review');
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'case_not_open' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true, 'id', p_case_id, 'status', p_status);
end
$function$;

revoke all on function public.custody_reconciliation_refresh()
from public, anon;
revoke all on function public.custody_reconciliation_list()
from public, anon;
revoke all on function public.custody_reconciliation_update_case(
  uuid, text, uuid, text, text, text
) from public, anon;
grant execute on function public.custody_reconciliation_refresh()
to authenticated;
grant execute on function public.custody_reconciliation_list()
to authenticated;
grant execute on function public.custody_reconciliation_update_case(
  uuid, text, uuid, text, text, text
) to authenticated;

-- Initial inventory only: create cases; never mutate the source records.
select public._custody_reconciliation_refresh();

commit;
