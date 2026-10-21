-- Purpose: Record canonical exact-asset allocations for automatic provisioning.
-- Risk: Additive allocation evidence only for deterministic reserved asset
-- request items; no RLS, role, financial, or custody rule is broadened.
-- Rollback: Drop the trigger and restore the prior trusted workflow behavior;
-- retain allocation evidence already created.

begin;

-- Reconcile the sole deterministic active reservation missing its canonical
-- allocation. This intentionally excludes historical, multi-quantity,
-- completed, duplicate, and ambiguous records.
insert into public.request_asset_allocations (
  request_id, request_item_id, asset_id, state, selected_by, selected_at
)
select
  ri.request_id,
  ri.id,
  ri.asset_id,
  'selected',
  coalesce(r.prepared_by, r.created_by),
  coalesce(r.prepared_at, ri.created_at)
from public.request_items ri
join public.requests r on r.id = ri.request_id
join public.assets a on a.id = ri.asset_id
where ri.item_kind = 'asset'
  and ri.asset_id is not null
  and ri.quantity = 1
  and r.status in ('approved', 'provisioned', 'preparing')
  and a.status = 'reserved'
  and coalesce(r.prepared_by, r.created_by) is not null
  and not exists (
    select 1
    from public.request_asset_allocations allocation
    where allocation.request_item_id = ri.id
  )
  and not exists (
    select 1
    from public.request_asset_allocations allocation
    where allocation.asset_id = ri.asset_id
      and allocation.state in ('selected', 'prepared', 'delivered')
  );

-- Only the pre-existing trusted auto-provision transaction sets this local
-- flag. Direct clients have no table write grant, and the trigger function is
-- not executable as a public RPC.
create or replace function public.request_items_auto_provision_allocation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if current_setting('app.request_fulfillment_apply', true) = 'on'
     and new.item_kind = 'asset'
     and new.asset_id is not null then
    insert into public.request_asset_allocations (
      request_id, request_item_id, asset_id, state, selected_by
    ) values (
      new.request_id, new.id, new.asset_id, 'selected', auth.uid()
    )
    on conflict (request_item_id, asset_id) do nothing;
  end if;
  return new;
end
$function$;

drop trigger if exists request_items_auto_provision_allocation on public.request_items;
create trigger request_items_auto_provision_allocation
after insert on public.request_items
for each row execute function public.request_items_auto_provision_allocation();

revoke all on function public.request_items_auto_provision_allocation() from public, anon, authenticated;

commit;
