-- EDIT 4 inventory completion: scoped immutable snapshots and per-line review.
-- Additive/forward-only. No asset is changed while a session is scanned.
begin;

alter table public.stocktakes
  add column if not exists scope_kind text not null default 'full',
  add column if not exists scope_category_id uuid references public.categories(id),
  add column if not exists scope_label text;
alter table public.stocktakes drop constraint if exists stocktakes_scope_kind_check;
alter table public.stocktakes add constraint stocktakes_scope_kind_check
  check ((scope_kind = 'full' and scope_category_id is null) or (scope_kind = 'partial' and scope_category_id is not null));
create index if not exists ix_stocktakes_scope on public.stocktakes(location_id, scope_kind, scope_category_id);

alter table public.stocktake_items
  add column if not exists snapshot_category_name text,
  add column if not exists snapshot_manufacturer text,
  add column if not exists snapshot_model text,
  add column if not exists review_decision text,
  add column if not exists review_note text,
  add column if not exists decided_by uuid references public.app_users(id),
  add column if not exists decided_at timestamptz;
alter table public.stocktake_items drop constraint if exists stocktake_items_review_decision_check;
alter table public.stocktake_items add constraint stocktake_items_review_decision_check check (
  review_decision is null or review_decision in ('approve_correction', 'keep_current', 'request_recheck')
);

create or replace function public._stocktake_can_review()
returns boolean language sql stable security definer set search_path = '' as $function$
  select public.is_approved()
    and public.app_user_role() in ('admin', 'it_manager')
    and public.current_user_has_capability('stocktake.manage');
$function$;

drop function if exists public.stocktake_create(text,uuid,uuid,uuid);
create function public.stocktake_create(
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
  select v_id,a.id,'asset',true,a.status,a.location_id,a.asset_tag,a.name,a.serial_number,a.rfid_tag,coalesce(c.name_ar,c.name),a.manufacturer,a.model
  from public.assets a left join public.categories c on c.id=a.category_id
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
    select p_stocktake_id,a.id,'asset',false,a.status,a.location_id,a.asset_tag,a.name,a.serial_number,a.rfid_tag,coalesce(c.name_ar,c.name),a.manufacturer,a.model,true,true,now(),auth.uid(),v_take.location_id,btrim(p_identifier),'unexpected' from public.assets a left join public.categories c on c.id=a.category_id where a.id=v_asset.id returning * into v_item;
  end if;
  perform public._stocktake_refresh_counts(p_stocktake_id); perform public._stocktake_event(p_stocktake_id,'scanned',p_operation_id,v_item.id,null,jsonb_build_object('asset_id',v_asset.id,'classification',v_classification,'count_round',v_item.count_round),null);
  v_result:=jsonb_build_object('ok',true,'item_id',v_item.id,'asset_id',v_asset.id,'asset_tag',v_item.snapshot_asset_tag,'asset_name',v_item.snapshot_asset_name,'classification',v_classification,'count_round',v_item.count_round); return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'scan',v_result);
end $function$;

create function public.stocktake_decide_item(p_stocktake_id uuid,p_item_id uuid,p_decision text,p_note text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_existing jsonb; v_take public.stocktakes%rowtype; v_item public.stocktake_items%rowtype; v_result jsonb;
begin
  if not public._stocktake_can_review() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_operation_id is null or p_decision not in ('approve_correction','keep_current','request_recheck') or coalesce(length(btrim(p_note)),0)<3 or length(p_note)>1000 then raise exception 'invalid_discrepancy_decision' using errcode='22023'; end if;
  v_existing:=public._stocktake_existing_operation(p_operation_id,'decide_item'); if v_existing is not null then return v_existing; end if;
  select * into v_take from public.stocktakes where id=p_stocktake_id for update; if not found or v_take.status<>'in_progress' or v_take.review_state<>'submitted' then raise exception 'stocktake_not_reviewable' using errcode='22023'; end if;
  select * into v_item from public.stocktake_items where id=p_item_id and stocktake_id=p_stocktake_id for update; if not found or v_item.observation_status not in ('missing','unexpected','wrong_location') then raise exception 'variance_item_required' using errcode='22023'; end if;
  update public.stocktake_items set review_decision=p_decision,review_note=btrim(p_note),decided_by=auth.uid(),decided_at=now() where id=p_item_id;
  if p_decision='request_recheck' then update public.stocktake_items set scanned=false,found=false,scanned_at=null,scanned_by=null,observed_location_id=null,observed_identifier=null,observation_status=null,count_round=count_round+1,recount_required=true where id=p_item_id; update public.stocktakes set review_state='recount' where id=p_stocktake_id; end if;
  perform public._stocktake_event(p_stocktake_id,'discrepancy_decided',p_operation_id,p_item_id,null,jsonb_build_object('decision',p_decision),p_note);
  v_result:=jsonb_build_object('ok',true,'item_id',p_item_id,'decision',p_decision); return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'decide_item',v_result);
