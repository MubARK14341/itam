begin;

-- P1-06: risk-based segregation of duties and delivery evidence.
-- This migration is restrictive: legacy request_deliver is no longer exposed
-- to authenticated clients. All deliveries must use the evidence wrapper.

create table public.sod_operation_policies (
  operation_type text primary key,
  risk_level text not null check (risk_level in ('low', 'high')),
  required_control text not null,
  second_approval_required boolean not null default false,
  external_dependency text null,
  updated_at timestamptz not null default now()
);

insert into public.sod_operation_policies (
  operation_type, risk_level, required_control,
  second_approval_required, external_dependency
) values
  ('request_delivery_low', 'low', 'scan_acknowledgement_actor_evidence', false, null),
  ('request_delivery_high_value', 'high', 'independent_approval_preparation_delivery_and_strong_receipt', true, null),
  ('purchase_financial', 'high', 'requester_first_approver_second_approver_receiver_separated', true, null),
  ('destructive_delete', 'high', 'deny_without_explicit_two_person_workflow', true, null),
  ('state_override', 'high', 'deny_direct_override_use_state_machine', true, null),
  ('stocktake_large_variance', 'high', 'independent_reviewer_and_adjuster', true, null),
  ('manual_inventory_adjustment', 'high', 'use_reviewed_stocktake_workflow', true, null);

alter table public.sod_operation_policies enable row level security;
revoke all on public.sod_operation_policies from public, anon, authenticated;
grant select on public.sod_operation_policies to authenticated;

create policy sod_operation_policies_audit_read
on public.sod_operation_policies
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'auditor')
);

alter table public.requests
  add column prepared_by uuid null references public.app_users(id),
  add column prepared_at timestamptz null,
  add column second_approved_by uuid null references public.app_users(id),
  add column second_approved_at timestamptz null,
  add column second_approval_reason text null,
  add column delivered_by uuid null references public.app_users(id),
  add column delivery_proof_id uuid null,
  add column risk_level_snapshot text null,
  add column risk_reason_snapshot text null;

alter table public.requests
  add constraint requests_risk_level_snapshot_check
  check (risk_level_snapshot is null or risk_level_snapshot in ('low', 'high'));

create or replace function public._request_sod_stamp()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if new.status is distinct from old.status
     and new.status in ('preparing', 'ready_for_pickup')
     and old.status not in ('preparing', 'ready_for_pickup') then
    new.prepared_by := auth.uid();
    new.prepared_at := clock_timestamp();
  else
    new.prepared_by := old.prepared_by;
    new.prepared_at := old.prepared_at;
  end if;
  if new.second_approved_by is distinct from old.second_approved_by
     or new.second_approved_at is distinct from old.second_approved_at
     or new.second_approval_reason is distinct from old.second_approval_reason then
    if old.second_approved_by is not null
       or new.second_approved_by is distinct from auth.uid()
       or new.second_approved_at is null
       or coalesce(length(btrim(new.second_approval_reason)), 0) < 3
       or new.approved_by is null
       or auth.uid() = any(array_remove(array[
         new.created_by, new.approved_by, new.prepared_by
       ], null))
       or public._request_delivery_risk(new.id)->>'level' <> 'high'
       or not public.current_user_has_capability('request.approve') then
      raise exception 'invalid_secondary_approval'
        using errcode = '42501';
    end if;
  else
    new.second_approved_by := old.second_approved_by;
    new.second_approved_at := old.second_approved_at;
    new.second_approval_reason := old.second_approval_reason;
  end if;
  if new.delivered_by is distinct from old.delivered_by
     or new.delivery_proof_id is distinct from old.delivery_proof_id then
    if old.delivery_proof_id is not null
       or new.delivered_by is distinct from auth.uid()
       or new.delivery_proof_id is null
       or not exists (
         select 1 from public.request_delivery_proofs p
         where p.id = new.delivery_proof_id
           and p.request_id = new.id
           and p.delivered_by = auth.uid()
           and p.evidence_status = 'verified'
       ) then
      raise exception 'invalid_delivery_evidence'
        using errcode = '42501';
    end if;
  else
    new.delivered_by := old.delivered_by;
    new.delivery_proof_id := old.delivery_proof_id;
  end if;
  if new.risk_level_snapshot is distinct from old.risk_level_snapshot
     or new.risk_reason_snapshot is distinct from old.risk_reason_snapshot then
    if new.risk_level_snapshot <> public._request_delivery_risk(new.id)->>'level'
       or new.risk_reason_snapshot <> public._request_delivery_risk(new.id)->>'reason'
       or (
         new.second_approved_by is null
         and new.delivery_proof_id is null
       ) then
      raise exception 'invalid_risk_snapshot'
        using errcode = '42501';
    end if;
  else
    new.risk_level_snapshot := old.risk_level_snapshot;
    new.risk_reason_snapshot := old.risk_reason_snapshot;
  end if;
  return new;
