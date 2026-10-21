-- Edit 1 follow-up: asset assignment stores a condition *grade*, while the
-- request workflow stores a return inspection condition. Keep that mapping in
-- the trusted RPC so an otherwise valid return cannot violate the grade check.
begin;

create or replace function public.request_inspect_return(p_id uuid, p_lines jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_req public.requests%rowtype;
  v_line jsonb;
  v_asset uuid;
  v_cond text;
  v_notes text;
  v_cur public.asset_status;
  v_new public.asset_status;
  v_assignment_grade text;
  v_seen uuid[] := array[]::uuid[];
  v_processed integer := 0;
  v_issues integer := 0;
  v_remaining integer;
begin
  if v_role is null
     or v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    return json_build_object('ok', false, 'error', 'invalid_return_inspection');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered', 'partially_returned', 'overdue') then
    return json_build_object('ok', false, 'error', 'state_not_returnable');
  end if;

  -- Validate and lock every line before changing any row.
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_asset := nullif(v_line->>'asset_id', '')::uuid;
    v_cond := nullif(v_line->>'condition', '');
    v_notes := nullif(btrim(v_line->>'notes'), '');
    if v_asset is null or v_asset = any(v_seen)
       or v_cond not in ('sound', 'unsound', 'missing', 'needs_maintenance') then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
    if v_cond in ('unsound', 'missing', 'needs_maintenance') and v_notes is null then
      return json_build_object('ok', false, 'error', 'return_notes_required');
    end if;
    if not exists (
      select 1 from public.request_items ri
      where ri.request_id = p_id and ri.item_kind = 'asset' and ri.asset_id = v_asset
        and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0)
    ) then return json_build_object('ok', false, 'error', 'invalid_return_inspection'); end if;
    select status into v_cur from public.assets where id = v_asset for update;
    if v_cur not in ('rented', 'assigned') then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
    v_seen := array_append(v_seen, v_asset);
  end loop;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_asset := (v_line->>'asset_id')::uuid;
    v_cond := v_line->>'condition';
    v_notes := nullif(btrim(v_line->>'notes'), '');
    select status into v_cur from public.assets where id = v_asset;
    v_new := case
      when v_cond = 'sound' then 'available'::public.asset_status
      when v_cond = 'missing' then 'lost'::public.asset_status
      else 'in_maintenance'::public.asset_status
    end;
    v_assignment_grade := case v_cond
      when 'sound' then 'good'
      when 'needs_maintenance' then 'fair'
      else 'poor'
    end;

    update public.assets
    set status = v_new, assigned_to_employee_id = null, last_return_condition = v_cond,
        last_return_at = now(), last_request_id = p_id,
        unsound_return_count = coalesce(unsound_return_count, 0)
          + case when v_cond in ('unsound', 'needs_maintenance') then 1 else 0 end
    where id = v_asset;
    insert into public.asset_movements(asset_id, movement_type, from_status, to_status, performed_by, note)
    values (v_asset, 'status_change', v_cur, v_new, auth.uid(),
      'إرجاع وفحص طلب ' || v_req.request_number || ' — ' || v_cond || coalesce(' · ' || v_notes, ''));
    update public.asset_assignments
    set status = 'returned', returned_at = now(), return_condition = v_assignment_grade
    where asset_id = v_asset and status = 'active';
    if v_cond in ('unsound', 'needs_maintenance') then
      insert into public.maintenance_records(asset_id, reported_by, problem_description)
      values (v_asset, auth.uid(), 'جهاز راجع غير سليم من الطلب ' || v_req.request_number || coalesce(' · ' || v_notes, ''));
    end if;
    update public.request_items set returned_quantity = quantity
    where request_id = p_id and item_kind = 'asset' and asset_id = v_asset;
    v_processed := v_processed + 1;
    if v_cond <> 'sound' then v_issues := v_issues + 1; end if;
  end loop;

  select count(*) into v_remaining from public.request_items ri
  where ri.request_id = p_id and ri.item_kind = 'asset'
    and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0);
  if v_remaining > 0 then
    update public.requests set status = 'partially_returned' where id = p_id;
  else
    update public.requests set status = 'returned', returned_at = now() where id = p_id;
  end if;
  perform public._request_add_event(p_id, 'inspected_return', 'staff', null,
    jsonb_build_object('processed', v_processed, 'issues', v_issues, 'remaining', v_remaining));
  return json_build_object('ok', true, 'processed', v_processed, 'issues', v_issues, 'remaining', v_remaining);
exception when invalid_text_representation then
  return json_build_object('ok', false, 'error', 'invalid_return_inspection');
end
$function$;

revoke all on function public.request_inspect_return(uuid, jsonb) from public, anon;
grant execute on function public.request_inspect_return(uuid, jsonb) to authenticated;

commit;
