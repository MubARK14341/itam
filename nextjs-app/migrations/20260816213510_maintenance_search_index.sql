-- Purpose: flatten non-financial maintenance and asset search fields so one
-- RLS-preserving Data API query can paginate every matching maintenance row.
-- Risk: additive view only; underlying table RLS and column grants remain the
-- authorization source of truth. No data is copied or mutated.
-- Rollback: drop view if exists public.maintenance_search_index;

create or replace view public.maintenance_search_index
with (security_invoker = true)
as
select
  m.id,
  m.asset_id,
  m.status,
  m.type,
  m.problem_type,
  m.technician_id,
  m.action_taken,
  m.next_due_date,
  m.problem_description,
  m.reported_at,
  a.asset_tag,
  a.name as asset_name,
  a.serial_number as asset_serial_number
from public.maintenance_records m
left join public.assets a on a.id = m.asset_id;

revoke all on public.maintenance_search_index from public;
revoke all on public.maintenance_search_index from anon;
revoke all on public.maintenance_search_index from authenticated;
grant select on public.maintenance_search_index to authenticated;

comment on view public.maintenance_search_index is
  'Non-financial, security-invoker search projection for cursor-paginated maintenance lists.';
