begin;

-- -------------------------------------------------------------------------
-- Request amendments and idempotent operation registry
-- -------------------------------------------------------------------------
create table if not exists public.request_operation_results (
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  operation_type text not null,
  request_id uuid null references public.requests(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation_id)
);
alter table public.request_operation_results enable row level security;
revoke all on public.request_operation_results from public, anon, authenticated;
create policy request_operation_result_self
on public.request_operation_results
for select to authenticated
using (actor_id = auth.uid() and public.is_approved());

create table if not exists public.request_amendments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id),
  version integer not null check (version > 0),
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'rejected')),
  patch jsonb not null check (jsonb_typeof(patch) = 'object'),
  reason text not null check (length(btrim(reason)) >= 5),
  requires_reapproval boolean not null default true,
  created_by uuid not null references auth.users(id),
  reviewed_by uuid null references auth.users(id),
  reviewed_at timestamptz null,
  review_reason text null,
  created_at timestamptz not null default now(),
  unique (request_id, version)
);
create index if not exists idx_request_amendments_request_version
  on public.request_amendments(request_id, version desc);
alter table public.request_amendments enable row level security;
revoke all on public.request_amendments from public, anon, authenticated;
grant select on public.request_amendments to authenticated;
create policy request_amendments_staff_read
on public.request_amendments
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');

alter table public.requests
  add column if not exists scope_version integer not null default 1,
  add column if not exists last_amendment_id uuid null
    references public.request_amendments(id);

create or replace function public._request_scope_change_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if current_setting('app.request_amendment_apply', true) = 'on' then
    return new;
  end if;
  if old.status in (
    'approved', 'auto_provisioning', 'provisioned', 'stock_shortage',
    'preparing', 'ready_for_pickup', 'delivered', 'partially_returned',
    'returned', 'completed', 'overdue'
  ) and (
    new.request_type is distinct from old.request_type
    or new.beneficiary_type is distinct from old.beneficiary_type
    or new.beneficiary_employee_id is distinct from old.beneficiary_employee_id
    or new.customer_id is distinct from old.customer_id
    or new.pickup_date is distinct from old.pickup_date
    or new.return_date is distinct from old.return_date
  ) then
    raise exception 'approved_request_requires_amendment' using errcode = '23514';
  end if;
  return new;
end
$function$;