end
$function$;

create trigger trg_requests_sod_stamp
before update on public.requests
for each row execute function public._request_sod_stamp();

create or replace function public._request_delivery_risk(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when exists (
      select 1
      from public.request_items ri
      join public.assets a on a.id = ri.asset_id
      where ri.request_id = p_request_id
        and ri.item_kind = 'asset'
        and coalesce(a.purchase_cost, 0) >= 10000
    ) then jsonb_build_object(
      'level', 'high',
      'reason', 'high_value_asset',
      'threshold_amount', 10000,
      'currency', 'SAR'
    )
    else jsonb_build_object('level', 'low', 'reason', 'standard_delivery')
  end
$function$;

revoke all on function public._request_delivery_risk(uuid)
from public, anon, authenticated;

create or replace function public.request_delivery_requirements(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_request public.requests%rowtype;
  v_risk jsonb;
begin
  if not public.is_approved()
     or public.app_user_role() not in (
       'admin', 'it_manager', 'technician', 'warehouse_manager', 'auditor'
     ) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests where id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  v_risk := public._request_delivery_risk(p_request_id);
  return jsonb_build_object(
    'ok', true,
    'risk_level', v_risk->>'level',
    'risk_reason', v_risk->>'reason',
    'second_approval_required', v_risk->>'level' = 'high',
    'second_approval_complete', v_request.second_approved_by is not null,
    'allowed_proof_methods', case
      when v_risk->>'level' = 'high' then jsonb_build_array('signature', 'otp')
      else jsonb_build_array('acknowledgement', 'signature', 'otp')
    end
  );
end
$function$;

revoke all on function public.request_delivery_requirements(uuid)
from public, anon;
grant execute on function public.request_delivery_requirements(uuid)
to authenticated;

create table public.request_delivery_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id),
  provider text not null,
  provider_status text not null default 'pending_external'
    check (provider_status in ('pending_external', 'sent', 'verified', 'expired', 'failed')),
  code_digest text null,
  external_message_id text null,
  expires_at timestamptz null,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  requested_by uuid not null references public.app_users(id),
  verified_by uuid null references public.app_users(id),
  verified_at timestamptz null,
  operation_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (requested_by, operation_id),
  check (code_digest is null or code_digest ~ '^[0-9a-f]{64}$')
);

alter table public.request_delivery_otp_challenges enable row level security;
revoke all on public.request_delivery_otp_challenges
from public, anon, authenticated;

create table public.request_delivery_proofs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id),
  proof_method text not null check (proof_method in ('acknowledgement', 'otp', 'signature')),
  receiver_name text not null check (length(btrim(receiver_name)) between 2 and 160),
  acknowledged_at timestamptz not null default clock_timestamp(),
  delivered_by uuid not null references public.app_users(id),
  receiver_actor_id uuid null,
  otp_challenge_id uuid null references public.request_delivery_otp_challenges(id),
  signature_reference text null,
  attachment_id uuid null references public.request_attachments(id),
  device_snapshot jsonb not null default '[]'::jsonb
    check (jsonb_typeof(device_snapshot) = 'array'),
  risk_level text not null check (risk_level in ('low', 'high')),
  risk_reason text not null,
  evidence_status text not null default 'pending'
    check (evidence_status in ('pending', 'verified', 'rejected')),
  operation_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (delivered_by, operation_id)
);

alter table public.requests
  add constraint requests_delivery_proof_fk
  foreign key (delivery_proof_id)
  references public.request_delivery_proofs(id);

create index idx_request_delivery_proofs_request
  on public.request_delivery_proofs(request_id, created_at desc);

