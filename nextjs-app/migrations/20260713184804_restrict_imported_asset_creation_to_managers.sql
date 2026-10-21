-- Purpose: prevent SECURITY DEFINER import_inventory from bypassing the
-- admin/it_manager-only asset creation rule. Consumable imports are unchanged.
-- Rollback: restore import_inventory from 20260705160000_granular_capabilities.sql.

create or replace function public.import_inventory(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role        text := public.app_user_role();
  v_fin         boolean := public.is_financial_viewer();
  v_item        jsonb;
  v_type        text;
  v_id          uuid;
  v_status      asset_status;
  v_loc         uuid;
  v_qty         integer;
  v_cost        numeric;
  v_assets      integer := 0;
  v_consumables integer := 0;
  v_idx         integer := 0;
begin
  if not public.has_capability(auth.uid(), 'asset.import') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_idx  := v_idx + 1;
    v_type := v_item->>'item_type';
    if v_type = 'asset' then
      if v_role is null or v_role not in ('admin','it_manager') then
        raise exception 'asset_create_not_authorized' using errcode = '42501';
      end if;
      insert into public.assets (
        category_id, name, serial_number, status, location_id, company_id, supplier_id,
        purchase_date, purchase_cost, warranty_end, condition_grade, rfid_tag, notes
      ) values (
        (v_item->>'category_id')::uuid,
        nullif(v_item->>'name',''), nullif(v_item->>'serial_number',''),
        coalesce(nullif(v_item->>'status',''),'available')::asset_status,
        nullif(v_item->>'location_id','')::uuid, nullif(v_item->>'company_id','')::uuid,
        nullif(v_item->>'supplier_id','')::uuid, nullif(v_item->>'purchase_date','')::date,
        case when v_fin then nullif(v_item->>'purchase_cost','')::numeric else null end,
        nullif(v_item->>'warranty_end','')::date, nullif(v_item->>'condition_grade',''),
        nullif(v_item->>'rfid_tag',''), nullif(v_item->>'notes','')
      ) returning id, status, location_id into v_id, v_status, v_loc;
      insert into public.asset_movements (asset_id, movement_type, to_status, to_location_id, performed_by, note)
      values (v_id, 'create'::movement_type, v_status, v_loc, auth.uid(), 'استيراد CSV');
      v_assets := v_assets + 1;
    elsif v_type = 'consumable' then
      v_qty  := coalesce(floor(nullif(v_item->>'quantity','')::numeric), 0)::integer;
      v_cost := case when v_fin then nullif(v_item->>'unit_cost','')::numeric else null end;
      insert into public.consumables (
        category_id, name, sku, unit, quantity_on_hand, reorder_level,
        company_id, supplier_id, location_id, unit_cost, rfid_tag, notes
      ) values (
        (v_item->>'category_id')::uuid, nullif(v_item->>'name',''), nullif(v_item->>'sku',''),
        coalesce(nullif(v_item->>'unit',''),'each'), v_qty,
        coalesce(floor(nullif(v_item->>'reorder_level','')::numeric), 0)::integer,
        nullif(v_item->>'company_id','')::uuid, nullif(v_item->>'supplier_id','')::uuid,
        nullif(v_item->>'location_id','')::uuid, v_cost,
        nullif(v_item->>'rfid_tag',''), nullif(v_item->>'notes','')
      ) returning id into v_id;
      if v_qty > 0 then
        insert into public.consumable_transactions (
          consumable_id, txn_type, quantity, previous_quantity, balance_after,
          unit_cost, total_cost, supplier_id, reason, performed_by
        ) values (
          v_id, 'in'::consumable_txn_type, v_qty, 0, v_qty, v_cost,
          case when v_cost is not null then v_cost * v_qty else null end,
          nullif(v_item->>'supplier_id','')::uuid, 'رصيد افتتاحي (استيراد)', auth.uid()
        );
      end if;
      v_consumables := v_consumables + 1;
    else
      raise exception 'invalid_item_type at row %', v_idx using errcode = '22023';
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'assets', v_assets, 'consumables', v_consumables);
end
$function$;