-- Existing provisioning RPCs legitimately materialize approved demand into
-- asset rows (and remove the fulfilled custom demand row). Keep the direct
-- trigger fail-closed, but grant that narrow bypass only while trusted
-- SECURITY DEFINER workflow functions execute.
create or replace function public.request_approve(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_request public.requests%rowtype;
  v_provision jsonb;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'under_review'
     or v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  update public.requests
  set status = 'approved',
      responsible_employee_id = coalesce(responsible_employee_id, v_uid)
  where id = p_id;
  perform set_config('app.request_fulfillment_apply', 'on', true);
  v_provision := public._request_auto_provision(p_id);
  perform set_config('app.request_fulfillment_apply', 'off', true);
  return json_build_object('ok', true, 'provision', v_provision);
end
$function$;

create or replace function public.request_auto_provision(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_result jsonb;
begin
  if v_role is null
     or v_role not in ('admin','it_manager','technician','warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  perform set_config('app.request_fulfillment_apply', 'on', true);
  v_result := public._request_auto_provision(p_id);
  perform set_config('app.request_fulfillment_apply', 'off', true);
  return v_result;
end
$function$;

create or replace function public.request_shortage_fulfill_available(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
begin
  if v_role is null
     or v_role not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_request.status <> 'stock_shortage' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  perform set_config('app.request_fulfillment_apply', 'on', true);
  delete from public.request_items
  where request_id = p_id
    and item_kind = 'custom'
    and requested_kind = 'existing_asset'
    and asset_id is null
    and coalesce(needs_purchase, false) = false;
  perform set_config('app.request_fulfillment_apply', 'off', true);
  update public.requests set status = 'provisioned' where id = p_id;
  perform public._request_add_event(
    p_id, 'shortage_fulfill_available', 'staff', null, '{}'::jsonb
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.request_complete(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller text := public.app_user_role();
  v_request public.requests%rowtype;
  v_uid uuid := auth.uid();
  v_item record;
begin
  if v_caller is null
     or v_caller not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_request.status not in ('delivered','partially_returned','returned') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  -- Evidence belongs to this checkout only when it was recorded after the
  -- asset left for this request. last_request_id alone is insufficient because
  -- delivery intentionally reuses the asset row and older return timestamps.
  if v_request.request_type <> 'sale' and exists (
    select 1
    from public.request_items ri
    join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
      and coalesce(ri.delivered_quantity, 0) > 0
      and not (
        a.last_request_id = p_id
        and a.last_out_at is not null
        and a.last_return_at is not null
        and a.last_return_at >= a.last_out_at
        and a.last_return_condition in ('sound','unsound','missing','needs_maintenance')
      )
  ) then
    return json_build_object('ok', false, 'error', 'inspection_required');
  end if;

  for v_item in
    select ri.id, ri.asset_id, ri.delivered_quantity, a.status
    from public.request_items ri
    join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
      and a.status = 'rented'
    for update of a
  loop
    update public.assets set status = 'available' where id = v_item.asset_id;
    insert into public.asset_movements(
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_item.asset_id, 'status_change', 'rented', 'available', v_uid,
      'إكمال طلب ' || v_request.request_number
    );
    update public.request_items
    set returned_quantity = delivered_quantity
    where id = v_item.id;
  end loop;
  update public.requests set status = 'completed' where id = p_id;
  return json_build_object('ok', true);
end
$function$;

drop trigger if exists trg_request_scope_change_guard on public.requests;
create trigger trg_request_scope_change_guard
before update on public.requests
for each row execute function public._request_scope_change_guard();

create or replace function public._request_item_scope_change_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_status text;
  v_request_id uuid;
begin
  if tg_op = 'DELETE' then
    v_request_id := old.request_id;
  else
    v_request_id := new.request_id;
  end if;
  if current_setting('app.request_amendment_apply', true) = 'on'
     or current_setting('app.request_fulfillment_apply', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  select status into v_status from public.requests where id = v_request_id;
  if v_status in (
    'approved', 'auto_provisioning', 'provisioned', 'stock_shortage',
    'preparing', 'ready_for_pickup', 'delivered', 'partially_returned',
    'returned', 'completed', 'overdue'
  ) and (
    tg_op in ('INSERT', 'DELETE')
    or new.quantity is distinct from old.quantity
    or new.requested_kind is distinct from old.requested_kind
    or new.requested_description is distinct from old.requested_description
    or new.requested_category is distinct from old.requested_category
    or new.preferred_model is distinct from old.preferred_model
    or new.preferred_company_id is distinct from old.preferred_company_id
    or new.unit_price is distinct from old.unit_price
    or new.total_price is distinct from old.total_price
  ) then
    raise exception 'approved_request_items_require_amendment' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

drop trigger if exists trg_request_item_scope_change_guard on public.request_items;
create trigger trg_request_item_scope_change_guard
before insert or update or delete on public.request_items
for each row execute function public._request_item_scope_change_guard();

create or replace function public.requests_guard_status()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_amendment_reset boolean :=
    current_setting('app.request_amendment_apply', true) = 'on'
    and old.status in (
      'approved', 'auto_provisioning', 'provisioned', 'stock_shortage',
      'preparing', 'ready_for_pickup'
    )
    and new.status = 'under_review';
begin
  if new.status is distinct from old.status then
    if not v_amendment_reset
       and not public.request_status_allowed(old.status, new.status) then
      raise exception 'انتقال حالة طلب غير مسموح: % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status in ('approved','rejected')
       and not public.current_user_has_capability('request.approve') then
      raise exception 'الاعتماد/الرفض يتطلب صلاحية اعتماد الطلبات'
        using errcode = 'insufficient_privilege';
    end if;
    if v_amendment_reset then
      new.approved_by := null;
      new.approved_at := null;
      new.rejected_by := null;
      new.rejected_at := null;
      new.rejection_reason := null;
    elsif new.status = 'approved' then
      new.approved_by := auth.uid(); new.approved_at := now();
      new.rejected_by := null; new.rejected_at := null; new.rejection_reason := null;
    elsif new.status = 'rejected' then
      new.rejected_by := auth.uid(); new.rejected_at := now();
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    else
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
      new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at;
      new.rejection_reason := old.rejection_reason;
    end if;
  else
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at;
    new.rejection_reason := old.rejection_reason;
  end if;
  return new;
end
$function$;

create or replace function public._request_sod_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if current_setting('app.request_amendment_apply', true) = 'on'
     and new.status = 'under_review' then
    new.prepared_by := null;
    new.prepared_at := null;
    new.second_approved_by := null;
    new.second_approved_at := null;
    new.second_approval_reason := null;
    new.delivered_by := null;
    new.delivery_proof_id := null;
    new.risk_level_snapshot := null;
    new.risk_reason_snapshot := null;
    return new;
  end if;
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
      raise exception 'invalid_secondary_approval' using errcode = '42501';
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
      raise exception 'invalid_delivery_evidence' using errcode = '42501';
    end if;
  else
    new.delivered_by := old.delivered_by;
    new.delivery_proof_id := old.delivery_proof_id;
  end if;
  if new.risk_level_snapshot is distinct from old.risk_level_snapshot
     or new.risk_reason_snapshot is distinct from old.risk_reason_snapshot then
    if new.risk_level_snapshot <> public._request_delivery_risk(new.id)->>'level'
       or new.risk_reason_snapshot <> public._request_delivery_risk(new.id)->>'reason'
       or (new.second_approved_by is null and new.delivery_proof_id is null) then
      raise exception 'invalid_risk_snapshot' using errcode = '42501';
    end if;
  else
    new.risk_level_snapshot := old.risk_level_snapshot;
    new.risk_reason_snapshot := old.risk_reason_snapshot;
  end if;
  return new;
end
$function$;

create or replace function public.request_create_amendment(
  p_request_id uuid,
  p_patch jsonb,
  p_reason text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_version integer;
  v_request_status text;
  v_id uuid;
  v_existing jsonb;
begin
  if not public.is_approved()
     or public.app_user_role() not in (
       'admin', 'it_manager', 'technician', 'warehouse_manager'
     ) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or jsonb_typeof(p_patch) <> 'object'
     or length(btrim(coalesce(p_reason, ''))) < 5 then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_existing
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_existing; end if;

  select status into v_request_status
  from public.requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request_status not in (
    'approved', 'auto_provisioning', 'provisioned', 'stock_shortage',
    'preparing', 'ready_for_pickup'
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  select coalesce(max(version), 0) + 1 into v_version
  from public.request_amendments where request_id = p_request_id;
  insert into public.request_amendments(
    request_id, version, patch, reason, created_by
  ) values (
    p_request_id, v_version, p_patch, btrim(p_reason), v_uid
  ) returning id into v_id;
  v_existing := jsonb_build_object(
    'ok', true, 'id', v_id, 'request_id', p_request_id, 'version', v_version
  );
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, request_id, result
  ) values (v_uid, p_operation_id, 'create_amendment', p_request_id, v_existing);
  return v_existing;
end
$function$;

create or replace function public.request_review_amendment(
  p_amendment_id uuid,
  p_decision text,
  p_review_reason text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_amendment public.request_amendments%rowtype;
  v_request_status text;
  v_request_patch jsonb;
  v_item jsonb;
  v_result jsonb;
begin
  if not public.current_user_has_capability('request.approve') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or p_decision not in ('approved', 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  select * into v_amendment
  from public.request_amendments
  where id = p_amendment_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_amendment.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if v_amendment.created_by = v_uid then
    return jsonb_build_object('ok', false, 'error', 'independent_review_required');
  end if;

  if p_decision = 'approved' then
    select status into v_request_status
    from public.requests
    where id = v_amendment.request_id
    for update;
    if v_request_status not in (
      'approved', 'auto_provisioning', 'provisioned', 'stock_shortage',
      'preparing', 'ready_for_pickup'
    ) then
      return jsonb_build_object('ok', false, 'error', 'invalid_state');
    end if;
    if v_amendment.patch - array['request', 'items'] <> '{}'::jsonb then
      return jsonb_build_object('ok', false, 'error', 'unsupported_amendment_patch');
    end if;
    v_request_patch := coalesce(v_amendment.patch -> 'request', '{}'::jsonb);
    if jsonb_typeof(v_request_patch) <> 'object'
       or jsonb_typeof(coalesce(v_amendment.patch -> 'items', '[]'::jsonb)) <> 'array' then
      return jsonb_build_object('ok', false, 'error', 'invalid_amendment_patch');
    end if;
    if v_request_patch - array['pickup_date', 'return_date', 'notes'] <> '{}'::jsonb then
      return jsonb_build_object('ok', false, 'error', 'unsupported_request_patch');
    end if;
    -- Validate every item before changing any row. Returning a JSON error does
    -- not roll back earlier statements, so validation and application must be
    -- separate phases.
    for v_item in
      select value from jsonb_array_elements(
        coalesce(v_amendment.patch -> 'items', '[]'::jsonb)
      ) items(value)
    loop
      if v_item - array['id', 'quantity', 'unit_price', 'total_price'] <> '{}'::jsonb
         or not (v_item ? 'id') then
        return jsonb_build_object('ok', false, 'error', 'unsupported_item_patch');
      end if;
      if (v_item ? 'unit_price' or v_item ? 'total_price')
         and not public.is_financial_viewer() then
        return jsonb_build_object('ok', false, 'error', 'financial_access_required');
      end if;
      perform 1 from public.request_items
      where id = (v_item->>'id')::uuid
        and request_id = v_amendment.request_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'item_not_found');
      end if;
    end loop;

    perform set_config('app.request_amendment_apply', 'on', true);
    update public.requests
    set pickup_date = case when v_request_patch ? 'pickup_date'
          then nullif(v_request_patch->>'pickup_date', '')::date else pickup_date end,
        return_date = case when v_request_patch ? 'return_date'
          then nullif(v_request_patch->>'return_date', '')::date else return_date end,
        notes = case when v_request_patch ? 'notes'
          then nullif(v_request_patch->>'notes', '') else notes end
    where id = v_amendment.request_id;

    for v_item in
      select value from jsonb_array_elements(
        coalesce(v_amendment.patch -> 'items', '[]'::jsonb)
      ) items(value)
    loop
      update public.request_items
      set quantity = case when v_item ? 'quantity'
            then (v_item->>'quantity')::numeric else quantity end,
          unit_price = case when v_item ? 'unit_price'
            then (v_item->>'unit_price')::numeric else unit_price end,
          total_price = case when v_item ? 'total_price'
            then (v_item->>'total_price')::numeric else total_price end
      where id = (v_item->>'id')::uuid
        and request_id = v_amendment.request_id;
    end loop;

    perform public._request_release_reservations(
      v_amendment.request_id, 'approved_amendment'
    );
    update public.requests
    set status = 'under_review',
        approved_at = null,
        approved_by = null,
        prepared_at = null,
        prepared_by = null,
        second_approved_at = null,
        second_approved_by = null,
        second_approval_reason = null,
        delivered_by = null,
        delivery_proof_id = null,
        risk_level_snapshot = null,
        risk_reason_snapshot = null,
        scope_version = scope_version + 1,
        last_amendment_id = v_amendment.id
    where id = v_amendment.request_id;
    perform set_config('app.request_amendment_apply', 'off', true);
  end if;

  update public.request_amendments
  set status = p_decision,
      reviewed_by = v_uid,
      reviewed_at = now(),
      review_reason = nullif(btrim(p_review_reason), '')
  where id = p_amendment_id;
  v_result := jsonb_build_object(
    'ok', true, 'id', p_amendment_id, 'decision', p_decision,
    'request_id', v_amendment.request_id
  );
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, request_id, result
  ) values (v_uid, p_operation_id, 'review_amendment', v_amendment.request_id, v_result);
  return v_result;
end
$function$;

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

create or replace function public.request_create_idempotent(
  p_operation_id uuid,
  p_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_role text := public.app_user_role();
begin
  if not public.is_approved() or p_operation_id is null
     or jsonb_typeof(p_input) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  if v_role = 'employee' then
    v_result := public.request_create_employee_self(
      p_input->>'status',
      p_input->>'project_name',
      nullif(p_input->>'pickup_date', '')::date,
      nullif(p_input->>'return_date', '')::date,
      p_input->>'notes',
      coalesce(p_input->'items', '[]'::jsonb)
    )::jsonb;
  else
    v_result := public.request_create_staff(
      p_input->>'status',
      nullif(p_input->>'customer_id', '')::uuid,
      p_input->>'customer_name',
      p_input->>'contact_phone',
      p_input->>'project_name',
      p_input->>'project_city',
      p_input->>'request_type',
      nullif(p_input->>'pickup_date', '')::date,
      nullif(p_input->>'return_date', '')::date,
      p_input->>'notes',
      p_input->>'internal_notes',
      coalesce(p_input->'items', '[]'::jsonb)
    )::jsonb;
  end if;
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, request_id, result
  ) values (
    v_uid, p_operation_id, 'create',
    nullif(v_result->>'id', '')::uuid, v_result
  );
  return v_result;
end
$function$;

create or replace function public.request_operation_result_lookup(p_operation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select result
  from public.request_operation_results
  where actor_id = auth.uid() and operation_id = p_operation_id
$function$;

-- -------------------------------------------------------------------------
-- Maintenance workflow evidence
-- -------------------------------------------------------------------------
alter table public.maintenance_records
  add column if not exists diagnosis text null,
  add column if not exists cause_code text null,
  add column if not exists resolution_code text null,
  add column if not exists waiting_reason text null,
  add column if not exists labor_minutes integer not null default 0
    check (labor_minutes >= 0 and labor_minutes <= 100000),
  add column if not exists escalation_level integer not null default 0
    check (escalation_level between 0 and 5),
  add column if not exists escalated_at timestamptz null,
  add column if not exists sla_due_at timestamptz null,
  add column if not exists sla_breached_at timestamptz null,
  add column if not exists repair_checklist jsonb not null default '{}'::jsonb
    check (jsonb_typeof(repair_checklist) = 'object'),
  add column if not exists functional_test_passed boolean null,
  add column if not exists functional_test_notes text null,
  add column if not exists completed_by uuid null references auth.users(id),
  add column if not exists handoff_state text not null default 'not_ready'
    check (handoff_state in ('not_ready', 'ready_for_custody', 'handed_off'));

grant select (
  diagnosis, cause_code, resolution_code, waiting_reason, labor_minutes,
  escalation_level, escalated_at, sla_due_at, sla_breached_at,
  repair_checklist, functional_test_passed, functional_test_notes,
  completed_by, handoff_state
) on public.maintenance_records to authenticated;

create table if not exists public.maintenance_time_entries (
  id uuid primary key default gen_random_uuid(),
  maintenance_id uuid not null references public.maintenance_records(id),
  technician_id uuid not null references auth.users(id),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  minutes integer generated always as (
    greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60)::integer)
  ) stored,
  note text null,
  created_at timestamptz not null default now(),
  check (ended_at > started_at)
);
create index if not exists idx_maintenance_time_entries_record
  on public.maintenance_time_entries(maintenance_id, started_at desc);
alter table public.maintenance_time_entries enable row level security;
revoke all on public.maintenance_time_entries from public, anon, authenticated;
grant select on public.maintenance_time_entries to authenticated;
create policy maintenance_time_read
on public.maintenance_time_entries for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');

create table if not exists public.maintenance_parts (
  id uuid primary key default gen_random_uuid(),
  maintenance_id uuid not null references public.maintenance_records(id),
  consumable_id uuid null references public.consumables(id),
  description text null,
  planned_quantity numeric not null check (planned_quantity > 0),
  used_quantity numeric not null default 0
    check (used_quantity >= 0 and used_quantity <= planned_quantity),
  stock_transaction_id uuid null references public.consumable_transactions(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (consumable_id is not null or nullif(btrim(description), '') is not null),
  check (used_quantity = 0 or stock_transaction_id is not null)
);
create index if not exists idx_maintenance_parts_record
  on public.maintenance_parts(maintenance_id);
alter table public.maintenance_parts enable row level security;
revoke all on public.maintenance_parts from public, anon, authenticated;
grant select on public.maintenance_parts to authenticated;
create policy maintenance_parts_read
on public.maintenance_parts for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');

create or replace function public._maintenance_sla_stamp()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.sla_due_at is null then
    new.sla_due_at := coalesce(
      new.next_due_date::timestamptz + interval '1 day' - interval '1 second',
      coalesce(new.reported_at, now()) + case coalesce(new.priority, 'medium')
        when 'critical' then interval '4 hours'
        when 'high' then interval '8 hours'
        when 'low' then interval '5 days'
        else interval '2 days'
      end
    );
  end if;
  if new.status in ('completed', 'cancelled') then
    return new;
  end if;
  if new.sla_due_at < now() then
    new.sla_breached_at := coalesce(new.sla_breached_at, now());
  end if;
  return new;
end
$function$;

drop trigger if exists trg_maintenance_sla_stamp on public.maintenance_records;
create trigger trg_maintenance_sla_stamp
before insert or update on public.maintenance_records
for each row execute function public._maintenance_sla_stamp();

create or replace function public._maintenance_completion_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_closing boolean := tg_op = 'INSERT';
begin
  if tg_op = 'UPDATE' then
    v_closing := old.status is distinct from 'completed';
  end if;
  if new.status = 'completed' and v_closing then
    if new.technician_id is null
       or nullif(btrim(new.diagnosis), '') is null
       or nullif(btrim(new.cause_code), '') is null
       or nullif(btrim(new.resolution_code), '') is null
       or (
         new.workflow_stage = 'completed'
         and (
           new.functional_test_passed is not true
           or coalesce((new.repair_checklist->>'safety_checked')::boolean, false) is not true
           or coalesce((new.repair_checklist->>'function_checked')::boolean, false) is not true
           or coalesce((new.repair_checklist->>'data_checked')::boolean, false) is not true
         )
       ) then
      raise exception 'maintenance_completion_evidence_required' using errcode = '23514';
    end if;
    new.completed_by := auth.uid();
    new.handoff_state := case
      when new.workflow_stage = 'completed' then 'ready_for_custody'
      else 'not_ready'
    end;
  end if;
  if new.workflow_stage in ('awaiting_parts', 'at_vendor')
     and nullif(btrim(new.waiting_reason), '') is null then
    raise exception 'maintenance_waiting_reason_required' using errcode = '23514';
  end if;
  return new;
end
$function$;

create or replace function public.maintenance_confirm_handoff(
  p_id uuid,
  p_operation_id uuid
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
  if not public.current_user_has_capability('maintenance.manage')
     or p_operation_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  update public.maintenance_records
  set handoff_state = 'handed_off'
  where id = p_id
    and status = 'completed'
    and workflow_stage = 'completed'
    and handoff_state = 'ready_for_custody'
    and functional_test_passed is true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'handoff_not_ready');
  end if;
  v_result := jsonb_build_object('ok', true, 'id', p_id, 'handoff_state', 'handed_off');
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, result
  ) values (v_uid, p_operation_id, 'maintenance_handoff', v_result);
  return v_result;
end
$function$;

drop trigger if exists trg_maintenance_completion_guard on public.maintenance_records;
create trigger trg_maintenance_completion_guard
before insert or update on public.maintenance_records
for each row execute function public._maintenance_completion_guard();

create or replace function public.maintenance_update_safe(
  p_id uuid,
  p_input jsonb,
  p_operation_id uuid
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
  if not public.current_user_has_capability('maintenance.manage')
     or p_operation_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  update public.maintenance_records
  set diagnosis = case when p_input ? 'diagnosis'
        then nullif(btrim(p_input->>'diagnosis'), '') else diagnosis end,
      cause_code = case when p_input ? 'cause_code'
        then nullif(btrim(p_input->>'cause_code'), '') else cause_code end,
      resolution_code = case when p_input ? 'resolution_code'
        then nullif(btrim(p_input->>'resolution_code'), '') else resolution_code end,
      waiting_reason = case when p_input ? 'waiting_reason'
        then nullif(btrim(p_input->>'waiting_reason'), '') else waiting_reason end,
      labor_minutes = case when p_input ? 'labor_minutes'
        then (p_input->>'labor_minutes')::integer else labor_minutes end,
      repair_checklist = case when p_input ? 'repair_checklist'
        then p_input->'repair_checklist' else repair_checklist end,
      functional_test_passed = case when p_input ? 'functional_test_passed'
        then (p_input->>'functional_test_passed')::boolean else functional_test_passed end,
      functional_test_notes = case when p_input ? 'functional_test_notes'
        then nullif(btrim(p_input->>'functional_test_notes'), '') else functional_test_notes end
  where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  v_result := public.maintenance_update_atomic(p_id, p_input)::jsonb;
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    -- Abort the transaction so the evidence update above cannot survive a
    -- rejected state/asset transition from the authoritative atomic RPC.
    raise exception 'maintenance_update_rejected:%',
      coalesce(v_result->>'error', 'failed')
      using errcode = 'P0001';
  end if;
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, request_id, result
  ) values (v_uid, p_operation_id, 'maintenance_update', null, v_result);
  return v_result;
end
$function$;

create or replace function public.maintenance_add_time_entry(
  p_maintenance_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_note text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_result jsonb;
begin
  if not public.current_user_has_capability('maintenance.manage')
     or p_operation_id is null
     or p_started_at is null
     or p_ended_at is null
     or p_ended_at <= p_started_at then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  perform 1 from public.maintenance_records
  where id = p_maintenance_id and status not in ('completed', 'cancelled')
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_maintenance_state');
  end if;
  insert into public.maintenance_time_entries(
    maintenance_id, technician_id, started_at, ended_at, note
  ) values (
    p_maintenance_id, v_uid, p_started_at, p_ended_at,
    nullif(btrim(p_note), '')
  ) returning id into v_id;
  v_result := jsonb_build_object(
    'ok', true, 'id', v_id, 'maintenance_id', p_maintenance_id
  );
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, result
  ) values (v_uid, p_operation_id, 'maintenance_time', v_result);
  return v_result;
end
$function$;

create or replace function public.maintenance_plan_part(
  p_maintenance_id uuid,
  p_consumable_id uuid,
  p_description text,
  p_planned_quantity numeric,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_result jsonb;
begin
  if not public.current_user_has_capability('maintenance.manage')
     or p_operation_id is null
     or p_planned_quantity is null
     or p_planned_quantity <= 0
     or (p_consumable_id is null and nullif(btrim(p_description), '') is null) then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  perform 1 from public.maintenance_records
  where id = p_maintenance_id and status not in ('completed', 'cancelled')
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_maintenance_state');
  end if;
  insert into public.maintenance_parts(
    maintenance_id, consumable_id, description, planned_quantity, created_by
  ) values (
    p_maintenance_id, p_consumable_id, nullif(btrim(p_description), ''),
    p_planned_quantity, v_uid
  ) returning id into v_id;
  v_result := jsonb_build_object(
    'ok', true, 'id', v_id, 'maintenance_id', p_maintenance_id
  );
  insert into public.request_operation_results(
    actor_id, operation_id, operation_type, result
  ) values (v_uid, p_operation_id, 'maintenance_part_plan', v_result);
  return v_result;
end
$function$;

create or replace function public.maintenance_escalate_overdue()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer;
begin
  if public.app_user_role() not in ('admin', 'it_manager') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  update public.maintenance_records
  set escalation_level = least(5, escalation_level + 1),
      escalated_at = now()
  where status in ('open', 'in_progress')
    and sla_due_at < now()
    and (escalated_at is null or escalated_at < now() - interval '24 hours');
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

revoke all on function public._request_scope_change_guard() from public, anon, authenticated;
revoke all on function public._request_item_scope_change_guard() from public, anon, authenticated;
revoke all on function public.request_create_amendment(uuid,jsonb,text,uuid) from public, anon;
revoke all on function public.request_review_amendment(uuid,text,text,uuid) from public, anon;
revoke all on function public.request_execute_idempotent(uuid,text,uuid,jsonb) from public, anon;
revoke all on function public.request_create_idempotent(uuid,jsonb) from public, anon;
revoke all on function public.request_operation_result_lookup(uuid) from public, anon;
revoke all on function public._maintenance_completion_guard() from public, anon, authenticated;
revoke all on function public._maintenance_sla_stamp() from public, anon, authenticated;
revoke all on function public.maintenance_update_safe(uuid,jsonb,uuid) from public, anon;
revoke all on function public.maintenance_add_time_entry(uuid,timestamptz,timestamptz,text,uuid) from public, anon;
revoke all on function public.maintenance_plan_part(uuid,uuid,text,numeric,uuid) from public, anon;
revoke all on function public.maintenance_confirm_handoff(uuid,uuid) from public, anon;
revoke all on function public.maintenance_escalate_overdue() from public, anon;
grant execute on function public.request_create_amendment(uuid,jsonb,text,uuid) to authenticated;
grant execute on function public.request_review_amendment(uuid,text,text,uuid) to authenticated;
grant execute on function public.request_execute_idempotent(uuid,text,uuid,jsonb) to authenticated;
grant execute on function public.request_create_idempotent(uuid,jsonb) to authenticated;
grant execute on function public.request_operation_result_lookup(uuid) to authenticated;
grant execute on function public.maintenance_update_safe(uuid,jsonb,uuid) to authenticated;
grant execute on function public.maintenance_add_time_entry(uuid,timestamptz,timestamptz,text,uuid) to authenticated;
grant execute on function public.maintenance_plan_part(uuid,uuid,text,numeric,uuid) to authenticated;
grant execute on function public.maintenance_confirm_handoff(uuid,uuid) to authenticated;
grant execute on function public.maintenance_escalate_overdue() to authenticated;

commit;
