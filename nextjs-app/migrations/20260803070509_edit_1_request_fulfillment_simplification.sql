-- Purpose: EDIT 1 — simplify request readiness, delivery, reserved-device
-- replacement, return receipt, and rejection while retaining RPC/RLS controls.
-- Security impact: all mutations remain SECURITY DEFINER RPCs with explicit
-- approved-user/role checks, row locks, idempotency, and existing audit triggers.
-- Risk: low/medium. The return workflow now stops at returned and requires the
-- explicit request_complete close step. Damaged/missing returns require notes.
-- Rollback: restore the function definitions from migrations 20260727145511,
-- 20260709130000, 20260731180000, and 20260731210000; the nullable
-- delivery_notes column may remain safely in place.

begin;

alter table public.request_delivery_proofs
  add column if not exists delivery_notes text null;

create or replace function public.request_confirm_ready(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_asset record;
begin
  if not public.is_approved()
     or v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in ('approved', 'provisioned', 'preparing') then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if not exists (select 1 from public.request_items where request_id = p_id) then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if exists (
    select 1 from public.request_items
    where request_id = p_id and (item_kind = 'custom' or needs_purchase)
  ) then
    return jsonb_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;
  if exists (
    select 1 from public.request_items
    where request_id = p_id
      and (
        quantity <= 0
        or quantity <> trunc(quantity)
        or coalesce(delivered_quantity, 0) <> 0
        or coalesce(returned_quantity, 0) <> 0
      )
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_quantities');
  end if;
  if exists (
    select asset_id from public.request_items
    where request_id = p_id and item_kind = 'asset'
    group by asset_id
    having asset_id is null or count(*) > 1
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_asset_selection');
  end if;

  perform 1
  from public.assets a
  join public.request_items ri on ri.asset_id = a.id
  where ri.request_id = p_id
  order by a.id
  for update of a;
  perform 1
  from public.consumables c
  join public.request_items ri on ri.consumable_id = c.id
  where ri.request_id = p_id
  order by c.id
  for update of c;

  if exists (
    select 1
    from public.request_items ri
    left join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
      and (a.id is null or a.status not in ('available', 'reserved'))
  ) then
    return jsonb_build_object('ok', false, 'error', 'asset_not_available');
  end if;
  if exists (
    select 1
    from public.request_items ri
    join public.consumables c on c.id = ri.consumable_id
    where ri.request_id = p_id and ri.item_kind = 'consumable'
    group by ri.consumable_id, c.quantity_on_hand
    having sum(ri.quantity) > c.quantity_on_hand
  ) then
    return jsonb_build_object('ok', false, 'error', 'insufficient_stock');
  end if;

  for v_asset in
    select a.id, a.status
    from public.assets a
    join public.request_items ri on ri.asset_id = a.id
    where ri.request_id = p_id and ri.item_kind = 'asset'
    order by a.id
  loop
    if v_asset.status = 'available' then
      update public.assets set status = 'reserved' where id = v_asset.id;
      insert into public.asset_movements(
        asset_id, movement_type, from_status, to_status, performed_by, note
      ) values (
        v_asset.id, 'status_change', 'available', 'reserved', auth.uid(),
        'حجز لطلب ' || v_request.request_number
      );
    end if;
  end loop;

  if v_request.status <> 'preparing' then
    update public.requests set status = 'preparing' where id = p_id;
  end if;
  update public.requests set status = 'ready_for_pickup' where id = p_id;
  perform public._request_add_event(
    p_id, 'devices_ready_confirmed', 'staff', null, '{}'::jsonb
  );
  return jsonb_build_object('ok', true, 'status', 'ready_for_pickup');
end
$function$;

revoke all on function public.request_confirm_ready(uuid) from public, anon;
grant execute on function public.request_confirm_ready(uuid) to authenticated;

create or replace function public.request_change_reserved_asset(
  p_item_id uuid,
  p_new_asset_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public.app_user_role();
  v_item public.request_items%rowtype;
  v_request public.requests%rowtype;
  v_old public.assets%rowtype;
  v_new public.assets%rowtype;
  v_result jsonb;
begin
  if not public.is_approved()
     or v_role not in ('admin', 'it_manager', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or p_new_asset_id is null then
    return jsonb_build_object('ok', false, 'error', 'reserved_device_change_invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  select * into v_item
  from public.request_items
  where id = p_item_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into v_request
  from public.requests
  where id = v_item.request_id
  for update;
  if not found
     or v_request.status not in ('approved', 'provisioned', 'preparing')
     or v_item.item_kind <> 'asset'
     or v_item.asset_id is null
     or coalesce(v_item.delivered_quantity, 0) > 0
     or v_item.asset_id = p_new_asset_id then
    return jsonb_build_object('ok', false, 'error', 'reserved_device_change_invalid');
  end if;

  perform 1
  from public.assets
  where id in (v_item.asset_id, p_new_asset_id)
  order by id
  for update;
  select * into v_old from public.assets where id = v_item.asset_id;
  select * into v_new from public.assets where id = p_new_asset_id;
  if v_old.id is null or v_old.status <> 'reserved'
     or v_new.id is null or not coalesce(v_new.is_active, false)
     or v_new.status <> 'available'
     or exists (
       select 1 from public.request_items
       where asset_id = p_new_asset_id and id <> p_item_id
     ) then
    return jsonb_build_object('ok', false, 'error', 'reserved_device_change_invalid');
  end if;

  update public.assets set status = 'available' where id = v_old.id;
  insert into public.asset_movements(
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    v_old.id, 'status_change', 'reserved', 'available', v_uid,
    'تغيير الجهاز المحجوز للطلب ' || v_request.request_number
  );
  update public.assets set status = 'reserved' where id = v_new.id;
  insert into public.asset_movements(
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    v_new.id, 'status_change', 'available', 'reserved', v_uid,
    'حجز جهاز بديل للطلب ' || v_request.request_number
  );
  update public.request_items set asset_id = v_new.id where id = p_item_id;
  perform public._request_add_event(
    v_request.id,
    'reserved_asset_changed',
    'staff',
    null,
    jsonb_build_object('item_id', p_item_id, 'operation_id', p_operation_id)
  );
  v_result := jsonb_build_object(
    'ok', true,
    'request_id', v_request.id,
    'item_id', p_item_id
  );
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, request_id, result
  ) values (
    v_uid, p_operation_id, 'change_reserved_asset', v_request.id, v_result
  );
  return v_result;
end
$function$;

revoke all on function public.request_change_reserved_asset(uuid, uuid, uuid)
from public, anon;
grant execute on function public.request_change_reserved_asset(uuid, uuid, uuid)
to authenticated;

create or replace function public.request_reject(
  p_id uuid,
  p_reason text default null
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request public.requests%rowtype;
  v_released integer;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_reason is null or length(v_reason) < 3 then
    return json_build_object('ok', false, 'error', 'reason_required');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if not public.request_transition_allowed(v_request.status, 'rejected')
     or v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  v_released := public._request_release_reservations(
    p_id,
    'رفض طلب ' || v_request.request_number
  );
  update public.requests
  set status = 'rejected', rejection_reason = v_reason
  where id = p_id;
  return json_build_object('ok', true, 'released', v_released);
end
$function$;

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
  select * into v_req
  from public.requests
  where id = p_id
  for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered', 'partially_returned', 'overdue') then
    return json_build_object('ok', false, 'error', 'state_not_returnable');
  end if;

  -- Validate and lock every line before changing any row. Returning a JSON error
  -- after mutation would otherwise commit a partial receipt.
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_asset := nullif(v_line->>'asset_id', '')::uuid;
    v_cond := nullif(v_line->>'condition', '');
    v_notes := nullif(btrim(v_line->>'notes'), '');
    if v_asset is null
       or v_asset = any(v_seen)
       or v_cond not in ('sound', 'unsound', 'missing', 'needs_maintenance') then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
    if v_cond in ('unsound', 'missing', 'needs_maintenance') and v_notes is null then
      return json_build_object('ok', false, 'error', 'return_notes_required');
    end if;
    if not exists (
      select 1
      from public.request_items ri
      where ri.request_id = p_id
        and ri.item_kind = 'asset'
        and ri.asset_id = v_asset
        and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0)
    ) then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
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

    update public.assets
    set status = v_new,
        assigned_to_employee_id = null,
        last_return_condition = v_cond,
        last_return_at = now(),
        last_request_id = p_id,
        unsound_return_count = coalesce(unsound_return_count, 0)
          + case when v_cond in ('unsound', 'needs_maintenance') then 1 else 0 end
    where id = v_asset;
    insert into public.asset_movements(
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset, 'status_change', v_cur, v_new, auth.uid(),
      'إرجاع وفحص طلب ' || v_req.request_number || ' — ' || v_cond
        || coalesce(' · ' || v_notes, '')
    );
    update public.asset_assignments
    set status = 'returned', returned_at = now(), return_condition = v_cond
    where asset_id = v_asset and status = 'active';
    if v_cond in ('unsound', 'needs_maintenance') then
      insert into public.maintenance_records(
        asset_id, reported_by, problem_description
      ) values (
        v_asset, auth.uid(),
        'جهاز راجع غير سليم من الطلب ' || v_req.request_number
          || coalesce(' · ' || v_notes, '')
      );
    end if;
    update public.request_items
    set returned_quantity = quantity
    where request_id = p_id and item_kind = 'asset' and asset_id = v_asset;
    v_processed := v_processed + 1;
    if v_cond <> 'sound' then v_issues := v_issues + 1; end if;
  end loop;

  select count(*) into v_remaining
  from public.request_items ri
  where ri.request_id = p_id
    and ri.item_kind = 'asset'
    and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0);
  if v_remaining > 0 then
    update public.requests set status = 'partially_returned' where id = p_id;
  else
    update public.requests set status = 'returned', returned_at = now() where id = p_id;
  end if;
  perform public._request_add_event(
    p_id,
    'inspected_return',
    'staff',
    null,
    jsonb_build_object(
      'processed', v_processed,
      'issues', v_issues,
      'remaining', v_remaining
    )
  );
  return json_build_object(
    'ok', true,
    'processed', v_processed,
    'issues', v_issues,
    'remaining', v_remaining
  );
exception
  when invalid_text_representation then
    return json_build_object('ok', false, 'error', 'invalid_return_inspection');
end
$function$;

create or replace function public.request_deliver_with_proof(
  p_id uuid,
  p_proof jsonb,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_risk jsonb;
  v_method text := nullif(btrim(p_proof->>'method'), '');
  v_receiver text := nullif(btrim(p_proof->>'receiver_name'), '');
  v_notes text := nullif(btrim(p_proof->>'delivery_notes'), '');
  v_ack boolean := coalesce((p_proof->>'acknowledged')::boolean, false);
  v_signature text := nullif(btrim(p_proof->>'signature_reference'), '');
  v_attachment_id uuid;
  v_otp_id uuid;
  v_proof_id uuid;
  v_existing uuid;
  v_delivery jsonb;
  v_devices jsonb;
begin
  if v_role is null
     or v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null
     or v_receiver is null
     or length(v_receiver) not between 2 and 160
     or coalesce(length(v_notes), 0) > 1000
     or v_method not in ('acknowledgement', 'otp', 'signature') then
    return jsonb_build_object('ok', false, 'error', 'invalid_delivery_proof');
  end if;
  select id into v_existing
  from public.request_delivery_proofs
  where delivered_by = auth.uid() and operation_id = p_operation_id;
  if found then
    return jsonb_build_object('ok', true, 'proof_id', v_existing, 'idempotent', true);
  end if;
  select * into v_request
  from public.requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_request.status <> 'ready_for_pickup' then
    return jsonb_build_object('ok', false, 'error', 'state_not_deliverable');
  end if;
  begin
    v_attachment_id := nullif(p_proof->>'attachment_id', '')::uuid;
    v_otp_id := nullif(p_proof->>'otp_challenge_id', '')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'error', 'invalid_delivery_proof');
  end;
  if v_attachment_id is not null and not exists (
    select 1 from public.request_attachments a
    where a.id = v_attachment_id
      and a.request_id = p_id
      and a.scan_status = 'clean'
  ) then
    return jsonb_build_object('ok', false, 'error', 'clean_request_attachment_required');
  end if;
  v_risk := public._request_delivery_risk(p_id);
  if v_risk->>'level' = 'high' then
    if v_request.second_approved_by is null then
      return jsonb_build_object('ok', false, 'error', 'second_approval_required');
    end if;
    if v_request.prepared_by is null then
      return jsonb_build_object('ok', false, 'error', 'preparer_evidence_required');
    end if;
    if auth.uid() = any(array_remove(array[
      v_request.created_by,
      v_request.approved_by,
      v_request.second_approved_by,
      v_request.prepared_by
    ], null)) then
      perform public._audit_write(
        'request_delivery_denied', 'denied', 'requests', p_id::text,
        p_id, null, null, 'segregation_of_duties', 'rpc:request_deliver_with_proof',
        jsonb_build_object('operation_id', p_operation_id), null, null
      );
      return jsonb_build_object('ok', false, 'error', 'independent_deliverer_required');
    end if;
    if v_method = 'acknowledgement' then
      return jsonb_build_object('ok', false, 'error', 'strong_proof_required');
    end if;
  end if;
  if v_method = 'acknowledgement' and not v_ack then
    return jsonb_build_object('ok', false, 'error', 'acknowledgement_required');
  elsif v_method = 'signature'
        and v_signature is null
        and v_attachment_id is null then
    return jsonb_build_object('ok', false, 'error', 'signature_reference_required');
  elsif v_method = 'otp' and not exists (
    select 1 from public.request_delivery_otp_challenges c
    where c.id = v_otp_id
      and c.request_id = p_id
      and c.requested_by = auth.uid()
      and c.provider_status = 'verified'
      and c.verified_at is not null
  ) then
    return jsonb_build_object('ok', false, 'error', 'verified_otp_required');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'asset_id', a.id,
    'asset_tag', a.asset_tag,
    'name', a.name
  ) order by a.id), '[]'::jsonb)
  into v_devices
  from public.request_items ri
  join public.assets a on a.id = ri.asset_id
  where ri.request_id = p_id and ri.item_kind = 'asset';

  -- A nested exception block is a PostgreSQL subtransaction. If the official
  -- delivery RPC rejects, every proof/delivery/movement write in this block is
  -- rolled back before the structured error is returned.
  begin
    insert into public.request_delivery_proofs(
      request_id, proof_method, receiver_name, delivery_notes, delivered_by,
      otp_challenge_id, signature_reference, attachment_id,
      device_snapshot, risk_level, risk_reason, operation_id
    ) values (
      p_id, v_method, v_receiver, v_notes, auth.uid(),
      v_otp_id, v_signature, v_attachment_id,
      v_devices, v_risk->>'level', v_risk->>'reason', p_operation_id
    ) returning id into v_proof_id;

    v_delivery := public.request_deliver(p_id)::jsonb;
    if not coalesce((v_delivery->>'ok')::boolean, false) then
      raise exception 'request_delivery_failed' using errcode = 'P0001';
    end if;
    update public.request_delivery_proofs
    set evidence_status = 'verified'
    where id = v_proof_id;
    update public.requests
    set delivered_by = auth.uid(),
        delivery_proof_id = v_proof_id,
        risk_level_snapshot = v_risk->>'level',
        risk_reason_snapshot = v_risk->>'reason'
    where id = p_id;
  exception
    when sqlstate 'P0001' then
      return v_delivery;
  end;
  return jsonb_build_object(
    'ok', true,
    'proof_id', v_proof_id,
    'risk_level', v_risk->>'level'
  );
exception
  when invalid_text_representation then
    return jsonb_build_object('ok', false, 'error', 'invalid_delivery_proof');
end
$function$;

revoke all on function public.request_deliver_with_proof(uuid, jsonb, uuid)
from public, anon;
grant execute on function public.request_deliver_with_proof(uuid, jsonb, uuid)
to authenticated;

create or replace function public.request_execute_idempotent(
  p_request_id uuid,
  p_operation_type text,
  p_operation_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if not public.is_approved() or p_operation_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;
  case p_operation_type
    when 'submit' then v_result := public.request_submit(p_request_id)::jsonb;
    when 'approve' then v_result := public.request_approve(p_request_id)::jsonb;
    when 'reject' then v_result := public.request_reject(
      p_request_id, nullif(p_payload->>'reason', '')
    )::jsonb;
    when 'start_preparing' then v_result := public.request_start_preparing(p_request_id)::jsonb;
    when 'mark_ready' then v_result := public.request_mark_ready(p_request_id)::jsonb;
    when 'confirm_ready' then v_result := public.request_confirm_ready(p_request_id)::jsonb;
    when 'return' then v_result := public.request_return(p_request_id)::jsonb;
    when 'inspect_return' then v_result := public.request_inspect_return(
      p_request_id, coalesce(p_payload->'lines', '[]'::jsonb)
    )::jsonb;
    when 'complete' then v_result := public.request_complete(p_request_id)::jsonb;
    when 'cancel' then v_result := public.request_cancel(p_request_id)::jsonb;
    else return jsonb_build_object('ok', false, 'error', 'unsupported_operation');
  end case;
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, request_id, result
  ) values (v_uid, p_operation_id, p_operation_type, p_request_id, v_result);
  return v_result;
end
$function$;

revoke all on function public.request_execute_idempotent(uuid, text, uuid, jsonb)
from public, anon;
grant execute on function public.request_execute_idempotent(uuid, text, uuid, jsonb)
to authenticated;

commit;
