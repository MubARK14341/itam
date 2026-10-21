-- Purpose: close NULL-role procurement access; preserve legacy idempotent replays;
-- create portal drafts and all their items atomically; restore requester ownership
-- and the customer attachment switch in the database/storage boundary.
-- Risk: additive RPC replacements and one new RPC; no historical records, stock,
-- quantities, financial grants, public QR projection, or portal reads are rewritten.
-- Rollback: retain guards and operation records; disable affected creation/linking
-- UI while correcting forward. Never restore the old NULL-role/ownership bypass.

begin;

create or replace function public.procurement_record_external_document(
  p_purchase_request_id uuid,
  p_purchase_request_item_id uuid,
  p_document_type text,
  p_source_system text,
  p_external_reference text,
  p_document_status text,
  p_stock_transaction_id uuid,
  p_metadata jsonb,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_pr_status text;
  v_item_consumable_id uuid;
  v_txn_consumable_id uuid;
  v_txn_type text;
  v_id uuid;
  v_result jsonb;
  v_event_type text;
  v_document public.procurement_document_refs%rowtype;
begin
  if v_uid is null or public.is_approved() is distinct from true
     or public.app_user_role() is null
     or (public.current_user_has_capability('purchase.manage') is distinct from true
         and public.app_user_role() is distinct from 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or p_purchase_request_id is null
     or p_document_type is null or p_document_type not in (
       'purchase_order', 'goods_receipt', 'invoice', 'stock_receipt'
     )
     or coalesce(length(btrim(p_source_system)), 0) not between 1 and 100
     or coalesce(length(btrim(p_external_reference)), 0) not between 1 and 200
     or coalesce(p_document_status, 'recorded') not in ('recorded', 'confirmed', 'cancelled')
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_document_type = 'invoice' and public.is_financial_viewer() is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.procurement_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then
    -- Compare with the existing immutable document, including old operation results.
    -- Replays do not re-run mutable purchase-request status checks.
    select * into v_document from public.procurement_document_refs
    where id::text = v_result->>'id' and recorded_by = v_uid;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'operation_result_unavailable');
    end if;
    if v_document.purchase_request_id is distinct from p_purchase_request_id
       or v_document.purchase_request_item_id is distinct from p_purchase_request_item_id
       or v_document.document_type is distinct from p_document_type
       or v_document.source_system is distinct from btrim(p_source_system)
       or v_document.external_reference is distinct from btrim(p_external_reference)
       or v_document.document_status is distinct from coalesce(p_document_status, 'recorded')
       or v_document.stock_transaction_id is distinct from p_stock_transaction_id
       or v_document.metadata is distinct from coalesce(p_metadata, '{}'::jsonb) then
      return jsonb_build_object('ok', false, 'error', 'operation_id_conflict');
    end if;
    if v_document.document_type = 'invoice' and public.is_financial_viewer() is distinct from true then
      return jsonb_build_object('ok', false, 'error', 'financial_not_authorized');
    end if;
    return v_result;
  end if;

  select status into v_pr_status
  from public.purchase_requests
  where id = p_purchase_request_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'purchase_request_not_found');
  end if;
  if v_pr_status in ('draft', 'submitted', 'cancelled') then
    return jsonb_build_object('ok', false, 'error', 'invalid_purchase_request_state');
  end if;

  if p_purchase_request_item_id is not null then
    select consumable_id into v_item_consumable_id
    from public.purchase_request_items
    where id = p_purchase_request_item_id
      and purchase_request_id = p_purchase_request_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'purchase_request_item_mismatch');
    end if;
  end if;

  if p_document_type = 'stock_receipt' then
    if p_purchase_request_item_id is null or p_stock_transaction_id is null then
      return jsonb_build_object('ok', false, 'error', 'stock_receipt_links_required');
    end if;
    select consumable_id, txn_type::text
    into v_txn_consumable_id, v_txn_type
    from public.consumable_transactions
    where id = p_stock_transaction_id;
    if not found or v_txn_type <> 'in'
       or v_txn_consumable_id is distinct from v_item_consumable_id then
      return jsonb_build_object('ok', false, 'error', 'invalid_stock_transaction');
    end if;
    if not exists (
      select 1 from public.procurement_document_refs d
      where d.purchase_request_id = p_purchase_request_id
        and d.purchase_request_item_id = p_purchase_request_item_id
        and d.document_type = 'goods_receipt'
        and d.document_status <> 'cancelled'
    ) then
      return jsonb_build_object('ok', false, 'error', 'goods_receipt_required');
    end if;
  elsif p_stock_transaction_id is not null then
    return jsonb_build_object('ok', false, 'error', 'unexpected_stock_transaction');
  end if;

  insert into public.procurement_document_refs(
    purchase_request_id, purchase_request_item_id, document_type,
    source_system, external_reference, document_status,
    stock_transaction_id, metadata, recorded_by
  ) values (
    p_purchase_request_id, p_purchase_request_item_id, p_document_type,
    btrim(p_source_system), btrim(p_external_reference),
    coalesce(p_document_status, 'recorded'), p_stock_transaction_id,
    coalesce(p_metadata, '{}'::jsonb), v_uid
  ) returning id into v_id;

  v_event_type := case p_document_type
    when 'purchase_order' then 'purchase_order_recorded'
    when 'goods_receipt' then 'goods_receipt_recorded'
    when 'invoice' then 'invoice_recorded'
    when 'stock_receipt' then 'stock_receipt_posted'
  end;
  insert into public.procurement_integration_events(
    purchase_request_id, purchase_request_item_id, document_ref_id,
    event_type, payload, recorded_by
  ) values (
    p_purchase_request_id, p_purchase_request_item_id, v_id,
    v_event_type,
    jsonb_build_object(
      'source_system', btrim(p_source_system),
      'external_reference', btrim(p_external_reference),
      'document_status', coalesce(p_document_status, 'recorded'),
      'stock_effect', p_document_type = 'stock_receipt'
    ),
    v_uid
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', v_id, 'document_type', p_document_type,
    'stock_effect', p_document_type = 'stock_receipt'
  );
  insert into public.procurement_operation_results(actor_id, operation_id, result)
  values (v_uid, p_operation_id, v_result);
  return v_result;
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'duplicate_document_reference');
end
$function$;

