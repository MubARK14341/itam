-- Purpose: EDIT 3 — preserve pending self-registration and add one canonical,
-- exact physical-asset allocation record for warehouse preparation/delivery/return.
-- Risk: additive table/RPCs plus deterministic legacy-status remediation.
-- Rollback: revoke the new RPCs and leave immutable movement/audit evidence intact.
-- No assets, Auth users, custody rows, or audit records are deleted.

begin;

-- A neutral archive marker is intentionally separate from an operational status.
alter table public.assets add column if not exists archived_at timestamptz;
alter table public.assets add column if not exists archive_note text;
create index if not exists assets_active_operational_idx
  on public.assets (status, category_id) where archived_at is null and is_active;

-- The existing status trigger validates this remediation too.  Permit only the
-- two deterministic legacy-to-archive transitions before the final policy
-- below removes every legacy transition again.
create or replace function public.asset_status_allowed(p_old public.asset_status, p_new public.asset_status)
returns boolean language plpgsql immutable set search_path = public as $function$
begin
  if p_old in ('damaged'::public.asset_status,'retired'::public.asset_status) then return p_new='available'::public.asset_status; end if;
  if p_old = p_new then return true; end if;
  return case p_old
    when 'available' then p_new in ('assigned','reserved','in_maintenance','rented','sold')
    when 'assigned' then p_new in ('available','reserved','in_maintenance')
    when 'reserved' then p_new in ('available','assigned','in_maintenance','rented','sold')
    when 'in_maintenance' then p_new in ('available','assigned')
    when 'rented' then p_new in ('available','reserved','in_maintenance','sold')
    when 'sold' then false
    when 'disposed' then false
    else false
  end;
end
$function$;

-- These six synthetic legacy assets were prechecked before this migration: no
-- active custody, open maintenance, or open request allocation exists. They are
-- preserved as archived records and their old status remains only in history.
insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
select a.id, 'status_change', a.status, 'available'::public.asset_status, auth.uid(),
  'EDIT 3 legacy status remediation: archived record; original operational state retained in history'
from public.assets a
where a.status in ('damaged'::public.asset_status, 'retired'::public.asset_status)
  and not exists (select 1 from public.asset_assignments aa where aa.asset_id = a.id and aa.status = 'active')
  and not exists (select 1 from public.maintenance_records mr where mr.asset_id = a.id and mr.status in ('open','in_progress'))
  and not exists (
    select 1 from public.request_items ri join public.requests r on r.id = ri.request_id
    where ri.asset_id = a.id and r.status not in ('completed','cancelled','rejected','returned')
  );

update public.assets a
set status = 'available'::public.asset_status,
    is_active = false,
    archived_at = coalesce(a.archived_at, now()),
    archive_note = coalesce(a.archive_note, 'EDIT 3: archived during legacy operational-status remediation'),
    assigned_to_employee_id = null
where a.status in ('damaged'::public.asset_status, 'retired'::public.asset_status)
  and not exists (select 1 from public.asset_assignments aa where aa.asset_id = a.id and aa.status = 'active')
  and not exists (select 1 from public.maintenance_records mr where mr.asset_id = a.id and mr.status in ('open','in_progress'))
  and not exists (
    select 1 from public.request_items ri join public.requests r on r.id = ri.request_id
    where ri.asset_id = a.id and r.status not in ('completed','cancelled','rejected','returned')
  );

do $legacy$
begin
  if exists (select 1 from public.assets where status in ('damaged'::public.asset_status, 'retired'::public.asset_status)) then
    raise exception 'edit_3_legacy_status_remediation_incomplete';
  end if;
end
$legacy$;

-- Legacy enum labels are retained only because immutable movement/audit history
-- uses the same enum. The active status-transition function can no longer enter
-- them, and all active asset rows have been remediated above.
create or replace function public.asset_status_allowed(p_old public.asset_status, p_new public.asset_status)
returns boolean language plpgsql immutable set search_path = public as $function$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'available' then p_new in ('assigned','reserved','in_maintenance','rented','sold')
    when 'assigned' then p_new in ('available','reserved','in_maintenance')
    when 'reserved' then p_new in ('available','assigned','in_maintenance','rented','sold')
    when 'in_maintenance' then p_new in ('available','assigned')
    when 'rented' then p_new in ('available','reserved','in_maintenance','sold')
    when 'sold' then false
    when 'disposed' then false
    else false
  end;
