-- Repair stocktake snapshots after the assets model details were normalized.
-- Additive/forward-only: retain the original count and review workflow.
begin;

create or replace function public.stocktake_create(
  p_title text, p_location_id uuid, p_operation_id uuid,
  p_correction_of uuid default null, p_scope_kind text default 'full',
  p_scope_category_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_existing jsonb; v_id uuid; v_code text; v_expected integer; v_result jsonb; v_category text;
begin
  if not public._stocktake_can_manage() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_operation_id is null then raise exception 'operation_id_required' using errcode='22023'; end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'create'); if v_existing is not null then return v_existing; end if;
  if coalesce(length(btrim(p_title)),0) < 3 or length(p_title) > 160 then raise exception 'invalid_title' using errcode='22023'; end if;
  if p_scope_kind not in ('full','partial') or (p_scope_kind='full' and p_scope_category_id is not null) or (p_scope_kind='partial' and p_scope_category_id is null) then raise exception 'invalid_inventory_scope' using errcode='22023'; end if;
  if not exists(select 1 from public.locations l where l.id=p_location_id and l.is_active) then raise exception 'location_not_found' using errcode='22023'; end if;
  if p_scope_kind='partial' then select coalesce(c.name_ar,c.name) into v_category from public.categories c where c.id=p_scope_category_id; if v_category is null then raise exception 'category_not_found' using errcode='22023'; end if; end if;
  v_id:=gen_random_uuid(); v_code:='STK-'||upper(substr(replace(v_id::text,'-',''),1,10));
  insert into public.stocktakes(id,code,title,location_id,status,created_by,snapshot_at,blind_count,review_state,correction_of,create_operation_id,scope_kind,scope_category_id,scope_label)
  values(v_id,v_code,btrim(p_title),p_location_id,'draft',auth.uid(),now(),true,'counting',p_correction_of,p_operation_id,p_scope_kind,p_scope_category_id,coalesce(v_category,'Full inventory'));
  insert into public.stocktake_items(stocktake_id,asset_id,item_kind,is_expected,expected_status,expected_location_id,snapshot_asset_tag,snapshot_asset_name,snapshot_serial_number,snapshot_rfid_tag,snapshot_category_name,snapshot_manufacturer,snapshot_model)
  select v_id,a.id,'asset',true,a.status,a.location_id,a.asset_tag,a.name,a.serial_number,a.rfid_tag,coalesce(c.name_ar,c.name),m.brand,m.model_name
  from public.assets a left join public.categories c on c.id=a.category_id left join public.models m on m.id=a.model_id
  where a.is_active and a.archived_at is null and a.location_id=p_location_id and (p_scope_kind='full' or a.category_id=p_scope_category_id) order by a.id;
  get diagnostics v_expected=row_count; update public.stocktakes set expected_count=v_expected where id=v_id;
  perform public._stocktake_event(v_id,'created',p_operation_id,null,null,jsonb_build_object('location_id',p_location_id,'scope_kind',p_scope_kind,'scope_category_id',p_scope_category_id,'expected_count',v_expected),null);
  v_result:=jsonb_build_object('ok',true,'id',v_id,'code',v_code,'expected_count',v_expected);
  return public._stocktake_record_operation(p_operation_id,v_id,'create',v_result);
end $function$;

