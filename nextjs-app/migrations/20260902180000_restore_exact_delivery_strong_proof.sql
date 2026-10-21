-- Restore strong signature/OTP evidence handling after the exact-asset delivery
-- rewrite accidentally reduced every delivery proof to acknowledgement and made
-- high-risk delivery impossible. Exact scan verification and SoD stay intact.
-- Rollback: restore the preceding request_deliver_with_proof definition only if
-- high-risk delivery is intentionally disabled again.

begin;

do $restore_exact_delivery_strong_proof$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.request_deliver_with_proof(uuid,jsonb,uuid)'::regprocedure
  ) into v_definition;

  if position(
    $q$v_receiver text:=nullif(btrim(p_proof->>'receiver_name'),''); v_notes text:=nullif(btrim(p_proof->>'delivery_notes'),'');$q$
    in v_definition
  ) = 0
     or position(
       $q$return jsonb_build_object('ok',false,'error','strong_proof_required');$q$
       in v_definition
     ) = 0
     or position(
       $q$select p_id,'acknowledgement',v_receiver,v_notes,auth.uid(),$q$
       in v_definition
     ) = 0 then
    raise exception 'request_deliver_with_proof_exact_contract_unexpected';
  end if;

  v_definition := replace(
    v_definition,
    $q$v_receiver text:=nullif(btrim(p_proof->>'receiver_name'),''); v_notes text:=nullif(btrim(p_proof->>'delivery_notes'),'');$q$,
    $q$v_method text:=nullif(btrim(p_proof->>'method'),'');
  v_receiver text:=nullif(btrim(p_proof->>'receiver_name'),''); v_notes text:=nullif(btrim(p_proof->>'delivery_notes'),'');
  v_ack boolean:=coalesce((p_proof->>'acknowledged')::boolean,false);
  v_signature text:=nullif(btrim(p_proof->>'signature_reference'),'');
  v_attachment_id uuid; v_otp_id uuid;$q$
  );

  v_definition := replace(
    v_definition,
    $q$if v_receiver is null or length(v_receiver) not between 2 and 160 or coalesce(length(v_notes),0)>1000 then return jsonb_build_object('ok',false,'error','invalid_delivery_proof'); end if;$q$,
    $q$if v_receiver is null or length(v_receiver) not between 2 and 160 or coalesce(length(v_notes),0)>1000
     or v_method not in ('acknowledgement','otp','signature') then
    return jsonb_build_object('ok',false,'error','invalid_delivery_proof');
  end if;$q$
  );

  v_definition := replace(
    v_definition,
    $q$if v_req.status <> 'ready_for_pickup' then return jsonb_build_object('ok',false,'error','state_not_deliverable'); end if;$q$,
    $q$if v_req.status <> 'ready_for_pickup' then return jsonb_build_object('ok',false,'error','state_not_deliverable'); end if;
  begin
    v_attachment_id:=nullif(p_proof->>'attachment_id','')::uuid;
    v_otp_id:=nullif(p_proof->>'otp_challenge_id','')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok',false,'error','invalid_delivery_proof');
  end;
  if v_attachment_id is not null and not exists (
    select 1 from public.request_attachments a
    where a.id=v_attachment_id and a.request_id=p_id and a.scan_status='clean'
  ) then
    return jsonb_build_object('ok',false,'error','clean_request_attachment_required');
  end if;$q$
  );

  v_definition := replace(
    v_definition,
    $q$return jsonb_build_object('ok',false,'error','strong_proof_required');$q$,
    $q$if v_method='acknowledgement' then
      return jsonb_build_object('ok',false,'error','strong_proof_required');
    end if;$q$
  );

  v_definition := replace(
    v_definition,
    $q$insert into public.request_delivery_proofs(request_id,proof_method,receiver_name,delivery_notes,delivered_by,device_snapshot,risk_level,risk_reason,operation_id)$q$,
    $q$if v_method='acknowledgement' and not v_ack then
    return jsonb_build_object('ok',false,'error','acknowledgement_required');
  elsif v_method='signature' and v_signature is null and v_attachment_id is null then
    return jsonb_build_object('ok',false,'error','signature_reference_required');
  elsif v_method='otp' and not exists (
    select 1 from public.request_delivery_otp_challenges c
    where c.id=v_otp_id and c.request_id=p_id and c.requested_by=auth.uid()
      and c.provider_status='verified' and c.verified_at is not null
  ) then
    return jsonb_build_object('ok',false,'error','verified_otp_required');
  end if;
  insert into public.request_delivery_proofs(request_id,proof_method,receiver_name,delivery_notes,delivered_by,otp_challenge_id,signature_reference,attachment_id,device_snapshot,risk_level,risk_reason,operation_id)$q$
  );

  v_definition := replace(
    v_definition,
    $q$select p_id,'acknowledgement',v_receiver,v_notes,auth.uid(),coalesce(jsonb_agg($q$,
    $q$select p_id,v_method,v_receiver,v_notes,auth.uid(),v_otp_id,v_signature,v_attachment_id,coalesce(jsonb_agg($q$
  );

  v_definition := replace(
    v_definition,
    $q$return jsonb_build_object('ok',true,'proof_id',v_proof_id,'assets',cardinality(v_expected));$q$,
    $q$return jsonb_build_object('ok',true,'proof_id',v_proof_id,'assets',cardinality(v_expected),'risk_level',v_risk->>'level');$q$
  );

  execute v_definition;
end
$restore_exact_delivery_strong_proof$;

revoke all on function public.request_deliver_with_proof(uuid,jsonb,uuid)
from public, anon;
grant execute on function public.request_deliver_with_proof(uuid,jsonb,uuid)
to authenticated, service_role;

-- The proofless compatibility RPC remains unavailable to browser roles.
revoke all on function public.request_deliver(uuid)
from public, anon, authenticated;
grant execute on function public.request_deliver(uuid)
to service_role;

commit;