end
$function$;

create table if not exists public.request_asset_allocations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  request_item_id uuid not null references public.request_items(id) on delete cascade,
  asset_id uuid not null references public.assets(id),
  state text not null default 'selected' check (state in ('selected','prepared','delivered','returned','released')),
  selected_by uuid not null references auth.users(id),
  selected_at timestamptz not null default now(),
  prepared_by uuid references auth.users(id),
  prepared_at timestamptz,
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  delivered_by uuid references auth.users(id),
  delivered_at timestamptz,
  recipient_name text,
  returned_by uuid references auth.users(id),
  returned_at timestamptz,
  return_result text check (return_result in ('good','needs_inspection')),
  return_note text,
  released_at timestamptz,
  released_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_item_id, asset_id)
);
alter table public.request_asset_allocations enable row level security;
revoke all on public.request_asset_allocations from public, anon, authenticated;
create unique index if not exists request_asset_allocations_one_active_asset
  on public.request_asset_allocations(asset_id)
  where state in ('selected','prepared','delivered');
create index if not exists request_asset_allocations_request_item_state_idx
  on public.request_asset_allocations(request_id, request_item_id, state);

-- Preserve current exact item-to-asset links as the canonical allocation source.
insert into public.request_asset_allocations (request_id, request_item_id, asset_id, state, selected_by, selected_at, prepared_by, prepared_at, delivered_by, delivered_at, recipient_name, returned_by, returned_at, return_result)
select ri.request_id, ri.id, ri.asset_id,
  case when coalesce(ri.returned_quantity, 0) >= coalesce(ri.delivered_quantity, 0) and coalesce(ri.delivered_quantity, 0) > 0 then 'returned'
       when coalesce(ri.delivered_quantity, 0) > 0 then 'delivered'
       when a.status = 'reserved' then 'prepared' else 'selected' end,
  coalesce(r.prepared_by, r.created_by, auth.uid()), coalesce(r.prepared_at, ri.created_at),
  r.prepared_by, r.prepared_at, r.delivered_by, r.delivered_at, r.customer_name_snapshot,
  case when coalesce(ri.returned_quantity,0) > 0 then r.delivered_by else null end,
  case when coalesce(ri.returned_quantity,0) > 0 then r.returned_at else null end,
  case when coalesce(ri.returned_quantity,0) > 0 then 'good' else null end
from public.request_items ri
join public.requests r on r.id = ri.request_id
join public.assets a on a.id = ri.asset_id
where ri.item_kind = 'asset' and ri.asset_id is not null
on conflict (request_item_id, asset_id) do nothing;