end $function$;


create or replace function public.stocktake_apply_adjustments(p_stocktake_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_existing jsonb; v_take public.stocktakes%rowtype; v_asset public.assets%rowtype; v_applied integer:=0; v_result jsonb; r record;
begin
  if not public._stocktake_can_review() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_operation_id is null then raise exception 'operation_id_required' using errcode='22023'; end if;
  v_existing:=public._stocktake_existing_operation(p_operation_id,'apply'); if v_existing is not null then return v_existing; end if;
  select * into v_take from public.stocktakes where id=p_stocktake_id for update; if not found or v_take.status<>'in_progress' or v_take.review_state<>'submitted' then raise exception 'submitted_stocktake_required' using errcode='22023'; end if;
  if exists(select 1 from public.stocktake_items i where i.stocktake_id=p_stocktake_id and i.observation_status in ('missing','unexpected','wrong_location') and i.review_decision is null) then raise exception 'every_discrepancy_requires_decision' using errcode='22023'; end if;
  if exists(select 1 from public.stocktake_items i where i.stocktake_id=p_stocktake_id and i.review_decision='request_recheck') then raise exception 'recheck_required' using errcode='22023'; end if;
  for r in select i.* from public.stocktake_items i where i.stocktake_id=p_stocktake_id and i.review_decision='approve_correction' and i.observation_status in ('unexpected','wrong_location') and not i.adjustment_applied order by i.asset_id loop
    select * into v_asset from public.assets where id=r.asset_id for update;
    if v_asset.location_id is distinct from v_take.location_id then update public.assets set location_id=v_take.location_id where id=r.asset_id; insert into public.asset_movements(asset_id,movement_type,from_status,to_status,from_location_id,to_location_id,performed_by,note) values(r.asset_id,'transfer',v_asset.status,v_asset.status,v_asset.location_id,v_take.location_id,auth.uid(),'Stocktake '||v_take.code||': '||r.review_note); v_applied:=v_applied+1; end if;
    update public.stocktake_items set adjustment_applied=true where id=r.id;
  end loop;
  update public.stocktakes set review_state='approved',reviewed_at=now(),reviewed_by=auth.uid(),status='completed',completed_at=now(),locked_at=now() where id=p_stocktake_id;
  perform public._stocktake_event(p_stocktake_id,'completed',p_operation_id,null,null,jsonb_build_object('adjustments_applied',v_applied), 'Per-discrepancy manager decisions completed');
  v_result:=jsonb_build_object('ok',true,'id',p_stocktake_id,'adjustments_applied',v_applied); return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'apply',v_result);
end $function$;

revoke all on function public._stocktake_can_review() from public,anon,authenticated;
revoke all on function public.stocktake_create(text,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.stocktake_decide_item(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.stocktake_create(text,uuid,uuid,uuid,text,uuid) to authenticated;
grant execute on function public.stocktake_decide_item(uuid,uuid,text,text,uuid) to authenticated;
-- stocktake_scan and stocktake_apply_adjustments retain their existing authenticated grants.
commit;
