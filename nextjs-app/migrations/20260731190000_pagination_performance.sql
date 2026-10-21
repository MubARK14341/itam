begin;

-- Cursor query support. Each index corresponds to a list query in src/lib that
-- orders by the timestamp and UUID as a deterministic tie-breaker.
create index if not exists idx_requests_created_id_desc
  on public.requests (created_at desc, id desc);
drop index if exists public.idx_requests_created_at;
create index if not exists idx_maintenance_reported_id_desc
  on public.maintenance_records (reported_at desc, id desc);
create index if not exists idx_purchase_requests_created_id_desc
  on public.purchase_requests (created_at desc, id desc);
create index if not exists idx_action_alerts_last_seen_id_desc
  on public.action_alert_instances (last_seen_at desc, id desc);
create index if not exists idx_audit_events_v2_occurred_id_desc
  on public.audit_events_v2 (occurred_at desc, id desc);
create index if not exists idx_assets_company
  on public.assets (company_id);
create index if not exists idx_consumables_company
  on public.consumables (company_id);
create index if not exists idx_consumables_location
  on public.consumables (location_id);
create index if not exists idx_consumables_name_id
  on public.consumables (name, id);

-- KPI values are computed over the full authorized relation, never the
-- currently loaded cursor page.
create or replace function public.request_operational_counts()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with visible as (
    select r.status, r.return_date
    from public.requests r
    where public.is_approved()
      and r.portal_approval_status not in (
        'pending_project_manager',
        'rejected_by_project_manager'
      )
  )
  select jsonb_build_object(
    'total', count(*),
    'review', count(*) filter (
      where status in ('draft', 'under_review', 'needs_clarification')
    ),
    'awaiting', count(*) filter (
      where status in (
        'approved', 'auto_provisioning', 'provisioned',
        'stock_shortage', 'preparing', 'ready_for_pickup'
      )
    ),
    'out', count(*) filter (
      where status in ('delivered', 'partially_returned')
    ),
    'completed', count(*) filter (where status = 'completed'),
    'overdue', count(*) filter (
      where status = 'overdue'
         or (
           status in ('delivered', 'partially_returned')
           and return_date < current_date
         )
    )
  )
  from visible
$function$;

create or replace function public.request_filter_options()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with visible as (
    select
      r.project_city,
      r.customer_id,
      r.customer_name_snapshot,
      r.responsible_employee_id
    from public.requests r
    where public.is_approved()
      and r.portal_approval_status not in (
        'pending_project_manager',
        'rejected_by_project_manager'
      )
  )
  select jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(city order by city)
      from (
        select distinct project_city as city
        from visible
        where project_city is not null and project_city <> ''
      ) city_rows
    ), '[]'::jsonb),
    'customers', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', customer_id, 'name', customer_name)
        order by customer_name
      )
      from (
        select distinct
          v.customer_id,
          coalesce(c.name, v.customer_name_snapshot) as customer_name
        from visible v
        left join public.customers c on c.id = v.customer_id
        where v.customer_id is not null
      ) customer_rows
    ), '[]'::jsonb),
    'responsible_ids', coalesce((
      select jsonb_agg(responsible_employee_id order by responsible_employee_id)
      from (
        select distinct responsible_employee_id
        from visible
        where responsible_employee_id is not null
      ) responsible_rows
    ), '[]'::jsonb)
  )
$function$;

create or replace function public.maintenance_operational_summary()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with scoped as (
    select
      m.status,
      m.cost,
      m.cost_recorded,
      coalesce(nullif(m.currency, ''), 'SAR') as currency
    from public.maintenance_records m
    where public.is_approved()
  ),
  aggregate as (
    select
      count(*) filter (where status = 'open') as open_count,
      count(*) filter (where status = 'in_progress') as in_progress_count,
      count(*) filter (where status = 'completed') as completed_count,
      count(*) as record_count,
      count(*) filter (where cost_recorded and cost is not null) as recorded_count,
      count(distinct currency) filter (where cost_recorded and cost is not null) as currencies,
      min(currency) filter (where cost_recorded and cost is not null) as currency,
      sum(cost) filter (where cost_recorded and cost is not null) as amount
    from scoped
  )
  select jsonb_build_object(
    'open', open_count,
    'in_progress', in_progress_count,
    'completed', completed_count,
    'cost', jsonb_build_object(
      'state', case
        when not public.is_financial_viewer() then 'forbidden'
        when record_count = 0 or recorded_count <> record_count then 'missing'
        when currencies <> 1 then 'mixed_currency'
        else 'available'
      end,
      'amount', case
        when public.is_financial_viewer()
          and record_count > 0
          and recorded_count = record_count
          and currencies = 1
        then amount
        else null
      end,
      'currency', case when currencies = 1 then currency else null end,
      'coverage_pct', case
        when not public.is_financial_viewer() or record_count = 0 then 0
        else round((recorded_count::numeric / record_count::numeric) * 100, 2)
      end,
      'used_records', case
        when public.is_financial_viewer() then recorded_count else 0
      end,
      'excluded_records', case
        when public.is_financial_viewer() then record_count - recorded_count
        else record_count
      end
    )
  )
  from aggregate
$function$;

create or replace function public.action_alert_operational_counts()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'needs_action', count(*) filter (where status in ('open', 'reopened')),
    'high_severity', count(*) filter (
      where status in ('open', 'reopened')
        and severity in ('critical', 'high')
    ),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'mine', count(*) filter (
      where assigned_to = auth.uid() and status <> 'auto_resolved'
    ),
    'resolved', count(*) filter (where status = 'auto_resolved'),
    'resolved_today', count(*) filter (
      where status = 'auto_resolved'
        and auto_resolved_at::date = current_date
    )
  )
  from public.action_alert_instances
  where public.is_approved()
$function$;

revoke all on function public.request_operational_counts() from public, anon;
revoke all on function public.request_filter_options() from public, anon;
revoke all on function public.maintenance_operational_summary() from public, anon;
revoke all on function public.action_alert_operational_counts() from public, anon;
grant execute on function public.request_operational_counts() to authenticated;
grant execute on function public.request_filter_options() to authenticated;
grant execute on function public.maintenance_operational_summary() to authenticated;
grant execute on function public.action_alert_operational_counts() to authenticated;

commit;