-- One actor-scoped operation owns the header and every item. A caught validation
-- exception rolls back the inner subtransaction; a logical false result alone
-- would leave a partially created draft behind.
create or replace function public.portal_create_request_atomic(
  p_operation_id uuid,
  p_input jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_existing public.request_operation_results%rowtype;
  v_fingerprint text;
  v_result jsonb;
  v_item jsonb;
  v_request_id uuid;
  v_error text;
  v_item_index integer := 0;
begin
  if v_uid is null or v_customer_id is null or v_role is null
     or v_role not in ('authorized_requester', 'project_manager')
     or (public._portal_settings(v_customer_id)).portal_enabled is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null then
    return jsonb_build_object('ok', false, 'error', 'operation_id_required');
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if jsonb_typeof(p_input->'items') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_input->'items') = 0 then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_input->'items') > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_items');
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_input) as k(key)
    where k.key <> all(array['project_name','project_city','contact_phone','contact_email',
      'request_type','pickup_date','return_date','notes','items'])
  ) then
    return jsonb_build_object('ok', false, 'error', 'server_fields_forbidden');
  end if;
  -- jsonb canonicalizes object key order. The exact accepted input, including
  -- item ordering, owns the operation; retry with a different payload conflicts.
  v_fingerprint := encode(extensions.digest(p_input::text, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select * into v_existing from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then
    if v_existing.operation_type <> 'portal_create'
       or v_existing.result #>> '{_operation,input_fingerprint}' is distinct from v_fingerprint then
      return jsonb_build_object('ok', false, 'error', 'operation_id_conflict');
    end if;
    if not exists (
      select 1 from public.requests r
      where r.id = v_existing.request_id and r.customer_id = v_customer_id
        and r.submitted_by = v_uid and r.request_source = 'client_portal'
        and r.id::text = v_existing.result->>'id'
    ) then
      return jsonb_build_object('ok', false, 'error', 'operation_result_unavailable');
    end if;
    return v_existing.result;
  end if;

  begin
    v_result := public.portal_create_request(
      p_input->>'project_name', p_input->>'project_city',
      p_input->>'contact_phone', p_input->>'contact_email',
      p_input->>'request_type', nullif(p_input->>'pickup_date', '')::date,
      nullif(p_input->>'return_date', '')::date, p_input->>'notes'
    )::jsonb;
    if (v_result->>'ok')::boolean is distinct from true then
      v_error := coalesce(v_result->>'error', 'invalid_input');
      raise exception using errcode = 'P0400', message = 'portal_atomic_validation';
    end if;
    v_request_id := (v_result->>'id')::uuid;
    for v_item in select value from jsonb_array_elements(p_input->'items') loop
      v_item_index := v_item_index + 1;
      if jsonb_typeof(v_item) is distinct from 'object' then
        v_error := 'invalid_item';
        raise exception using errcode = 'P0400', message = 'portal_atomic_validation';
      end if;
      if exists (
        select 1 from jsonb_object_keys(v_item) as k(key)
        where k.key <> all(array['requested_kind','requested_description','requested_category',
          'quantity','preferred_model','accept_alternative','needs_purchase','category_key',
          'preferred_company_id','model_id','consumable_id','additional_quantity_requested'])
      ) then
        v_error := 'server_fields_forbidden';
        raise exception using errcode = 'P0400', message = 'portal_atomic_validation';
      end if;
      if jsonb_typeof(v_item->'quantity') is distinct from 'number' then
        v_error := 'invalid_quantity';
        raise exception using errcode = 'P0400', message = 'portal_atomic_validation';
      end if;
      v_result := public.portal_add_item(
        v_request_id, v_item->>'requested_kind', v_item->>'requested_description',
        v_item->>'requested_category', (v_item->>'quantity')::numeric,
        v_item->>'preferred_model', (v_item->>'accept_alternative')::boolean,
        (v_item->>'needs_purchase')::boolean,
        nullif(v_item->>'preferred_company_id', '')::uuid, v_item->>'category_key',
        nullif(v_item->>'model_id', '')::uuid, nullif(v_item->>'consumable_id', '')::uuid,
        coalesce((v_item->>'additional_quantity_requested')::boolean, false)
      )::jsonb;
      if (v_result->>'ok')::boolean is distinct from true then
        v_error := coalesce(v_result->>'error', 'invalid_item');
        raise exception using errcode = 'P0400', message = 'portal_atomic_validation';
      end if;
    end loop;
    v_result := jsonb_build_object('ok', true, 'id', v_request_id,
      '_operation', jsonb_build_object('type', 'portal_create', 'target_id', v_request_id,
        'input_fingerprint', v_fingerprint));
    insert into public.request_operation_results(actor_id, operation_id, operation_type, request_id, result)
    values (v_uid, p_operation_id, 'portal_create', v_request_id, v_result);
    return v_result;
  exception
    when sqlstate 'P0400' then
      -- The actor lock has serialized earlier attempts, the ledger lookup found
      -- no committed result, and this subtransaction rolled back every write.
      -- Only known validation failures may release the client's pending marker.
      return jsonb_build_object('ok', false, 'error', v_error, 'item_index', nullif(v_item_index, 0),
        'definitive_rollback', coalesce(v_error = any(array[
          'invalid_input', 'invalid_item', 'server_fields_forbidden', 'invalid_quantity',
          'project_name_required', 'city_required', 'delivery_date_required',
          'delivery_date_in_past', 'phone_required', 'catalog_item_not_allowed',
          'additional_quantity_acknowledgement_required', 'description_required', 'invalid_kind'
        ]), false));
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      return jsonb_build_object('ok', false, 'error', 'invalid_input', 'item_index', nullif(v_item_index, 0),
        'definitive_rollback', true);
  end;
end
$function$;

create or replace function public.request_operation_result_lookup(p_operation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select o.result from public.request_operation_results o
  where o.actor_id = auth.uid() and o.operation_id = p_operation_id
    and case when o.operation_type = 'portal_create' then
      public.portal_user_role() in ('authorized_requester', 'project_manager')
      and exists (
        select 1 from public.requests r
        where r.id = o.request_id and r.customer_id = public.portal_customer_id()
          and r.submitted_by = auth.uid() and r.request_source = 'client_portal'
      )
    else public.is_approved() is true end
$function$;

create or replace function public.portal_submit_request(p_request_id uuid)
returns json language plpgsql security definer set search_path = public
as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype; v_s public.customer_portal_settings; v_line record; v_available jsonb; v_qty int; v_shortage int := 0; v_requires_return boolean;
begin
  if auth.uid() is null or v_cid is null or v_role is null or v_role not in ('authorized_requester', 'project_manager') then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  v_s := public._portal_settings(v_cid); if not v_s.portal_enabled then return jsonb_build_object('ok',false,'error','portal_disabled'); end if;
  select * into v_req from public.requests where id=p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid or v_req.status <> 'draft' or v_req.portal_approval_status <> 'not_required' then return jsonb_build_object('ok',false,'error','invalid_state'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if nullif(btrim(v_req.project_name),'') is null then return jsonb_build_object('ok',false,'error','project_name_required'); end if;
  if nullif(btrim(v_req.project_city),'') is null then return jsonb_build_object('ok',false,'error','city_required'); end if;
  if v_req.pickup_date is null then return jsonb_build_object('ok',false,'error','delivery_date_required'); end if;
  if v_req.pickup_date < (now() at time zone 'Asia/Riyadh')::date then return jsonb_build_object('ok',false,'error','delivery_date_in_past'); end if;
  if not exists(select 1 from public.request_items where request_id=p_request_id) then return jsonb_build_object('ok',false,'error','no_items'); end if;
  select exists(select 1 from public.request_items where request_id=p_request_id and portal_model_id is not null) into v_requires_return;
  if v_requires_return and v_req.return_date is null then return jsonb_build_object('ok',false,'error','return_date_required'); end if;
  if v_requires_return and v_req.return_date <= v_req.pickup_date then return jsonb_build_object('ok',false,'error','return_date_invalid'); end if;
  for v_line in select * from public.request_items where request_id=p_request_id for update loop
    if v_line.portal_model_id is not null then select public.portal_item_availability('durable', (select category_id from public.models where id=v_line.portal_model_id), v_line.portal_model_id, null) into v_available;
    elsif v_line.consumable_id is not null then select public.portal_item_availability('consumable',null,null,v_line.consumable_id) into v_available;
    else continue; end if;
    if not coalesce((v_available->>'ok')::boolean,false) then return jsonb_build_object('ok',false,'error','availability_unavailable'); end if;
    v_qty:=coalesce(v_line.quantity,0)::int; v_shortage:=greatest(v_qty-coalesce((v_available->>'available_quantity')::int,0),0);
    if v_shortage>0 and not v_line.additional_quantity_requested then return jsonb_build_object('ok',false,'error','additional_quantity_acknowledgement_required'); end if;
    update public.request_items set available_quantity_at_submission=coalesce((v_available->>'available_quantity')::int,0),shortage_quantity=v_shortage,availability_snapshot_at=now(),needs_purchase=case when v_shortage>0 then true else needs_purchase end where id=v_line.id;
  end loop;
  if v_role='authorized_requester' and v_s.require_project_manager_approval then
    update public.requests set portal_approval_status='pending_project_manager',portal_approval_requested_by=auth.uid(),portal_approval_requested_at=now() where id=p_request_id;
    perform public._request_add_event(p_request_id,'portal_pm_approval_requested','portal',null,jsonb_build_object('availability_snapshot',true));
    return jsonb_build_object('ok',true,'pending_pm',true);
  end if;
  update public.requests set status='under_review',portal_approval_status=case when v_role='project_manager' and v_s.require_project_manager_approval then 'approved_by_project_manager' else portal_approval_status end,portal_approved_by=case when v_role='project_manager' and v_s.require_project_manager_approval then auth.uid() else portal_approved_by end,portal_approved_at=case when v_role='project_manager' and v_s.require_project_manager_approval then now() else portal_approved_at end where id=p_request_id;
  perform public._request_add_event(p_request_id,'submitted','portal',null,jsonb_build_object('availability_snapshot',true));
  return jsonb_build_object('ok',true,'pending_pm',false);
end $function$;

create or replace function public.portal_can_upload_request_attachment(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_customer_id uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_request_id uuid;
  v_request public.requests%rowtype;
begin
  if auth.uid() is null or v_customer_id is null or v_role is null
     or v_role not in ('authorized_requester', 'project_manager')
     or (public._portal_settings(v_customer_id)).allow_attachments is distinct from true then
    return false;
  end if;
  if p_name is null or p_name !~ '^requests/[0-9a-f-]{36}/portal/(customer_visible/)?[A-Za-z0-9._-]{1,150}$' then
    return false;
  end if;
  begin
    v_request_id := split_part(p_name, '/', 2)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  select * into v_request
  from public.requests
  where id = v_request_id;
  if not found
     or v_request.customer_id is distinct from v_customer_id
     or v_request.status not in (
       'draft', 'under_review', 'needs_clarification'
     ) then
    return false;
  end if;
  if v_role = 'authorized_requester'
     and v_request.submitted_by is distinct from auth.uid() then
    return false;
  end if;
  return true;
end
$function$;

create or replace function public.portal_register_request_attachment(
  p_request_id uuid,
  p_file_name text,
  p_storage_path text
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_customer_id uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_request public.requests%rowtype;
  v_mime text;
  v_size bigint;
  v_id uuid;
  v_allowed text[] := array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
begin
  if auth.uid() is null or v_customer_id is null then
    return json_build_object('ok', false, 'error', 'not_portal');
  end if;
  if v_role is null or v_role not in ('authorized_requester', 'project_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if (public._portal_settings(v_customer_id)).allow_attachments is distinct from true then
    return json_build_object('ok', false, 'error', 'attachments_disabled');
  end if;
  select * into v_request
  from public.requests
  where id = p_request_id
  for update;
  if not found or v_request.customer_id is distinct from v_customer_id then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_role = 'authorized_requester'
     and v_request.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in (
    'draft', 'under_review', 'needs_clarification'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if p_storage_path is null or p_storage_path !~ (
    '^requests/' || p_request_id::text
    || '/portal/(customer_visible/)?[A-Za-z0-9._-]{1,150}$'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_path');
  end if;
  if coalesce(length(btrim(p_file_name)), 0) = 0
     or length(p_file_name) > 200 then
    return json_build_object('ok', false, 'error', 'invalid_name');
  end if;

  select
    nullif(o.metadata->>'mimetype', ''),
    coalesce((o.metadata->>'size')::bigint, 0)
  into v_mime, v_size
  from storage.objects o
  where o.bucket_id = 'request-attachments'
    and o.name = p_storage_path
    and o.owner_id = auth.uid()::text;
  if not found then
    return json_build_object('ok', false, 'error', 'object_not_found');
  end if;
  if v_mime is null or v_mime <> all(v_allowed) then
    return json_build_object('ok', false, 'error', 'bad_type');
  end if;
  if v_size <= 0 or v_size > 10485760 then
    return json_build_object('ok', false, 'error', 'too_large');
  end if;

  insert into public.request_attachments (
    request_id,
    uploaded_by_kind,
    uploaded_by,
    visible_to_customer,
    classification,
    functional_type,
    file_name,
    storage_path,
    mime_type,
    size_bytes
  ) values (
    p_request_id,
    'portal',
    auth.uid(),
    true,
    'customer_visible',
    'request_attachment',
    p_file_name,
    p_storage_path,
    v_mime,
    v_size
  )
  on conflict (storage_path) do nothing
  returning id into v_id;
  if v_id is null then
    -- A lost registration reply is replayable only for this exact owned object
    -- and unchanged metadata. The prior registration already emitted its event.
    select a.id into v_id from public.request_attachments a
    where a.storage_path = p_storage_path and a.request_id = p_request_id
      and a.uploaded_by = auth.uid() and a.uploaded_by_kind = 'portal'
      and a.visible_to_customer is true and a.classification = 'customer_visible'
      and a.functional_type = 'request_attachment' and a.file_name = p_file_name
      and a.mime_type = v_mime and a.size_bytes = v_size;
    if found then
      return json_build_object('ok', true, 'id', v_id, 'registered', true);
    end if;
    return json_build_object('ok', false, 'error', 'already_registered');
  end if;

  perform public._request_add_event(
    p_request_id,
    'attachment_added',
    'portal',
    p_file_name,
    jsonb_build_object('attachment_id', v_id)
  );
  return json_build_object('ok', true, 'id', v_id);
end
$function$;
create or replace function public.portal_get_request(p_request_id uuid)
returns json language plpgsql stable security definer set search_path = public as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
        v_req public.requests%rowtype; v_s public.customer_portal_settings;
begin
  if auth.uid() is null or v_cid is null or v_role is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;

  return json_build_object('ok', true,
    'creation_complete', exists (
      select 1 from public.request_operation_results o
      where o.request_id = v_req.id and o.actor_id = v_req.submitted_by
        and o.operation_type = 'portal_create'
        and o.result->>'id' = v_req.id::text
    ),
    'request', json_build_object(
      'id', v_req.id, 'request_number', v_req.request_number, 'status', v_req.status,
      'portal_approval_status', v_req.portal_approval_status,
      'portal_rejection_reason', v_req.portal_rejection_reason,
      'can_submit_draft', coalesce(v_req.status = 'draft'
        and v_req.portal_approval_status = 'not_required'
        and (v_role = 'project_manager'
          or (v_role = 'authorized_requester' and v_req.submitted_by = auth.uid())), false),
      'can_pm_approve', (v_role = 'project_manager'
                         and v_req.status = 'draft'
                         and v_req.portal_approval_status = 'pending_project_manager'),
      'request_type', v_req.request_type, 'project_name', v_req.project_name, 'project_city', v_req.project_city,
      'contact_phone', v_req.contact_phone_snapshot, 'contact_email', v_req.contact_email_snapshot,
      'pickup_date', v_req.pickup_date, 'return_date', v_req.return_date,
      'notes', v_req.notes, 'created_at', v_req.created_at, 'rejection_reason', v_req.rejection_reason
    ),
    'items', coalesce((
      select json_agg(json_build_object(
        'id', ri.id, 'requested_kind', ri.requested_kind, 'requested_description', ri.requested_description,
        'requested_category', ri.requested_category, 'preferred_model', ri.preferred_model,
        'accept_alternative', ri.accept_alternative, 'needs_purchase', ri.needs_purchase, 'quantity', ri.quantity,
        'fulfillment', case
          when ri.delivered_quantity > 0 then 'delivered'
          when ri.item_kind in ('asset','consumable') then 'preparing'
          when ri.needs_purchase then 'procuring'
          else 'reviewing' end
      ) order by ri.created_at)
      from public.request_items ri where ri.request_id = p_request_id
    ), '[]'::json),
    'events', coalesce((
      select json_agg(json_build_object(
        'event_type', e.event_type,
        'to_status', case when e.event_type = 'status_changed' then e.metadata->>'to' else null end,
        'message', case when e.event_type in ('clarification_requested','clarification_reply','portal_pm_rejected') then e.message else null end,
        'created_at', e.created_at
      ) order by e.created_at)
      from public.request_events e
      where e.request_id = p_request_id
        and e.event_type in ('status_changed','clarification_requested','clarification_reply','submitted',
                             'portal_pm_approval_requested','portal_pm_approved','portal_pm_rejected')
    ), '[]'::json)
  );
end $function$;

revoke all on function public.procurement_record_external_document(uuid,uuid,text,text,text,text,uuid,jsonb,uuid),
  public.portal_create_request_atomic(uuid,jsonb), public.portal_submit_request(uuid), public.portal_get_request(uuid),
  public.portal_can_upload_request_attachment(text), public.portal_register_request_attachment(uuid,text,text),
  public.request_operation_result_lookup(uuid) from public, anon;
grant execute on function public.procurement_record_external_document(uuid,uuid,text,text,text,text,uuid,jsonb,uuid),
  public.portal_create_request_atomic(uuid,jsonb), public.portal_submit_request(uuid), public.portal_get_request(uuid),
  public.portal_can_upload_request_attachment(text), public.portal_register_request_attachment(uuid,text,text),
  public.request_operation_result_lookup(uuid) to authenticated;

-- Keep the baseline compatibility version while requiring the new client RPC.
update public.app_schema_versions
set required_signatures = array_append(required_signatures, 'public.portal_create_request_atomic(uuid,jsonb)')
where contract_key = 'itam_app'
  and compatibility_version = 2026073110
  and not ('public.portal_create_request_atomic(uuid,jsonb)' = any(required_signatures));

do $schema_contract$
begin
  if not exists (
    select 1 from public.app_schema_versions
    where contract_key = 'itam_app' and compatibility_version = 2026073110
      and 'public.portal_create_request_atomic(uuid,jsonb)' = any(required_signatures)
  ) then
    raise exception 'portal_atomic_schema_contract_missing';
  end if;
end $schema_contract$;

commit;