create or replace function public.stocktake_scan(p_stocktake_id uuid,p_identifier text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_existing jsonb; v_take public.stocktakes%rowtype; v_asset public.assets%rowtype; v_item public.stocktake_items%rowtype; v_count integer; v_result jsonb; v_classification text;
begin
  if not public._stocktake_can_manage() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_operation_id is null then raise exception 'operation_id_required' using errcode='22023'; end if;
  v_existing:=public._stocktake_existing_operation(p_operation_id,'scan'); if v_existing is not null then return v_existing; end if;
  if coalesce(length(btrim(p_identifier)),0)=0 or length(p_identifier)>255 then raise exception 'invalid_identifier' using errcode='22023'; end if;
  select * into v_take from public.stocktakes where id=p_stocktake_id for update; if not found or v_take.status<>'in_progress' or v_take.review_state not in ('counting','recount') then raise exception 'stocktake_not_countable' using errcode='22023'; end if;
  select count(*) into v_count from public.assets a where a.is_active and a.archived_at is null and (lower(a.asset_tag)=lower(btrim(p_identifier)) or lower(coalesce(a.serial_number,''))=lower(btrim(p_identifier)) or lower(coalesce(a.rfid_tag,''))=lower(btrim(p_identifier)) or lower(a.qr_token)=lower(btrim(p_identifier)));
  if v_count=0 then raise exception 'asset_not_found' using errcode='P0002'; elsif v_count>1 then raise exception 'identifier_ambiguous' using errcode='21000'; end if;
  select * into v_asset from public.assets a where a.is_active and a.archived_at is null and (lower(a.asset_tag)=lower(btrim(p_identifier)) or lower(coalesce(a.serial_number,''))=lower(btrim(p_identifier)) or lower(coalesce(a.rfid_tag,''))=lower(btrim(p_identifier)) or lower(a.qr_token)=lower(btrim(p_identifier))) for update;
  select * into v_item from public.stocktake_items where stocktake_id=p_stocktake_id and asset_id=v_asset.id for update;
  if found and v_item.scanned then
    perform public._stocktake_event(p_stocktake_id,'duplicate_scan',p_operation_id,v_item.id,null,jsonb_build_object('asset_id',v_asset.id),null);
    v_result:=jsonb_build_object('ok',true,'item_id',v_item.id,'asset_id',v_asset.id,'asset_tag',v_item.snapshot_asset_tag,'asset_name',v_item.snapshot_asset_name,'classification','duplicate_scan','count_round',v_item.count_round);
    return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'scan',v_result);
  end if;
  if found then v_classification:=case when v_asset.location_id is not distinct from v_take.location_id then 'found' else 'wrong_location' end;
    update public.stocktake_items set scanned=true,found=true,scanned_at=now(),scanned_by=auth.uid(),observed_location_id=v_take.location_id,observed_identifier=btrim(p_identifier),observation_status=v_classification,recount_required=false where id=v_item.id returning * into v_item;
  else v_classification:='unexpected';
    insert into public.stocktake_items(stocktake_id,asset_id,item_kind,is_expected,expected_status,expected_location_id,snapshot_asset_tag,snapshot_asset_name,snapshot_serial_number,snapshot_rfid_tag,snapshot_category_name,snapshot_manufacturer,snapshot_model,scanned,found,scanned_at,scanned_by,observed_location_id,observed_identifier,observation_status)
    select p_stocktake_id,a.id,'asset',false,a.status,a.location_id,a.asset_tag,a.name,a.serial_number,a.rfid_tag,coalesce(c.name_ar,c.name),m.brand,m.model_name,true,true,now(),auth.uid(),v_take.location_id,btrim(p_identifier),'unexpected' from public.assets a left join public.categories c on c.id=a.category_id left join public.models m on m.id=a.model_id where a.id=v_asset.id returning * into v_item;
  end if;
  perform public._stocktake_refresh_counts(p_stocktake_id); perform public._stocktake_event(p_stocktake_id,'scanned',p_operation_id,v_item.id,null,jsonb_build_object('asset_id',v_asset.id,'classification',v_classification,'count_round',v_item.count_round),null);
  v_result:=jsonb_build_object('ok',true,'item_id',v_item.id,'asset_id',v_asset.id,'asset_tag',v_item.snapshot_asset_tag,'asset_name',v_item.snapshot_asset_name,'classification',v_classification,'count_round',v_item.count_round); return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'scan',v_result);
end $function$;

revoke all on function public.stocktake_create(text,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.stocktake_scan(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.stocktake_create(text,uuid,uuid,uuid,text,uuid) to authenticated;
grant execute on function public.stocktake_scan(uuid,text,uuid) to authenticated;

commit;
