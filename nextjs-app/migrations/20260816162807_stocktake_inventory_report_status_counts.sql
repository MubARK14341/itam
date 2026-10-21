-- Purpose: restore distinct, authoritative reserved and delivered/custody counts
-- in the registered-assets report after primary asset statuses were simplified.
-- Risk: low/additive. The RPC is read-only, non-financial, and restricted to the
-- existing stocktake read roles; no asset or workflow row is modified.
-- Rollback: drop public.stocktake_system_inventory_report(uuid) after reverting
-- the client to its prior report query.

begin;

create or replace function public.stocktake_system_inventory_report(
  p_location_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_report jsonb;
begin
  if not public._stocktake_can_read() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_location_id is null or not exists (
    select 1
    from public.locations l
    where l.id = p_location_id and l.is_active
  ) then
    raise exception 'active_location_required' using errcode = '22023';
  end if;

  with inventory as materialized (
    select
      a.status,
      a.location_id,
      (
        exists (
          select 1
          from public.asset_assignments aa
          where aa.asset_id = a.id and aa.status = 'active'
        )
        or exists (
          select 1
          from public.request_asset_allocations ra
          where ra.asset_id = a.id and ra.state = 'delivered'
        )
      ) as is_delivered
    from public.assets a
    where a.is_active
  )
  select jsonb_build_object(
    'registered', count(*) filter (where i.location_id = p_location_id),
    'available', count(*) filter (
      where i.location_id = p_location_id and i.status = 'available'
    ),
    'reserved', count(*) filter (
      where i.location_id = p_location_id
        and i.status = 'reserved'
        and not i.is_delivered
    ),
    'delivered', count(*) filter (
      where i.status = 'reserved' and i.is_delivered
    ),
    'inMaintenance', count(*) filter (where i.status = 'in_maintenance'),
    'dataIssues', count(*) filter (where i.location_id is null)
  )
  into v_report
  from inventory i;

  return v_report;
end;
$function$;

revoke all on function public.stocktake_system_inventory_report(uuid)
from public, anon, authenticated;
grant execute on function public.stocktake_system_inventory_report(uuid)
to authenticated;

comment on function public.stocktake_system_inventory_report(uuid) is
  'Non-financial registered-assets report. Reserved excludes assets already delivered or held in active custody.';

commit;