create or replace function public.request_allocate_asset(p_request_item_id uuid, p_asset_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare
  v_role text := public.app_user_role(); v_item public.request_items%rowtype;
  v_request public.requests%rowtype; v_asset public.assets%rowtype; v_count integer;
begin
  if v_role not in ('admin','it_manager','technician','warehouse_manager') or p_operation_id is null then
    return jsonb_build_object('ok',false,'error','not_authorized');
  end if;
  select * into v_item from public.request_items where id = p_request_item_id for update;
  if not found or not (v_item.item_kind = 'custom' and v_item.requested_kind = 'existing_asset') then return jsonb_build_object('ok',false,'error','invalid_asset_request_item'); end if;
  select * into v_request from public.requests where id = v_item.request_id for update;
  if not found or v_request.status not in ('approved','provisioned','stock_shortage','preparing') then return jsonb_build_object('ok',false,'error','invalid_state'); end if;
  select * into v_asset from public.assets where id = p_asset_id for update;
  if not found or not v_asset.is_active or v_asset.archived_at is not null or v_asset.status <> 'available'
     or v_asset.assigned_to_employee_id is not null
     or exists (select 1 from public.asset_assignments aa where aa.asset_id = p_asset_id and aa.status='active') then
    return jsonb_build_object('ok',false,'error','asset_not_available');
  end if;
  if v_item.requested_category is not null and not exists (
    select 1 from public.assets a join public.categories c on c.id=a.category_id
    where a.id=p_asset_id and (c.name=v_item.requested_category or c.name_ar=v_item.requested_category)
  ) then return jsonb_build_object('ok',false,'error','asset_category_mismatch'); end if;
  if v_item.preferred_company_id is not null and v_asset.company_id is distinct from v_item.preferred_company_id then
    return jsonb_build_object('ok',false,'error','asset_company_mismatch');
  end if;
  if exists (select 1 from public.request_asset_allocations where request_item_id=v_item.id and asset_id=p_asset_id) then
    return jsonb_build_object('ok',true,'idempotent',true);
  end if;
  select count(*) into v_count from public.request_asset_allocations where request_item_id = v_item.id and state in ('selected','prepared','delivered');
  if v_count >= v_item.quantity then return jsonb_build_object('ok',false,'error','required_quantity_already_selected'); end if;
  insert into public.request_asset_allocations(request_id,request_item_id,asset_id,state,selected_by)
  values(v_request.id,v_item.id,p_asset_id,'selected',auth.uid());
  update public.assets set status='reserved' where id=p_asset_id;
  insert into public.asset_movements(asset_id,movement_type,from_status,to_status,performed_by,note)
  values(p_asset_id,'status_change','available','reserved',auth.uid(),'EDIT 3 exact allocation for request '||v_request.request_number);
  perform public._request_add_event(v_request.id,'asset_allocated','staff',null,jsonb_build_object('request_item_id',v_item.id,'asset_id',p_asset_id,'operation_id',p_operation_id));
  return jsonb_build_object('ok',true,'selected',v_count+1,'required',v_item.quantity);
end
$function$;

create or replace function public.request_prepare_allocated_assets(p_request_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare v_role text:=public.app_user_role(); v_bad boolean;
begin
  if v_role not in ('admin','it_manager','technician','warehouse_manager') or p_operation_id is null then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  perform 1 from public.requests where id=p_request_id for update;
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  select exists(
    select 1 from public.request_items ri
    where ri.request_id=p_request_id and (ri.item_kind='asset' or (ri.item_kind='custom' and ri.requested_kind='existing_asset'))
      and (select count(*) from public.request_asset_allocations a where a.request_item_id=ri.id and a.state in ('selected','prepared')) <> ri.quantity
  ) into v_bad;
  if v_bad then return jsonb_build_object('ok',false,'error','exact_assets_required'); end if;
  update public.request_asset_allocations set state='prepared',prepared_by=auth.uid(),prepared_at=now(),updated_at=now()
  where request_id=p_request_id and state='selected';
  update public.requests set prepared_by=auth.uid(),prepared_at=now(),status='preparing' where id=p_request_id;
  return jsonb_build_object('ok',true);
end
$function$;

-- This replaces the legacy quantity-only ready transition.  It keeps the
-- public RPC name used by the idempotent operation dispatcher, but it derives
-- readiness exclusively from the exact selections above.
create or replace function public.request_confirm_ready(p_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $function$
declare v_role text:=public.app_user_role(); v_req public.requests%rowtype; v_bad boolean;
begin
  if v_role not in ('admin','it_manager','technician','warehouse_manager') then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  select * into v_req from public.requests where id=p_id for update;
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if v_req.status not in ('approved','provisioned','preparing') then return jsonb_build_object('ok',false,'error','invalid_state'); end if;
  if exists (select 1 from public.request_items ri where ri.request_id=p_id and ri.item_kind='custom' and ri.requested_kind<>'existing_asset' and not coalesce(ri.needs_purchase,false)) then
    return jsonb_build_object('ok',false,'error','unfulfilled_items');
  end if;
  select exists(
    select 1 from public.request_items ri
    where ri.request_id=p_id and (ri.item_kind='asset' or (ri.item_kind='custom' and ri.requested_kind='existing_asset'))
      and (select count(*) from public.request_asset_allocations a where a.request_item_id=ri.id and a.state in ('selected','prepared')) <> ri.quantity
  ) into v_bad;
  if v_bad then return jsonb_build_object('ok',false,'error','exact_assets_required'); end if;
  update public.request_asset_allocations set state='prepared',prepared_by=auth.uid(),prepared_at=now(),updated_at=now()
  where request_id=p_id and state='selected';
  update public.requests set status='ready_for_pickup',prepared_by=coalesce(prepared_by,auth.uid()),prepared_at=coalesce(prepared_at,now()) where id=p_id;
  perform public._request_add_event(p_id,'devices_ready_confirmed','staff',null,jsonb_build_object('exact_assets',true));
  return jsonb_build_object('ok',true,'status','ready_for_pickup');
end
$function$;
revoke all on function public.request_confirm_ready(uuid) from public, anon;
grant execute on function public.request_confirm_ready(uuid) to authenticated;

create or replace function public.request_asset_allocation_summary(p_request_id uuid)
returns jsonb language sql stable security definer set search_path = public as $function$
  select case when public.app_user_role() in ('admin','it_manager','technician','warehouse_manager')
    or exists (select 1 from public.requests r where r.id=p_request_id and r.created_by=auth.uid())
  then coalesce(jsonb_agg(jsonb_build_object(
    'request_item_id',a.request_item_id,'asset_id',a.asset_id,'asset_tag',x.asset_tag,'name',x.name,
    'manufacturer',m.brand,'model',m.model_name,'status',x.status,'location',coalesce(l.name_ar,l.name),'state',a.state
  ) order by a.selected_at),'[]'::jsonb) else '[]'::jsonb end
  from public.request_asset_allocations a join public.assets x on x.id=a.asset_id
  left join public.models m on m.id=x.model_id left join public.locations l on l.id=x.location_id
  where a.request_id=p_request_id
$function$;

revoke all on function public.request_allocate_asset(uuid,uuid,uuid), public.request_prepare_allocated_assets(uuid,uuid), public.request_asset_allocation_summary(uuid) from public, anon;
grant execute on function public.request_allocate_asset(uuid,uuid,uuid), public.request_prepare_allocated_assets(uuid,uuid), public.request_asset_allocation_summary(uuid) to authenticated;

-- A database guard prevents any path (including an old UI) from declaring a
-- durable request ready before every requested physical asset is prepared.
create or replace function public.request_exact_assets_ready_guard()
returns trigger language plpgsql security definer set search_path=public as $function$
begin
  if new.status='ready_for_pickup' and old.status is distinct from 'ready_for_pickup' and exists (
    select 1 from public.request_items ri where ri.request_id=new.id and (ri.item_kind='asset' or (ri.item_kind='custom' and ri.requested_kind='existing_asset'))
      and (select count(*) from public.request_asset_allocations a where a.request_item_id=ri.id and a.state='prepared') <> ri.quantity
  ) then
    raise exception 'exact_assets_required_before_ready' using errcode='P0001';
  end if;
  return new;
end
$function$;
do $trigger$
begin
  if not exists (select 1 from pg_trigger where tgrelid='public.requests'::regclass and tgname='request_exact_assets_ready_guard' and not tgisinternal) then
    execute $sql$create trigger request_exact_assets_ready_guard before update of status on public.requests
      for each row execute function public.request_exact_assets_ready_guard()$sql$;
  end if;
end
$trigger$;

-- Manager cancellation is deliberately not permitted. The requester may cancel
-- only their own unprepared request; the event differs from manager rejection.
create or replace function public.request_cancel(p_id uuid)
returns json language plpgsql security definer set search_path=public as $function$
declare v_req public.requests%rowtype; v_released integer;
begin
  if public.app_user_role() <> 'employee' then return json_build_object('ok',false,'error','not_authorized'); end if;
  select * into v_req from public.requests where id=p_id for update;
  if not found then return json_build_object('ok',false,'error','not_found'); end if;
  if v_req.created_by is distinct from auth.uid() or v_req.status not in ('draft','under_review','needs_clarification') or v_req.prepared_at is not null then
    return json_build_object('ok',false,'error','cannot_cancel_after_preparation');
  end if;
  v_released:=public._request_release_reservations(p_id,'Requester cancellation '||v_req.request_number);
  update public.request_asset_allocations set state='released',released_at=now(),released_by=auth.uid(),updated_at=now() where request_id=p_id and state in ('selected','prepared');
  update public.requests set status='cancelled' where id=p_id;
  perform public._request_add_event(p_id,'requester_cancelled','requester',null,jsonb_build_object('released',v_released));
  return json_build_object('ok',true,'released',v_released);
end
$function$;
revoke all on function public.request_cancel(uuid) from public, anon;
grant execute on function public.request_cancel(uuid) to authenticated;

-- Delivery is based on the prepared allocation rows, never on a quantity-only
-- request line. Each exact asset must be scanned/verified in the dialog before
-- the same transaction creates custody, movement, proof, and audit evidence.
create or replace function public.request_deliver_with_proof(p_id uuid, p_proof jsonb, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $function$
declare
  v_role text:=public.app_user_role(); v_req public.requests%rowtype; v_emp public.employees%rowtype;
  v_receiver text:=nullif(btrim(p_proof->>'receiver_name'),''); v_notes text:=nullif(btrim(p_proof->>'delivery_notes'),'');
  v_verified uuid[]:=array[]::uuid[]; v_expected uuid[]; v_seen uuid[]:=array[]::uuid[];
  v_asset uuid; v_current public.asset_status; v_target public.asset_status; v_proof_id uuid; v_existing uuid;
  v_line jsonb; v_count integer; v_consumable record; v_before integer; v_need integer; v_risk jsonb;
begin
  if v_role not in ('admin','it_manager','technician','warehouse_manager') or p_operation_id is null then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  if v_receiver is null or length(v_receiver) not between 2 and 160 or coalesce(length(v_notes),0)>1000 then return jsonb_build_object('ok',false,'error','invalid_delivery_proof'); end if;
  select id into v_existing from public.request_delivery_proofs where delivered_by=auth.uid() and operation_id=p_operation_id;
  if found then return jsonb_build_object('ok',true,'proof_id',v_existing,'idempotent',true); end if;
  select * into v_req from public.requests where id=p_id for update;
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if v_req.status <> 'ready_for_pickup' then return jsonb_build_object('ok',false,'error','state_not_deliverable'); end if;
  if jsonb_typeof(coalesce(p_proof->'verified_asset_ids','[]'::jsonb)) <> 'array' then return jsonb_build_object('ok',false,'error','invalid_delivery_verification'); end if;
  begin
    for v_line in select value from jsonb_array_elements(coalesce(p_proof->'verified_asset_ids','[]'::jsonb)) loop
      v_asset:=nullif(trim(both '"' from v_line::text),'')::uuid;
      if v_asset is null or v_asset=any(v_seen) then return jsonb_build_object('ok',false,'error','invalid_delivery_verification'); end if;
      v_seen:=array_append(v_seen,v_asset); v_verified:=array_append(v_verified,v_asset);
    end loop;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'error','invalid_delivery_verification'); end;
  select coalesce(array_agg(a.asset_id order by a.asset_id),'{}'::uuid[]) into v_expected
  from public.request_asset_allocations a where a.request_id=p_id and a.state='prepared';
  if cardinality(v_expected) <> cardinality(v_verified) or exists(select 1 from unnest(v_expected) x where not x=any(v_verified)) then
    return jsonb_build_object('ok',false,'error','all_prepared_assets_must_be_verified');
  end if;
  if exists (select 1 from public.request_items ri where ri.request_id=p_id and (ri.item_kind='asset' or (ri.item_kind='custom' and ri.requested_kind='existing_asset')) and (select count(*) from public.request_asset_allocations a where a.request_item_id=ri.id and a.state='prepared')<>ri.quantity) then
    return jsonb_build_object('ok',false,'error','exact_assets_required');
  end if;
  if coalesce(v_req.beneficiary_type,'customer')='employee' then
    if v_req.beneficiary_employee_id is null then return jsonb_build_object('ok',false,'error','no_beneficiary'); end if;
    select * into v_emp from public.employees where id=v_req.beneficiary_employee_id;
    if not found or not coalesce(v_emp.is_active,false) then return jsonb_build_object('ok',false,'error','beneficiary_inactive'); end if;
    v_target:='assigned'::public.asset_status;
  else v_target:=case when v_req.request_type='sale' then 'sold'::public.asset_status else 'rented'::public.asset_status end;
  end if;
  perform 1 from public.assets where id=any(v_expected) order by id for update;
  if exists(select 1 from public.assets where id=any(v_expected) and (status<>'reserved' or archived_at is not null or not is_active)) then return jsonb_build_object('ok',false,'error','asset_not_available'); end if;
  if v_target='assigned' and exists(select 1 from public.asset_assignments where asset_id=any(v_expected) and status='active') then return jsonb_build_object('ok',false,'error','already_assigned'); end if;
  v_risk:=public._request_delivery_risk(p_id);
  -- Exact scan verification supplements, but never relaxes, the existing
  -- high-risk approval, separation-of-duties, and strong-proof controls.
  if v_risk->>'level'='high' then
    if v_req.second_approved_by is null then return jsonb_build_object('ok',false,'error','second_approval_required'); end if;
    if v_req.prepared_by is null then return jsonb_build_object('ok',false,'error','preparer_evidence_required'); end if;
    if auth.uid()=any(array_remove(array[v_req.created_by,v_req.approved_by,v_req.second_approved_by,v_req.prepared_by],null)) then
      perform public._audit_write('request_delivery_denied','denied','requests',p_id::text,p_id,null,null,'segregation_of_duties','rpc:request_deliver_with_proof',jsonb_build_object('operation_id',p_operation_id),null,null);
      return jsonb_build_object('ok',false,'error','independent_deliverer_required');
    end if;
    return jsonb_build_object('ok',false,'error','strong_proof_required');
  end if;
  insert into public.request_delivery_proofs(request_id,proof_method,receiver_name,delivery_notes,delivered_by,device_snapshot,risk_level,risk_reason,operation_id)
  select p_id,'acknowledgement',v_receiver,v_notes,auth.uid(),coalesce(jsonb_agg(jsonb_build_object('asset_id',a.asset_id,'asset_tag',x.asset_tag,'name',x.name) order by x.asset_tag),'[]'::jsonb),v_risk->>'level',v_risk->>'reason',p_operation_id
  from public.request_asset_allocations a join public.assets x on x.id=a.asset_id where a.request_id=p_id and a.state='prepared'
  returning id into v_proof_id;
  foreach v_asset in array v_expected loop
    select status into v_current from public.assets where id=v_asset;
    update public.assets set status=v_target,assigned_to_employee_id=case when v_target='assigned' then v_req.beneficiary_employee_id else null end,times_checked_out=coalesce(times_checked_out,0)+1,last_out_at=now(),last_request_id=p_id where id=v_asset;
    if v_target='assigned' then
      insert into public.asset_assignments(asset_id,employee_id,due_return_date,status) values(v_asset,v_req.beneficiary_employee_id,v_req.return_date,'active');
      insert into public.asset_movements(asset_id,movement_type,from_status,to_status,to_employee_id,performed_by,note) values(v_asset,'assign',v_current,'assigned',v_req.beneficiary_employee_id,auth.uid(),'Exact delivery for request '||v_req.request_number);
    else
      insert into public.asset_movements(asset_id,movement_type,from_status,to_status,performed_by,note) values(v_asset,'status_change',v_current,v_target,auth.uid(),'Exact delivery for request '||v_req.request_number);
    end if;
  end loop;
  update public.request_asset_allocations set state='delivered',delivered_by=auth.uid(),delivered_at=now(),recipient_name=v_receiver,updated_at=now() where request_id=p_id and state='prepared';
  update public.request_items ri set delivered_quantity=(select count(*) from public.request_asset_allocations a where a.request_item_id=ri.id and a.state='delivered') where ri.request_id=p_id and (ri.item_kind='asset' or (ri.item_kind='custom' and ri.requested_kind='existing_asset'));
  for v_consumable in select ri.id,ri.consumable_id,ri.quantity,coalesce(ri.delivered_quantity,0) delivered_quantity,c.quantity_on_hand from public.request_items ri join public.consumables c on c.id=ri.consumable_id where ri.request_id=p_id and ri.item_kind='consumable' loop
    v_need:=(v_consumable.quantity-v_consumable.delivered_quantity)::int; if v_need<=0 then continue; end if;
    if v_consumable.quantity_on_hand<v_need then raise exception 'insufficient_stock' using errcode='P0001'; end if;
    v_before:=v_consumable.quantity_on_hand;
    insert into public.consumable_transactions(consumable_id,txn_type,quantity,previous_quantity,balance_after,reason,performed_by,related_employee_id,department_id) values(v_consumable.consumable_id,'out',v_need,v_before,v_before-v_need,'Delivery request '||v_req.request_number,auth.uid(),case when v_target='assigned' then v_req.beneficiary_employee_id else null end,case when v_target='assigned' then v_emp.department_id else null end);
    update public.consumables set quantity_on_hand=v_before-v_need where id=v_consumable.consumable_id;
    update public.request_items set delivered_quantity=quantity where id=v_consumable.id;
  end loop;
  update public.request_delivery_proofs set evidence_status='verified' where id=v_proof_id;
  update public.requests set status=case when v_req.request_type='sale' then 'completed' else 'delivered' end,delivered_at=now(),delivered_by=auth.uid(),delivery_proof_id=v_proof_id,risk_level_snapshot=v_risk->>'level',risk_reason_snapshot=v_risk->>'reason' where id=p_id;
  perform public._request_add_event(p_id,'delivered_exact_assets','staff',null,jsonb_build_object('proof_id',v_proof_id,'assets',cardinality(v_expected)));
  return jsonb_build_object('ok',true,'proof_id',v_proof_id,'assets',cardinality(v_expected));
exception when sqlstate 'P0001' then return jsonb_build_object('ok',false,'error','insufficient_stock');
end
$function$;
revoke all on function public.request_deliver_with_proof(uuid,jsonb,uuid) from public, anon;
grant execute on function public.request_deliver_with_proof(uuid,jsonb,uuid) to authenticated;

-- Return intake is similarly limited to assets actually delivered by this
-- request. A problem result creates the existing maintenance intake record.
create or replace function public.request_inspect_return(p_id uuid, p_lines jsonb)
returns json language plpgsql security definer set search_path=public as $function$
declare v_role text:=public.app_user_role(); v_req public.requests%rowtype; v_line jsonb; v_asset uuid; v_result text; v_note text; v_seen uuid[]:=array[]::uuid[]; v_current public.asset_status; v_remaining integer:=0; v_processed integer:=0;
begin
  if v_role not in ('admin','it_manager','technician','warehouse_manager') then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then return jsonb_build_object('ok',false,'error','invalid_return_inspection'); end if;
  select * into v_req from public.requests where id=p_id for update;
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if v_req.status not in ('delivered','partially_returned','overdue') then return jsonb_build_object('ok',false,'error','state_not_returnable'); end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    begin v_asset:=nullif(v_line->>'asset_id','')::uuid; exception when invalid_text_representation then return jsonb_build_object('ok',false,'error','invalid_return_inspection'); end;
    v_result:=nullif(v_line->>'condition',''); v_note:=nullif(btrim(v_line->>'notes'),'');
    if v_asset is null or v_asset=any(v_seen) or v_result not in ('sound','needs_inspection') or (v_result='needs_inspection' and v_note is null) then return jsonb_build_object('ok',false,'error','invalid_return_inspection'); end if;
    perform 1 from public.request_asset_allocations where request_id=p_id and asset_id=v_asset and state='delivered' for update;
    if not found then return jsonb_build_object('ok',false,'error','invalid_return_inspection'); end if;
    v_seen:=array_append(v_seen,v_asset);
  end loop;
  foreach v_asset in array v_seen loop
    select status into v_current from public.assets where id=v_asset for update;
    select nullif(value->>'condition',''),nullif(btrim(value->>'notes'),'') into v_result,v_note from jsonb_array_elements(p_lines) value where (value->>'asset_id')::uuid=v_asset;
    update public.assets set status=case when v_result='sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end,assigned_to_employee_id=null,last_return_condition=case when v_result='sound' then 'sound' else 'needs_maintenance' end,last_return_at=now() where id=v_asset;
    update public.asset_assignments set status='returned',returned_at=now(),return_condition=case when v_result='sound' then 'good' else 'fair' end where asset_id=v_asset and status='active';
    update public.request_asset_allocations set state='returned',returned_by=auth.uid(),returned_at=now(),return_result=case when v_result='sound' then 'good' else 'needs_inspection' end,return_note=v_note,updated_at=now() where request_id=p_id and asset_id=v_asset and state='delivered';
    insert into public.asset_movements(asset_id,movement_type,from_status,to_status,performed_by,note) values(v_asset,'status_change',v_current,case when v_result='sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end,auth.uid(),'Exact return intake for request '||v_req.request_number||coalesce(' · '||v_note,''));
    if v_result='needs_inspection' then insert into public.maintenance_records(asset_id,reported_by,problem_description) values(v_asset,auth.uid(),'Return needs inspection for request '||v_req.request_number||' · '||v_note); end if;
    v_processed:=v_processed+1;
  end loop;
  update public.request_items ri set returned_quantity=(select count(*) from public.request_asset_allocations a where a.request_item_id=ri.id and a.state='returned') where ri.request_id=p_id and (ri.item_kind='asset' or (ri.item_kind='custom' and ri.requested_kind='existing_asset'));
  select count(*) into v_remaining from public.request_asset_allocations where request_id=p_id and state='delivered';
  update public.requests set status=case when v_remaining>0 then 'partially_returned' else 'returned' end,returned_at=case when v_remaining=0 then now() else returned_at end where id=p_id;
  perform public._request_add_event(p_id,'inspected_return','staff',null,jsonb_build_object('processed',v_processed,'remaining',v_remaining));
  return jsonb_build_object('ok',true,'processed',v_processed,'remaining',v_remaining);
end
$function$;
revoke all on function public.request_inspect_return(uuid,jsonb) from public, anon;
grant execute on function public.request_inspect_return(uuid,jsonb) to authenticated;

create or replace function public.warehouse_receive_employee_return(p_return_request_id uuid, p_condition text, p_note text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $function$
declare v_role text:=public.app_user_role(); v_actor uuid:=auth.uid(); v_return public.employee_asset_return_requests%rowtype; v_asset public.assets%rowtype; v_existing jsonb; v_result jsonb;
begin
  if v_role not in ('admin','it_manager','technician','warehouse_manager') then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  if p_return_request_id is null or p_operation_id is null or p_condition not in ('sound','needs_inspection') or (p_condition='needs_inspection' and nullif(btrim(coalesce(p_note,'')),'') is null) then return jsonb_build_object('ok',false,'error','invalid_return_intake'); end if;
  select result into v_existing from public.employee_return_intake_operations where actor_id=v_actor and operation_id=p_operation_id;
  if found then return v_existing; end if;
  select * into v_return from public.employee_asset_return_requests where id=p_return_request_id for update;
  if not found then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if v_return.status not in ('pending','acknowledged') then return jsonb_build_object('ok',false,'error','return_already_processed'); end if;
  select * into v_asset from public.assets where id=v_return.asset_id for update;
  if not found or v_asset.assigned_to_employee_id is distinct from v_return.employee_id then return jsonb_build_object('ok',false,'error','custody_mismatch'); end if;
  perform 1 from public.asset_assignments where id=v_return.assignment_id and asset_id=v_return.asset_id and employee_id=v_return.employee_id and status='active' for update;
  if not found then return jsonb_build_object('ok',false,'error','custody_mismatch'); end if;
  update public.assets set status=case when p_condition='sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end,assigned_to_employee_id=null,last_return_condition=case when p_condition='sound' then 'sound' else 'needs_maintenance' end,last_return_at=now() where id=v_asset.id;
  update public.asset_assignments set status='returned',returned_at=now(),return_condition=case when p_condition='sound' then 'good' else 'fair' end where id=v_return.assignment_id;
  update public.employee_asset_return_requests set status='completed',resolved_by=v_actor,resolved_at=now(),resolution_note=nullif(btrim(coalesce(p_note,'')),'') where id=v_return.id;
  insert into public.asset_movements(asset_id,movement_type,from_status,to_status,performed_by,note) values(v_asset.id,'status_change',v_asset.status,case when p_condition='sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end,v_actor,'Employee return intake'||coalesce(' · '||nullif(btrim(p_note),''),''));
  if p_condition='needs_inspection' then insert into public.maintenance_records(asset_id,reported_by,problem_description) values(v_asset.id,v_actor,'Employee return needs inspection'||coalesce(' · '||nullif(btrim(p_note),''),'')); end if;
  v_result:=jsonb_build_object('ok',true,'id',v_return.id,'asset_id',v_asset.id);
  insert into public.employee_return_intake_operations(actor_id,operation_id,return_request_id,result) values(v_actor,p_operation_id,v_return.id,v_result);
  return v_result;
end
$function$;
revoke all on function public.warehouse_receive_employee_return(uuid,text,text,uuid) from public, anon;
grant execute on function public.warehouse_receive_employee_return(uuid,text,text,uuid) to authenticated;

commit;