alter table public.request_delivery_proofs enable row level security;
revoke all on public.request_delivery_proofs from public, anon, authenticated;
grant select on public.request_delivery_proofs to authenticated;

create policy request_delivery_proofs_staff_read
on public.request_delivery_proofs
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in (
    'admin', 'it_manager', 'technician', 'warehouse_manager', 'auditor'
  )
);

create or replace function public.request_secondary_approve(
  p_id uuid,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request public.requests%rowtype;
  v_risk jsonb;
begin
  if not public.current_user_has_capability('request.approve') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or coalesce(length(btrim(p_reason)), 0) < 3 then
    return jsonb_build_object('ok', false, 'error', 'reason_required');
  end if;
  select * into v_request
  from public.requests where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in ('approved', 'provisioned', 'preparing', 'ready_for_pickup')
     or v_request.approved_by is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  v_risk := public._request_delivery_risk(p_id);
  if v_risk->>'level' <> 'high' then
    return jsonb_build_object('ok', false, 'error', 'second_approval_not_required');
  end if;
  if auth.uid() = any(array_remove(array[
    v_request.created_by,
    v_request.approved_by,
    v_request.prepared_by
  ], null)) then
    perform public._audit_write(
      'request_secondary_approval_denied', 'denied', 'requests', p_id::text,
      p_id, null, null, 'segregation_of_duties', 'rpc:request_secondary_approve',
      jsonb_build_object('operation_id', p_operation_id), null, null
    );
    return jsonb_build_object('ok', false, 'error', 'independent_approver_required');
  end if;
  update public.requests
  set second_approved_by = auth.uid(),
      second_approved_at = clock_timestamp(),
      second_approval_reason = btrim(p_reason),
      risk_level_snapshot = 'high',
      risk_reason_snapshot = v_risk->>'reason'
  where id = p_id;
  return jsonb_build_object('ok', true, 'risk_level', 'high');
end
$function$;

revoke all on function public.request_secondary_approve(uuid,text,uuid)
from public, anon;
grant execute on function public.request_secondary_approve(uuid,text,uuid)
to authenticated;

create or replace function public.request_delivery_create_otp_challenge(
  p_request_id uuid,
  p_provider text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_role text := public.app_user_role();
begin
  if v_role is null
     or v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or nullif(btrim(p_provider), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_otp_request');
  end if;
  if not exists (
    select 1 from public.requests
    where id = p_request_id and status = 'ready_for_pickup'
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  insert into public.request_delivery_otp_challenges (
    request_id, provider, requested_by, operation_id
  ) values (
    p_request_id, btrim(p_provider), auth.uid(), p_operation_id
  )
  on conflict (requested_by, operation_id) do update
  set request_id = excluded.request_id
  returning id into v_id;
  return jsonb_build_object(
    'ok', false,
    'error', 'otp_provider_integration_required',
    'challenge_id', v_id,
    'provider_status', 'pending_external'
  );
end
$function$;

revoke all on function public.request_delivery_create_otp_challenge(uuid,text,uuid)
from public, anon;
grant execute on function public.request_delivery_create_otp_challenge(uuid,text,uuid)
to authenticated;

create or replace function public.request_delivery_activate_otp(
  p_challenge_id uuid,
  p_code text,
  p_external_message_id text,
  p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(length(p_code), 0) < 6
     or p_expires_at <= clock_timestamp()
     or nullif(btrim(p_external_message_id), '') is null then
    raise exception 'invalid_otp_activation' using errcode = '22023';
  end if;
  update public.request_delivery_otp_challenges
  set code_digest = encode(extensions.digest(p_code, 'sha256'), 'hex'),
      external_message_id = btrim(p_external_message_id),
      expires_at = p_expires_at,
      provider_status = 'sent'
  where id = p_challenge_id
    and provider_status = 'pending_external';
  if not found then
    raise exception 'otp_challenge_not_pending' using errcode = '22023';
  end if;
end
$function$;

revoke all on function public.request_delivery_activate_otp(uuid,text,text,timestamptz)
from public, anon, authenticated;
grant execute on function public.request_delivery_activate_otp(uuid,text,text,timestamptz)
to service_role;

create or replace function public.request_delivery_verify_otp(
  p_challenge_id uuid,
  p_code text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_challenge public.request_delivery_otp_challenges%rowtype;
begin
  select * into v_challenge
  from public.request_delivery_otp_challenges
  where id = p_challenge_id for update;
  if not found or v_challenge.requested_by <> auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_challenge.provider_status <> 'sent'
     or v_challenge.expires_at <= clock_timestamp()
     or v_challenge.attempt_count >= 5 then
    update public.request_delivery_otp_challenges
    set provider_status = case
      when provider_status = 'sent' then 'expired'
      else provider_status
    end
    where id = p_challenge_id;
    return jsonb_build_object('ok', false, 'error', 'otp_not_verifiable');
  end if;
  update public.request_delivery_otp_challenges
  set attempt_count = attempt_count + 1
  where id = p_challenge_id;
  if encode(extensions.digest(p_code, 'sha256'), 'hex')
     <> v_challenge.code_digest then
    return jsonb_build_object('ok', false, 'error', 'otp_invalid');
  end if;
  update public.request_delivery_otp_challenges
  set provider_status = 'verified',
      verified_by = auth.uid(),
      verified_at = clock_timestamp()
  where id = p_challenge_id;
  return jsonb_build_object('ok', true);
end
$function$;

revoke all on function public.request_delivery_verify_otp(uuid,text)
from public, anon;
grant execute on function public.request_delivery_verify_otp(uuid,text)
to authenticated;

create or replace function public.request_deliver_with_proof(
  p_id uuid,
  p_proof jsonb,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_risk jsonb;
  v_method text := nullif(btrim(p_proof->>'method'), '');
  v_receiver text := nullif(btrim(p_proof->>'receiver_name'), '');
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
  if p_operation_id is null or v_receiver is null or length(v_receiver) > 160
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
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in ('ready_for_pickup', 'provisioned') then
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

  insert into public.request_delivery_proofs (
    request_id, proof_method, receiver_name, delivered_by,
    otp_challenge_id, signature_reference, attachment_id,
    device_snapshot, risk_level, risk_reason, operation_id
  ) values (
    p_id, v_method, v_receiver, auth.uid(),
    v_otp_id, v_signature, v_attachment_id,
    v_devices, v_risk->>'level', v_risk->>'reason', p_operation_id
  )
  returning id into v_proof_id;

  v_delivery := public.request_deliver(p_id)::jsonb;
  if not coalesce((v_delivery->>'ok')::boolean, false) then
    delete from public.request_delivery_proofs where id = v_proof_id;
    return v_delivery;
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

revoke all on function public.request_deliver(uuid)
from public, anon, authenticated;
revoke all on function public.request_deliver_with_proof(uuid,jsonb,uuid)
from public, anon;
grant execute on function public.request_deliver_with_proof(uuid,jsonb,uuid)
to authenticated;

-- An approved request may be converted into a purchase draft by the technician
-- preparing it. Approval of the resulting financial request remains manager-only.
do $extend_purchase_preparer$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.request_item_convert_to_pr(uuid,uuid)'::regprocedure
  ) into v_definition;
  if position(
    $q$v_role in ('admin', 'it_manager', 'technician')$q$
    in v_definition
  ) = 0 then
    v_definition := replace(
      v_definition,
      $q$v_role in ('admin', 'it_manager')$q$,
      $q$v_role in ('admin', 'it_manager', 'technician')$q$
    );
    execute v_definition;
  end if;
end
$extend_purchase_preparer$;

-- Purchase requests are financial: requester, two approvers, and receiver must
-- be separate people. The existing status remains "approved" between approvals.
alter table public.purchase_requests
  add column second_approved_by uuid null references public.app_users(id),
  add column second_approved_at timestamptz null;

create or replace function public.purchase_request_set_status(
  p_id uuid,
  p_to text
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.purchase_requests%rowtype;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  select * into v_request
  from public.purchase_requests where id = p_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_to = 'submitted' and v_request.status = 'draft' then
    if not exists (
      select 1 from public.purchase_request_items
      where purchase_request_id = p_id
    ) then
      return json_build_object('ok', false, 'error', 'items_required');
    end if;
    update public.purchase_requests
    set status = 'submitted', submitted_at = clock_timestamp()
    where id = p_id;
  elsif p_to = 'approved'
        and v_request.status = 'submitted'
        and v_role in ('admin', 'it_manager') then
    if v_request.requested_by = auth.uid() then
      return json_build_object('ok', false, 'error', 'independent_approver_required');
    end if;
    update public.purchase_requests
    set status = 'approved',
        approved_by = auth.uid(),
        approved_at = clock_timestamp()
    where id = p_id;
  elsif p_to = 'second_approved'
        and v_request.status = 'approved'
        and v_role in ('admin', 'it_manager') then
    if auth.uid() = any(array_remove(array[
      v_request.requested_by, v_request.approved_by
    ], null)) then
      return json_build_object('ok', false, 'error', 'independent_second_approver_required');
    end if;
    update public.purchase_requests
    set second_approved_by = auth.uid(),
        second_approved_at = clock_timestamp()
    where id = p_id;
  elsif p_to = 'ordered' and v_request.status = 'approved' then
    if v_request.second_approved_by is null then
      return json_build_object('ok', false, 'error', 'second_approval_required');
    end if;
    if auth.uid() = any(array_remove(array[
      v_request.requested_by,
      v_request.approved_by,
      v_request.second_approved_by
    ], null)) then
      return json_build_object('ok', false, 'error', 'independent_orderer_required');
    end if;
    update public.purchase_requests set status = 'ordered' where id = p_id;
  elsif p_to in ('partially_received', 'received') then
    return json_build_object('ok', false, 'error', 'receipt_status_is_derived');
  elsif p_to = 'cancelled'
        and v_request.status in ('draft', 'submitted', 'approved', 'ordered') then
    if v_role in ('admin', 'it_manager')
       or (v_request.status = 'draft' and v_request.requested_by = auth.uid()) then
      update public.purchase_requests
      set status = 'cancelled',
          cancelled_by = auth.uid(),
          cancelled_at = clock_timestamp()
      where id = p_id;
    else
      return json_build_object('ok', false, 'error', 'bad_transition');
    end if;
  else
    return json_build_object('ok', false, 'error', 'bad_transition');
  end if;
  return json_build_object('ok', true);
end
$function$;

-- Receiving is an operational warehouse duty. Extend only the current
-- receiving RPC's role gate; its state/quantity locks and the SoD trigger below
-- remain authoritative.
do $extend_receiving_role$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.purchase_request_item_receive(uuid,numeric)'::regprocedure
  ) into v_definition;
  if position('warehouse_manager' in v_definition) = 0 then
    v_definition := replace(
      v_definition,
      $q$'admin', 'it_manager', 'technician'$q$,
      $q$'admin', 'it_manager', 'technician', 'warehouse_manager'$q$
    );
    execute v_definition;
  end if;
end
$extend_receiving_role$;

create or replace function public._purchase_receipt_sod_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  v_request public.purchase_requests%rowtype;
begin
  if new.received_quantity > old.received_quantity then
    select * into v_request
    from public.purchase_requests
    where id = new.purchase_request_id;
    if v_request.second_approved_by is null then
      raise exception 'second_approval_required' using errcode = '42501';
    end if;
    if auth.uid() = any(array_remove(array[
      v_request.requested_by,
      v_request.approved_by,
      v_request.second_approved_by
    ], null)) then
      raise exception 'independent_receiver_required' using errcode = '42501';
    end if;
  end if;
  return new;
end
$function$;

create trigger trg_purchase_receipt_sod_guard
before update of received_quantity on public.purchase_request_items
for each row execute function public._purchase_receipt_sod_guard();

-- Manual absolute balance changes bypass independent review. Make the legacy
-- adjust mode fail closed; reviewed stocktake is the supported correction path.
create or replace function public._consumable_manual_adjustment_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if new.txn_type = 'adjust' then
    raise exception 'manual_adjustment_requires_stocktake'
      using errcode = '42501';
  end if;
  return new;
end
$function$;

create trigger trg_consumable_manual_adjustment_guard
before insert on public.consumable_transactions
for each row execute function public._consumable_manual_adjustment_guard();

create trigger trg_unified_audit
after insert or update or delete on public.request_delivery_proofs
for each row execute function public._audit_row_change();

create trigger trg_unified_audit
after insert or update or delete on public.sod_operation_policies
for each row execute function public._audit_row_change();

commit;
