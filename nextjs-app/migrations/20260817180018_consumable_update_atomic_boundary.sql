-- Make consumable profile edits and absolute quantity adjustments one locked
-- transaction, and prevent browser clients from forging the stock ledger.

begin;

create or replace function public.consumable_update_atomic(
  p_consumable_id uuid,
  p_input jsonb
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_old public.consumables%rowtype;
  v_category_id uuid;
  v_company_id uuid;
  v_supplier_id uuid;
  v_location_id uuid;
  v_quantity integer;
  v_reorder integer;
  v_delta integer;
  v_unit text;
  v_cost numeric;
begin
  if not public.current_user_has_capability('consumable.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or nullif(btrim(p_input->>'category_id'), '') is null
     or nullif(btrim(p_input->>'name'), '') is null then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  if coalesce(p_input->>'quantity_on_hand', '') !~ '^[0-9]+$'
     or coalesce(p_input->>'reorder_level', '') !~ '^[0-9]+$' then
    return json_build_object('ok', false, 'error', 'invalid_quantity');
  end if;

  v_unit := coalesce(nullif(p_input->>'unit', ''), 'piece');
  if v_unit not in ('piece', 'box', 'ream', 'set') then
    return json_build_object('ok', false, 'error', 'invalid_unit');
  end if;

  begin
    v_category_id := (p_input->>'category_id')::uuid;
    v_company_id := nullif(p_input->>'company_id', '')::uuid;
    v_supplier_id := nullif(p_input->>'supplier_id', '')::uuid;
    v_location_id := nullif(p_input->>'location_id', '')::uuid;
    v_quantity := (p_input->>'quantity_on_hand')::integer;
    v_reorder := (p_input->>'reorder_level')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_reference_or_quantity');
  end;
  if v_quantity > 1000000 or v_reorder > 1000000 then
    return json_build_object('ok', false, 'error', 'quantity_too_large');
  end if;

  select * into v_old
  from public.consumables
  where id = p_consumable_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'consumable_not_found');
  end if;

  v_cost := v_old.unit_cost;
  if p_input ? 'unit_cost' then
    if not public.is_financial_viewer() then
      return json_build_object('ok', false, 'error', 'financial_not_authorized');
    end if;
    begin
      v_cost := nullif(p_input->>'unit_cost', '')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      return json_build_object('ok', false, 'error', 'invalid_financial_value');
    end;
    if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
      return json_build_object('ok', false, 'error', 'invalid_financial_value');
    end if;
  end if;

  v_delta := abs(v_quantity - v_old.quantity_on_hand);
  if v_delta > 0 then
    insert into public.consumable_transactions (
      consumable_id, txn_type, quantity, previous_quantity, balance_after,
      reason, performed_by
    ) values (
      p_consumable_id, 'adjust', v_delta, v_old.quantity_on_hand, v_quantity,
      'تسوية عبر تعديل بيانات المستهلك', auth.uid()
    );
  end if;

  update public.consumables
  set category_id = v_category_id,
      name = btrim(p_input->>'name'),
      sku = nullif(btrim(p_input->>'sku'), ''),
      brand = nullif(btrim(p_input->>'brand'), ''),
      unit = v_unit,
      quantity_on_hand = v_quantity,
      reorder_level = v_reorder,
      company_id = v_company_id,
      supplier_id = v_supplier_id,
      location_id = v_location_id,
      rfid_tag = nullif(btrim(p_input->>'rfid_tag'), ''),
      notes = nullif(btrim(p_input->>'notes'), ''),
      unit_cost = v_cost,
      updated_at = now()
  where id = p_consumable_id;

  return json_build_object('ok', true, 'quantity_on_hand', v_quantity);
end
$function$;

revoke all on function public.consumable_update_atomic(uuid, jsonb)
from public, anon;
grant execute on function public.consumable_update_atomic(uuid, jsonb)
to authenticated, service_role;

-- All browser writes now use consumable_create_with_opening_stock,
-- consumable_update_atomic, or consumable_stock_move.  The ledger itself is
-- append-only through those self-authorizing RPCs.
revoke insert, update, delete
on public.consumables, public.consumable_transactions
from anon, authenticated;

drop policy if exists ins_ops on public.consumables;
drop policy if exists ins_managers on public.consumables;
drop policy if exists ins_capability on public.consumables;
drop policy if exists upd_ops on public.consumables;
drop policy if exists upd_managers on public.consumables;
drop policy if exists upd_capability on public.consumables;
drop policy if exists del_admin on public.consumables;

drop policy if exists ins_ops on public.consumable_transactions;
drop policy if exists ins_managers on public.consumable_transactions;
drop policy if exists ins_capability on public.consumable_transactions;
drop policy if exists upd_ops on public.consumable_transactions;
drop policy if exists upd_managers on public.consumable_transactions;
drop policy if exists upd_capability on public.consumable_transactions;
drop policy if exists del_admin on public.consumable_transactions;

commit;
