-- Purpose: EDIT 1 follow-up — preserve the employee assignment safeguards
-- while keeping rental requests in the simplified delivered → return → close flow.
-- Security: retains the existing SECURITY DEFINER body, pinned empty search_path,
-- role/auth checks, proof validation, SoD, and authenticated-only grant.

begin;

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
    select 1
    from public.request_attachments a
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

    -- request_deliver correctly creates the employee assignment, but its
    -- legacy terminal status prevents the inspected-return workflow. Rental
    -- employee requests remain delivered until the authenticated return RPC
    -- records inspection and request_complete closes the request.
    if coalesce(v_request.beneficiary_type, 'customer') = 'employee'
       and v_request.request_type <> 'sale' then
      update public.requests
      set status = 'delivered'
      where id = p_id and status = 'completed';
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

commit;
