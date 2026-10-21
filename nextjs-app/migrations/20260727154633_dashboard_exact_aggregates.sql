-- Batch 8: exact, non-financial dashboard aggregates.  Detail rows remain
-- bounded for rendering; enterprise KPIs no longer depend on PostgREST's
-- 1,000-row response cap.

begin;

create or replace function public.dashboard_operational_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
with
guard as (
  select public.is_approved() as allowed
),
asset_counts as (
  select
    count(*) as total,
    count(*) filter (where status = 'available') as available,
    count(*) filter (where status = 'assigned') as assigned,
    count(*) filter (where status = 'in_maintenance') as in_maintenance,
    count(*) filter (where status = 'lost') as lost,
    count(*) filter (where status = 'damaged') as damaged,
    count(*) filter (where status = 'retired') as retired
  from public.assets, guard
  where is_active and guard.allowed
),
consumable_counts as (
  select
    count(*) filter (
      where reorder_level > 0 and quantity_on_hand <= reorder_level
    ) as at_risk,
    count(*) filter (where quantity_on_hand = 0) as stockout,
    count(*) filter (where reorder_level <= 0) as without_threshold
  from public.consumables, guard
  where is_active and guard.allowed
),
maintenance_counts as (
  select
    count(*) filter (
      where status in ('open', 'in_progress')
        and reported_at < now() - interval '14 days'
    ) as long_open,
    count(*) filter (
      where status in ('open', 'in_progress')
        and nullif(btrim(action_taken), '') is null
        and technician_id is null
    ) as no_action,
    count(*) filter (
      where status in ('open', 'in_progress')
        and (
          reported_at < now() - interval '14 days'
          or (
            nullif(btrim(action_taken), '') is null
            and technician_id is null
          )
        )
    ) as followup
  from public.maintenance_records, guard
  where guard.allowed
),
request_counts as (
  select
    count(*) filter (where status = 'under_review') as actionable,
    count(*) filter (
      where status = 'overdue'
        or (
          status in ('delivered', 'partially_returned')
          and return_date < (now() at time zone 'Asia/Riyadh')::date
        )
    ) as overdue,
    count(*) filter (
      where status in (
        'approved', 'auto_provisioning', 'provisioned',
        'stock_shortage', 'preparing'
      )
    ) as preparation,
    count(*) filter (where status = 'ready_for_pickup') as ready_delivery,
    count(*) filter (
      where status in ('delivered', 'partially_returned', 'overdue')
        and return_date <= (now() at time zone 'Asia/Riyadh')::date
    ) as returns_due,
    count(*) filter (where status = 'returned') as returned_inspection
  from public.requests, guard
  where guard.allowed
    and portal_approval_status not in (
      'pending_project_manager', 'rejected_by_project_manager'
    )
)
select jsonb_build_object(
  'assets', jsonb_build_object(
    'total', a.total,
    'available', a.available,
    'assigned', a.assigned,
    'in_maintenance', a.in_maintenance,
    'lost', a.lost,
    'damaged', a.damaged,
    'retired', a.retired
  ),
  'consumables', jsonb_build_object(
    'at_risk', c.at_risk,
    'stockout', c.stockout,
    'without_threshold', c.without_threshold
  ),
  'maintenance', jsonb_build_object(
    'long_open', m.long_open,
    'no_action', m.no_action,
    'followup', m.followup
  ),
  'requests', jsonb_build_object(
    'actionable', r.actionable,
    'overdue', r.overdue,
    'preparation', r.preparation,
    'ready_delivery', r.ready_delivery,
    'returns_due', r.returns_due,
    'returned_inspection', r.returned_inspection
  )
)
from asset_counts a
cross join consumable_counts c
cross join maintenance_counts m
cross join request_counts r;
$function$;

revoke all on function public.dashboard_operational_summary()
from public, anon;
grant execute on function public.dashboard_operational_summary()
to authenticated;

commit;
