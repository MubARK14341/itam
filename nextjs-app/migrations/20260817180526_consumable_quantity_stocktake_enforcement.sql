-- Consumable profile edits are metadata-only. Absolute balance corrections
-- remain exclusively in the independently reviewed stocktake workflow.

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
  v_reorder integer;
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

  -- Fail closed even when a non-UI caller tries to smuggle an unchanged
  -- balance. Profile editing is never a quantity mutation path.
  if p_input ? 'quantity_on_hand' then
    return json_build_object('ok', false, 'error', 'quantity_requires_stocktake');
  end if;
  if coalesce(p_input->>'reorder_level', '') !~ '^[0-9]+$' then
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
    v_reorder := (p_input->>'reorder_level')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_reference_or_quantity');
  end;
  if v_reorder > 1000000 then
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

  update public.consumables
  set category_id = v_category_id,
      name = btrim(p_input->>'name'),
      sku = nullif(btrim(p_input->>'sku'), ''),
      brand = nullif(btrim(p_input->>'brand'), ''),
      unit = v_unit,
      reorder_level = v_reorder,
      company_id = v_company_id,
      supplier_id = v_supplier_id,
      location_id = v_location_id,
      rfid_tag = nullif(btrim(p_input->>'rfid_tag'), ''),
      notes = nullif(btrim(p_input->>'notes'), ''),
      unit_cost = v_cost,
      updated_at = now()
  where id = p_consumable_id;

  return json_build_object('ok', true, 'quantity_on_hand', v_old.quantity_on_hand);
end
$function$;

revoke all on function public.consumable_update_atomic(uuid, jsonb)
from public, anon;
grant execute on function public.consumable_update_atomic(uuid, jsonb)
to authenticated, service_role;

commit;
