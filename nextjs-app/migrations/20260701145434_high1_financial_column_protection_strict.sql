-- ============================================================================
--  HIGH-1 (Phase 2) — Financial API Protection (Strict) — APPLIED 2026-07-01
--  (version 20260701145434). Mirror of the live migration.
--
--  is_financial_viewer() + 6 financial RPCs (SECURITY DEFINER, self-gated)
--  + maintenance cost write-guard trigger.
--  ⚠️ ملاحظة: أوامر REVOKE على مستوى العمود هنا كانت بلا أثر لأن authenticated يملك
--  GRANT SELECT على مستوى الجدول؛ الحجب الفعلي تمّ في المهاجرة التالية
--  20260701150032_high1b_financial_column_grants_correction (revoke table + grant columns).
--  غير مدمّر: صلاحيات/دوال/trigger فقط.
-- ============================================================================

create or replace function public.is_financial_viewer()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_user_role() in ('admin','it_manager') and public.is_approved();
$$;
revoke all on function public.is_financial_viewer() from public, anon;
grant execute on function public.is_financial_viewer() to authenticated;

-- (بلا أثر — صُحّح في HIGH-1b) محاولة حجب على مستوى العمود:
revoke select (purchase_cost, salvage_rate)   on public.assets                  from authenticated;
revoke select (unit_cost)                     on public.consumables             from authenticated;
revoke select (unit_cost, total_cost)         on public.consumable_transactions from authenticated;
revoke select (cost)                          on public.maintenance_records     from authenticated;
revoke select (unit_price, total_price)       on public.request_items           from authenticated;
revoke select (annual_rate, salvage_rate)     on public.depreciation_rules      from authenticated;

create or replace function public.assets_financial(p_ids uuid[])
returns table (id uuid, purchase_cost numeric)
language sql stable security definer set search_path = public as $$
  select a.id, a.purchase_cost from public.assets a
  where public.is_financial_viewer() and a.id = any(p_ids);
$$;
create or replace function public.consumables_financial(p_ids uuid[])
returns table (id uuid, unit_cost numeric)
language sql stable security definer set search_path = public as $$
  select c.id, c.unit_cost from public.consumables c
  where public.is_financial_viewer() and c.id = any(p_ids);
$$;
create or replace function public.consumable_txn_financial(p_ids uuid[])
returns table (id uuid, unit_cost numeric, total_cost numeric)
language sql stable security definer set search_path = public as $$
  select t.id, t.unit_cost, t.total_cost from public.consumable_transactions t
  where public.is_financial_viewer() and t.id = any(p_ids);
$$;
create or replace function public.maintenance_financial(p_ids uuid[])
returns table (id uuid, cost numeric)
language sql stable security definer set search_path = public as $$
  select m.id, m.cost from public.maintenance_records m
  where public.is_financial_viewer() and m.id = any(p_ids);
$$;
create or replace function public.request_items_financial(p_request_ids uuid[])
returns table (id uuid, request_id uuid, unit_price numeric, total_price numeric)
language sql stable security definer set search_path = public as $$
  select ri.id, ri.request_id, ri.unit_price, ri.total_price from public.request_items ri
  where public.is_financial_viewer() and ri.request_id = any(p_request_ids);
$$;
create or replace function public.depreciation_financial()
returns table (id uuid, annual_rate numeric, salvage_rate numeric)
language sql stable security definer set search_path = public as $$
  select d.id, d.annual_rate, d.salvage_rate from public.depreciation_rules d
  where public.is_financial_viewer();
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.assets_financial(uuid[])','public.consumables_financial(uuid[])',
    'public.consumable_txn_financial(uuid[])','public.maintenance_financial(uuid[])',
    'public.request_items_financial(uuid[])','public.depreciation_financial()'
  ] loop
    execute format('revoke all on function %s from public, anon;', fn);
    execute format('grant execute on function %s to authenticated;', fn);
  end loop;
end $$;

create or replace function public.maintenance_guard_financial()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_financial_viewer() then
    if tg_op = 'INSERT' then new.cost := null; else new.cost := old.cost; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_maintenance_guard_financial on public.maintenance_records;
create trigger trg_maintenance_guard_financial
  before insert or update on public.maintenance_records
  for each row execute function public.maintenance_guard_financial();
