-- Purpose: remove legacy primary-status branches from asset create/edit RPCs.
-- Risk: callers that submit a removed status receive a clear business error;
-- custody and allocation remain dedicated RPC workflows. Rollback: restore the
-- prior function definitions only with the canonical assets constraint intact.

begin;

create or replace function public.asset_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid; v_status public.asset_status; v_cost numeric;
begin
  if not public.current_user_has_capability('asset.create') then return json_build_object('ok',false,'error','not_authorized'); end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then return json_build_object('ok',false,'error','invalid_payload'); end if;
  begin
    v_status := coalesce(nullif(p_input->>'status',''),'available')::public.asset_status;
    v_cost := nullif(p_input->>'purchase_cost','')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok',false,'error','invalid_status');
  end;
  if v_status not in ('available','in_maintenance') then return json_build_object('ok',false,'error','invalid_initial_status'); end if;
  if nullif(btrim(p_input->>'category_id'),'') is null or nullif(btrim(p_input->>'location_id'),'') is null or nullif(btrim(p_input->>'company_id'),'') is null or nullif(btrim(p_input->>'serial_number'),'') is null then return json_build_object('ok',false,'error','required_asset_fields'); end if;
  if v_cost is not null and (not public.is_financial_viewer() or v_cost < 0 or v_cost > 9999999999.99) then return json_build_object('ok',false,'error','invalid_financial_value'); end if;
  if jsonb_typeof(coalesce(p_input->'special_attributes','{}'::jsonb)) <> 'object' then return json_build_object('ok',false,'error','invalid_special_attributes'); end if;
  insert into public.assets(category_id,model_id,serial_number,name,status,location_id,department_id,purchase_date,purchase_cost,warranty_end,supplier_id,company_id,pool_id,rfid_tag,notes,special_attributes,created_by)
  values((p_input->>'category_id')::uuid,nullif(p_input->>'model_id','')::uuid,btrim(p_input->>'serial_number'),nullif(btrim(p_input->>'name'),''),v_status,(p_input->>'location_id')::uuid,nullif(p_input->>'department_id','')::uuid,nullif(p_input->>'purchase_date','')::date,v_cost,nullif(p_input->>'warranty_end','')::date,nullif(p_input->>'supplier_id','')::uuid,(p_input->>'company_id')::uuid,nullif(p_input->>'pool_id','')::uuid,nullif(btrim(p_input->>'rfid_tag'),''),nullif(btrim(p_input->>'notes'),''),coalesce(p_input->'special_attributes','{}'::jsonb),auth.uid())
  returning id into v_id;
  insert into public.asset_movements(asset_id,movement_type,to_status,to_location_id,performed_by,note) values(v_id,'create',v_status,(p_input->>'location_id')::uuid,auth.uid(),'إنشاء أصل');
  return json_build_object('ok',true,'id',v_id);
end
$function$;

create or replace function public.asset_update_atomic(p_asset_id uuid, p_input jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_old public.assets%rowtype; v_status public.asset_status; v_cost numeric;
begin
  if not public.current_user_has_capability('asset.update') then return json_build_object('ok',false,'error','not_authorized'); end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then return json_build_object('ok',false,'error','invalid_payload'); end if;
  select * into v_old from public.assets where id=p_asset_id for update;
  if not found then return json_build_object('ok',false,'error','asset_not_found'); end if;
  begin
    v_status := coalesce(nullif(p_input->>'status',''),v_old.status::text)::public.asset_status;
    v_cost := case when p_input ? 'purchase_cost' then nullif(p_input->>'purchase_cost','')::numeric else v_old.purchase_cost end;
  exception when invalid_text_representation or numeric_value_out_of_range then return json_build_object('ok',false,'error','invalid_numeric_or_status'); end;
  if v_status not in ('available','reserved','in_maintenance') then return json_build_object('ok',false,'error','invalid_primary_status'); end if;
  if v_status = 'reserved' and v_old.status <> 'reserved' then return json_build_object('ok',false,'error','reservation_relationship_rpc_required'); end if;
  if v_old.assigned_to_employee_id is not null and v_status is distinct from v_old.status then return json_build_object('ok',false,'error','custody_return_rpc_required'); end if;
  if not public.asset_status_allowed(v_old.status,v_status) then return json_build_object('ok',false,'error','invalid_transition'); end if;
  if p_input ? 'purchase_cost' and not public.is_financial_viewer() then return json_build_object('ok',false,'error','financial_not_authorized'); end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then return json_build_object('ok',false,'error','invalid_financial_value'); end if;
  if nullif(btrim(p_input->>'category_id'),'') is null or nullif(btrim(p_input->>'location_id'),'') is null or nullif(btrim(p_input->>'company_id'),'') is null then return json_build_object('ok',false,'error','required_asset_fields'); end if;
  update public.assets set name=nullif(btrim(p_input->>'name'),''),category_id=(p_input->>'category_id')::uuid,model_id=nullif(p_input->>'model_id','')::uuid,serial_number=nullif(btrim(p_input->>'serial_number'),''),status=v_status,location_id=(p_input->>'location_id')::uuid,department_id=nullif(p_input->>'department_id','')::uuid,supplier_id=nullif(p_input->>'supplier_id','')::uuid,company_id=(p_input->>'company_id')::uuid,pool_id=nullif(p_input->>'pool_id','')::uuid,rfid_tag=nullif(btrim(p_input->>'rfid_tag'),''),purchase_date=nullif(p_input->>'purchase_date','')::date,purchase_cost=v_cost,warranty_end=nullif(p_input->>'warranty_end','')::date,condition_grade=nullif(p_input->>'condition_grade',''),notes=nullif(btrim(p_input->>'notes'),''),special_attributes=coalesce(p_input->'special_attributes','{}'::jsonb) where id=p_asset_id;
  if v_status is distinct from v_old.status then insert into public.asset_movements(asset_id,movement_type,from_status,to_status,performed_by,note) values(p_asset_id,'status_change',v_old.status,v_status,auth.uid(),'تعديل بيانات الأصل'); end if;
  return json_build_object('ok',true);
end
$function$;

revoke all on function public.asset_create_atomic(jsonb) from public, anon;
grant execute on function public.asset_create_atomic(jsonb) to authenticated;
revoke all on function public.asset_update_atomic(uuid,jsonb) from public, anon;
grant execute on function public.asset_update_atomic(uuid,jsonb) to authenticated;

commit;
