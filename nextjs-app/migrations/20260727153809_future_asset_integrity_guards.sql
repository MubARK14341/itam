-- F-007: prevent new asset ownership/location/creator and assignment
-- inconsistencies without inventing values for ambiguous historical rows.

begin;

create or replace function public.assets_guard_future_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.created_by is null then
      raise exception 'asset_creator_required' using errcode = '23514';
    end if;
    if new.company_id is null then
      raise exception 'asset_company_required' using errcode = '23514';
    end if;
    if new.location_id is null then
      raise exception 'asset_location_required' using errcode = '23514';
    end if;
    if nullif(btrim(new.serial_number), '') is null
       and not coalesce(new.serial_exempt, false) then
      raise exception 'asset_serial_required' using errcode = '23514';
    end if;
  else
    -- Legacy nulls remain untouched until a human can establish the truth, but
    -- a known value can never be cleared and created_by is immutable.
    if old.company_id is not null and new.company_id is null then
      raise exception 'asset_company_cannot_be_cleared' using errcode = '23514';
    end if;
    if old.location_id is not null and new.location_id is null then
      raise exception 'asset_location_cannot_be_cleared' using errcode = '23514';
    end if;
    if old.created_by is not null and new.created_by is distinct from old.created_by then
      raise exception 'asset_creator_immutable' using errcode = '23514';
    end if;
    if old.created_by is null and new.created_by is null then
      new.created_by := null; -- do not fabricate history during unrelated edits
    end if;
  end if;

  if new.status = 'assigned' and new.assigned_to_employee_id is null then
    raise exception 'assigned_employee_required' using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_assets_guard_future_integrity on public.assets;
create trigger trg_assets_guard_future_integrity
before insert or update on public.assets
for each row execute function public.assets_guard_future_integrity();

-- Deterministic legacy repair only: an immutable INSERT audit event with one
-- unambiguous actor proves who created the row.  Rows without that evidence
-- remain null for human remediation.
with proven_creator as (
  select a.id, min(al.changed_by::text)::uuid as creator_id
  from public.assets a
  join public.audit_logs al
    on al.table_name = 'assets'
   and al.record_id = a.id::text
   and al.action = 'INSERT'
   and al.changed_by is not null
  where a.created_by is null
  group by a.id
  having count(distinct al.changed_by) = 1
)
update public.assets a
set created_by = p.creator_id
from proven_creator p
where a.id = p.id and a.created_by is null;

-- A deferred check permits one transaction to update the asset and create its
-- assignment in either statement order, but rejects COMMIT unless the final
-- state has exactly one matching active assignment.
create or replace function public.assets_check_assigned_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_count integer;
begin
  if new.status <> 'assigned' then
    return new;
  end if;
  select count(*) into v_count
  from public.asset_assignments aa
  where aa.asset_id = new.id
    and aa.status = 'active'
    and aa.employee_id = new.assigned_to_employee_id;
  if v_count <> 1 then
    raise exception 'assigned_asset_requires_one_matching_active_assignment'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_assets_assigned_integrity_insert on public.assets;
create constraint trigger trg_assets_assigned_integrity_insert
after insert on public.assets
deferrable initially deferred
for each row
when (new.status = 'assigned')
execute function public.assets_check_assigned_integrity();

drop trigger if exists trg_assets_assigned_integrity_update on public.assets;
create constraint trigger trg_assets_assigned_integrity_update
after update of status, assigned_to_employee_id on public.assets
deferrable initially deferred
for each row
when (new.status = 'assigned')
execute function public.assets_check_assigned_integrity();

create unique index if not exists uq_maintenance_one_active_per_asset
on public.maintenance_records(asset_id)
where status <> 'cancelled'
  and coalesce(workflow_stage, 'open') in (
    'open', 'investigating', 'awaiting_parts', 'at_vendor'
  );

-- Keep trigger helpers off the API surface.
revoke all on function public.assets_guard_future_integrity()
from public, anon, authenticated;
revoke all on function public.assets_check_assigned_integrity()
from public, anon, authenticated;

commit;
