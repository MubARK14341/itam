-- M4 (RC1 hygiene, 2026-07-07): financial WRITE guard on consumables.unit_cost.
-- consumables.unit_cost is already READ-blocked at the column-grant level (HIGH-1),
-- but — unlike purchase_request_items (pr_items_guard_financial) and maintenance_records
-- (maintenance_guard_financial) — it had no WRITE guard, so a non-financial writer
-- (technician/viewer/auditor) could set/overwrite the stored catalog cost. This mirrors
-- pr_items_guard_financial verbatim. Financial viewers (admin/it_manager, is_approved)
-- are unaffected. Additive only: one trigger function + one BEFORE INSERT/UPDATE trigger.
-- Note: consumables already has trg_consumables_updated (BEFORE UPDATE -> set_updated_at),
-- so this guard intentionally touches unit_cost only and does not set updated_at.

create or replace function public.consumables_guard_financial()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if not public.is_financial_viewer() then
    if tg_op = 'INSERT' then
      new.unit_cost := null;
    elsif new.unit_cost is distinct from old.unit_cost then
      new.unit_cost := old.unit_cost;
    end if;
  end if;
  return new;
end $$;

-- trigger functions fire as the table owner; do not expose it as a callable RPC
revoke execute on function public.consumables_guard_financial() from public, anon, authenticated;

drop trigger if exists trg_consumables_guard_financial on public.consumables;
create trigger trg_consumables_guard_financial
  before insert or update on public.consumables
  for each row execute function public.consumables_guard_financial();
