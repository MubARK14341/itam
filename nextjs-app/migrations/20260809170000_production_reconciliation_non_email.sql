-- Purpose: reviewed non-bootstrap, non-email Production reconciliation pack.
-- Risk: applies only after a verified backup, fresh-clone rehearsal, and live SELECT preconditions.
-- Rollback: stop on any failed phase; preserve append-only audit/movement evidence and use the validated backup checkpoint.
-- DO NOT apply this file to Production during preparation. Email, cron, Storage configuration, Auth settings, and Vercel changes are intentionally excluded.


-- === SOURCE: migrations/20260727144004_harden_staff_request_creation.sql | sha256: b6361f9e10bf68518f123faa96fe119823b801ffc2e15e08c7f39586fe85133b ===
-- Purpose: F-001 — make staff request creation a single server-controlled
-- transaction and remove direct Data API mutations on requests/request_items.
-- Security impact: actor/source/status and all workflow/financial stamps are
-- server authoritative. Only approved operational staff can call the RPC.
-- Risk: callers that still INSERT directly will receive permission denied and
-- must use request_create_staff. Portal SECURITY DEFINER entrypoints are
-- intentionally unchanged.
-- Rollback consideration: restore the previous grants/policies only together
-- with removal of request_create_staff; doing so reopens the forged-field and
-- partial-header vulnerabilities and is not recommended.

begin;

create or replace function public.request_create_staff(
  p_status text,
  p_customer_id uuid,
  p_customer_name text,
  p_contact_phone text,
  p_project_name text,
  p_project_city text,
  p_request_type text,
  p_pickup_date date,
  p_return_date date,
  p_notes text,
  p_internal_notes text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public.app_user_role();
  v_status text := nullif(btrim(p_status), '');
  v_customer public.customers%rowtype;
  v_customer_name text;
  v_contact_phone text;
  v_item jsonb;
  v_item_kind text;
  v_requested_kind text;
  v_quantity numeric;
  v_consumable_id uuid;
  v_preferred_company_id uuid;
  v_available numeric;
  v_request_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_status not in ('draft', 'under_review') then
    return jsonb_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if p_request_type is null
     or p_request_type not in ('rental', 'sale', 'service', 'mixed') then
    return jsonb_build_object('ok', false, 'error', 'invalid_request_type');
  end if;
  if p_pickup_date is not null
     and p_return_date is not null
     and p_return_date < p_pickup_date then
    return jsonb_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_items) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_items');
  end if;

  if p_customer_id is not null then
    select * into v_customer
    from public.customers
    where id = p_customer_id and is_active;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'customer_not_found');
    end if;
    v_customer_name := nullif(btrim(v_customer.name), '');
    v_contact_phone := nullif(btrim(v_customer.phone), '');
  else
    v_customer_name := nullif(btrim(p_customer_name), '');
    v_contact_phone := nullif(btrim(p_contact_phone), '');
    if v_customer_name is null then
      return jsonb_build_object('ok', false, 'error', 'customer_required');
    end if;
  end if;

  -- Validate the complete payload before inserting the header. This keeps
  -- validation failures atomic without relying on compensating deletes.
  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('ok', false, 'error', 'invalid_item');
    end if;
    if v_item ?| array[
      'unit_price', 'total_price', 'approved_quantity',
      'delivered_quantity', 'returned_quantity', 'needs_purchase',
      'asset_id'
    ] then
      return jsonb_build_object('ok', false, 'error', 'server_fields_forbidden');
    end if;
    if jsonb_typeof(v_item->'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity <= 0
       or v_quantity > 1000000
       or v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_item_kind := nullif(btrim(v_item->>'item_kind'), '');
    if v_item_kind not in ('custom', 'consumable') then
      -- Physical assets are selected internally during fulfillment, never by
      -- the requester through a serial/asset identifier.
      return jsonb_build_object('ok', false, 'error', 'invalid_item_kind');
    end if;

    if v_item_kind = 'consumable' then
      begin
        v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end;
      if v_consumable_id is null then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      select quantity_on_hand into v_available
      from public.consumables
      where id = v_consumable_id and is_active;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      if v_quantity > v_available then
        return jsonb_build_object('ok', false, 'error', 'insufficient_stock');
      end if;
    else
      if nullif(btrim(v_item->>'requested_description'), '') is null then
        return jsonb_build_object('ok', false, 'error', 'description_required');
      end if;
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      if v_requested_kind not in ('existing_asset', 'custom') then
        return jsonb_build_object('ok', false, 'error', 'invalid_requested_kind');
      end if;
      begin
        v_preferred_company_id :=
          nullif(v_item->>'preferred_company_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end;
      if v_preferred_company_id is not null
         and not exists (
           select 1 from public.companies
           where id = v_preferred_company_id and is_active
         ) then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end if;
    end if;
  end loop;

  insert into public.requests (
    status,
    customer_id,
    customer_name_snapshot,
    contact_phone_snapshot,
    project_name,
    project_city,
    request_type,
    beneficiary_type,
    beneficiary_employee_id,
    pickup_date,
    return_date,
    notes,
    internal_notes,
    submitted_by,
    created_by,
    request_source,
    portal_approval_status
  ) values (
    v_status,
    p_customer_id,
    v_customer_name,
    v_contact_phone,
    nullif(btrim(p_project_name), ''),
    nullif(btrim(p_project_city), ''),
    p_request_type,
    'customer',
    null,
    p_pickup_date,
    p_return_date,
    nullif(btrim(p_notes), ''),
    nullif(btrim(p_internal_notes), ''),
    v_uid,
    v_uid,
    'internal',
    'not_required'
  ) returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    v_item_kind := v_item->>'item_kind';
    v_quantity := (v_item->>'quantity')::numeric;

    if v_item_kind = 'consumable' then
      v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        consumable_id,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        preferred_company_id,
        preferred_model,
        accept_alternative,
        needs_purchase
      ) values (
        v_request_id,
        'consumable',
        v_consumable_id,
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        'consumable',
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        null,
        null,
        coalesce((v_item->>'accept_alternative')::boolean, true),
        false
      );
    else
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      v_preferred_company_id :=
        nullif(v_item->>'preferred_company_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        preferred_company_id,
        preferred_model,
        accept_alternative,
        needs_purchase
      ) values (
        v_request_id,
        'custom',
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        v_requested_kind,
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        v_preferred_company_id,
        nullif(btrim(v_item->>'preferred_model'), ''),
        coalesce((v_item->>'accept_alternative')::boolean, true),
        false
      );
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'id', v_request_id);
end
$function$;

-- Keep the employee self-service path, but apply the same creator role and
-- payload invariants. The beneficiary remains derived exclusively from
-- auth.uid(); callers cannot nominate another employee.
create or replace function public.request_create_employee_self(
  p_status text,
  p_project_name text,
  p_pickup_date date,
  p_return_date date,
  p_notes text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public.app_user_role();
  v_employee_id uuid;
  v_email text;
  v_name text;
  v_request_id uuid;
  v_item jsonb;
  v_item_kind text;
  v_requested_kind text;
  v_quantity numeric;
  v_consumable_id uuid;
  v_preferred_company_id uuid;
  v_available numeric;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_status is null or btrim(p_status) not in ('draft', 'under_review') then
    return jsonb_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if p_pickup_date is not null
     and p_return_date is not null
     and p_return_date < p_pickup_date then
    return jsonb_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_items) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_items');
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('ok', false, 'error', 'invalid_item');
    end if;
    if v_item ?| array[
      'unit_price', 'total_price', 'approved_quantity',
      'delivered_quantity', 'returned_quantity', 'needs_purchase',
      'asset_id', 'beneficiary_employee_id'
    ] then
      return jsonb_build_object('ok', false, 'error', 'server_fields_forbidden');
    end if;
    if jsonb_typeof(v_item->'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity <= 0
       or v_quantity > 1000000
       or v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;

    v_item_kind := nullif(btrim(v_item->>'item_kind'), '');
    if v_item_kind not in ('custom', 'consumable') then
      return jsonb_build_object('ok', false, 'error', 'invalid_item_kind');
    end if;

    if v_item_kind = 'consumable' then
      begin
        v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end;
      if v_consumable_id is null then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      select quantity_on_hand into v_available
      from public.consumables
      where id = v_consumable_id and is_active;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'consumable_not_found');
      end if;
      if v_quantity > v_available then
        return jsonb_build_object('ok', false, 'error', 'insufficient_stock');
      end if;
    else
      if nullif(btrim(v_item->>'requested_description'), '') is null then
        return jsonb_build_object('ok', false, 'error', 'description_required');
      end if;
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      if v_requested_kind not in ('existing_asset', 'custom') then
        return jsonb_build_object('ok', false, 'error', 'invalid_requested_kind');
      end if;
      begin
        v_preferred_company_id :=
          nullif(v_item->>'preferred_company_id', '')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end;
      if v_preferred_company_id is not null
         and not exists (
           select 1 from public.companies
           where id = v_preferred_company_id and is_active
         ) then
        return jsonb_build_object('ok', false, 'error', 'company_not_found');
      end if;
    end if;
  end loop;

  select employee_id, email, full_name
  into v_employee_id, v_email, v_name
  from public.app_users
  where id = v_uid;

  if v_employee_id is null then
    if v_email is not null then
      select id into v_employee_id
      from public.employees
      where lower(email) = lower(v_email) and is_active
      order by created_at
      limit 1;
    end if;
    if v_employee_id is null then
      insert into public.employees (full_name, email)
      values (
        coalesce(
          nullif(btrim(v_name), ''),
          nullif(split_part(coalesce(v_email, ''), '@', 1), ''),
          'موظف'
        ),
        v_email
      )
      returning id into v_employee_id;
    end if;
    update public.app_users
    set employee_id = v_employee_id
    where id = v_uid;
  end if;

  insert into public.requests (
    status,
    request_type,
    beneficiary_type,
    beneficiary_employee_id,
    customer_id,
    submitted_by,
    created_by,
    request_source,
    project_name,
    pickup_date,
    return_date,
    notes,
    portal_approval_status
  ) values (
    btrim(p_status),
    'internal',
    'employee',
    v_employee_id,
    null,
    v_uid,
    v_uid,
    'internal',
    nullif(btrim(p_project_name), ''),
    p_pickup_date,
    p_return_date,
    nullif(btrim(p_notes), ''),
    'not_required'
  ) returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    v_item_kind := v_item->>'item_kind';
    v_quantity := (v_item->>'quantity')::numeric;
    if v_item_kind = 'consumable' then
      v_consumable_id := nullif(v_item->>'consumable_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        consumable_id,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        needs_purchase
      ) values (
        v_request_id,
        'consumable',
        v_consumable_id,
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        'consumable',
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        false
      );
    else
      v_requested_kind := coalesce(
        nullif(btrim(v_item->>'requested_kind'), ''),
        'existing_asset'
      );
      v_preferred_company_id :=
        nullif(v_item->>'preferred_company_id', '')::uuid;
      insert into public.request_items (
        request_id,
        item_kind,
        quantity,
        notes,
        requested_kind,
        requested_description,
        requested_category,
        preferred_company_id,
        preferred_model,
        needs_purchase
      ) values (
        v_request_id,
        'custom',
        v_quantity,
        nullif(btrim(v_item->>'notes'), ''),
        v_requested_kind,
        nullif(btrim(v_item->>'requested_description'), ''),
        nullif(btrim(v_item->>'requested_category'), ''),
        v_preferred_company_id,
        nullif(btrim(v_item->>'preferred_model'), ''),
        false
      );
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'id', v_request_id);
end
$function$;

revoke all on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) from public, anon;
grant execute on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) to authenticated;

revoke all on function public.request_create_staff(
  text, uuid, text, text, text, text, text, date, date, text, text, jsonb
) from public, anon;
grant execute on function public.request_create_staff(
  text, uuid, text, text, text, text, text, date, date, text, text, jsonb
) to authenticated;

-- RLS is retained as defense in depth, but the Data API no longer has a direct
-- mutation privilege. SECURITY DEFINER workflow entrypoints remain functional.
revoke insert, update, delete, truncate, references, trigger
  on public.requests from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.request_items from authenticated;

-- HIGH-1 column grants intentionally omit financial unit_price/total_price.
-- Re-expose every request-item field required by the operational workflow.
grant select (
  requested_kind,
  requested_description,
  requested_category,
  preferred_company_id,
  preferred_model,
  accept_alternative,
  needs_purchase
) on public.request_items to authenticated;

drop policy if exists ins_ops on public.requests;
drop policy if exists upd_ops on public.requests;
drop policy if exists del_admin on public.requests;
drop policy if exists ins_ops on public.request_items;
drop policy if exists upd_ops on public.request_items;
drop policy if exists del_ops on public.request_items;

commit;

-- === SOURCE: migrations/20260727144620_attachment_classification_hardening.sql | sha256: d7f91e27911e4e66c87ac86132b31c49cd4969abad67e2e916c2ebb9c0f7283e ===
-- Purpose: F-002/F-008 — replace path-substring-only attachment authorization
-- with persisted, server-derived classifications and fail-closed reads.
-- Security impact: financial invoices (including maintenance invoices) are
-- manager-only at metadata, storage, upload, and signed-URL layers. Request
-- attachment visibility changes are manager-only and cannot expose finance.
-- Risk: unknown legacy kinds become manager-only until manually classified.
-- Rollback consideration: reverting the policies would reopen financial file
-- disclosure. Columns/backfills are safe to retain even if application code is
-- rolled back. No object or metadata rows are deleted.

begin;

-- ---------------------------------------------------------------------------
-- Generic asset/maintenance/consumable attachments
-- ---------------------------------------------------------------------------

alter table public.attachments
  add column if not exists classification text;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'attachments_classification_check'
      and conrelid = 'public.attachments'::regclass
  ) then
    alter table public.attachments
      add constraint attachments_classification_check
      check (
        classification is null
        or classification in ('customer_visible', 'internal', 'financial')
      );
  end if;
end
$do$;

-- Deterministic legacy backfill only. Unknown/null kinds remain null and are
-- deliberately manager-only under the policies below.
update public.attachments
set classification = case
  when kind in (
    'warranty_invoice',
    'purchase_invoice',
    'consumable_invoice',
    'replenishment_invoice',
    'maintenance_invoice',
    'invoice'
  ) then 'financial'
  when kind in (
    'asset_photo',
    'consumable_photo',
    'device_photo',
    'other'
  ) then 'internal'
  else null
end
where classification is null;

create unique index if not exists idx_attachments_storage_path_unique
  on public.attachments(storage_path);

create or replace function public.attachments_guard_classification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_expected_classification text;
  v_expected_root text;
  v_mime text;
  v_size bigint;
  v_owner text;
  v_parts text[];
  v_allowed_mimes text[] := array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
begin
  if tg_op = 'UPDATE' then
    new.entity_type := old.entity_type;
    new.entity_id := old.entity_id;
    new.storage_path := old.storage_path;
    new.kind := old.kind;
    new.classification := old.classification;
    new.mime_type := old.mime_type;
    new.size_bytes := old.size_bytes;
    new.uploaded_by := old.uploaded_by;
    return new;
  end if;

  v_expected_classification := case
    when new.kind in (
      'warranty_invoice',
      'purchase_invoice',
      'consumable_invoice',
      'replenishment_invoice',
      'maintenance_invoice'
    ) then 'financial'
    when new.kind in (
      'asset_photo',
      'consumable_photo',
      'device_photo',
      'other'
    ) then 'internal'
    else null
  end;
  if v_expected_classification is null then
    raise exception 'invalid_attachment_kind' using errcode = '22023';
  end if;
  if v_expected_classification = 'financial'
     and not public.is_financial_viewer() then
    raise exception 'financial_attachment_forbidden' using errcode = '42501';
  end if;

  v_expected_root := case new.entity_type::text
    when 'asset' then 'assets'
    when 'consumable' then 'consumables'
    when 'maintenance' then 'maintenance'
    else null
  end;
  v_parts := string_to_array(new.storage_path, '/');
  if v_expected_root is null
     or array_length(v_parts, 1) <> 4
     or v_parts[1] <> v_expected_root
     or v_parts[2] <> new.entity_id::text
     or v_parts[3] <> new.kind
     or v_parts[4] !~ '^[A-Za-z0-9._-]{1,150}$' then
    raise exception 'invalid_attachment_path' using errcode = '22023';
  end if;
  if coalesce(length(btrim(new.file_name)), 0) = 0
     or length(new.file_name) > 200 then
    raise exception 'invalid_attachment_name' using errcode = '22023';
  end if;

  select
    nullif(o.metadata->>'mimetype', ''),
    coalesce((o.metadata->>'size')::bigint, 0),
    o.owner_id
  into v_mime, v_size, v_owner
  from storage.objects o
  where o.bucket_id = 'attachments'
    and o.name = new.storage_path;
  if not found or v_owner is distinct from auth.uid()::text then
    raise exception 'attachment_object_not_owned' using errcode = '42501';
  end if;
  if v_mime is null or v_mime <> all(v_allowed_mimes) then
    raise exception 'invalid_attachment_mime' using errcode = '22023';
  end if;
  if v_size <= 0 or v_size > 10485760 then
    raise exception 'invalid_attachment_size' using errcode = '22023';
  end if;

  new.classification := v_expected_classification;
  new.mime_type := v_mime;
  new.size_bytes := v_size;
  new.uploaded_by := auth.uid();
  return new;
end
$function$;

revoke all on function public.attachments_guard_classification()
  from public, anon, authenticated;

drop trigger if exists trg_attachments_guard_classification
  on public.attachments;
drop trigger if exists trg_attachments_guard_classification on public.attachments;
create trigger trg_attachments_guard_classification
  before insert or update on public.attachments
  for each row execute function public.attachments_guard_classification();

create or replace function public.attachment_object_registered(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.attachments a
    where a.storage_path = p_name
  );
$function$;

create or replace function public.can_read_attachment_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce((
    select case a.classification
      when 'financial' then public.is_financial_viewer()
      when 'internal' then public.is_approved()
      when 'customer_visible' then public.is_approved()
      else public.is_financial_viewer()
    end
    from public.attachments a
    where a.storage_path = p_name
  ), false);
$function$;

revoke all on function public.attachment_object_registered(text)
  from public, anon;
revoke all on function public.can_read_attachment_object(text)
  from public, anon;
grant execute on function public.attachment_object_registered(text)
  to authenticated;
grant execute on function public.can_read_attachment_object(text)
  to authenticated;

drop policy if exists sel_auth on public.attachments;
create policy sel_auth on public.attachments
for select to authenticated
using (
  public.is_approved()
  and case classification
    when 'financial' then public.is_financial_viewer()
    when 'internal' then true
    when 'customer_visible' then true
    else public.is_financial_viewer()
  end
);

drop policy if exists upd_ops on public.attachments;
revoke update on public.attachments from authenticated;

-- The bucket itself enforces size/MIME and remains private.
update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
where id = 'attachments';

drop policy if exists attachments_auth_read on storage.objects;
create policy attachments_auth_read on storage.objects
for select to authenticated
using (
  bucket_id = 'attachments'
  and public.can_read_attachment_object(name)
);

drop policy if exists attachments_auth_insert on storage.objects;
create policy attachments_auth_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'attachments'
  and owner_id = auth.uid()::text
  and (
    (
      split_part(name, '/', 3) in (
        'warranty_invoice',
        'purchase_invoice',
        'consumable_invoice',
        'replenishment_invoice',
        'maintenance_invoice'
      )
      and public.is_financial_viewer()
    )
    or (
      split_part(name, '/', 3) in (
        'asset_photo',
        'consumable_photo',
        'device_photo',
        'other'
      )
      and public.app_user_role() in ('admin', 'it_manager', 'technician')
    )
  )
);

drop policy if exists attachments_auth_update on storage.objects;

drop policy if exists attachments_auth_delete on storage.objects;
create policy attachments_auth_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'attachments'
  and owner_id = auth.uid()::text
  and not public.attachment_object_registered(name)
);

-- ---------------------------------------------------------------------------
-- Request attachments
-- ---------------------------------------------------------------------------

alter table public.request_attachments
  add column if not exists classification text;
alter table public.request_attachments
  add column if not exists functional_type text;

update public.request_attachments
set classification = case
      when uploaded_by_kind = 'portal' or visible_to_customer
        then 'customer_visible'
      else 'internal'
    end,
    functional_type = coalesce(functional_type, 'request_attachment')
where classification is null or functional_type is null;

alter table public.request_attachments
  alter column classification set default 'internal',
  alter column classification set not null,
  alter column functional_type set default 'request_attachment',
  alter column functional_type set not null;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'request_attachments_classification_check'
      and conrelid = 'public.request_attachments'::regclass
  ) then
    alter table public.request_attachments
      add constraint request_attachments_classification_check
      check (classification in ('customer_visible', 'internal', 'financial'));
  end if;
end
$do$;

drop policy if exists sel_staff on public.request_attachments;
create policy sel_staff on public.request_attachments
for select to authenticated
using (
  public.is_approved()
  and case classification
    when 'financial' then public.is_financial_viewer()
    when 'internal' then true
    when 'customer_visible' then true
    else public.is_financial_viewer()
  end
);

create or replace function public.request_attachment_staff_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.is_approved() and coalesce((
    select case ra.classification
      when 'financial' then public.is_financial_viewer()
      when 'internal' then true
      when 'customer_visible' then true
      else public.is_financial_viewer()
    end
    from public.request_attachments ra
    where ra.storage_path = p_name
  ), false);
$function$;

create or replace function public.portal_can_read_request_attachment(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.request_attachments ra
    join public.requests r on r.id = ra.request_id
    where ra.storage_path = p_name
      and ra.classification = 'customer_visible'
      and public.portal_customer_id() is not null
      and r.customer_id = public.portal_customer_id()
      and (
        public.portal_user_role() <> 'authorized_requester'
        or r.submitted_by is not distinct from auth.uid()
      )
      and (ra.uploaded_by_kind = 'portal' or ra.visible_to_customer)
  );
$function$;

revoke all on function public.request_attachment_staff_can_read(text)
  from public, anon;
revoke all on function public.portal_can_read_request_attachment(text)
  from public, anon;
grant execute on function public.request_attachment_staff_can_read(text)
  to authenticated;
grant execute on function public.portal_can_read_request_attachment(text)
  to authenticated;

drop policy if exists req_att_staff_read on storage.objects;
create policy req_att_staff_read on storage.objects
for select to authenticated
using (
  bucket_id = 'request-attachments'
  and public.request_attachment_staff_can_read(name)
);

drop policy if exists req_att_portal_read on storage.objects;
create policy req_att_portal_read on storage.objects
for select to authenticated
using (
  bucket_id = 'request-attachments'
  and public.is_portal_user()
  and public.portal_can_read_request_attachment(name)
);

drop policy if exists req_att_staff_insert on storage.objects;
create policy req_att_staff_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'request-attachments'
  and owner_id = auth.uid()::text
  and (
    (
      name ~ '^requests/[0-9a-f-]{36}/staff/(internal|customer_visible)/[A-Za-z0-9._-]{1,150}$'
      and public.app_user_role() in ('admin', 'it_manager', 'technician')
    )
    or (
      name ~ '^requests/[0-9a-f-]{36}/staff/financial/[A-Za-z0-9._-]{1,150}$'
      and public.is_financial_viewer()
    )
    -- Rolling-deploy compatibility; metadata RPC still determines visibility.
    or (
      name ~ '^requests/[0-9a-f-]{36}/staff/[A-Za-z0-9._-]{1,150}$'
      and public.app_user_role() in ('admin', 'it_manager', 'technician')
    )
  )
);

drop policy if exists req_att_portal_insert on storage.objects;
create policy req_att_portal_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'request-attachments'
  and owner_id = auth.uid()::text
  and public.portal_can_upload_request_attachment(name)
);

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
  if v_customer_id is null or v_role = 'viewer' then
    return false;
  end if;
  if p_name !~ '^requests/[0-9a-f-]{36}/portal/(customer_visible/)?[A-Za-z0-9._-]{1,150}$' then
    return false;
  end if;
  begin
    v_request_id := split_part(p_name, '/', 2)::uuid;
  exception when others then
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

revoke all on function public.portal_can_upload_request_attachment(text)
  from public, anon;
grant execute on function public.portal_can_upload_request_attachment(text)
  to authenticated;

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
  if v_customer_id is null then
    return json_build_object('ok', false, 'error', 'not_portal');
  end if;
  if v_role = 'viewer' then
    return json_build_object('ok', false, 'error', 'not_authorized');
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
  if p_storage_path !~ (
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

create or replace function public.staff_register_request_attachment_v2(
  p_request_id uuid,
  p_file_name text,
  p_storage_path text,
  p_visible_to_customer boolean,
  p_classification text,
  p_functional_type text
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
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
  if v_role is null
     or v_role not in ('admin', 'it_manager', 'technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_classification not in (
    'customer_visible', 'internal', 'financial'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_classification');
  end if;
  if p_classification in ('customer_visible', 'financial')
     and v_role not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if coalesce(p_visible_to_customer, false)
     is distinct from (p_classification = 'customer_visible') then
    return json_build_object('ok', false, 'error', 'visibility_mismatch');
  end if;
  if p_functional_type not in (
    'request_attachment', 'photo', 'financial_invoice', 'other'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_functional_type');
  end if;
  if (p_functional_type = 'financial_invoice')
     is distinct from (p_classification = 'financial') then
    return json_build_object('ok', false, 'error', 'classification_mismatch');
  end if;

  select * into v_request
  from public.requests
  where id = p_request_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_storage_path !~ (
    '^requests/' || p_request_id::text || '/staff/('
    || p_classification || '/)?[A-Za-z0-9._-]{1,150}$'
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
    'staff',
    auth.uid(),
    p_classification = 'customer_visible',
    p_classification,
    p_functional_type,
    p_file_name,
    p_storage_path,
    v_mime,
    v_size
  )
  on conflict (storage_path) do nothing
  returning id into v_id;
  if v_id is null then
    return json_build_object('ok', false, 'error', 'already_registered');
  end if;

  perform public._request_add_event(
    p_request_id,
    'attachment_added',
    'staff',
    p_file_name,
    jsonb_build_object(
      'attachment_id', v_id,
      'classification', p_classification,
      'functional_type', p_functional_type
    )
  );
  return json_build_object('ok', true, 'id', v_id);
end
$function$;

create or replace function public.staff_register_request_attachment(
  p_request_id uuid,
  p_file_name text,
  p_storage_path text,
  p_visible_to_customer boolean default false
) returns json
language sql
security definer
set search_path to 'public'
as $function$
  select public.staff_register_request_attachment_v2(
    p_request_id,
    p_file_name,
    p_storage_path,
    coalesce(p_visible_to_customer, false),
    case
      when coalesce(p_visible_to_customer, false)
        then 'customer_visible'
      else 'internal'
    end,
    'request_attachment'
  );
$function$;

create or replace function public.staff_set_request_attachment_visibility(
  p_attachment_id uuid,
  p_visible boolean
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_attachment public.request_attachments%rowtype;
begin
  if v_role is null or v_role not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_attachment
  from public.request_attachments
  where id = p_attachment_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_attachment.uploaded_by_kind <> 'staff' then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if v_attachment.classification = 'financial' then
    return json_build_object('ok', false, 'error', 'financial_visibility_forbidden');
  end if;

  update public.request_attachments
  set visible_to_customer = coalesce(p_visible, false),
      classification = case
        when coalesce(p_visible, false) then 'customer_visible'
        else 'internal'
      end
  where id = p_attachment_id;

  perform public._request_add_event(
    v_attachment.request_id,
    'attachment_visibility_changed',
    'staff',
    v_attachment.file_name,
    jsonb_build_object(
      'attachment_id', v_attachment.id,
      'visible_to_customer', coalesce(p_visible, false)
    )
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.portal_list_request_attachments(
  p_request_id uuid
) returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_customer_id uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_request public.requests%rowtype;
begin
  if v_customer_id is null then
    return json_build_object('ok', false, 'error', 'not_portal');
  end if;
  select * into v_request
  from public.requests
  where id = p_request_id;
  if not found or v_request.customer_id is distinct from v_customer_id then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_role = 'authorized_requester'
     and v_request.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object(
    'ok', true,
    'attachments', coalesce((
      select json_agg(json_build_object(
        'id', ra.id,
        'file_name', ra.file_name,
        'mime_type', ra.mime_type,
        'size_bytes', ra.size_bytes,
        'created_at', ra.created_at,
        'uploaded_by_kind', ra.uploaded_by_kind
      ) order by ra.created_at)
      from public.request_attachments ra
      where ra.request_id = p_request_id
        and ra.classification = 'customer_visible'
        and (
          ra.uploaded_by_kind = 'portal'
          or ra.visible_to_customer
        )
    ), '[]'::json)
  );
end
$function$;

create or replace function public.portal_get_request_attachment_path(
  p_attachment_id uuid
) returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_customer_id uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_attachment public.request_attachments%rowtype;
  v_request public.requests%rowtype;
begin
  if v_customer_id is null then
    return json_build_object('ok', false, 'error', 'not_portal');
  end if;
  select * into v_attachment
  from public.request_attachments
  where id = p_attachment_id;
  if not found or v_attachment.classification <> 'customer_visible' then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_request
  from public.requests
  where id = v_attachment.request_id;
  if not found or v_request.customer_id is distinct from v_customer_id then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_role = 'authorized_requester'
     and v_request.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if not (
    v_attachment.uploaded_by_kind = 'portal'
    or v_attachment.visible_to_customer
  ) then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object(
    'ok', true,
    'path', v_attachment.storage_path
  );
end
$function$;

do $do$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'portal_can_upload_request_attachment(text)',
    'portal_can_read_request_attachment(text)',
    'request_attachment_staff_can_read(text)',
    'portal_register_request_attachment(uuid, text, text)',
    'portal_list_request_attachments(uuid)',
    'portal_get_request_attachment_path(uuid)',
    'staff_register_request_attachment_v2(uuid, text, text, boolean, text, text)',
    'staff_register_request_attachment(uuid, text, text, boolean)',
    'staff_set_request_attachment_visibility(uuid, boolean)'
  ] loop
    execute format(
      'revoke all on function public.%s from public, anon;',
      v_signature
    );
    execute format(
      'grant execute on function public.%s to authenticated;',
      v_signature
    );
  end loop;
end
$do$;

commit;

-- === SOURCE: migrations/20260727145511_request_state_machine_hardening.sql | sha256: b942e3bfeaf95a8c097c359a8b42c585438abfe9060a267e996a2accc4bff1b3 ===
-- Purpose: F-003 — establish one request transition matrix, enforce the
-- clarification/review path, require preparation readiness before delivery,
-- and release reservations when a request is unfulfilled/rejected/cancelled.
-- Security impact: direct state jumps now fail in the existing status trigger;
-- workflow RPCs also validate their own preconditions under row locks.
-- Risk: intentionally restrictive. Drafts must be submitted before approval
-- and delivery must pass through ready_for_pickup.
-- Rollback consideration: restoring the permissive matrix would reopen unsafe
-- transitions and ghost reservations. No historical rows are rewritten.

begin;

create or replace function public.request_transition_allowed(
  p_from text,
  p_to text
) returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select p_from = p_to or exists (
    select 1
    from (values
      ('draft', 'under_review'),
      ('draft', 'cancelled'),

      ('under_review', 'needs_clarification'),
      ('under_review', 'approved'),
      ('under_review', 'rejected'),
      ('under_review', 'cancelled'),

      ('needs_clarification', 'under_review'),
      ('needs_clarification', 'rejected'),
      ('needs_clarification', 'cancelled'),

      ('approved', 'auto_provisioning'),
      ('approved', 'provisioned'),
      ('approved', 'stock_shortage'),
      ('approved', 'preparing'),
      ('approved', 'cancelled'),

      ('auto_provisioning', 'approved'),
      ('auto_provisioning', 'provisioned'),
      ('auto_provisioning', 'stock_shortage'),
      ('auto_provisioning', 'cancelled'),

      ('provisioned', 'auto_provisioning'),
      ('provisioned', 'preparing'),
      ('provisioned', 'stock_shortage'),
      ('provisioned', 'cancelled'),

      ('stock_shortage', 'auto_provisioning'),
      ('stock_shortage', 'provisioned'),
      ('stock_shortage', 'cancelled'),

      ('preparing', 'auto_provisioning'),
      ('preparing', 'provisioned'),
      ('preparing', 'stock_shortage'),
      ('preparing', 'ready_for_pickup'),
      ('preparing', 'cancelled'),

      ('ready_for_pickup', 'delivered'),
      -- Sale and internal custody requests intentionally complete on delivery.
      ('ready_for_pickup', 'completed'),
      ('ready_for_pickup', 'cancelled'),

      ('delivered', 'partially_returned'),
      ('delivered', 'returned'),
      ('delivered', 'completed'),
      ('delivered', 'overdue'),

      ('partially_returned', 'returned'),
      ('partially_returned', 'overdue'),

      ('returned', 'completed'),

      ('overdue', 'partially_returned'),
      ('overdue', 'returned')
    ) as allowed(from_status, to_status)
    where allowed.from_status = p_from
      and allowed.to_status = p_to
  );
$function$;

-- Compatibility boundary for the existing status trigger. The matrix above is
-- the only place where transition pairs are defined.
create or replace function public.request_status_allowed(
  p_old text,
  p_new text
) returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select public.request_transition_allowed(p_old, p_new);
$function$;

revoke all on function public.request_transition_allowed(text, text)
  from public, anon;
revoke all on function public.request_status_allowed(text, text)
  from public, anon;
grant execute on function public.request_transition_allowed(text, text)
  to authenticated;
grant execute on function public.request_status_allowed(text, text)
  to authenticated;

create or replace function public.request_submit(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'draft' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if v_request.request_source <> 'internal'
     or v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  update public.requests
  set status = 'under_review',
      submitted_by = coalesce(submitted_by, auth.uid())
  where id = p_id;
  perform public._request_add_event(
    p_id,
    'submitted',
    'staff',
    null,
    '{}'::jsonb
  );
  return json_build_object('ok', true);
end
$function$;

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
  v_provision := public._request_auto_provision(p_id);
  return json_build_object(
    'ok', true,
    'provision', v_provision
  );
end
$function$;

create or replace function public._request_release_reservations(
  p_id uuid,
  p_reason text
) returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item record;
  v_released integer := 0;
begin
  for v_item in
    select
      ri.id,
      ri.asset_id,
      ri.delivered_quantity,
      a.status,
      a.asset_tag,
      a.name
    from public.request_items ri
    join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
    order by a.id
    for update of ri, a
  loop
    if coalesce(v_item.delivered_quantity, 0) > 0 then
      continue;
    end if;
    if v_item.status = 'reserved' then
      update public.assets
      set status = 'available'
      where id = v_item.asset_id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        v_item.asset_id,
        'status_change',
        'reserved',
        'available',
        auth.uid(),
        p_reason
      );
      v_released := v_released + 1;
    end if;
    update public.request_items
    set item_kind = 'custom',
        asset_id = null,
        consumable_id = null,
        requested_kind = 'existing_asset',
        requested_description = coalesce(
          requested_description,
          v_item.name,
          v_item.asset_tag
        ),
        needs_purchase = false
    where id = v_item.id;
  end loop;
  return v_released;
end
$function$;

revoke all on function public._request_release_reservations(uuid, text)
  from public, anon, authenticated;

create or replace function public.request_reject(
  p_id uuid,
  p_reason text default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request public.requests%rowtype;
  v_released integer;
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
  if not public.request_transition_allowed(v_request.status, 'rejected')
     or v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  v_released := public._request_release_reservations(
    p_id,
    'رفض طلب ' || v_request.request_number
  );
  update public.requests
  set status = 'rejected',
      rejection_reason = nullif(btrim(p_reason), '')
  where id = p_id;
  return json_build_object('ok', true, 'released', v_released);
end
$function$;

create or replace function public.request_cancel(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_released integer;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if not public.request_transition_allowed(v_request.status, 'cancelled') then
    return json_build_object(
      'ok', false, 'error', 'cannot_cancel_after_deliver'
    );
  end if;
  if v_request.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  v_released := public._request_release_reservations(
    p_id,
    'إلغاء طلب ' || v_request.request_number
  );
  update public.requests
  set status = 'cancelled'
  where id = p_id;
  return json_build_object('ok', true, 'released', v_released);
end
$function$;

create or replace function public.request_item_unfulfill(p_item_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.request_items%rowtype;
  v_request public.requests%rowtype;
  v_asset public.assets%rowtype;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_item
  from public.request_items
  where id = p_item_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_request
  from public.requests
  where id = v_item.request_id
  for update;
  if v_request.status not in (
    'under_review',
    'needs_clarification',
    'approved',
    'auto_provisioning',
    'provisioned',
    'stock_shortage',
    'preparing'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if coalesce(v_item.delivered_quantity, 0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered');
  end if;

  if v_item.asset_id is not null then
    select * into v_asset
    from public.assets
    where id = v_item.asset_id
    for update;
    if found and v_asset.status = 'reserved' then
      update public.assets
      set status = 'available'
      where id = v_asset.id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        v_asset.id,
        'status_change',
        'reserved',
        'available',
        auth.uid(),
        'فك ربط من طلب ' || v_request.request_number
      );
    end if;
  end if;

  update public.request_items
  set item_kind = 'custom',
      asset_id = null,
      consumable_id = null,
      requested_kind = case
        when v_item.item_kind = 'consumable' then 'consumable'
        else coalesce(v_item.requested_kind, 'existing_asset')
      end,
      needs_purchase = false
  where id = p_item_id;
  perform public._request_add_event(
    v_item.request_id,
    'item_unfulfilled',
    'staff',
    null,
    jsonb_build_object('item_id', p_item_id)
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.request_start_preparing(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_item record;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in ('approved', 'provisioned') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and (item_kind = 'custom' or needs_purchase)
  ) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;
  if exists (
    select 1
    from public.request_items ri
    join public.consumables c on c.id = ri.consumable_id
    where ri.request_id = p_id
      and ri.item_kind = 'consumable'
    group by ri.consumable_id, c.quantity_on_hand
    having sum(ri.quantity) > c.quantity_on_hand
  ) then
    return json_build_object('ok', false, 'error', 'insufficient_stock');
  end if;

  for v_item in
    select ri.asset_id, a.status
    from public.request_items ri
    join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
    order by a.id
    for update of a
  loop
    if v_item.status not in ('available', 'reserved') then
      return json_build_object(
        'ok', false, 'error', 'asset_not_available'
      );
    end if;
    if v_item.status = 'available' then
      update public.assets
      set status = 'reserved'
      where id = v_item.asset_id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        v_item.asset_id,
        'status_change',
        'available',
        'reserved',
        auth.uid(),
        'حجز لطلب ' || v_request.request_number
      );
    end if;
  end loop;

  update public.requests
  set status = 'preparing'
  where id = p_id;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.request_ready_issue(p_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from public.request_items where request_id = p_id
  ) then
    return 'items_required';
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and (item_kind = 'custom' or needs_purchase)
  ) then
    return 'unfulfilled_items';
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and (
        quantity <= 0
        or quantity <> trunc(quantity)
        or coalesce(delivered_quantity, 0) <> 0
        or coalesce(returned_quantity, 0) <> 0
      )
  ) then
    return 'invalid_quantities';
  end if;
  if exists (
    select asset_id
    from public.request_items
    where request_id = p_id
      and item_kind = 'asset'
    group by asset_id
    having asset_id is null or count(*) > 1
  ) then
    return 'invalid_asset_selection';
  end if;
  if exists (
    select 1
    from public.request_items ri
    left join public.assets a on a.id = ri.asset_id
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
      and (a.id is null or a.status <> 'reserved')
  ) then
    return 'asset_not_reserved';
  end if;
  if exists (
    select 1
    from public.request_items ri
    join public.consumables c on c.id = ri.consumable_id
    where ri.request_id = p_id
      and ri.item_kind = 'consumable'
    group by ri.consumable_id, c.quantity_on_hand
    having sum(ri.quantity) > c.quantity_on_hand
  ) then
    return 'insufficient_stock';
  end if;
  return null;
end
$function$;

revoke all on function public.request_ready_issue(uuid)
  from public, anon, authenticated;

create or replace function public.request_mark_ready(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
  v_issue text;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'preparing' then
    return json_build_object('ok', false, 'error', 'invalid_state');
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

  v_issue := public.request_ready_issue(p_id);
  if v_issue is not null then
    return json_build_object('ok', false, 'error', v_issue);
  end if;
  update public.requests
  set status = 'ready_for_pickup'
  where id = p_id;
  return json_build_object('ok', true);
end
$function$;

-- Legacy request_return used to mark asset lines returned and release the asset
-- before request_inspect_return recorded a condition. The completion guard then
-- correctly rejected the request, but the inspection RPC could no longer see an
-- outstanding rented asset, leaving the workflow stuck. Asset-bearing returns
-- must go through request_inspect_return, which performs return + condition
-- inspection atomically. Consumable-only rentals retain a no-asset return path.
create or replace function public.request_return(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_request public.requests%rowtype;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_request
  from public.requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status not in ('delivered', 'partially_returned', 'overdue') then
    return json_build_object('ok', false, 'error', 'state_not_returnable');
  end if;
  if exists (
    select 1
    from public.request_items
    where request_id = p_id
      and item_kind = 'asset'
      and coalesce(delivered_quantity, 0) > coalesce(returned_quantity, 0)
  ) then
    return json_build_object('ok', false, 'error', 'inspection_required');
  end if;

  update public.requests
  set status = 'returned',
      returned_at = now()
  where id = p_id;
  return json_build_object('ok', true);
end
$function$;

do $do$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'request_submit(uuid)',
    'request_approve(uuid)',
    'request_reject(uuid, text)',
    'request_cancel(uuid)',
    'request_item_unfulfill(uuid)',
    'request_start_preparing(uuid)',
    'request_mark_ready(uuid)',
    'request_return(uuid)'
  ] loop
    execute format(
      'revoke all on function public.%s from public, anon;',
      v_signature
    );
    execute format(
      'grant execute on function public.%s to authenticated;',
      v_signature
    );
  end loop;
end
$do$;

commit;

-- === SOURCE: migrations/20260727150423_purchase_receiving_bridge_hardening.sql | sha256: 432c85705c1b4426f9d1c09c7c38813bf6bee45023bf7c0cd5d00e48356c7d31 ===
-- Purpose: F-004 — cap purchase receiving under row locks, derive header
-- receipt status from item state, and reconnect fulfilled procurement items to
-- their source request workflow.
-- Security impact: callers cannot over-receive or forge a received header.
-- Physical procurement remains pending until a real asset is registered and
-- explicitly fulfilled; consumables still use consumable_stock_move.
-- Risk: restrictive only. Existing quantity integrity was checked before this
-- migration was authored (no over-received/fractional/invalid rows).
-- Rollback consideration: removing the constraints or derived-status logic
-- would reopen quantity inflation and false completion.

begin;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pr_items_receipt_bounds'
      and conrelid = 'public.purchase_request_items'::regclass
  ) then
    alter table public.purchase_request_items
      add constraint pr_items_receipt_bounds
      check (
        requested_quantity > 0
        and requested_quantity <= 1000000
        and requested_quantity = trunc(requested_quantity)
        and received_quantity >= 0
        and received_quantity <= requested_quantity
        and received_quantity = trunc(received_quantity)
      );
  end if;
end
$do$;

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
  v_current text;
  v_requested_by uuid;
  v_allowed boolean := false;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician'
  ) then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;

  select status, requested_by
  into v_current, v_requested_by
  from public.purchase_requests
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_to = 'submitted' and v_current = 'draft' then
    if not exists (
      select 1
      from public.purchase_request_items
      where purchase_request_id = p_id
    ) then
      return json_build_object('ok', false, 'error', 'items_required');
    end if;
    v_allowed := true;
    update public.purchase_requests
    set status = 'submitted',
        submitted_at = now()
    where id = p_id;
  elsif p_to = 'approved'
        and v_current = 'submitted'
        and v_role in ('admin', 'it_manager') then
    v_allowed := true;
    update public.purchase_requests
    set status = 'approved',
        approved_by = auth.uid(),
        approved_at = now()
    where id = p_id;
  elsif p_to = 'ordered' and v_current = 'approved' then
    v_allowed := true;
    update public.purchase_requests
    set status = 'ordered'
    where id = p_id;
  elsif p_to in ('partially_received', 'received') then
    -- Receipt states are derived exclusively by item receiving.
    return json_build_object(
      'ok', false, 'error', 'receipt_status_is_derived'
    );
  elsif p_to = 'cancelled'
        and v_current in ('draft', 'submitted', 'approved', 'ordered') then
    if v_role in ('admin', 'it_manager')
       or (v_current = 'draft' and v_requested_by = auth.uid()) then
      v_allowed := true;
      update public.purchase_requests
      set status = 'cancelled',
          cancelled_by = auth.uid(),
          cancelled_at = now()
      where id = p_id;
    end if;
  end if;

  if not v_allowed then
    return json_build_object('ok', false, 'error', 'bad_transition');
  end if;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.purchase_request_item_receive(
  p_item_id uuid,
  p_qty numeric
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.purchase_request_items%rowtype;
  v_header public.purchase_requests%rowtype;
  v_remaining numeric;
  v_new_received numeric;
  v_all_received boolean;
  v_source_request_id uuid;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician'
  ) then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_qty is null
     or p_qty <= 0
     or p_qty > 1000000
     or p_qty <> trunc(p_qty) then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;

  select * into v_item
  from public.purchase_request_items
  where id = p_item_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_header
  from public.purchase_requests
  where id = v_item.purchase_request_id
  for update;
  if v_header.status not in ('ordered', 'partially_received') then
    return json_build_object('ok', false, 'error', 'bad_status');
  end if;

  v_remaining := v_item.requested_quantity - v_item.received_quantity;
  if v_remaining <= 0 then
    return json_build_object('ok', false, 'error', 'already_received');
  end if;
  if p_qty > v_remaining then
    return json_build_object(
      'ok', false, 'error', 'quantity_exceeds_remaining',
      'remaining', v_remaining
    );
  end if;

  v_new_received := v_item.received_quantity + p_qty;
  update public.purchase_request_items
  set received_quantity = v_new_received,
      updated_at = now()
  where id = p_item_id;

  select bool_and(received_quantity = requested_quantity)
  into v_all_received
  from public.purchase_request_items
  where purchase_request_id = v_item.purchase_request_id;

  update public.purchase_requests
  set status = case
    when coalesce(v_all_received, false) then 'received'
    else 'partially_received'
  end
  where id = v_item.purchase_request_id;

  if v_item.source_request_item_id is not null
     and v_new_received = v_item.requested_quantity then
    select request_id into v_source_request_id
    from public.request_items
    where id = v_item.source_request_item_id;
    if v_source_request_id is not null then
      perform public._request_add_event(
        v_source_request_id,
        'purchase_received_awaiting_fulfillment',
        'staff',
        null,
        jsonb_build_object(
          'request_item_id', v_item.source_request_item_id,
          'purchase_request_id', v_item.purchase_request_id,
          'purchase_request_item_id', v_item.id
        )
      );
    end if;
  end if;

  return json_build_object(
    'ok', true,
    'received_quantity', v_new_received,
    'remaining', v_remaining - p_qty,
    'header_status', case
      when coalesce(v_all_received, false) then 'received'
      else 'partially_received'
    end
  );
end
$function$;

create or replace function public.request_item_fulfill(
  p_item_id uuid,
  p_asset_id uuid default null,
  p_consumable_id uuid default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.request_items%rowtype;
  v_request public.requests%rowtype;
  v_asset public.assets%rowtype;
  v_consumable public.consumables%rowtype;
  v_source_pr public.purchase_request_items%rowtype;
  v_all_fulfilled boolean;
begin
  if v_role is null or v_role not in (
    'admin', 'it_manager', 'technician', 'warehouse_manager'
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if (p_asset_id is null) = (p_consumable_id is null) then
    return json_build_object('ok', false, 'error', 'exactly_one_ref');
  end if;

  select * into v_item
  from public.request_items
  where id = p_item_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_item.item_kind <> 'custom'
     or coalesce(v_item.delivered_quantity, 0) > 0 then
    return json_build_object('ok', false, 'error', 'invalid_item_state');
  end if;

  select * into v_request
  from public.requests
  where id = v_item.request_id
  for update;
  if v_request.status not in (
    'approved', 'provisioned', 'stock_shortage', 'preparing'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  if v_item.needs_purchase then
    select * into v_source_pr
    from public.purchase_request_items
    where source_request_item_id = p_item_id
    for update;
    if not found
       or v_source_pr.received_quantity <> v_source_pr.requested_quantity then
      return json_build_object(
        'ok', false, 'error', 'purchase_not_received'
      );
    end if;
  end if;

  if p_asset_id is not null then
    select * into v_asset
    from public.assets
    where id = p_asset_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'asset_not_found');
    end if;
    if v_asset.status not in ('available', 'reserved') then
      return json_build_object(
        'ok', false, 'error', 'asset_not_available'
      );
    end if;
    if exists (
      select 1
      from public.request_items other_item
      join public.requests other_request
        on other_request.id = other_item.request_id
      where other_item.asset_id = p_asset_id
        and other_item.id <> p_item_id
        and other_request.status not in (
          'rejected', 'cancelled', 'completed', 'returned'
        )
    ) then
      return json_build_object('ok', false, 'error', 'asset_already_reserved');
    end if;

    if v_asset.status = 'available' then
      update public.assets
      set status = 'reserved'
      where id = p_asset_id;
      insert into public.asset_movements (
        asset_id,
        movement_type,
        from_status,
        to_status,
        performed_by,
        note
      ) values (
        p_asset_id,
        'status_change',
        'available',
        'reserved',
        auth.uid(),
        'تلبية شراء للطلب ' || v_request.request_number
      );
    end if;

    update public.request_items
    set item_kind = 'asset',
        asset_id = p_asset_id,
        consumable_id = null,
        needs_purchase = false
    where id = p_item_id;
  else
    select * into v_consumable
    from public.consumables
    where id = p_consumable_id
      and is_active
    for update;
    if not found then
      return json_build_object(
        'ok', false, 'error', 'consumable_not_found'
      );
    end if;
    if v_consumable.quantity_on_hand < v_item.quantity then
      return json_build_object(
        'ok', false, 'error', 'insufficient_stock'
      );
    end if;
    update public.request_items
    set item_kind = 'consumable',
        consumable_id = p_consumable_id,
        asset_id = null,
        needs_purchase = false
    where id = p_item_id;
  end if;

  select not exists (
    select 1
    from public.request_items
    where request_id = v_item.request_id
      and (item_kind = 'custom' or needs_purchase)
  ) into v_all_fulfilled;

  if v_request.status = 'stock_shortage' and v_all_fulfilled then
    update public.requests
    set status = 'provisioned'
    where id = v_item.request_id;
  end if;

  perform public._request_add_event(
    v_item.request_id,
    'item_fulfilled',
    'staff',
    null,
    jsonb_build_object(
      'item_id', p_item_id,
      'kind', case
        when p_asset_id is not null then 'asset'
        else 'consumable'
      end,
      'procurement_resolved', v_item.needs_purchase,
      'request_status', case
        when v_request.status = 'stock_shortage' and v_all_fulfilled
          then 'provisioned'
        else v_request.status
      end
    )
  );
  return json_build_object(
    'ok', true,
    'request_status', case
      when v_request.status = 'stock_shortage' and v_all_fulfilled
        then 'provisioned'
      else v_request.status
    end
  );
end
$function$;

create or replace function public.request_item_convert_to_pr(
  p_item_id uuid,
  p_pr_id uuid default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := public.app_user_role();
  v_item public.request_items%rowtype;
  v_request public.requests%rowtype;
  v_pr_id uuid;
  v_pr_number text;
  v_pr_status text;
  v_description text;
  v_company text;
  v_notes text;
  v_parts text[] := array[]::text[];
begin
  if not (
    public.current_user_has_capability('request.approve')
    or v_role in ('admin', 'it_manager')
  ) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_item
  from public.request_items
  where id = p_item_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_item.item_kind <> 'custom'
     or coalesce(v_item.delivered_quantity, 0) > 0 then
    return json_build_object('ok', false, 'error', 'not_custom');
  end if;
  if v_item.quantity <= 0
     or v_item.quantity > 1000000
     or v_item.quantity <> trunc(v_item.quantity) then
    return json_build_object('ok', false, 'error', 'invalid_quantity');
  end if;
  if exists (
    select 1
    from public.purchase_request_items
    where source_request_item_id = p_item_id
  ) then
    return json_build_object('ok', false, 'error', 'already_converted');
  end if;

  select * into v_request
  from public.requests
  where id = v_item.request_id
  for update;
  if v_request.status not in (
    'under_review',
    'needs_clarification',
    'approved',
    'provisioned',
    'stock_shortage',
    'preparing'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  if p_pr_id is null then
    insert into public.purchase_requests (supplier_id, notes)
    values (
      null,
      'طلب شراء مرتبط بالطلب ' || v_request.request_number
    )
    returning id, request_number into v_pr_id, v_pr_number;
  else
    select id, request_number, status
    into v_pr_id, v_pr_number, v_pr_status
    from public.purchase_requests
    where id = p_pr_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'pr_not_found');
    end if;
    if v_pr_status <> 'draft' then
      return json_build_object('ok', false, 'error', 'pr_not_draft');
    end if;
  end if;

  v_description := coalesce(
    nullif(btrim(v_item.requested_description), ''),
    nullif(btrim(v_item.requested_category), ''),
    'عنصر مطلوب'
  );
  if nullif(btrim(v_item.preferred_model), '') is not null then
    v_parts := v_parts || (
      'الموديل: ' || btrim(v_item.preferred_model)
    );
  end if;
  if v_item.preferred_company_id is not null then
    select name into v_company
    from public.companies
    where id = v_item.preferred_company_id;
    if v_company is not null then
      v_parts := v_parts || ('الشركة المفضلة: ' || v_company);
    end if;
  end if;
  v_parts := v_parts || ('من الطلب ' || v_request.request_number);
  v_notes := array_to_string(v_parts, ' · ');

  insert into public.purchase_request_items (
    purchase_request_id,
    consumable_id,
    description,
    requested_quantity,
    notes,
    source_request_item_id
  ) values (
    v_pr_id,
    null,
    v_description,
    v_item.quantity,
    v_notes,
    p_item_id
  );

  update public.request_items
  set needs_purchase = true
  where id = p_item_id;
  if v_request.status in ('approved', 'provisioned', 'preparing') then
    update public.requests
    set status = 'stock_shortage'
    where id = v_item.request_id;
  end if;

  perform public._request_add_event(
    v_item.request_id,
    'purchase_requested',
    'staff',
    null,
    jsonb_build_object(
      'item_id', p_item_id,
      'pr_id', v_pr_id,
      'pr_number', v_pr_number
    )
  );
  return json_build_object(
    'ok', true,
    'pr_id', v_pr_id,
    'pr_number', v_pr_number
  );
end
$function$;

do $do$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'purchase_request_set_status(uuid, text)',
    'purchase_request_item_receive(uuid, numeric)',
    'request_item_fulfill(uuid, uuid, uuid)',
    'request_item_convert_to_pr(uuid, uuid)'
  ] loop
    execute format(
      'revoke all on function public.%s from public, anon;',
      v_signature
    );
    execute format(
      'grant execute on function public.%s to authenticated;',
      v_signature
    );
  end loop;
end
$do$;

commit;

-- === SOURCE: migrations/20260727152018_atomic_business_operations.sql | sha256: 71cc155c4dceb22e42912a5d7bd2c370de1764e2d48c833278fb5e23bdc2b452 ===
-- F-005: move each browser-orchestrated business transaction into one database
-- transaction.  Storage remains intentionally outside Postgres and is handled
-- with compensating cleanup in the application.

begin;

-- A purchase request is an operational workflow of its own.  Making the
-- capability explicit removes the former accidental dependency on table RLS.
insert into public.permissions (key, grp, description)
values ('purchase.manage', 'purchasing', 'إدارة طلبات الشراء')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'purchase.manage'
where r.key in ('admin', 'it_manager', 'technician')
on conflict do nothing;

create or replace function public.asset_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_id uuid;
  v_status public.asset_status;
  v_employee uuid;
  v_cost numeric;
begin
  if not public.current_user_has_capability('asset.create') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  begin
    v_status := coalesce(nullif(p_input->>'status', ''), 'available')::public.asset_status;
  exception when invalid_text_representation then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end;
  if v_status not in ('available', 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if nullif(btrim(p_input->>'category_id'), '') is null
     or nullif(btrim(p_input->>'location_id'), '') is null
     or nullif(btrim(p_input->>'company_id'), '') is null
     or nullif(btrim(p_input->>'serial_number'), '') is null then
    return json_build_object('ok', false, 'error', 'required_asset_fields');
  end if;

  begin
    v_employee := nullif(p_input->>'assigned_to_employee_id', '')::uuid;
    v_cost := nullif(p_input->>'purchase_cost', '')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_numeric_or_id');
  end;
  if v_status = 'assigned' and v_employee is null then
    return json_build_object('ok', false, 'error', 'assigned_employee_required');
  end if;
  if v_cost is not null and (not public.is_financial_viewer() or v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_financial_value');
  end if;
  if coalesce(p_input->'special_attributes', '{}'::jsonb) is not null
     and jsonb_typeof(coalesce(p_input->'special_attributes', '{}'::jsonb)) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_special_attributes');
  end if;

  insert into public.assets (
    category_id, model_id, serial_number, name, status, location_id,
    department_id, assigned_to_employee_id, purchase_date, purchase_cost,
    warranty_end, supplier_id, company_id, pool_id, rfid_tag, notes,
    special_attributes, created_by
  ) values (
    (p_input->>'category_id')::uuid,
    nullif(p_input->>'model_id', '')::uuid,
    btrim(p_input->>'serial_number'),
    nullif(btrim(p_input->>'name'), ''),
    v_status,
    (p_input->>'location_id')::uuid,
    nullif(p_input->>'department_id', '')::uuid,
    case when v_status = 'assigned' then v_employee else null end,
    nullif(p_input->>'purchase_date', '')::date,
    v_cost,
    nullif(p_input->>'warranty_end', '')::date,
    nullif(p_input->>'supplier_id', '')::uuid,
    (p_input->>'company_id')::uuid,
    nullif(p_input->>'pool_id', '')::uuid,
    nullif(btrim(p_input->>'rfid_tag'), ''),
    nullif(btrim(p_input->>'notes'), ''),
    coalesce(p_input->'special_attributes', '{}'::jsonb),
    auth.uid()
  )
  returning id into v_id;

  insert into public.asset_movements (
    asset_id, movement_type, to_status, to_location_id, to_employee_id,
    performed_by, note
  ) values (
    v_id, 'create', v_status, (p_input->>'location_id')::uuid,
    case when v_status = 'assigned' then v_employee else null end,
    auth.uid(), 'إنشاء أصل'
  );

  if v_status = 'assigned' then
    insert into public.asset_assignments (
      asset_id, employee_id, assigned_by, status
    ) values (v_id, v_employee, auth.uid(), 'active');
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$func$;

create or replace function public.asset_move_atomic(
  p_asset_id uuid,
  p_to_location_id uuid,
  p_to_department_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_from_location uuid;
begin
  if not public.current_user_has_capability('asset.update') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_to_location_id is null
     or not exists (select 1 from public.locations where id = p_to_location_id) then
    return json_build_object('ok', false, 'error', 'invalid_location');
  end if;

  select location_id into v_from_location
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  update public.assets
  set location_id = p_to_location_id,
      department_id = coalesce(p_to_department_id, department_id)
  where id = p_asset_id;

  insert into public.asset_movements (
    asset_id, movement_type, from_location_id, to_location_id, performed_by, note
  ) values (
    p_asset_id, 'transfer', v_from_location, p_to_location_id, auth.uid(), 'نقل موقع'
  );
  return json_build_object('ok', true);
end
$func$;

create or replace function public.asset_update_atomic(p_asset_id uuid, p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_old public.assets%rowtype;
  v_status public.asset_status;
  v_cost numeric;
begin
  if not public.current_user_has_capability('asset.update') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  select * into v_old from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  begin
    v_status := coalesce(nullif(p_input->>'status', ''), v_old.status::text)::public.asset_status;
    v_cost := case when p_input ? 'purchase_cost'
      then nullif(p_input->>'purchase_cost', '')::numeric
      else v_old.purchase_cost end;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_numeric_or_status');
  end;
  if p_input ? 'purchase_cost' and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_financial_value');
  end if;
  if not public.asset_status_allowed(v_old.status, v_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  if nullif(btrim(p_input->>'category_id'), '') is null
     or nullif(btrim(p_input->>'location_id'), '') is null
     or nullif(btrim(p_input->>'company_id'), '') is null then
    return json_build_object('ok', false, 'error', 'required_asset_fields');
  end if;

  if v_status in ('available', 'retired', 'disposed', 'lost') then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = p_asset_id and status = 'active';
  end if;

  update public.assets set
    name = nullif(btrim(p_input->>'name'), ''),
    category_id = (p_input->>'category_id')::uuid,
    model_id = nullif(p_input->>'model_id', '')::uuid,
    serial_number = nullif(btrim(p_input->>'serial_number'), ''),
    status = v_status,
    location_id = (p_input->>'location_id')::uuid,
    department_id = nullif(p_input->>'department_id', '')::uuid,
    supplier_id = nullif(p_input->>'supplier_id', '')::uuid,
    company_id = (p_input->>'company_id')::uuid,
    pool_id = nullif(p_input->>'pool_id', '')::uuid,
    rfid_tag = nullif(btrim(p_input->>'rfid_tag'), ''),
    purchase_date = nullif(p_input->>'purchase_date', '')::date,
    purchase_cost = v_cost,
    warranty_end = nullif(p_input->>'warranty_end', '')::date,
    condition_grade = nullif(p_input->>'condition_grade', ''),
    notes = nullif(btrim(p_input->>'notes'), ''),
    special_attributes = coalesce(p_input->'special_attributes', '{}'::jsonb),
    assigned_to_employee_id = case
      when v_status in ('available', 'retired', 'disposed', 'lost') then null
      else assigned_to_employee_id
    end
  where id = p_asset_id;

  if v_status is distinct from v_old.status then
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      p_asset_id, 'status_change', v_old.status, v_status, auth.uid(), 'تعديل بيانات الأصل'
    );
  end if;
  return json_build_object('ok', true);
end
$func$;

create or replace function public.maintenance_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_id uuid;
  v_asset public.assets%rowtype;
  v_stage text;
  v_done boolean;
  v_cost numeric;
begin
  if not public.current_user_has_capability('maintenance.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  v_stage := coalesce(nullif(p_input->>'workflow_stage', ''), 'open');
  if v_stage not in ('open', 'investigating', 'awaiting_parts', 'at_vendor', 'completed', 'unrepairable') then
    return json_build_object('ok', false, 'error', 'invalid_maintenance_stage');
  end if;
  begin
    v_cost := nullif(p_input->>'cost', '')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end;
  if (v_cost is not null or nullif(p_input->>'invoice_number', '') is not null
      or nullif(p_input->>'invoice_date', '') is not null)
     and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end if;

  select * into v_asset
  from public.assets
  where id = (p_input->>'asset_id')::uuid
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  v_done := v_stage in ('completed', 'unrepairable');
  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance'
     and not public.asset_status_allowed(v_asset.status, 'in_maintenance') then
    return json_build_object('ok', false, 'error', 'invalid_asset_transition');
  end if;

  insert into public.maintenance_records (
    asset_id, type, status, workflow_stage, priority, problem_type,
    problem_description, action_taken, cost, invoice_number, invoice_date,
    reported_by, technician_id, reported_by_employee_id, final_summary,
    next_due_date, completed_at, vendor_supplier_id, vendor_name, vendor_phone,
    vendor_location, vendor_map_link, handoff_notes, receiver_name
  ) values (
    v_asset.id,
    coalesce(nullif(p_input->>'type', ''), 'corrective')::public.maintenance_type,
    case when v_done then 'completed'::public.maintenance_status
         when v_stage = 'open' then 'open'::public.maintenance_status
         else 'in_progress'::public.maintenance_status end,
    v_stage, nullif(p_input->>'priority', ''), nullif(p_input->>'problem_type', ''),
    nullif(p_input->>'problem_description', ''), nullif(p_input->>'action_taken', ''),
    coalesce(v_cost, 0), nullif(p_input->>'invoice_number', ''),
    nullif(p_input->>'invoice_date', '')::date, auth.uid(), auth.uid(),
    nullif(p_input->>'reported_by_employee_id', '')::uuid,
    nullif(p_input->>'final_summary', ''), nullif(p_input->>'next_due_date', '')::date,
    case when v_done then now() else null end,
    nullif(p_input->>'vendor_supplier_id', '')::uuid,
    nullif(p_input->>'vendor_name', ''), nullif(p_input->>'vendor_phone', ''),
    nullif(p_input->>'vendor_location', ''), nullif(p_input->>'vendor_map_link', ''),
    nullif(p_input->>'handoff_notes', ''), nullif(p_input->>'receiver_name', '')
  )
  returning id into v_id;

  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance' then
    update public.assets set status = 'in_maintenance' where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', v_asset.status, 'in_maintenance', auth.uid(), 'إدخال صيانة'
    );
  elsif v_done and v_asset.status = 'in_maintenance' then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = v_asset.id and status = 'active';
    update public.assets
    set status = 'available', assigned_to_employee_id = null
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', 'in_maintenance', 'available', auth.uid(), 'انتهاء صيانة'
    );
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$func$;

create or replace function public.maintenance_update_atomic(
  p_id uuid,
  p_input jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_record public.maintenance_records%rowtype;
  v_asset public.assets%rowtype;
  v_stage text;
  v_done boolean;
  v_cost numeric;
begin
  if not public.current_user_has_capability('maintenance.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_record
  from public.maintenance_records
  where id = p_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'maintenance_not_found');
  end if;
  select * into v_asset from public.assets where id = v_record.asset_id for update;

  v_stage := coalesce(nullif(p_input->>'workflow_stage', ''), v_record.workflow_stage, 'open');
  if v_stage not in ('open', 'investigating', 'awaiting_parts', 'at_vendor', 'completed', 'unrepairable') then
    return json_build_object('ok', false, 'error', 'invalid_maintenance_stage');
  end if;
  begin
    v_cost := case when p_input ? 'cost'
      then nullif(p_input->>'cost', '')::numeric else v_record.cost end;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end;
  if (p_input ? 'cost' or p_input ? 'invoice_number' or p_input ? 'invoice_date')
     and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end if;
  v_done := v_stage in ('completed', 'unrepairable');
  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance'
     and not public.asset_status_allowed(v_asset.status, 'in_maintenance') then
    return json_build_object('ok', false, 'error', 'invalid_asset_transition');
  end if;

  update public.maintenance_records set
    type = coalesce(nullif(p_input->>'type', ''), type::text)::public.maintenance_type,
    status = case when v_done then 'completed'::public.maintenance_status
      when v_stage = 'open' then 'open'::public.maintenance_status
      else 'in_progress'::public.maintenance_status end,
    workflow_stage = v_stage,
    priority = nullif(p_input->>'priority', ''),
    problem_type = nullif(p_input->>'problem_type', ''),
    problem_description = nullif(p_input->>'problem_description', ''),
    action_taken = nullif(p_input->>'action_taken', ''),
    cost = v_cost,
    invoice_number = case when p_input ? 'invoice_number'
      then nullif(p_input->>'invoice_number', '') else invoice_number end,
    invoice_date = case when p_input ? 'invoice_date'
      then nullif(p_input->>'invoice_date', '')::date else invoice_date end,
    final_summary = nullif(p_input->>'final_summary', ''),
    next_due_date = nullif(p_input->>'next_due_date', '')::date,
    technician_id = auth.uid(),
    completed_at = case when v_done then coalesce(completed_at, now()) else null end,
    vendor_supplier_id = nullif(p_input->>'vendor_supplier_id', '')::uuid,
    vendor_name = nullif(p_input->>'vendor_name', ''),
    vendor_phone = nullif(p_input->>'vendor_phone', ''),
    vendor_location = nullif(p_input->>'vendor_location', ''),
    vendor_map_link = nullif(p_input->>'vendor_map_link', ''),
    handoff_notes = nullif(p_input->>'handoff_notes', ''),
    receiver_name = nullif(p_input->>'receiver_name', '')
  where id = p_id;

  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance' then
    update public.assets set status = 'in_maintenance' where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', v_asset.status, 'in_maintenance', auth.uid(), 'إدخال صيانة'
    );
  elsif v_done and v_asset.status = 'in_maintenance' then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = v_asset.id and status = 'active';
    update public.assets set status = 'available', assigned_to_employee_id = null
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id, 'status_change', 'in_maintenance', 'available', auth.uid(), 'انتهاء صيانة'
    );
  end if;
  return json_build_object('ok', true);
end
$func$;

create or replace function public.consumable_create_with_opening_stock(p_input jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_id uuid;
  v_qty integer;
  v_reorder integer;
  v_cost numeric;
begin
  if not public.current_user_has_capability('consumable.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or nullif(btrim(p_input->>'category_id'), '') is null
     or nullif(btrim(p_input->>'name'), '') is null then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  if coalesce(p_input->>'quantity_on_hand', '0') !~ '^[0-9]+$'
     or coalesce(p_input->>'reorder_level', '0') !~ '^[0-9]+$' then
    return json_build_object('ok', false, 'error', 'invalid_quantity');
  end if;
  begin
    v_qty := coalesce((p_input->>'quantity_on_hand')::integer, 0);
    v_reorder := coalesce((p_input->>'reorder_level')::integer, 0);
    v_cost := nullif(p_input->>'unit_cost', '')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_numeric');
  end;
  if v_qty > 1000000 or v_reorder > 1000000 then
    return json_build_object('ok', false, 'error', 'quantity_too_large');
  end if;
  if v_cost is not null and (not public.is_financial_viewer() or v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_financial_value');
  end if;

  insert into public.consumables (
    category_id, name, sku, brand, unit, quantity_on_hand, reorder_level,
    company_id, supplier_id, location_id, unit_cost, rfid_tag, notes
  ) values (
    (p_input->>'category_id')::uuid, btrim(p_input->>'name'),
    nullif(btrim(p_input->>'sku'), ''), nullif(btrim(p_input->>'brand'), ''),
    coalesce(nullif(p_input->>'unit', ''), 'piece'), 0, v_reorder,
    nullif(p_input->>'company_id', '')::uuid,
    nullif(p_input->>'supplier_id', '')::uuid,
    nullif(p_input->>'location_id', '')::uuid,
    v_cost, nullif(btrim(p_input->>'rfid_tag'), ''), nullif(btrim(p_input->>'notes'), '')
  ) returning id into v_id;

  if v_qty > 0 then
    insert into public.consumable_transactions (
      consumable_id, txn_type, quantity, previous_quantity, balance_after,
      unit_cost, total_cost, supplier_id, reason, performed_by
    ) values (
      v_id, 'in', v_qty, 0, v_qty, v_cost,
      case when v_cost is not null then v_cost * v_qty else null end,
      nullif(p_input->>'supplier_id', '')::uuid, 'رصيد افتتاحي', auth.uid()
    );
    update public.consumables set quantity_on_hand = v_qty where id = v_id;
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$func$;

create or replace function public.purchase_requests_create_from_shortages(p_items jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_item jsonb;
  v_supplier uuid;
  v_pr_id uuid;
  v_number text;
  v_qty integer;
  v_numbers text[] := array[]::text[];
begin
  if not public.current_user_has_capability('purchase.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    return json_build_object('ok', false, 'error', 'invalid_items');
  end if;

  -- Validate the complete payload before the first header is created.
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or nullif(v_item->>'consumable_id', '') is null
       or coalesce(v_item->>'quantity', '') !~ '^[1-9][0-9]*$' then
      return json_build_object('ok', false, 'error', 'invalid_item');
    end if;
    begin
      v_qty := (v_item->>'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      return json_build_object('ok', false, 'error', 'invalid_quantity');
    end;
    if v_qty > 1000000
       or not exists (
         select 1 from public.consumables
         where id = (v_item->>'consumable_id')::uuid and is_active
       ) then
      return json_build_object('ok', false, 'error', 'invalid_item');
    end if;
    if nullif(v_item->>'supplier_id', '') is not null
       and not exists (
         select 1 from public.suppliers where id = (v_item->>'supplier_id')::uuid and is_active
       ) then
      return json_build_object('ok', false, 'error', 'invalid_supplier');
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(p_items) x
    group by nullif(x->>'supplier_id', ''), x->>'consumable_id'
    having count(*) > 1
  ) then
    return json_build_object('ok', false, 'error', 'duplicate_item');
  end if;

  for v_supplier in
    select distinct nullif(value->>'supplier_id', '')::uuid
    from jsonb_array_elements(p_items)
  loop
    insert into public.purchase_requests (supplier_id)
    values (v_supplier)
    returning id, request_number into v_pr_id, v_number;

    insert into public.purchase_request_items (
      purchase_request_id, consumable_id, requested_quantity, suggested_quantity
    )
    select
      v_pr_id, (value->>'consumable_id')::uuid,
      (value->>'quantity')::integer, (value->>'quantity')::integer
    from jsonb_array_elements(p_items)
    where nullif(value->>'supplier_id', '')::uuid is not distinct from v_supplier;

    v_numbers := array_append(v_numbers, v_number);
  end loop;
  return json_build_object('ok', true, 'numbers', to_jsonb(v_numbers));
end
$func$;

revoke all on function public.asset_create_atomic(jsonb) from public, anon;
revoke all on function public.asset_move_atomic(uuid, uuid, uuid) from public, anon;
revoke all on function public.asset_update_atomic(uuid, jsonb) from public, anon;
revoke all on function public.maintenance_create_atomic(jsonb) from public, anon;
revoke all on function public.maintenance_update_atomic(uuid, jsonb) from public, anon;
revoke all on function public.consumable_create_with_opening_stock(jsonb) from public, anon;
revoke all on function public.purchase_requests_create_from_shortages(jsonb) from public, anon;

grant execute on function public.asset_create_atomic(jsonb) to authenticated;
grant execute on function public.asset_move_atomic(uuid, uuid, uuid) to authenticated;
grant execute on function public.asset_update_atomic(uuid, jsonb) to authenticated;
grant execute on function public.maintenance_create_atomic(jsonb) to authenticated;
grant execute on function public.maintenance_update_atomic(uuid, jsonb) to authenticated;
grant execute on function public.consumable_create_with_opening_stock(jsonb) to authenticated;
grant execute on function public.purchase_requests_create_from_shortages(jsonb) to authenticated;

-- SECURITY DEFINER entrypoints above are now the only browser creation paths.
revoke insert on public.assets, public.asset_movements, public.asset_assignments,
  public.maintenance_records, public.consumables, public.purchase_requests,
  public.purchase_request_items
from authenticated;

commit;

-- === SOURCE: migrations/20260727152842_capability_consistency_hardening.sql | sha256: 6e7d40d1d5a9eb9b0c18e14a35d4193f0d0517087f748d985c391e12524969d3 ===
-- F-006 / F-014: capability/RLS/RPC consistency.
-- Financial access and admin-account protection intentionally remain explicit
-- invariants rather than configurable capabilities.

begin;

insert into public.permissions (key, grp, description)
values ('asset.move', 'assets', 'نقل أصل بين المواقع')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'asset.move'
where r.key in ('admin', 'it_manager', 'technician')
on conflict do nothing;

-- Match the established UI/business rule: catalog/detail changes and CSV
-- imports are manager operations; technicians retain explicit move/custody
-- operations rather than the broad asset.update/import capabilities.
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and (
    (p.key = 'asset.update' and r.key in ('technician', 'warehouse_manager'))
    or (p.key = 'asset.import' and r.key in ('technician', 'warehouse_manager'))
  );

-- Stocktake policy previously allowed operational roles while the matrix
-- omitted them, and listed auditors even though auditors are read-only
-- everywhere else.
-- Align metadata with the intended runtime policy before making the capability
-- the RLS source of truth.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'stocktake.manage'
where r.key in ('technician', 'warehouse_manager')
on conflict do nothing;

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key = 'auditor'
  and p.key = 'stocktake.manage';

-- has_capability(user,key) is an internal primitive, not a public directory of
-- other users' permissions.  Self checks use current_user_has_capability.
revoke all on function public.has_capability(uuid, text)
from public, anon, authenticated;

create or replace function public.admin_user_has_capability(
  p_user uuid,
  p_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $function$
begin
  if public.app_user_role() <> 'admin'
     or not public.current_user_has_capability('user.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return public.has_capability(p_user, p_key);
end
$function$;

revoke all on function public.admin_user_has_capability(uuid, text)
from public, anon;
grant execute on function public.admin_user_has_capability(uuid, text)
to authenticated;

-- Existing asset RLS used manager role literals.  Keep direct catalog writes
-- manager-only, but make the matrix authoritative (user deny overrides work).
drop policy if exists upd_ops on public.assets;
drop policy if exists upd_managers on public.assets;
drop policy if exists upd_capability on public.assets;
create policy upd_capability on public.assets
for update to authenticated
using (public.current_user_has_capability('asset.update'))
with check (public.current_user_has_capability('asset.update'));

drop policy if exists ins_ops on public.assets;
drop policy if exists ins_managers on public.assets;
drop policy if exists assets_insert_managers_restrictive on public.assets;
drop policy if exists ins_capability on public.assets;
create policy ins_capability on public.assets
for insert to authenticated
with check (public.current_user_has_capability('asset.create'));

drop policy if exists upd_ops on public.maintenance_records;
drop policy if exists upd_capability on public.maintenance_records;
create policy upd_capability on public.maintenance_records
for update to authenticated
using (public.current_user_has_capability('maintenance.manage'))
with check (public.current_user_has_capability('maintenance.manage'));

drop policy if exists ins_ops on public.stocktakes;
drop policy if exists upd_ops on public.stocktakes;
drop policy if exists ins_capability on public.stocktakes;
drop policy if exists upd_capability on public.stocktakes;
create policy ins_capability on public.stocktakes
for insert to authenticated
with check (public.current_user_has_capability('stocktake.manage'));
create policy upd_capability on public.stocktakes
for update to authenticated
using (public.current_user_has_capability('stocktake.manage'))
with check (public.current_user_has_capability('stocktake.manage'));

drop policy if exists ins_ops on public.stocktake_items;
drop policy if exists upd_ops on public.stocktake_items;
drop policy if exists ins_capability on public.stocktake_items;
drop policy if exists upd_capability on public.stocktake_items;
create policy ins_capability on public.stocktake_items
for insert to authenticated
with check (public.current_user_has_capability('stocktake.manage'));
create policy upd_capability on public.stocktake_items
for update to authenticated
using (public.current_user_has_capability('stocktake.manage'))
with check (public.current_user_has_capability('stocktake.manage'));

-- The atomic move entrypoint has a narrower capability than full record edit.
create or replace function public.asset_move_atomic(
  p_asset_id uuid,
  p_to_location_id uuid,
  p_to_department_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from_location uuid;
begin
  if not public.current_user_has_capability('asset.move') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_to_location_id is null
     or not exists (select 1 from public.locations where id = p_to_location_id) then
    return json_build_object('ok', false, 'error', 'invalid_location');
  end if;
  if p_to_department_id is not null
     and not exists (select 1 from public.departments where id = p_to_department_id) then
    return json_build_object('ok', false, 'error', 'invalid_department');
  end if;

  select location_id into v_from_location
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  update public.assets
  set location_id = p_to_location_id,
      department_id = coalesce(p_to_department_id, department_id)
  where id = p_asset_id;
  insert into public.asset_movements (
    asset_id, movement_type, from_location_id, to_location_id, performed_by, note
  ) values (
    p_asset_id, 'transfer', v_from_location, p_to_location_id, auth.uid(), 'نقل موقع'
  );
  return json_build_object('ok', true);
end
$function$;

-- Custody uses the dedicated asset.assign capability; technician is the
-- established operational default, warehouse remains limited to request flows.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key = 'asset.assign'
where r.key = 'technician'
on conflict do nothing;

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and p.key = 'asset.assign' and r.key = 'warehouse_manager';

create or replace function public.asset_assign(
  p_asset_id uuid,
  p_employee_id uuid,
  p_due_date date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_employee_id is null
     or not exists (
       select 1 from public.employees where id = p_employee_id and is_active
     ) then
    return json_build_object('ok', false, 'error', 'employee_not_found');
  end if;
  select status into v_from
  from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if exists (
    select 1 from public.asset_assignments
    where asset_id = p_asset_id and status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'already_assigned');
  end if;
  if not public.asset_status_allowed(v_from, 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  insert into public.asset_assignments (
    asset_id, employee_id, assigned_by, due_return_date, status
  ) values (
    p_asset_id, p_employee_id, auth.uid(), p_due_date, 'active'
  );
  update public.assets
  set status = 'assigned', assigned_to_employee_id = p_employee_id
  where id = p_asset_id;
  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, to_employee_id,
    performed_by, note
  ) values (
    p_asset_id, 'assign', v_from, 'assigned', p_employee_id,
    auth.uid(), 'تسليم عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_return(
  p_asset_id uuid,
  p_condition text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select status into v_from
  from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.asset_status_allowed(v_from, 'available') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  update public.asset_assignments
  set status = 'returned', returned_at = now(),
      return_condition = nullif(p_condition, '')
  where asset_id = p_asset_id and status = 'active';
  update public.assets
  set status = 'available', assigned_to_employee_id = null
  where id = p_asset_id;
  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    p_asset_id, 'return', v_from, 'available', auth.uid(), 'إرجاع عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_change_status(
  p_asset_id uuid,
  p_to_status public.asset_status,
  p_note text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.update') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_to_status in ('retired', 'disposed')
     and not public.current_user_has_capability('asset.retire') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select status into v_from
  from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.asset_status_allowed(v_from, p_to_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;
  if p_to_status in ('available', 'retired', 'disposed', 'lost') then
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = p_asset_id and status = 'active';
    update public.assets
    set status = p_to_status, assigned_to_employee_id = null
    where id = p_asset_id;
  else
    update public.assets set status = p_to_status where id = p_asset_id;
  end if;
  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    p_asset_id, 'status_change', v_from, p_to_status, auth.uid(),
    coalesce(nullif(p_note, ''), 'تغيير حالة')
  );
  return json_build_object('ok', true);
end
$function$;

revoke all on function public.admin_user_has_capability(uuid, text) from public, anon;
revoke all on function public.asset_move_atomic(uuid, uuid, uuid) from public, anon;
revoke all on function public.asset_assign(uuid, uuid, date) from public, anon;
revoke all on function public.asset_return(uuid, text) from public, anon;
revoke all on function public.asset_change_status(uuid, public.asset_status, text) from public, anon;
grant execute on function public.admin_user_has_capability(uuid, text) to authenticated;
grant execute on function public.asset_move_atomic(uuid, uuid, uuid) to authenticated;
grant execute on function public.asset_assign(uuid, uuid, date) to authenticated;
grant execute on function public.asset_return(uuid, text) to authenticated;
grant execute on function public.asset_change_status(uuid, public.asset_status, text) to authenticated;

commit;

-- === SOURCE: migrations/20260727153809_future_asset_integrity_guards.sql | sha256: 8dc492f367fbddab13560dade0a3e2bbccdaa14bd4c2f3239036958477bb4ca9 ===
-- F-007: prevent new asset ownership/location/creator and assignment
-- inconsistencies without inventing values for ambiguous historical rows.

begin;

create or replace function public.assets_guard_future_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.created_by is null then
      raise exception 'asset_creator_required' using errcode = '23514';
    end if;
    if new.company_id is null then
      raise exception 'asset_company_required' using errcode = '23514';
    end if;
    if new.location_id is null then
      raise exception 'asset_location_required' using errcode = '23514';
    end if;
    if nullif(btrim(new.serial_number), '') is null
       and not coalesce(new.serial_exempt, false) then
      raise exception 'asset_serial_required' using errcode = '23514';
    end if;
  else
    -- Legacy nulls remain untouched until a human can establish the truth, but
    -- a known value can never be cleared and created_by is immutable.
    if old.company_id is not null and new.company_id is null then
      raise exception 'asset_company_cannot_be_cleared' using errcode = '23514';
    end if;
    if old.location_id is not null and new.location_id is null then
      raise exception 'asset_location_cannot_be_cleared' using errcode = '23514';
    end if;
    if old.created_by is not null and new.created_by is distinct from old.created_by then
      raise exception 'asset_creator_immutable' using errcode = '23514';
    end if;
    if old.created_by is null and new.created_by is null then
      new.created_by := null; -- do not fabricate history during unrelated edits
    end if;
  end if;

  if new.status = 'assigned' and new.assigned_to_employee_id is null then
    raise exception 'assigned_employee_required' using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_assets_guard_future_integrity on public.assets;
drop trigger if exists trg_assets_guard_future_integrity on public.assets;
create trigger trg_assets_guard_future_integrity
before insert or update on public.assets
for each row execute function public.assets_guard_future_integrity();

-- Deterministic legacy repair only: an immutable INSERT audit event with one
-- unambiguous actor proves who created the row.  Rows without that evidence
-- remain null for human remediation.
with proven_creator as (
  select a.id, min(al.changed_by::text)::uuid as creator_id
  from public.assets a
  join public.audit_logs al
    on al.table_name = 'assets'
   and al.record_id = a.id::text
   and al.action = 'INSERT'
   and al.changed_by is not null
  where a.created_by is null
  group by a.id
  having count(distinct al.changed_by) = 1
)
update public.assets a
set created_by = p.creator_id
from proven_creator p
where a.id = p.id and a.created_by is null;

-- A deferred check permits one transaction to update the asset and create its
-- assignment in either statement order, but rejects COMMIT unless the final
-- state has exactly one matching active assignment.
create or replace function public.assets_check_assigned_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_count integer;
begin
  if new.status <> 'assigned' then
    return new;
  end if;
  select count(*) into v_count
  from public.asset_assignments aa
  where aa.asset_id = new.id
    and aa.status = 'active'
    and aa.employee_id = new.assigned_to_employee_id;
  if v_count <> 1 then
    raise exception 'assigned_asset_requires_one_matching_active_assignment'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_assets_assigned_integrity_insert on public.assets;
create constraint trigger trg_assets_assigned_integrity_insert
after insert on public.assets
deferrable initially deferred
for each row
when (new.status = 'assigned')
execute function public.assets_check_assigned_integrity();

drop trigger if exists trg_assets_assigned_integrity_update on public.assets;
create constraint trigger trg_assets_assigned_integrity_update
after update of status, assigned_to_employee_id on public.assets
deferrable initially deferred
for each row
when (new.status = 'assigned')
execute function public.assets_check_assigned_integrity();

create unique index if not exists uq_maintenance_one_active_per_asset
on public.maintenance_records(asset_id)
where status <> 'cancelled'
  and coalesce(workflow_stage, 'open') in (
    'open', 'investigating', 'awaiting_parts', 'at_vendor'
  );

-- Keep trigger helpers off the API surface.
revoke all on function public.assets_guard_future_integrity()
from public, anon, authenticated;
revoke all on function public.assets_check_assigned_integrity()
from public, anon, authenticated;

commit;

-- === SOURCE: migrations/20260727154633_dashboard_exact_aggregates.sql | sha256: bd320736de1f8bdbc0f888fbdc3ca653a73adc61390f2cbce660985325c84e8f ===
-- Batch 8: exact, non-financial dashboard aggregates.  Detail rows remain
-- bounded for rendering; enterprise KPIs no longer depend on PostgREST's
-- 1,000-row response cap.

begin;

create or replace function public.dashboard_operational_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
with
guard as (
  select public.is_approved() as allowed
),
asset_counts as (
  select
    count(*) as total,
    count(*) filter (where status = 'available') as available,
    count(*) filter (where status = 'assigned') as assigned,
    count(*) filter (where status = 'in_maintenance') as in_maintenance,
    count(*) filter (where status = 'lost') as lost,
    count(*) filter (where status = 'damaged') as damaged,
    count(*) filter (where status = 'retired') as retired
  from public.assets, guard
  where is_active and guard.allowed
),
consumable_counts as (
  select
    count(*) filter (
      where reorder_level > 0 and quantity_on_hand <= reorder_level
    ) as at_risk,
    count(*) filter (where quantity_on_hand = 0) as stockout,
    count(*) filter (where reorder_level <= 0) as without_threshold
  from public.consumables, guard
  where is_active and guard.allowed
),
maintenance_counts as (
  select
    count(*) filter (
      where status in ('open', 'in_progress')
        and reported_at < now() - interval '14 days'
    ) as long_open,
    count(*) filter (
      where status in ('open', 'in_progress')
        and nullif(btrim(action_taken), '') is null
        and technician_id is null
    ) as no_action,
    count(*) filter (
      where status in ('open', 'in_progress')
        and (
          reported_at < now() - interval '14 days'
          or (
            nullif(btrim(action_taken), '') is null
            and technician_id is null
          )
        )
    ) as followup
  from public.maintenance_records, guard
  where guard.allowed
),
request_counts as (
  select
    count(*) filter (where status = 'under_review') as actionable,
    count(*) filter (
      where status = 'overdue'
        or (
          status in ('delivered', 'partially_returned')
          and return_date < (now() at time zone 'Asia/Riyadh')::date
        )
    ) as overdue,
    count(*) filter (
      where status in (
        'approved', 'auto_provisioning', 'provisioned',
        'stock_shortage', 'preparing'
      )
    ) as preparation,
    count(*) filter (where status = 'ready_for_pickup') as ready_delivery,
    count(*) filter (
      where status in ('delivered', 'partially_returned', 'overdue')
        and return_date <= (now() at time zone 'Asia/Riyadh')::date
    ) as returns_due,
    count(*) filter (where status = 'returned') as returned_inspection
  from public.requests, guard
  where guard.allowed
    and portal_approval_status not in (
      'pending_project_manager', 'rejected_by_project_manager'
    )
)
select jsonb_build_object(
  'assets', jsonb_build_object(
    'total', a.total,
    'available', a.available,
    'assigned', a.assigned,
    'in_maintenance', a.in_maintenance,
    'lost', a.lost,
    'damaged', a.damaged,
    'retired', a.retired
  ),
  'consumables', jsonb_build_object(
    'at_risk', c.at_risk,
    'stockout', c.stockout,
    'without_threshold', c.without_threshold
  ),
  'maintenance', jsonb_build_object(
    'long_open', m.long_open,
    'no_action', m.no_action,
    'followup', m.followup
  ),
  'requests', jsonb_build_object(
    'actionable', r.actionable,
    'overdue', r.overdue,
    'preparation', r.preparation,
    'ready_delivery', r.ready_delivery,
    'returns_due', r.returns_due,
    'returned_inspection', r.returned_inspection
  )
)
from asset_counts a
cross join consumable_counts c
cross join maintenance_counts m
cross join request_counts r;
$function$;

revoke all on function public.dashboard_operational_summary()
from public, anon;
grant execute on function public.dashboard_operational_summary()
to authenticated;

commit;

-- === SOURCE: migrations/20260731073033_schema_compatibility_contract.sql | sha256: d490559a4518c9b14cc5569a8f249c1740973abdb73a45ce2189805159a2c213 ===
-- Purpose: expose a minimal, non-sensitive schema compatibility contract so the
-- application and deployment checks fail before users reach a mutation button.
-- Risk: low/additive. One deny-by-default table and one explicitly granted RPC.
-- Rollback: forward-fix only. A later migration may revoke EXECUTE or advance the
-- version; do not drop the table/function while an older app may call it.

begin;

create table if not exists public.app_schema_versions (
  contract_key text primary key,
  compatibility_version bigint not null check (compatibility_version > 0),
  required_signatures text[] not null default '{}'::text[],
  applied_at timestamptz not null default now()
);

alter table public.app_schema_versions enable row level security;
revoke all on table public.app_schema_versions from public, anon, authenticated;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073101,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

create or replace function public.app_schema_compatibility()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_version bigint;
  v_required text[];
  v_missing text[];
begin
  select compatibility_version, required_signatures
    into v_version, v_required
  from public.app_schema_versions
  where contract_key = 'itam_app';

  if v_version is null then
    return pg_catalog.jsonb_build_object(
      'contract', 'itam_app',
      'version', 0,
      'compatible', false,
      'missing', pg_catalog.to_jsonb(array['schema_version_ledger']::text[])
    );
  end if;

  select coalesce(pg_catalog.array_agg(signature order by signature), '{}'::text[])
    into v_missing
  from pg_catalog.unnest(v_required) as required(signature)
  where pg_catalog.to_regprocedure(signature) is null;

  return pg_catalog.jsonb_build_object(
    'contract', 'itam_app',
    'version', v_version,
    'compatible', pg_catalog.cardinality(v_missing) = 0,
    'missing', pg_catalog.to_jsonb(v_missing)
  );
end;
$function$;

comment on table public.app_schema_versions is
  'Application/schema compatibility ledger. Direct client access is denied.';
comment on function public.app_schema_compatibility() is
  'Returns only the current compatibility version and missing required RPC signatures.';

revoke all on function public.app_schema_compatibility() from public, anon, authenticated;
grant execute on function public.app_schema_compatibility() to anon, authenticated;

commit;

-- === SOURCE: migrations/20260731105203_attachment_quarantine_lifecycle.sql | sha256: db570bf023721fbc51fd94fc8ae1e8803fb9a3bae5e2ad4f1a510f58fe8f09d7 ===
-- Purpose: P0-02 — make attachment reads fail closed until a trusted scanner
-- records a clean verdict, and expose a service-role-only scan completion
-- contract for both private attachment buckets.
-- Security impact: authenticated users cannot read or sign pending, infected,
-- or failed objects even when they know the UUID/path and otherwise have access
-- to the related entity. Only service_role can record a scanner verdict.
-- Rollout risk: all existing rows become pending. Production rollout therefore
-- requires an inventory plus a trusted historical scan/backfill before enabling
-- application downloads. This migration never deletes objects or metadata.
-- Rollback: restoring the prior read helpers would re-enable unscanned reads;
-- retain the columns and scan evidence even if application code is rolled back.

begin;

alter table public.attachments
  add column if not exists scan_status text,
  add column if not exists scan_provider text,
  add column if not exists scan_reason text,
  add column if not exists content_sha256 text,
  add column if not exists scanned_at timestamptz;

alter table public.request_attachments
  add column if not exists scan_status text,
  add column if not exists scan_provider text,
  add column if not exists scan_reason text,
  add column if not exists content_sha256 text,
  add column if not exists scanned_at timestamptz;

update public.attachments
set scan_status = 'pending'
where scan_status is null;

update public.request_attachments
set scan_status = 'pending'
where scan_status is null;

alter table public.attachments
  alter column scan_status set default 'pending',
  alter column scan_status set not null;

alter table public.request_attachments
  alter column scan_status set default 'pending',
  alter column scan_status set not null;

do $do$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attachments_scan_status_check'
      and conrelid = 'public.attachments'::regclass
  ) then
    alter table public.attachments
      add constraint attachments_scan_status_check
      check (scan_status in ('pending', 'clean', 'infected', 'error'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'request_attachments_scan_status_check'
      and conrelid = 'public.request_attachments'::regclass
  ) then
    alter table public.request_attachments
      add constraint request_attachments_scan_status_check
      check (scan_status in ('pending', 'clean', 'infected', 'error'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'attachments_content_sha256_check'
      and conrelid = 'public.attachments'::regclass
  ) then
    alter table public.attachments
      add constraint attachments_content_sha256_check
      check (
        content_sha256 is null
        or content_sha256 ~ '^[0-9a-f]{64}$'
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'request_attachments_content_sha256_check'
      and conrelid = 'public.request_attachments'::regclass
  ) then
    alter table public.request_attachments
      add constraint request_attachments_content_sha256_check
      check (
        content_sha256 is null
        or content_sha256 ~ '^[0-9a-f]{64}$'
      );
  end if;
end
$do$;

create index if not exists idx_attachments_scan_queue
  on public.attachments(created_at, id)
  where scan_status = 'pending';

create index if not exists idx_request_attachments_scan_queue
  on public.request_attachments(created_at, id)
  where scan_status = 'pending';

-- No browser/client role may mutate scanner evidence directly. Existing
-- manager workflows use SECURITY DEFINER RPCs and do not require table UPDATE.
revoke update on public.attachments
  from anon, authenticated;
revoke update on public.request_attachments
  from anon, authenticated;

create or replace function public.complete_attachment_scan(
  p_bucket text,
  p_storage_path text,
  p_verdict text,
  p_provider text,
  p_reason text default null,
  p_content_sha256 text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_updated integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'scan_service_role_required' using errcode = '42501';
  end if;
  if p_bucket not in ('attachments', 'request-attachments') then
    raise exception 'invalid_attachment_bucket' using errcode = '22023';
  end if;
  if p_verdict not in ('clean', 'infected', 'error') then
    raise exception 'invalid_scan_verdict' using errcode = '22023';
  end if;
  if coalesce(length(btrim(p_provider)), 0) = 0
     or length(p_provider) > 100 then
    raise exception 'invalid_scan_provider' using errcode = '22023';
  end if;
  if p_reason is not null and length(p_reason) > 1000 then
    raise exception 'invalid_scan_reason' using errcode = '22023';
  end if;
  if p_content_sha256 is not null
     and p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_content_sha256' using errcode = '22023';
  end if;

  if p_bucket = 'attachments' then
    update public.attachments
    set scan_status = p_verdict,
        scan_provider = btrim(p_provider),
        scan_reason = nullif(btrim(p_reason), ''),
        content_sha256 = p_content_sha256,
        scanned_at = statement_timestamp()
    where storage_path = p_storage_path;
    get diagnostics v_updated = row_count;
  else
    update public.request_attachments
    set scan_status = p_verdict,
        scan_provider = btrim(p_provider),
        scan_reason = nullif(btrim(p_reason), ''),
        content_sha256 = p_content_sha256,
        scanned_at = statement_timestamp()
    where storage_path = p_storage_path;
    get diagnostics v_updated = row_count;
  end if;

  if v_updated <> 1 then
    raise exception 'attachment_not_registered' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'ok', true,
    'bucket', p_bucket,
    'storage_path', p_storage_path,
    'verdict', p_verdict
  );
end
$function$;

revoke all on function public.complete_attachment_scan(
  text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_attachment_scan(
  text, text, text, text, text, text
) to service_role;

-- Entity authorization remains the first gate; a clean scanner verdict is the
-- second, mandatory gate. Unknown paths and unknown classifications stay denied.
create or replace function public.can_read_attachment_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce((
    select
      a.scan_status = 'clean'
      and case a.classification
        when 'financial' then public.is_financial_viewer()
        when 'internal' then public.is_approved()
        when 'customer_visible' then public.is_approved()
        else false
      end
    from public.attachments a
    where a.storage_path = p_name
  ), false);
$function$;

create or replace function public.request_attachment_staff_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select public.is_approved() and coalesce((
    select
      ra.scan_status = 'clean'
      and case ra.classification
        when 'financial' then public.is_financial_viewer()
        when 'internal' then true
        when 'customer_visible' then true
        else false
      end
    from public.request_attachments ra
    where ra.storage_path = p_name
  ), false);
$function$;

create or replace function public.portal_can_read_request_attachment(p_name text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.request_attachments ra
    join public.requests r on r.id = ra.request_id
    where ra.storage_path = p_name
      and ra.scan_status = 'clean'
      and ra.classification = 'customer_visible'
      and public.portal_customer_id() is not null
      and r.customer_id = public.portal_customer_id()
      and (
        public.portal_user_role() <> 'authorized_requester'
        or r.submitted_by is not distinct from auth.uid()
      )
      and (ra.uploaded_by_kind = 'portal' or ra.visible_to_customer)
  );
$function$;

revoke all on function public.can_read_attachment_object(text)
  from public, anon;
revoke all on function public.request_attachment_staff_can_read(text)
  from public, anon;
revoke all on function public.portal_can_read_request_attachment(text)
  from public, anon;
grant execute on function public.can_read_attachment_object(text)
  to authenticated;
grant execute on function public.request_attachment_staff_can_read(text)
  to authenticated;
grant execute on function public.portal_can_read_request_attachment(text)
  to authenticated;

-- The metadata list intentionally exposes pending status to the owning portal
-- user, but the path RPC and Storage SELECT policy deny access until clean.
create or replace function public.portal_list_request_attachments(
  p_request_id uuid
) returns json
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_customer_id uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_request public.requests%rowtype;
begin
  if v_customer_id is null then
    return json_build_object('ok', false, 'error', 'not_portal');
  end if;
  select * into v_request
  from public.requests
  where id = p_request_id;
  if not found or v_request.customer_id is distinct from v_customer_id then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_role = 'authorized_requester'
     and v_request.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object(
    'ok', true,
    'attachments', coalesce((
      select json_agg(json_build_object(
        'id', ra.id,
        'file_name', ra.file_name,
        'mime_type', ra.mime_type,
        'size_bytes', ra.size_bytes,
        'created_at', ra.created_at,
        'uploaded_by_kind', ra.uploaded_by_kind,
        'scan_status', ra.scan_status
      ) order by ra.created_at)
      from public.request_attachments ra
      where ra.request_id = p_request_id
        and ra.classification = 'customer_visible'
        and (
          ra.uploaded_by_kind = 'portal'
          or ra.visible_to_customer
        )
    ), '[]'::json)
  );
end
$function$;

create or replace function public.portal_get_request_attachment_path(
  p_attachment_id uuid
) returns json
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_customer_id uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_attachment public.request_attachments%rowtype;
  v_request public.requests%rowtype;
begin
  if v_customer_id is null then
    return json_build_object('ok', false, 'error', 'not_portal');
  end if;
  select * into v_attachment
  from public.request_attachments
  where id = p_attachment_id;
  if not found or v_attachment.classification <> 'customer_visible' then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_request
  from public.requests
  where id = v_attachment.request_id;
  if not found or v_request.customer_id is distinct from v_customer_id then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_role = 'authorized_requester'
     and v_request.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if not (
    v_attachment.uploaded_by_kind = 'portal'
    or v_attachment.visible_to_customer
  ) then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_attachment.scan_status <> 'clean' then
    return json_build_object(
      'ok', false,
      'error', 'attachment_quarantined',
      'scan_status', v_attachment.scan_status
    );
  end if;
  return json_build_object(
    'ok', true,
    'path', v_attachment.storage_path,
    'file_name', v_attachment.file_name
  );
end
$function$;

revoke all on function public.portal_list_request_attachments(uuid)
  from public, anon;
revoke all on function public.portal_get_request_attachment_path(uuid)
  from public, anon;
grant execute on function public.portal_list_request_attachments(uuid)
  to authenticated;
grant execute on function public.portal_get_request_attachment_path(uuid)
  to authenticated;

commit;

-- === SOURCE: migrations/20260731110758_custody_integrity_and_reconciliation.sql | sha256: 76cab51e9cf7e67b0dad4660439acc5c307a2e3561f22edd54bc750087ee367a ===
-- Purpose: P0-03 — enforce custody consistency in both directions and expose
-- historical contradictions as an evidence-backed reconciliation workflow.
-- Security impact: browser roles lose direct assignment DML; atomic RPCs remain
-- the only write path. Deferred constraints reject every final state where an
-- asset and its active assignment disagree, including employee deactivation.
-- Data impact: no asset, holder, assignment, or historical event is corrected.
-- Existing contradictions are copied into open reconciliation cases.
-- Rollout: additive tables/functions/triggers plus RPC replacements. Rehearse
-- against a representative restore and export the queue before production.
-- Rollback: do not remove reconciliation evidence. Dropping the new constraint
-- triggers or restoring prior RPCs would reopen silent custody corruption.

begin;

-- ---------------------------------------------------------------------------
-- One authoritative predicate used by guards and atomic RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.custody_asset_is_consistent(p_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  with asset_state as (
    select a.status, a.assigned_to_employee_id
    from public.assets a
    where a.id = p_asset_id
  ),
  active_state as (
    select
      count(aa.id)::integer as active_count,
      count(aa.id) filter (
        where aa.employee_id = s.assigned_to_employee_id
      )::integer as matching_count,
      count(aa.id) filter (
        where e.id is null or not e.is_active
      )::integer as inactive_employee_count
    from asset_state s
    left join public.asset_assignments aa
      on aa.asset_id = p_asset_id
     and aa.status = 'active'
    left join public.employees e on e.id = aa.employee_id
  )
  select coalesce((
    select
      case
        when s.status = 'assigned' then
          s.assigned_to_employee_id is not null
          and a.active_count = 1
          and a.matching_count = 1
          and a.inactive_employee_count = 0
        else a.active_count = 0
      end
    from asset_state s
    cross join active_state a
  ), false);
$function$;

revoke all on function public.custody_asset_is_consistent(uuid)
from public, anon, authenticated;

-- The immediate guard prevents a normal workflow from silently "repairing" a
-- pre-existing contradiction. A real-world reconciliation must be completed
-- through an approved, evidenced maintenance procedure.
create or replace function public.assets_guard_custody_transition()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.custody_asset_is_consistent(old.id) then
    raise exception 'custody_reconciliation_required' using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_assets_guard_custody_transition on public.assets;
drop trigger if exists trg_assets_guard_custody_transition on public.assets;
create trigger trg_assets_guard_custody_transition
before update of status, assigned_to_employee_id on public.assets
for each row execute function public.assets_guard_custody_transition();

-- The deferred assertion permits the asset and assignment rows to be written in
-- either order inside one transaction, while enforcing the final committed state.
create or replace function public.assert_asset_custody_consistency()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_asset_id uuid;
begin
  if tg_table_name = 'assets' then
    v_asset_id := new.id;
  elsif tg_op = 'DELETE' then
    v_asset_id := old.asset_id;
  else
    v_asset_id := new.asset_id;
  end if;
  if exists (select 1 from public.assets where id = v_asset_id)
     and not public.custody_asset_is_consistent(v_asset_id) then
    raise exception 'asset_custody_invariant_violation' using errcode = '23514';
  end if;
  return null;
end
$function$;

drop trigger if exists trg_assets_assigned_integrity_insert on public.assets;
drop trigger if exists trg_assets_assigned_integrity_update on public.assets;
drop trigger if exists trg_assets_custody_consistency on public.assets;
create constraint trigger trg_assets_custody_consistency
after insert or update of status, assigned_to_employee_id on public.assets
deferrable initially deferred
for each row execute function public.assert_asset_custody_consistency();

drop trigger if exists trg_assignments_custody_consistency
on public.asset_assignments;
create constraint trigger trg_assignments_custody_consistency
after insert or update or delete on public.asset_assignments
deferrable initially deferred
for each row execute function public.assert_asset_custody_consistency();

create unique index if not exists uq_active_assignment
on public.asset_assignments(asset_id)
where status = 'active';

create or replace function public.assert_employee_has_no_active_custody()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not new.is_active and exists (
    select 1
    from public.asset_assignments aa
    where aa.employee_id = new.id
      and aa.status = 'active'
  ) then
    raise exception 'inactive_employee_has_active_custody' using errcode = '23514';
  end if;
  return null;
end
$function$;

drop trigger if exists trg_employee_active_custody on public.employees;
create constraint trigger trg_employee_active_custody
after update of is_active on public.employees
deferrable initially deferred
for each row
when (old.is_active and not new.is_active)
execute function public.assert_employee_has_no_active_custody();

revoke all on function public.assets_guard_custody_transition()
from public, anon, authenticated;
revoke all on function public.assert_asset_custody_consistency()
from public, anon, authenticated;
revoke all on function public.assert_employee_has_no_active_custody()
from public, anon, authenticated;

drop function if exists public.assets_check_assigned_integrity();

-- Browser clients must use asset_assign/asset_return/request workflow RPCs.
revoke insert, update, delete on public.asset_assignments
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Final custody RPC definitions. Asset-first ordering works with the immediate
-- historical guard and the deferred bidirectional invariant.
-- ---------------------------------------------------------------------------

create or replace function public.asset_assign(
  p_asset_id uuid,
  p_employee_id uuid,
  p_due_date date default null
) returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_employee_id is null or not exists (
    select 1
    from public.employees
    where id = p_employee_id and is_active
  ) then
    return json_build_object('ok', false, 'error', 'employee_not_found');
  end if;

  select status into v_from
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.custody_asset_is_consistent(p_asset_id) then
    return json_build_object(
      'ok', false,
      'error', 'custody_reconciliation_required'
    );
  end if;
  if not public.asset_status_allowed(v_from, 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.assets
  set status = 'assigned',
      assigned_to_employee_id = p_employee_id
  where id = p_asset_id;

  insert into public.asset_assignments (
    asset_id, employee_id, assigned_by, due_return_date, status
  ) values (
    p_asset_id, p_employee_id, auth.uid(), p_due_date, 'active'
  );

  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, to_employee_id,
    performed_by, note
  ) values (
    p_asset_id, 'assign', v_from, 'assigned', p_employee_id,
    auth.uid(), 'تسليم عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_return(
  p_asset_id uuid,
  p_condition text default null
) returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_from public.asset_status;
  v_employee_id uuid;
begin
  if not public.current_user_has_capability('asset.assign') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_condition is not null
     and p_condition not in ('new', 'good', 'fair', 'poor') then
    return json_build_object('ok', false, 'error', 'invalid_condition');
  end if;

  select status, assigned_to_employee_id
  into v_from, v_employee_id
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.custody_asset_is_consistent(p_asset_id) then
    return json_build_object(
      'ok', false,
      'error', 'custody_reconciliation_required'
    );
  end if;
  if v_from <> 'assigned'
     or not public.asset_status_allowed(v_from, 'available') then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.assets
  set status = 'available',
      assigned_to_employee_id = null,
      last_return_condition = nullif(p_condition, ''),
      last_return_at = statement_timestamp()
  where id = p_asset_id;

  update public.asset_assignments
  set status = 'returned',
      returned_at = statement_timestamp(),
      return_condition = nullif(p_condition, '')
  where asset_id = p_asset_id
    and status = 'active';

  insert into public.asset_movements (
    asset_id, movement_type, from_employee_id, from_status, to_status,
    performed_by, note
  ) values (
    p_asset_id, 'return', v_employee_id, v_from, 'available',
    auth.uid(), 'إرجاع عهدة'
  );
  return json_build_object('ok', true);
end
$function$;

create or replace function public.asset_change_status(
  p_asset_id uuid,
  p_to_status public.asset_status,
  p_note text default null
) returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.update') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_to_status in ('retired', 'disposed')
     and not public.current_user_has_capability('asset.retire') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select status into v_from
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.custody_asset_is_consistent(p_asset_id) then
    return json_build_object(
      'ok', false,
      'error', 'custody_reconciliation_required'
    );
  end if;
  if p_to_status = 'assigned' then
    return json_build_object(
      'ok', false,
      'error', 'custody_assignment_rpc_required'
    );
  end if;
  if not public.asset_status_allowed(v_from, p_to_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.assets
  set status = p_to_status,
      assigned_to_employee_id = null
  where id = p_asset_id;

  update public.asset_assignments
  set status = 'returned',
      returned_at = statement_timestamp()
  where asset_id = p_asset_id
    and status = 'active';

  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    p_asset_id, 'status_change', v_from, p_to_status, auth.uid(),
    coalesce(nullif(p_note, ''), 'تغيير حالة')
  );
  return json_build_object('ok', true);
end
$function$;

revoke all on function public.asset_assign(uuid, uuid, date)
from public, anon;
revoke all on function public.asset_return(uuid, text)
from public, anon;
revoke all on function public.asset_change_status(
  uuid, public.asset_status, text
) from public, anon;
grant execute on function public.asset_assign(uuid, uuid, date)
to authenticated;
grant execute on function public.asset_return(uuid, text)
to authenticated;
grant execute on function public.asset_change_status(
  uuid, public.asset_status, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Read-only anomaly detector and persistent, manually resolved workflow.
-- ---------------------------------------------------------------------------

create or replace view public.custody_current_anomalies
with (security_invoker = true)
as
with custody_state as (
  select
    a.id as asset_id,
    a.asset_tag,
    a.status::text as asset_status,
    a.assigned_to_employee_id as holder_employee_id,
    count(aa.id)::integer as active_assignment_count,
    count(aa.id) filter (
      where aa.employee_id = a.assigned_to_employee_id
    )::integer as matching_assignment_count,
    bool_or(
      aa.id is not null and (e.id is null or not e.is_active)
    ) as has_inactive_employee
  from public.assets a
  left join public.asset_assignments aa
    on aa.asset_id = a.id
   and aa.status = 'active'
  left join public.employees e on e.id = aa.employee_id
  group by
    a.id,
    a.asset_tag,
    a.status,
    a.assigned_to_employee_id
)
select
  s.asset_id,
  s.asset_tag,
  s.asset_status,
  s.holder_employee_id,
  s.active_assignment_count,
  anomaly.anomaly_code
from custody_state s
cross join lateral (
  select 'assigned_without_holder'::text as anomaly_code
  where s.asset_status = 'assigned'
    and s.holder_employee_id is null
  union all
  select 'assigned_without_active'
  where s.asset_status = 'assigned'
    and s.active_assignment_count = 0
  union all
  select 'multiple_active'
  where s.active_assignment_count > 1
  union all
  select 'holder_mismatch'
  where s.asset_status = 'assigned'
    and s.active_assignment_count = 1
    and s.matching_assignment_count <> 1
  union all
  select 'active_on_nonassigned'
  where s.asset_status <> 'assigned'
    and s.active_assignment_count > 0
  union all
  select 'inactive_employee'
  where coalesce(s.has_inactive_employee, false)
) anomaly;

revoke all on public.custody_current_anomalies
from public, anon, authenticated;

create table if not exists public.custody_reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete restrict,
  anomaly_code text not null check (
    anomaly_code in (
      'assigned_without_holder',
      'assigned_without_active',
      'multiple_active',
      'holder_mismatch',
      'active_on_nonassigned',
      'inactive_employee'
    )
  ),
  status text not null default 'open' check (
    status in ('open', 'in_review', 'resolved', 'dismissed')
  ),
  detected_at timestamptz not null default statement_timestamp(),
  last_detected_at timestamptz not null default statement_timestamp(),
  snapshot jsonb not null default '{}'::jsonb,
  assigned_to uuid references public.app_users(id) on delete set null,
  resolution_code text check (
    resolution_code is null or resolution_code in (
      'holder_confirmed',
      'asset_quarantined',
      'asset_not_found',
      'investigation_opened',
      'false_positive'
    )
  ),
  resolution_notes text,
  evidence_ref text,
  resolved_at timestamptz,
  resolved_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create unique index if not exists uq_custody_open_case
on public.custody_reconciliation_cases(asset_id, anomaly_code)
where status in ('open', 'in_review');

create index if not exists idx_custody_cases_work_queue
on public.custody_reconciliation_cases(status, detected_at, id);

alter table public.custody_reconciliation_cases enable row level security;
revoke all on public.custody_reconciliation_cases
from anon, authenticated;
grant select on public.custody_reconciliation_cases
to authenticated;
grant select on public.custody_reconciliation_cases
to service_role;

drop policy if exists custody_cases_select on public.custody_reconciliation_cases;
create policy custody_cases_select
on public.custody_reconciliation_cases
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'auditor')
);

create or replace function public._custody_reconciliation_refresh()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer;
begin
  insert into public.custody_reconciliation_cases (
    asset_id,
    anomaly_code,
    snapshot
  )
  select
    a.asset_id,
    a.anomaly_code,
    jsonb_build_object(
      'asset_tag', a.asset_tag,
      'asset_status', a.asset_status,
      'holder_employee_id', a.holder_employee_id,
      'active_assignment_count', a.active_assignment_count
    )
  from public.custody_current_anomalies a
  on conflict (asset_id, anomaly_code)
    where status in ('open', 'in_review')
  do update
  set last_detected_at = statement_timestamp(),
      snapshot = excluded.snapshot,
      updated_at = statement_timestamp();
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

revoke all on function public._custody_reconciliation_refresh()
from public, anon, authenticated;

create or replace function public.custody_reconciliation_refresh()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
  v_touched integer;
  v_current integer;
begin
  if v_role is null or v_role not in ('admin', 'it_manager', 'auditor') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_touched := public._custody_reconciliation_refresh();
  select count(*) into v_current
  from public.custody_current_anomalies;
  return jsonb_build_object(
    'ok', true,
    'current_anomalies', v_current,
    'cases_touched', v_touched
  );
end
$function$;

create or replace function public.custody_reconciliation_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin', 'it_manager', 'auditor') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'ok', true,
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'asset_id', c.asset_id,
        'anomaly_code', c.anomaly_code,
        'status', c.status,
        'detected_at', c.detected_at,
        'last_detected_at', c.last_detected_at,
        'snapshot', c.snapshot,
        'assigned_to', c.assigned_to,
        'resolution_code', c.resolution_code,
        'resolution_notes', c.resolution_notes,
        'evidence_ref', c.evidence_ref,
        'resolved_at', c.resolved_at,
        'resolved_by', c.resolved_by
      ) order by c.detected_at, c.id)
      from public.custody_reconciliation_cases c
    ), '[]'::jsonb)
  );
end
$function$;

create or replace function public.custody_reconciliation_update_case(
  p_case_id uuid,
  p_status text,
  p_assigned_to uuid default null,
  p_resolution_code text default null,
  p_resolution_notes text default null,
  p_evidence_ref text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text := public.app_user_role();
  v_updated integer;
begin
  if v_role is null or v_role not in ('admin', 'it_manager') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_status not in ('in_review', 'resolved', 'dismissed') then
    raise exception 'invalid_case_status' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not exists (
    select 1
    from public.app_users u
    where u.id = p_assigned_to
      and u.is_active
      and u.approval_status = 'approved'
  ) then
    raise exception 'invalid_case_assignee' using errcode = '22023';
  end if;
  if p_status in ('resolved', 'dismissed') and (
    p_resolution_code is null
    or coalesce(length(btrim(p_resolution_notes)), 0) = 0
    or coalesce(length(btrim(p_evidence_ref)), 0) = 0
  ) then
    raise exception 'resolution_evidence_required' using errcode = '22023';
  end if;

  update public.custody_reconciliation_cases
  set status = p_status,
      assigned_to = p_assigned_to,
      resolution_code = p_resolution_code,
      resolution_notes = nullif(btrim(p_resolution_notes), ''),
      evidence_ref = nullif(btrim(p_evidence_ref), ''),
      resolved_at = case
        when p_status in ('resolved', 'dismissed')
          then statement_timestamp()
        else null
      end,
      resolved_by = case
        when p_status in ('resolved', 'dismissed')
          then auth.uid()
        else null
      end,
      updated_at = statement_timestamp()
  where id = p_case_id
    and status in ('open', 'in_review');
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'case_not_open' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true, 'id', p_case_id, 'status', p_status);
end
$function$;

revoke all on function public.custody_reconciliation_refresh()
from public, anon;
revoke all on function public.custody_reconciliation_list()
from public, anon;
revoke all on function public.custody_reconciliation_update_case(
  uuid, text, uuid, text, text, text
) from public, anon;
grant execute on function public.custody_reconciliation_refresh()
to authenticated;
grant execute on function public.custody_reconciliation_list()
to authenticated;
grant execute on function public.custody_reconciliation_update_case(
  uuid, text, uuid, text, text, text
) to authenticated;

-- Initial inventory only: create cases; never mutate the source records.
select public._custody_reconciliation_refresh();

commit;

-- === SOURCE: migrations/20260731123640_financial_truthfulness.sql | sha256: 1aa0af9d99619769cae189773dc5633b15d7f780a6e69d4860d279f9e70c4bd3 ===
-- P0-04: distinguish a real zero from missing and forbidden financial data.
-- LOCAL-ONLY proposal. It does not backfill amounts or infer historical values.

begin;

-- The previous schema forced unpriced maintenance to zero. Make absence
-- representable and add explicit provenance for future zero-cost records.
alter table public.maintenance_records
  alter column cost drop not null,
  alter column cost drop default;

alter table public.maintenance_records
  add column if not exists cost_recorded boolean not null default false;

comment on column public.maintenance_records.cost_recorded is
  'True only when an authorized financial actor or trusted service explicitly supplied cost; historical zero remains unconfirmed.';

create or replace function public.maintenance_guard_financial()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() = 'service_role' then
    if tg_op = 'INSERT' or new.cost is distinct from old.cost then
      new.cost_recorded := new.cost is not null;
    end if;
  elsif public.is_financial_viewer() then
    if tg_op = 'INSERT' or new.cost is distinct from old.cost then
      new.cost_recorded := new.cost is not null;
    end if;
  elsif tg_op = 'INSERT' then
    new.cost := null;
    new.cost_recorded := false;
    new.invoice_number := null;
    new.invoice_date := null;
  else
    new.cost := old.cost;
    new.cost_recorded := old.cost_recorded;
    new.invoice_number := old.invoice_number;
    new.invoice_date := old.invoice_date;
  end if;
  return new;
end
$function$;

revoke execute on function public.maintenance_guard_financial()
from public, anon, authenticated;

-- Final create definition: absence remains NULL instead of being coerced to 0.
create or replace function public.maintenance_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_asset public.assets%rowtype;
  v_stage text;
  v_done boolean;
  v_cost numeric;
begin
  if not public.current_user_has_capability('maintenance.manage') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  v_stage := coalesce(nullif(p_input->>'workflow_stage', ''), 'open');
  if v_stage not in (
    'open', 'investigating', 'awaiting_parts', 'at_vendor',
    'completed', 'unrepairable'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_maintenance_stage');
  end if;
  begin
    v_cost := nullif(p_input->>'cost', '')::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      return json_build_object('ok', false, 'error', 'invalid_cost');
  end;
  if (
    v_cost is not null
    or nullif(p_input->>'invoice_number', '') is not null
    or nullif(p_input->>'invoice_date', '') is not null
  ) and not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 9999999999.99) then
    return json_build_object('ok', false, 'error', 'invalid_cost');
  end if;

  select *
  into v_asset
  from public.assets
  where id = (p_input->>'asset_id')::uuid
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  v_done := v_stage in ('completed', 'unrepairable');
  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance'
     and not public.asset_status_allowed(v_asset.status, 'in_maintenance') then
    return json_build_object('ok', false, 'error', 'invalid_asset_transition');
  end if;

  insert into public.maintenance_records (
    asset_id,
    type,
    status,
    workflow_stage,
    priority,
    problem_type,
    problem_description,
    action_taken,
    cost,
    invoice_number,
    invoice_date,
    reported_by,
    technician_id,
    reported_by_employee_id,
    final_summary,
    next_due_date,
    completed_at,
    vendor_supplier_id,
    vendor_name,
    vendor_phone,
    vendor_location,
    vendor_map_link,
    handoff_notes,
    receiver_name
  ) values (
    v_asset.id,
    coalesce(nullif(p_input->>'type', ''), 'corrective')::public.maintenance_type,
    case
      when v_done then 'completed'::public.maintenance_status
      when v_stage = 'open' then 'open'::public.maintenance_status
      else 'in_progress'::public.maintenance_status
    end,
    v_stage,
    nullif(p_input->>'priority', ''),
    nullif(p_input->>'problem_type', ''),
    nullif(p_input->>'problem_description', ''),
    nullif(p_input->>'action_taken', ''),
    v_cost,
    nullif(p_input->>'invoice_number', ''),
    nullif(p_input->>'invoice_date', '')::date,
    auth.uid(),
    auth.uid(),
    nullif(p_input->>'reported_by_employee_id', '')::uuid,
    nullif(p_input->>'final_summary', ''),
    nullif(p_input->>'next_due_date', '')::date,
    case when v_done then statement_timestamp() else null end,
    nullif(p_input->>'vendor_supplier_id', '')::uuid,
    nullif(p_input->>'vendor_name', ''),
    nullif(p_input->>'vendor_phone', ''),
    nullif(p_input->>'vendor_location', ''),
    nullif(p_input->>'vendor_map_link', ''),
    nullif(p_input->>'handoff_notes', ''),
    nullif(p_input->>'receiver_name', '')
  )
  returning id into v_id;

  if v_stage in ('open', 'investigating', 'awaiting_parts', 'at_vendor')
     and v_asset.status <> 'in_maintenance' then
    update public.assets
    set status = 'in_maintenance'
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id,
      'status_change',
      v_asset.status,
      'in_maintenance',
      auth.uid(),
      'إدخال صيانة'
    );
  elsif v_done and v_asset.status = 'in_maintenance' then
    update public.asset_assignments
    set status = 'returned', returned_at = statement_timestamp()
    where asset_id = v_asset.id and status = 'active';
    update public.assets
    set status = 'available', assigned_to_employee_id = null
    where id = v_asset.id;
    insert into public.asset_movements (
      asset_id, movement_type, from_status, to_status, performed_by, note
    ) values (
      v_asset.id,
      'status_change',
      'in_maintenance',
      'available',
      auth.uid(),
      'انتهاء صيانة'
    );
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$function$;

create or replace function public.maintenance_financial_truth(p_ids uuid[])
returns table (
  id uuid,
  cost numeric,
  cost_recorded boolean,
  currency text,
  invoice_number text,
  invoice_date date
)
language sql
stable
security definer
set search_path to ''
as $function$
  select
    m.id,
    case when m.cost_recorded then m.cost else null end,
    m.cost_recorded,
    m.currency,
    m.invoice_number,
    m.invoice_date
  from public.maintenance_records m
  where public.is_financial_viewer()
    and m.id = any(p_ids);
$function$;

revoke all on function public.maintenance_financial_truth(uuid[])
from public, anon;
grant execute on function public.maintenance_financial_truth(uuid[])
to authenticated;

-- Current work queue. It deliberately exposes only which facts are missing,
-- never a partial amount.
create or replace view public.financial_asset_data_quality
with (security_invoker = true)
as
select
  a.id as asset_id,
  a.asset_tag,
  a.name as asset_name,
  array_remove(array[
    case when a.purchase_cost is null then 'purchase_cost' end,
    case when a.purchase_date is null then 'purchase_date' end,
    case when a.warranty_end is null then 'warranty_end' end,
    case when a.company_id is null then 'manufacturer' end,
    case when a.model_id is null then 'model' end
  ], null)::text[] as missing_fields,
  a.updated_at
from public.assets a
where a.is_active
  and (
    a.purchase_cost is null
    or a.purchase_date is null
    or a.warranty_end is null
    or a.company_id is null
    or a.model_id is null
  );

revoke all on public.financial_asset_data_quality
from public, anon, authenticated;

create or replace function public.financial_data_quality_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_total bigint;
  v_missing_cost bigint;
  v_missing_purchase_date bigint;
  v_missing_warranty bigint;
  v_missing_manufacturer bigint;
  v_missing_model bigint;
begin
  if not public.is_financial_viewer() then
    raise exception 'financial_fields_forbidden' using errcode = '42501';
  end if;

  select
    count(*),
    count(*) filter (where a.purchase_cost is null),
    count(*) filter (where a.purchase_date is null),
    count(*) filter (where a.warranty_end is null),
    count(*) filter (where a.company_id is null),
    count(*) filter (where a.model_id is null)
  into
    v_total,
    v_missing_cost,
    v_missing_purchase_date,
    v_missing_warranty,
    v_missing_manufacturer,
    v_missing_model
  from public.assets a
  where a.is_active;

  return jsonb_build_object(
    'as_of', statement_timestamp(),
    'coverage_threshold_pct', 100,
    'total_assets', v_total,
    'missing_purchase_cost', v_missing_cost,
    'missing_purchase_date', v_missing_purchase_date,
    'missing_warranty_end', v_missing_warranty,
    'missing_manufacturer', v_missing_manufacturer,
    'missing_model', v_missing_model
  );
end
$function$;

create or replace function public.financial_data_quality_list(
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  asset_id uuid,
  asset_tag text,
  asset_name text,
  missing_fields text[],
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.is_financial_viewer() then
    raise exception 'financial_fields_forbidden' using errcode = '42501';
  end if;
  if p_limit < 1 or p_limit > 500 or p_offset < 0 then
    raise exception 'invalid_pagination' using errcode = '22023';
  end if;

  return query
  select
    q.asset_id,
    q.asset_tag,
    q.asset_name,
    q.missing_fields,
    q.updated_at
  from public.financial_asset_data_quality q
  order by q.updated_at, q.asset_id
  limit p_limit
  offset p_offset;
end
$function$;

revoke all on function public.financial_data_quality_summary()
from public, anon;
revoke all on function public.financial_data_quality_list(integer, integer)
from public, anon;
grant execute on function public.financial_data_quality_summary()
to authenticated;
grant execute on function public.financial_data_quality_list(integer, integer)
to authenticated;

commit;

-- === SOURCE: migrations/20260731133000_schema_contract_p0_complete.sql | sha256: 64e613b2aaf76814731b5d0ce093c706218cd0b665fc8518fd5b2791e4df2ee5 ===
-- Purpose: advance the application/schema compatibility ledger after all P0
-- contracts are present, so an older or partially migrated database fails closed.
-- Risk: low/additive. Existing clients receive the same JSON shape with a newer
-- version and a stricter required-signature set.
-- Rollback: forward-fix only. Do not lower the compatibility version while this
-- application build may be deployed.

begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073102,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731150000_stocktake_mvp.sql | sha256: 936dd2bb2ef27a18d8f8659585d2b58cf75055d263c79981193d5c4d9e2b0ef7 ===
-- Purpose: provide an RPC-only stocktake workflow with an immutable expected
-- snapshot, blind scan-first counting, recount/reason/review gates, atomic
-- location adjustments, append-only evidence, and read-only auditor access.
-- Risk: medium/additive. Existing draft stocktakes remain readable but cannot be
-- completed through the new workflow without a snapshot.
-- Rollback: forward-fix only. Revoke the RPCs to contain; do not drop evidence
-- tables or columns after a session has started.

begin;

alter table public.stocktakes
  add column if not exists snapshot_at timestamptz,
  add column if not exists expected_count integer not null default 0,
  add column if not exists observed_count integer not null default 0,
  add column if not exists variance_count integer not null default 0,
  add column if not exists blind_count boolean not null default true,
  add column if not exists review_state text not null default 'counting',
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.app_users(id),
  add column if not exists locked_at timestamptz,
  add column if not exists correction_of uuid references public.stocktakes(id),
  add column if not exists create_operation_id uuid;

alter table public.stocktakes
  drop constraint if exists stocktakes_review_state_check;
alter table public.stocktakes
  add constraint stocktakes_review_state_check check (
    review_state in ('counting', 'recount', 'submitted', 'approved', 'rejected')
  );
create unique index if not exists ux_stocktakes_create_operation
  on public.stocktakes(create_operation_id)
  where create_operation_id is not null;
create index if not exists ix_stocktakes_location_status
  on public.stocktakes(location_id, status, created_at desc);

alter table public.stocktake_items
  add column if not exists item_kind text not null default 'asset',
  add column if not exists is_expected boolean not null default true,
  add column if not exists expected_location_id uuid references public.locations(id),
  add column if not exists snapshot_asset_tag text,
  add column if not exists snapshot_asset_name text,
  add column if not exists snapshot_serial_number text,
  add column if not exists snapshot_rfid_tag text,
  add column if not exists observation_status text,
  add column if not exists observed_location_id uuid references public.locations(id),
  add column if not exists observed_identifier text,
  add column if not exists count_round integer not null default 1,
  add column if not exists recount_required boolean not null default false,
  add column if not exists variance_reason text,
  add column if not exists adjustment_applied boolean not null default false;

alter table public.stocktake_items
  drop constraint if exists stocktake_items_item_kind_check;
alter table public.stocktake_items
  add constraint stocktake_items_item_kind_check
  check (item_kind = 'asset');
alter table public.stocktake_items
  drop constraint if exists stocktake_items_observation_status_check;
alter table public.stocktake_items
  add constraint stocktake_items_observation_status_check check (
    observation_status is null
    or observation_status in ('found', 'missing', 'unexpected', 'wrong_location')
  );
create index if not exists ix_stocktake_items_progress
  on public.stocktake_items(stocktake_id, observation_status, scanned);

create table if not exists public.stocktake_operations (
  operation_id uuid primary key,
  stocktake_id uuid not null references public.stocktakes(id) on delete cascade,
  action text not null,
  result jsonb not null,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.stocktake_events (
  id bigint generated always as identity primary key,
  stocktake_id uuid not null references public.stocktakes(id) on delete cascade,
  event_type text not null,
  actor_type text not null default 'user',
  actor_id uuid,
  operation_id uuid,
  item_id uuid references public.stocktake_items(id) on delete set null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  source text not null default 'stocktake_rpc',
  created_at timestamptz not null default now()
);

alter table public.stocktake_operations enable row level security;
alter table public.stocktake_events enable row level security;
revoke all on public.stocktakes, public.stocktake_items,
  public.stocktake_operations, public.stocktake_events
from public, anon, authenticated;

drop policy if exists sel_auth on public.stocktakes;
drop policy if exists sel_stocktake_roles on public.stocktakes;
create policy sel_stocktake_roles on public.stocktakes
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor')
);

drop policy if exists sel_auth on public.stocktake_items;
drop policy if exists sel_stocktake_roles on public.stocktake_items;
create policy sel_stocktake_roles on public.stocktake_items
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor')
);

drop policy if exists sel_stocktake_events_roles on public.stocktake_events;
create policy sel_stocktake_events_roles on public.stocktake_events
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor')
);

grant select on public.stocktakes, public.stocktake_items, public.stocktake_events
to authenticated;

create or replace function public._stocktake_can_manage()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.is_approved()
    and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager')
    and public.current_user_has_capability('stocktake.manage');
$function$;

create or replace function public._stocktake_can_read()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.is_approved()
    and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor');
$function$;

create or replace function public._stocktake_event(
  p_stocktake_id uuid,
  p_event_type text,
  p_operation_id uuid,
  p_item_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
) returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.stocktake_events (
    stocktake_id, event_type, actor_type, actor_id, operation_id,
    item_id, before_data, after_data, reason
  ) values (
    p_stocktake_id, p_event_type, 'user', auth.uid(), p_operation_id,
    p_item_id, p_before, p_after, nullif(btrim(p_reason), '')
  );
$function$;

create or replace function public._stocktake_existing_operation(
  p_operation_id uuid,
  p_action text
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select o.result
  from public.stocktake_operations o
  where o.operation_id = p_operation_id
    and o.action = p_action;
$function$;

create or replace function public._stocktake_record_operation(
  p_operation_id uuid,
  p_stocktake_id uuid,
  p_action text,
  p_result jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.stocktake_operations (
    operation_id, stocktake_id, action, result, actor_id
  ) values (
    p_operation_id, p_stocktake_id, p_action, p_result, auth.uid()
  )
  on conflict (operation_id) do nothing;
  return p_result;
end;
$function$;

create or replace function public._stocktake_refresh_counts(p_stocktake_id uuid)
returns void
language sql
security definer
set search_path = ''
as $function$
  update public.stocktakes s
  set observed_count = q.observed_count,
      variance_count = q.variance_count
  from (
    select
      count(*) filter (where i.scanned) as observed_count,
      count(*) filter (
        where i.observation_status in ('missing', 'unexpected', 'wrong_location')
      ) as variance_count
    from public.stocktake_items i
    where i.stocktake_id = p_stocktake_id
  ) q
  where s.id = p_stocktake_id;
$function$;

create or replace function public.stocktake_create(
  p_title text,
  p_location_id uuid,
  p_operation_id uuid,
  p_correction_of uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_id uuid;
  v_code text;
  v_expected integer;
  v_prior public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'create');
  if v_existing is not null then return v_existing; end if;
  if coalesce(length(btrim(p_title)), 0) < 3 or length(p_title) > 160 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.locations l
    where l.id = p_location_id and l.is_active
  ) then
    raise exception 'location_not_found' using errcode = '22023';
  end if;
  if p_correction_of is not null then
    select * into v_prior from public.stocktakes where id = p_correction_of;
    if not found or v_prior.status <> 'completed' then
      raise exception 'completed_session_required' using errcode = '22023';
    end if;
    if v_prior.location_id is distinct from p_location_id then
      raise exception 'correction_location_mismatch' using errcode = '22023';
    end if;
  end if;

  v_id := gen_random_uuid();
  v_code := 'STK-' || upper(substr(replace(v_id::text, '-', ''), 1, 10));
  insert into public.stocktakes (
    id, code, title, location_id, status, created_by, snapshot_at,
    blind_count, review_state, correction_of, create_operation_id
  ) values (
    v_id, v_code, btrim(p_title), p_location_id, 'draft', auth.uid(), now(),
    true, 'counting', p_correction_of, p_operation_id
  );

  insert into public.stocktake_items (
    stocktake_id, asset_id, item_kind, is_expected, expected_status,
    expected_location_id, snapshot_asset_tag, snapshot_asset_name,
    snapshot_serial_number, snapshot_rfid_tag
  )
  select
    v_id, a.id, 'asset', true, a.status, a.location_id,
    a.asset_tag, a.name, a.serial_number, a.rfid_tag
  from public.assets a
  where a.is_active and a.location_id = p_location_id
  order by a.id;

  get diagnostics v_expected = row_count;
  update public.stocktakes set expected_count = v_expected where id = v_id;
  perform public._stocktake_event(
    v_id, case when p_correction_of is null then 'created' else 'correction_created' end,
    p_operation_id, null, null,
    jsonb_build_object(
      'location_id', p_location_id,
      'expected_count', v_expected,
      'correction_of', p_correction_of
    ),
    null
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', v_id, 'code', v_code, 'expected_count', v_expected
  );
  return public._stocktake_record_operation(
    p_operation_id, v_id, 'create', v_result
  );
end;
$function$;

create or replace function public.stocktake_start(
  p_stocktake_id uuid,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_row public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'start');
  if v_existing is not null then return v_existing; end if;
  select * into v_row
  from public.stocktakes where id = p_stocktake_id for update;
  if not found then raise exception 'stocktake_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'draft' or v_row.snapshot_at is null then
    raise exception 'stocktake_not_startable' using errcode = '22023';
  end if;
  update public.stocktakes
  set status = 'in_progress', started_at = now(), review_state = 'counting'
  where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'started', p_operation_id, null,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'in_progress'), null
  );
  v_result := jsonb_build_object('ok', true, 'id', p_stocktake_id);
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'start', v_result
  );
end;
$function$;

create or replace function public.stocktake_scan(
  p_stocktake_id uuid,
  p_identifier text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_asset public.assets%rowtype;
  v_asset_id uuid;
  v_item public.stocktake_items%rowtype;
  v_match_count integer;
  v_classification text;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'scan');
  if v_existing is not null then return v_existing; end if;
  if coalesce(length(btrim(p_identifier)), 0) = 0 or length(p_identifier) > 255 then
    raise exception 'invalid_identifier' using errcode = '22023';
  end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found then raise exception 'stocktake_not_found' using errcode = 'P0002'; end if;
  if v_take.status <> 'in_progress'
     or v_take.review_state not in ('counting', 'recount') then
    raise exception 'stocktake_not_countable' using errcode = '22023';
  end if;

  select count(*), min(a.id::text)::uuid
  into v_match_count, v_asset_id
  from public.assets a
  where a.is_active and (
    lower(a.asset_tag) = lower(btrim(p_identifier))
    or lower(coalesce(a.serial_number, '')) = lower(btrim(p_identifier))
    or lower(coalesce(a.rfid_tag, '')) = lower(btrim(p_identifier))
    or lower(a.qr_token) = lower(btrim(p_identifier))
  );
  if v_match_count = 0 then
    raise exception 'asset_not_found' using errcode = 'P0002';
  elsif v_match_count > 1 then
    raise exception 'identifier_ambiguous' using errcode = '21000';
  end if;
  select * into v_asset from public.assets where id = v_asset_id for update;

  select * into v_item
  from public.stocktake_items
  where stocktake_id = p_stocktake_id and asset_id = v_asset.id
  for update;

  if found then
    v_classification := case
      when v_asset.location_id is not distinct from v_take.location_id then 'found'
      else 'wrong_location'
    end;
    update public.stocktake_items
    set scanned = true,
        found = true,
        scanned_at = now(),
        scanned_by = auth.uid(),
        observed_location_id = v_take.location_id,
        observed_identifier = btrim(p_identifier),
        observation_status = v_classification,
        recount_required = false
    where id = v_item.id
    returning * into v_item;
  else
    v_classification := 'unexpected';
    insert into public.stocktake_items (
      stocktake_id, asset_id, item_kind, is_expected, expected_status,
      expected_location_id, snapshot_asset_tag, snapshot_asset_name,
      snapshot_serial_number, snapshot_rfid_tag, scanned, found,
      scanned_at, scanned_by, observed_location_id, observed_identifier,
      observation_status
    ) values (
      p_stocktake_id, v_asset.id, 'asset', false, v_asset.status,
      v_asset.location_id, v_asset.asset_tag, v_asset.name,
      v_asset.serial_number, v_asset.rfid_tag, true, true,
      now(), auth.uid(), v_take.location_id, btrim(p_identifier),
      v_classification
    )
    returning * into v_item;
  end if;

  perform public._stocktake_refresh_counts(p_stocktake_id);
  perform public._stocktake_event(
    p_stocktake_id, 'scanned', p_operation_id, v_item.id, null,
    jsonb_build_object(
      'asset_id', v_asset.id,
      'classification', v_classification,
      'count_round', v_item.count_round
    ), null
  );
  v_result := jsonb_build_object(
    'ok', true,
    'item_id', v_item.id,
    'asset_id', v_asset.id,
    'asset_tag', v_asset.asset_tag,
    'asset_name', v_asset.name,
    'classification', v_classification,
    'count_round', v_item.count_round
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'scan', v_result
  );
end;
$function$;

create or replace function public.stocktake_submit(
  p_stocktake_id uuid,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'submit');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state not in ('counting', 'recount') then
    raise exception 'stocktake_not_submittable' using errcode = '22023';
  end if;
  update public.stocktake_items
  set observation_status = 'missing',
      found = false,
      recount_required = true
  where stocktake_id = p_stocktake_id
    and is_expected and not scanned;
  perform public._stocktake_refresh_counts(p_stocktake_id);
  update public.stocktakes
  set review_state = 'submitted', submitted_at = now()
  where id = p_stocktake_id;
  select * into v_take from public.stocktakes where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'submitted', p_operation_id, null, null,
    jsonb_build_object(
      'observed_count', v_take.observed_count,
      'variance_count', v_take.variance_count
    ), null
  );
  v_result := jsonb_build_object(
    'ok', true,
    'id', p_stocktake_id,
    'observed_count', v_take.observed_count,
    'variance_count', v_take.variance_count
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'submit', v_result
  );
end;
$function$;

create or replace function public.stocktake_recount_item(
  p_stocktake_id uuid,
  p_item_id uuid,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_item public.stocktake_items%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null or coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'operation_and_reason_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'recount');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state not in ('submitted', 'recount') then
    raise exception 'stocktake_not_recountable' using errcode = '22023';
  end if;
  select * into v_item
  from public.stocktake_items
  where id = p_item_id and stocktake_id = p_stocktake_id
  for update;
  if not found or v_item.observation_status not in (
    'missing', 'unexpected', 'wrong_location'
  ) then
    raise exception 'variance_item_required' using errcode = '22023';
  end if;
  update public.stocktake_items
  set scanned = false,
      found = null,
      scanned_at = null,
      scanned_by = null,
      observed_location_id = null,
      observed_identifier = null,
      observation_status = null,
      count_round = count_round + 1,
      recount_required = true,
      variance_reason = btrim(p_reason)
  where id = p_item_id
  returning * into v_item;
  update public.stocktakes set review_state = 'recount' where id = p_stocktake_id;
  perform public._stocktake_refresh_counts(p_stocktake_id);
  perform public._stocktake_event(
    p_stocktake_id, 'recount_requested', p_operation_id, p_item_id, null,
    jsonb_build_object('count_round', v_item.count_round), p_reason
  );
  v_result := jsonb_build_object(
    'ok', true, 'item_id', p_item_id, 'count_round', v_item.count_round
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'recount', v_result
  );
end;
$function$;

create or replace function public.stocktake_set_variance_reason(
  p_stocktake_id uuid,
  p_item_id uuid,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_item public.stocktake_items%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null or coalesce(length(btrim(p_reason)), 0) < 3
     or length(p_reason) > 1000 then
    raise exception 'operation_and_reason_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'reason');
  if v_existing is not null then return v_existing; end if;
  if not exists (
    select 1 from public.stocktakes s
    where s.id = p_stocktake_id
      and s.status = 'in_progress'
      and s.review_state in ('submitted', 'recount')
  ) then
    raise exception 'stocktake_not_reviewable' using errcode = '22023';
  end if;
  update public.stocktake_items
  set variance_reason = btrim(p_reason)
  where id = p_item_id
    and stocktake_id = p_stocktake_id
    and observation_status in ('missing', 'unexpected', 'wrong_location')
  returning * into v_item;
  if not found then
    raise exception 'variance_item_required' using errcode = '22023';
  end if;
  perform public._stocktake_event(
    p_stocktake_id, 'variance_reasoned', p_operation_id, p_item_id,
    null, jsonb_build_object('classification', v_item.observation_status), p_reason
  );
  v_result := jsonb_build_object('ok', true, 'item_id', p_item_id);
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'reason', v_result
  );
end;
$function$;

create or replace function public.stocktake_review(
  p_stocktake_id uuid,
  p_decision text,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null
     or p_decision not in ('approved', 'rejected')
     or coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'invalid_review' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'review');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state <> 'submitted' then
    raise exception 'stocktake_not_reviewable' using errcode = '22023';
  end if;
  if v_take.created_by = auth.uid() then
    raise exception 'independent_reviewer_required' using errcode = '42501';
  end if;
  if p_decision = 'approved' and exists (
    select 1 from public.stocktake_items i
    where i.stocktake_id = p_stocktake_id
      and i.observation_status in ('missing', 'unexpected', 'wrong_location')
      and (
        i.count_round < 2
        or coalesce(length(btrim(i.variance_reason)), 0) < 3
      )
  ) then
    raise exception 'recount_and_reason_required' using errcode = '22023';
  end if;
  update public.stocktakes
  set review_state = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'reviewed', p_operation_id, null,
    jsonb_build_object('review_state', v_take.review_state),
    jsonb_build_object('review_state', p_decision), p_reason
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', p_stocktake_id, 'decision', p_decision
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'review', v_result
  );
end;
$function$;

create or replace function public.stocktake_apply_adjustments(
  p_stocktake_id uuid,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_asset public.assets%rowtype;
  v_applied integer := 0;
  v_result jsonb;
  r record;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'apply');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state <> 'approved' then
    raise exception 'approved_stocktake_required' using errcode = '22023';
  end if;
  if v_take.created_by = auth.uid() then
    raise exception 'independent_adjuster_required' using errcode = '42501';
  end if;

  for r in
    select i.*
    from public.stocktake_items i
    where i.stocktake_id = p_stocktake_id
      and i.observation_status in ('unexpected', 'wrong_location')
      and not i.adjustment_applied
    order by i.asset_id
  loop
    select * into v_asset from public.assets where id = r.asset_id for update;
    if v_asset.location_id is distinct from v_take.location_id then
      update public.assets
      set location_id = v_take.location_id
      where id = r.asset_id;
      insert into public.asset_movements (
        asset_id, movement_type, from_status, to_status,
        from_location_id, to_location_id, performed_by, note
      ) values (
        r.asset_id, 'transfer', v_asset.status, v_asset.status,
        v_asset.location_id, v_take.location_id, auth.uid(),
        'Stocktake ' || v_take.code || ': ' || r.variance_reason
      );
      v_applied := v_applied + 1;
    end if;
    update public.stocktake_items
    set adjustment_applied = true
    where id = r.id;
  end loop;

  update public.stocktakes
  set status = 'completed', completed_at = now(), locked_at = now()
  where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'completed', p_operation_id, null, null,
    jsonb_build_object(
      'adjustments_applied', v_applied,
      'missing_not_adjusted', (
        select count(*) from public.stocktake_items i
        where i.stocktake_id = p_stocktake_id
          and i.observation_status = 'missing'
      )
    ), 'Approved observed-location adjustments only'
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', p_stocktake_id, 'adjustments_applied', v_applied
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'apply', v_result
  );
end;
$function$;

create or replace function public.stocktake_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public._stocktake_can_read() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'code', s.code,
      'title', s.title,
      'location_id', s.location_id,
      'location_name', l.name,
      'status', s.status,
      'review_state', s.review_state,
      'snapshot_at', s.snapshot_at,
      'started_at', s.started_at,
      'submitted_at', s.submitted_at,
      'completed_at', s.completed_at,
      'expected_count', s.expected_count,
      'observed_count', s.observed_count,
      'variance_count', s.variance_count,
      'correction_of', s.correction_of,
      'created_by', s.created_by
    ) order by s.created_at desc)
    from public.stocktakes s
    left join public.locations l on l.id = s.location_id
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.stocktake_detail(p_stocktake_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_take public.stocktakes%rowtype;
  v_hide_expected boolean;
begin
  if not public._stocktake_can_read() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_take from public.stocktakes where id = p_stocktake_id;
  if not found then raise exception 'stocktake_not_found' using errcode = 'P0002'; end if;
  v_hide_expected := v_take.blind_count
    and v_take.review_state in ('counting', 'recount');
  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_take.id,
      'code', v_take.code,
      'title', v_take.title,
      'location_id', v_take.location_id,
      'status', v_take.status,
      'review_state', v_take.review_state,
      'snapshot_at', v_take.snapshot_at,
      'expected_count', v_take.expected_count,
      'observed_count', v_take.observed_count,
      'variance_count', v_take.variance_count,
      'blind_count', v_take.blind_count,
      'correction_of', v_take.correction_of,
      'created_by', v_take.created_by,
      'reviewed_by', v_take.reviewed_by
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'asset_id', i.asset_id,
        'asset_tag', i.snapshot_asset_tag,
        'asset_name', i.snapshot_asset_name,
        'is_expected', i.is_expected,
        'scanned', i.scanned,
        'classification', i.observation_status,
        'count_round', i.count_round,
        'recount_required', i.recount_required,
        'variance_reason', i.variance_reason,
        'adjustment_applied', i.adjustment_applied,
        'observed_at', i.scanned_at
      ) order by i.scanned_at nulls last, i.snapshot_asset_tag)
      from public.stocktake_items i
      where i.stocktake_id = p_stocktake_id
        and (not v_hide_expected or i.scanned)
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_type', e.event_type,
        'actor_id', e.actor_id,
        'item_id', e.item_id,
        'reason', e.reason,
        'created_at', e.created_at
      ) order by e.created_at, e.id)
      from public.stocktake_events e
      where e.stocktake_id = p_stocktake_id
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public._stocktake_can_manage() from public, anon, authenticated;
revoke all on function public._stocktake_can_read() from public, anon, authenticated;
revoke all on function public._stocktake_event(uuid,text,uuid,uuid,jsonb,jsonb,text)
from public, anon, authenticated;
revoke all on function public._stocktake_existing_operation(uuid,text)
from public, anon, authenticated;
revoke all on function public._stocktake_record_operation(uuid,uuid,text,jsonb)
from public, anon, authenticated;
revoke all on function public._stocktake_refresh_counts(uuid)
from public, anon, authenticated;

revoke all on function public.stocktake_create(text,uuid,uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_start(uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_scan(uuid,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_submit(uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_recount_item(uuid,uuid,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_set_variance_reason(uuid,uuid,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_review(uuid,text,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_apply_adjustments(uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_list()
from public, anon, authenticated;
revoke all on function public.stocktake_detail(uuid)
from public, anon, authenticated;

grant execute on function public.stocktake_create(text,uuid,uuid,uuid)
to authenticated;
grant execute on function public.stocktake_start(uuid,uuid)
to authenticated;
grant execute on function public.stocktake_scan(uuid,text,uuid)
to authenticated;
grant execute on function public.stocktake_submit(uuid,uuid)
to authenticated;
grant execute on function public.stocktake_recount_item(uuid,uuid,text,uuid)
to authenticated;
grant execute on function public.stocktake_set_variance_reason(uuid,uuid,text,uuid)
to authenticated;
grant execute on function public.stocktake_review(uuid,text,text,uuid)
to authenticated;
grant execute on function public.stocktake_apply_adjustments(uuid,uuid)
to authenticated;
grant execute on function public.stocktake_list()
to authenticated;
grant execute on function public.stocktake_detail(uuid)
to authenticated;

comment on function public.stocktake_detail(uuid) is
  'Non-financial stocktake projection. Blind sessions omit unobserved expected rows until submission.';
comment on function public.stocktake_apply_adjustments(uuid,uuid) is
  'Atomically moves only positively observed wrong-location/unexpected assets; missing assets are never guessed.';

commit;

-- === SOURCE: migrations/20260731151000_schema_contract_stocktake.sql | sha256: 63c8ab7adcfba74df82caf62b7b239c6b3834ebfeeb9ca7a5a451a696f7562c8 ===
-- Purpose: prevent this application build from opening the Stocktake surface
-- against a database that lacks the complete RPC workflow.
-- Risk: low/additive compatibility-ledger update only.
-- Rollback: forward-fix only; do not lower the version while this app is deployed.

begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073103,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()',
    'public.stocktake_create(text,uuid,uuid,uuid)',
    'public.stocktake_scan(uuid,text,uuid)',
    'public.stocktake_submit(uuid,uuid)',
    'public.stocktake_review(uuid,text,text,uuid)',
    'public.stocktake_apply_adjustments(uuid,uuid)'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731160000_employee_self_service.sql | sha256: 704f9d59046b790b07288c1dce9db188d8575c7ba968b99b011541f1bc2f0de0 ===
begin;

-- P1-04: real employee self-service boundary.
-- Employee identities are approved staff identities linked explicitly to an
-- active employees row. No RPC in this boundary creates or guesses that link.

insert into public.roles (key, name, name_ar, description, is_system)
values (
  'employee',
  'Employee',
  'موظف',
  'Self-service employee with access only to their own requests and custody.',
  true
)
on conflict (key) do update
set name = excluded.name,
    name_ar = excluded.name_ar,
    description = excluded.description,
    is_system = true;

insert into public.permissions (key, grp, description) values
  ('request.self.create', 'employee_self_service', 'Create an own employee request'),
  ('request.self.read', 'employee_self_service', 'Read own employee requests'),
  ('request.self.reply', 'employee_self_service', 'Reply to clarification on an own request'),
  ('custody.self.read', 'employee_self_service', 'Read own active and historical custody'),
  ('maintenance.self.report', 'employee_self_service', 'Report an issue on an own assigned asset'),
  ('custody.self.return_request', 'employee_self_service', 'Request return of an own assigned asset')
-- The legacy permissions table has an UPDATE trigger that assumes an
-- `updated_at` field which it does not own. Preserve pre-existing labels
-- rather than firing that incompatible trigger; newly required capabilities
-- are still inserted exactly once.
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.key in (
  'request.self.create',
  'request.self.read',
  'request.self.reply',
  'custody.self.read',
  'maintenance.self.report',
  'custody.self.return_request'
)
where r.key = 'employee'
on conflict do nothing;

create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
  select u.employee_id
  from public.app_users u
  join public.roles r on r.id = u.role_id
  join public.employees e on e.id = u.employee_id
  where u.id = auth.uid()
    and u.is_active
    and u.approval_status = 'approved'
    and r.key = 'employee'
    and e.is_active
$function$;

revoke all on function public.current_employee_id() from public, anon;
grant execute on function public.current_employee_id() to authenticated;

-- Existing permissive policies exposed all rows to every approved identity.
-- Replace them so employee access is self-scoped at the row boundary. Other
-- staff roles retain the established behavior.
drop policy if exists sel_auth on public.assets;
create policy sel_auth on public.assets
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.assets;
create policy sel_employee_self on public.assets
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and assigned_to_employee_id = public.current_employee_id()
);

drop policy if exists sel_auth on public.asset_assignments;
create policy sel_auth on public.asset_assignments
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.asset_assignments;
create policy sel_employee_self on public.asset_assignments
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and employee_id = public.current_employee_id()
);

drop policy if exists sel_auth on public.employees;
create policy sel_auth on public.employees
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.employees;
create policy sel_employee_self on public.employees
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and id = public.current_employee_id()
);

drop policy if exists sel_auth on public.requests;
create policy sel_auth on public.requests
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.requests;
create policy sel_employee_self on public.requests
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and beneficiary_type = 'employee'
  and beneficiary_employee_id = public.current_employee_id()
);

drop policy if exists sel_auth on public.request_items;
create policy sel_auth on public.request_items
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.request_items;
create policy sel_employee_self on public.request_items
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and exists (
    select 1
    from public.requests r
    where r.id = request_items.request_id
      and r.beneficiary_type = 'employee'
      and r.beneficiary_employee_id = public.current_employee_id()
  )
);

drop policy if exists sel_auth on public.request_events;
create policy sel_auth on public.request_events
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.request_events;
create policy sel_employee_self on public.request_events
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and exists (
    select 1
    from public.requests r
    where r.id = request_events.request_id
      and r.beneficiary_type = 'employee'
      and r.beneficiary_employee_id = public.current_employee_id()
  )
);

drop policy if exists sel_auth on public.maintenance_records;
create policy sel_auth on public.maintenance_records
for select to authenticated
using (public.is_approved() and public.app_user_role() <> 'employee');
drop policy if exists sel_employee_self on public.maintenance_records;
create policy sel_employee_self on public.maintenance_records
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and exists (
    select 1
    from public.assets a
    where a.id = maintenance_records.asset_id
      and a.assigned_to_employee_id = public.current_employee_id()
  )
);

-- Employee self-service does not include catalogs, customers, locations,
-- inventory balances, movements, purchasing, or organization directories.
-- These are direct Data API boundaries, independent of the navigation UI.
do $policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'asset_movements',
    'asset_pools',
    'categories',
    'companies',
    'consumable_transactions',
    'consumables',
    'customers',
    'departments',
    'depreciation_rules',
    'locations',
    'models',
    'notification_settings',
    'suppliers'
  ]
  loop
    if to_regclass('public.' || v_table) is not null then
      execute format('drop policy if exists sel_auth on public.%I', v_table);
      execute format(
        'create policy sel_auth on public.%I for select to authenticated using (public.is_approved() and public.app_user_role() <> %L)',
        v_table,
        'employee'
      );
    end if;
  end loop;
end
$policies$;

create table if not exists public.employee_asset_return_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  asset_id uuid not null references public.assets(id),
  assignment_id uuid not null references public.asset_assignments(id),
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'acknowledged', 'completed', 'rejected')),
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  resolved_by uuid null references auth.users(id),
  resolved_at timestamptz null,
  resolution_note text null,
  operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requested_by, operation_id)
);
create unique index if not exists uq_employee_asset_return_pending
  on public.employee_asset_return_requests(employee_id, asset_id)
  where status in ('pending', 'acknowledged');
create index if not exists idx_employee_asset_return_employee
  on public.employee_asset_return_requests(employee_id, requested_at desc);

alter table public.employee_asset_return_requests enable row level security;
revoke all on public.employee_asset_return_requests from public, anon, authenticated;
grant select on public.employee_asset_return_requests to authenticated;
grant select, insert, update, delete on public.employee_asset_return_requests to service_role;

drop policy if exists sel_employee_self on public.employee_asset_return_requests;
create policy sel_employee_self on public.employee_asset_return_requests
for select to authenticated
using (
  public.app_user_role() = 'employee'
  and employee_id = public.current_employee_id()
  and requested_by = auth.uid()
);
drop policy if exists sel_employee_ops on public.employee_asset_return_requests;
create policy sel_employee_ops on public.employee_asset_return_requests
for select to authenticated
using (
  public.app_user_role() in ('admin', 'it_manager', 'technician', 'warehouse_manager', 'auditor')
);

create table if not exists public.employee_self_operations (
  user_id uuid not null references auth.users(id),
  operation_id uuid not null,
  operation_type text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id, operation_type)
);
alter table public.employee_self_operations enable row level security;
revoke all on public.employee_self_operations from public, anon, authenticated;
grant select, insert, update, delete on public.employee_self_operations to service_role;

create or replace function public.request_create_employee_self(
  p_status text,
  p_project_name text,
  p_pickup_date date,
  p_return_date date,
  p_notes text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_request_id uuid;
  v_item jsonb;
  v_quantity numeric;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('request.self.create') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'employee_link_required');
  end if;
  if p_status is null or btrim(p_status) not in ('draft', 'under_review') then
    return jsonb_build_object('ok', false, 'error', 'invalid_initial_status');
  end if;
  if p_pickup_date is not null and p_return_date is not null
     and p_return_date < p_pickup_date then
    return jsonb_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'items_required');
  end if;
  if jsonb_array_length(p_items) > 50 then
    return jsonb_build_object('ok', false, 'error', 'too_many_items');
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or v_item ?| array[
         'asset_id', 'serial_number', 'qr_token', 'rfid_tag', 'asset_tag',
         'consumable_id', 'preferred_company_id', 'preferred_model',
         'unit_price', 'total_price', 'approved_quantity',
         'delivered_quantity', 'returned_quantity', 'needs_purchase',
         'beneficiary_employee_id', 'customer_id'
       ] then
      return jsonb_build_object('ok', false, 'error', 'server_fields_forbidden');
    end if;
    if coalesce(nullif(btrim(v_item->>'item_kind'), ''), 'custom') <> 'custom'
       or nullif(btrim(v_item->>'requested_description'), '') is null
       or jsonb_typeof(v_item->'quantity') <> 'number' then
      return jsonb_build_object('ok', false, 'error', 'invalid_item');
    end if;
    v_quantity := (v_item->>'quantity')::numeric;
    if v_quantity <= 0 or v_quantity > 1000 or v_quantity <> trunc(v_quantity) then
      return jsonb_build_object('ok', false, 'error', 'invalid_quantity');
    end if;
  end loop;

  insert into public.requests (
    status, request_type, beneficiary_type, beneficiary_employee_id,
    customer_id, submitted_by, created_by, request_source, project_name,
    pickup_date, return_date, notes, portal_approval_status
  ) values (
    btrim(p_status), 'internal', 'employee', v_employee_id,
    null, v_uid, v_uid, 'internal', nullif(btrim(p_project_name), ''),
    p_pickup_date, p_return_date, nullif(btrim(p_notes), ''), 'not_required'
  )
  returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    insert into public.request_items (
      request_id, item_kind, quantity, notes, requested_kind,
      requested_description, requested_category, accept_alternative,
      needs_purchase
    ) values (
      v_request_id, 'custom', (v_item->>'quantity')::numeric,
      nullif(btrim(v_item->>'notes'), ''), 'existing_asset',
      nullif(btrim(v_item->>'requested_description'), ''),
      nullif(btrim(v_item->>'requested_category'), ''),
      coalesce((v_item->>'accept_alternative')::boolean, true), false
    );
  end loop;

  perform public._request_add_event(
    v_request_id,
    'employee_request_created',
    'staff',
    null,
    jsonb_build_object('actor_scope', 'employee')
  );
  return jsonb_build_object('ok', true, 'id', v_request_id);
end
$function$;

create or replace function public.employee_my_requests()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() <> 'employee'
      or not public.current_user_has_capability('request.self.read')
      or public.current_employee_id() is null
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'request_number', r.request_number,
        'status', r.status,
        'project_name', r.project_name,
        'pickup_date', r.pickup_date,
        'return_date', r.return_date,
        'notes', r.notes,
        'created_at', r.created_at,
        'updated_at', r.updated_at,
        'item_count', (
          select count(*) from public.request_items ri where ri.request_id = r.id
        )
      ) order by r.created_at desc)
      from public.requests r
      where r.beneficiary_type = 'employee'
        and r.beneficiary_employee_id = public.current_employee_id()
    ), '[]'::jsonb)
  end
$function$;

create or replace function public.employee_my_request(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_employee_id uuid := public.current_employee_id();
  v_result jsonb;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('request.self.read')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select jsonb_build_object(
    'ok', true,
    'request', jsonb_build_object(
      'id', r.id,
      'request_number', r.request_number,
      'status', r.status,
      'project_name', r.project_name,
      'pickup_date', r.pickup_date,
      'return_date', r.return_date,
      'notes', r.notes,
      'created_at', r.created_at,
      'updated_at', r.updated_at
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id,
        'quantity', ri.quantity,
        'requested_description', ri.requested_description,
        'requested_category', ri.requested_category,
        'notes', ri.notes
      ) order by ri.created_at)
      from public.request_items ri where ri.request_id = r.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', re.id,
        'event_type', re.event_type,
        'message', re.message,
        'created_at', re.created_at
      ) order by re.created_at)
      from public.request_events re where re.request_id = r.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.requests r
  where r.id = p_request_id
    and r.beneficiary_type = 'employee'
    and r.beneficiary_employee_id = v_employee_id;

  return coalesce(v_result, jsonb_build_object('ok', false, 'error', 'not_found'));
end
$function$;

create or replace function public.employee_reply_request_clarification(
  p_request_id uuid,
  p_message text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_existing jsonb;
  v_result jsonb;
  v_request public.requests%rowtype;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('request.self.reply')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or nullif(btrim(p_message), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  select result into v_existing
  from public.employee_self_operations
  where user_id = v_uid
    and operation_id = p_operation_id
    and operation_type = 'clarification_reply';
  if found then return v_existing; end if;

  select * into v_request
  from public.requests
  where id = p_request_id
    and beneficiary_type = 'employee'
    and beneficiary_employee_id = v_employee_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_request.status <> 'needs_clarification' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;

  update public.requests set status = 'under_review' where id = p_request_id;
  perform public._request_add_event(
    p_request_id,
    'clarification_reply',
    'staff',
    btrim(p_message),
    jsonb_build_object('actor_scope', 'employee')
  );
  v_result := jsonb_build_object('ok', true, 'id', p_request_id);
  insert into public.employee_self_operations(user_id, operation_id, operation_type, result)
  values (v_uid, p_operation_id, 'clarification_reply', v_result);
  return v_result;
end
$function$;

create or replace function public.employee_my_assets()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() <> 'employee'
      or not public.current_user_has_capability('custody.self.read')
      or public.current_employee_id() is null
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'asset_id', a.id,
        'asset_tag', a.asset_tag,
        'name', a.name,
        'status', a.status,
        'condition_grade', a.condition_grade,
        'assigned_at', aa.assigned_at,
        'due_return_date', aa.due_return_date,
        'assignment_status', aa.status,
        'return_requested', exists (
          select 1 from public.employee_asset_return_requests rr
          where rr.assignment_id = aa.id
            and rr.status in ('pending', 'acknowledged')
        ),
        'open_issue_count', (
          select count(*) from public.maintenance_records mr
          where mr.asset_id = a.id and mr.status not in ('completed', 'cancelled')
        )
      ) order by aa.assigned_at desc)
      from public.asset_assignments aa
      join public.assets a on a.id = aa.asset_id
      where aa.employee_id = public.current_employee_id()
        and aa.status = 'active'
        and a.assigned_to_employee_id = public.current_employee_id()
    ), '[]'::jsonb)
  end
$function$;

create or replace function public.employee_report_asset_issue(
  p_asset_id uuid,
  p_description text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_existing jsonb;
  v_result jsonb;
  v_record_id uuid;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('maintenance.self.report')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or nullif(btrim(p_description), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  select result into v_existing
  from public.employee_self_operations
  where user_id = v_uid
    and operation_id = p_operation_id
    and operation_type = 'asset_issue';
  if found then return v_existing; end if;

  perform 1
  from public.assets a
  join public.asset_assignments aa
    on aa.asset_id = a.id and aa.employee_id = v_employee_id and aa.status = 'active'
  where a.id = p_asset_id
    and a.assigned_to_employee_id = v_employee_id
  for update of a;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.maintenance_records (
    asset_id, type, status, reported_by, reported_by_employee_id,
    problem_description, priority, problem_type, workflow_stage,
    cost, currency
  ) values (
    p_asset_id, 'corrective', 'open', v_uid, v_employee_id,
    btrim(p_description), 'normal', 'employee_reported', 'reported',
    0, 'SAR'
  )
  returning id into v_record_id;

  v_result := jsonb_build_object('ok', true, 'id', v_record_id);
  insert into public.employee_self_operations(user_id, operation_id, operation_type, result)
  values (v_uid, p_operation_id, 'asset_issue', v_result);
  return v_result;
end
$function$;

create or replace function public.employee_request_asset_return(
  p_asset_id uuid,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_employee_id uuid := public.current_employee_id();
  v_assignment_id uuid;
  v_existing jsonb;
  v_result jsonb;
  v_return_id uuid;
begin
  if public.app_user_role() <> 'employee'
     or not public.current_user_has_capability('custody.self.return_request')
     or v_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_operation_id is null or nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  select result into v_existing
  from public.employee_self_operations
  where user_id = v_uid
    and operation_id = p_operation_id
    and operation_type = 'asset_return_request';
  if found then return v_existing; end if;

  select aa.id into v_assignment_id
  from public.asset_assignments aa
  join public.assets a on a.id = aa.asset_id
  where aa.asset_id = p_asset_id
    and aa.employee_id = v_employee_id
    and aa.status = 'active'
    and a.assigned_to_employee_id = v_employee_id
  for update of aa;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if exists (
    select 1 from public.employee_asset_return_requests rr
    where rr.assignment_id = v_assignment_id
      and rr.status in ('pending', 'acknowledged')
  ) then
    return jsonb_build_object('ok', false, 'error', 'already_requested');
  end if;

  insert into public.employee_asset_return_requests (
    employee_id, asset_id, assignment_id, reason, requested_by, operation_id
  ) values (
    v_employee_id, p_asset_id, v_assignment_id, btrim(p_reason), v_uid, p_operation_id
  )
  returning id into v_return_id;

  v_result := jsonb_build_object('ok', true, 'id', v_return_id);
  insert into public.employee_self_operations(user_id, operation_id, operation_type, result)
  values (v_uid, p_operation_id, 'asset_return_request', v_result);
  return v_result;
end
$function$;

create or replace function public.employee_my_return_requests()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() <> 'employee'
      or not public.current_user_has_capability('custody.self.read')
      or public.current_employee_id() is null
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rr.id,
        'asset_id', rr.asset_id,
        'asset_tag', a.asset_tag,
        'asset_name', a.name,
        'reason', rr.reason,
        'status', rr.status,
        'requested_at', rr.requested_at,
        'resolution_note', rr.resolution_note,
        'resolved_at', rr.resolved_at
      ) order by rr.requested_at desc)
      from public.employee_asset_return_requests rr
      join public.assets a on a.id = rr.asset_id
      where rr.employee_id = public.current_employee_id()
        and rr.requested_by = auth.uid()
    ), '[]'::jsonb)
  end
$function$;

revoke all on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) from public, anon;
revoke all on function public.employee_my_requests() from public, anon;
revoke all on function public.employee_my_request(uuid) from public, anon;
revoke all on function public.employee_reply_request_clarification(uuid, text, uuid) from public, anon;
revoke all on function public.employee_my_assets() from public, anon;
revoke all on function public.employee_report_asset_issue(uuid, text, uuid) from public, anon;
revoke all on function public.employee_request_asset_return(uuid, text, uuid) from public, anon;
revoke all on function public.employee_my_return_requests() from public, anon;

grant execute on function public.request_create_employee_self(
  text, text, date, date, text, jsonb
) to authenticated;
grant execute on function public.employee_my_requests() to authenticated;
grant execute on function public.employee_my_request(uuid) to authenticated;
grant execute on function public.employee_reply_request_clarification(uuid, text, uuid) to authenticated;
grant execute on function public.employee_my_assets() to authenticated;
grant execute on function public.employee_report_asset_issue(uuid, text, uuid) to authenticated;
grant execute on function public.employee_request_asset_return(uuid, text, uuid) to authenticated;
grant execute on function public.employee_my_return_requests() to authenticated;

comment on function public.current_employee_id() is
  'Returns the active employee row linked to the current approved employee-role identity, otherwise null.';
comment on table public.employee_asset_return_requests is
  'Employee-initiated return intent queue. It never mutates custody; warehouse staff complete return through custody workflows.';

commit;

-- === SOURCE: migrations/20260731161000_schema_contract_employee_self_service.sql | sha256: f13c63dad22be4d3533781061d08e077227a2ef0cbbcbb19058d36f2c2008c32 ===
-- P1-04 compatibility gate: employee UI must never open against a database
-- that still has the legacy broad employee-request function.
begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073104,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()',
    'public.stocktake_create(text,uuid,uuid,uuid)',
    'public.stocktake_scan(uuid,text,uuid)',
    'public.stocktake_submit(uuid,uuid)',
    'public.stocktake_review(uuid,text,text,uuid)',
    'public.stocktake_apply_adjustments(uuid,uuid)',
    'public.employee_my_requests()',
    'public.employee_my_request(uuid)',
    'public.employee_my_assets()',
    'public.employee_reply_request_clarification(uuid,text,uuid)',
    'public.employee_report_asset_issue(uuid,text,uuid)',
    'public.employee_request_asset_return(uuid,text,uuid)'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731170000_unified_audit_ledger.sql | sha256: 33df82596928bd4baf93a5174dd97c3d94bb1c47eb0b80d507a39f4d1709308c ===
begin;

-- P1-05: unified append-only evidence for events created after this migration.
-- Historical tables are not rewritten or attributed retroactively.

create table if not exists public.audit_events_v2 (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  actor_type text not null
    check (actor_type in ('staff', 'employee', 'portal', 'system', 'service', 'anonymous')),
  actor_id uuid null,
  system_principal text null,
  event_type text not null,
  outcome text not null default 'success'
    check (outcome in ('success', 'denied', 'failure')),
  entity_type text not null,
  entity_id text null,
  request_id uuid null references public.requests(id) on delete set null,
  before_state jsonb null,
  after_state jsonb null,
  reason text null,
  source text not null,
  correlation_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  attribution_status text not null default 'attributed'
    check (attribution_status in ('attributed', 'system_attributed', 'legacy_unattributed')),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint audit_events_v2_actor_identity check (
    (actor_type in ('staff', 'employee', 'portal') and actor_id is not null and system_principal is null)
    or
    (actor_type in ('system', 'service') and actor_id is null and system_principal is not null)
    or
    (actor_type = 'anonymous' and actor_id is null and system_principal is null)
  ),
  constraint audit_events_v2_state_shape check (
    before_state is null or jsonb_typeof(before_state) = 'object'
  ),
  constraint audit_events_v2_after_shape check (
    after_state is null or jsonb_typeof(after_state) = 'object'
  ),
  constraint audit_events_v2_metadata_shape check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists idx_audit_events_v2_entity
  on public.audit_events_v2(entity_type, entity_id, id desc);
create index if not exists idx_audit_events_v2_request
  on public.audit_events_v2(request_id, id desc)
  where request_id is not null;
create index if not exists idx_audit_events_v2_actor
  on public.audit_events_v2(actor_id, id desc)
  where actor_id is not null;
create index if not exists idx_audit_events_v2_outcome
  on public.audit_events_v2(outcome, id desc)
  where outcome <> 'success';

alter table public.audit_events_v2 enable row level security;
revoke all on public.audit_events_v2 from public, anon, authenticated;
grant select on public.audit_events_v2 to authenticated;
grant select, insert on public.audit_events_v2 to service_role;

drop policy if exists sel_audit_roles on public.audit_events_v2;
create policy sel_audit_roles on public.audit_events_v2
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'auditor')
);

create or replace function public._audit_reject_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  raise exception 'audit_events_append_only' using errcode = '42501';
end
$function$;

drop trigger if exists trg_audit_events_v2_append_only on public.audit_events_v2;
drop trigger if exists trg_audit_events_v2_append_only on public.audit_events_v2;
create trigger trg_audit_events_v2_append_only
before update or delete on public.audit_events_v2
for each row execute function public._audit_reject_mutation();

create or replace function public._audit_sanitize(p_value jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = public
as $function$
declare
  v_result jsonb;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value) = 'object' then
    select coalesce(jsonb_object_agg(
      key,
      case
        when key ~* '(secret|token|password|authorization|api[_-]?key|cookie|signature|private[_-]?key|purchase[_-]?cost|unit[_-]?cost|unit[_-]?price|total[_-]?price|invoice|email|phone|contact|customer[_-]?name|storage[_-]?path|notes?|message|description)'
          then '"[REDACTED]"'::jsonb
        else public._audit_sanitize(value)
      end
    ), '{}'::jsonb)
    into v_result
    from jsonb_each(p_value);
    return v_result;
  elsif jsonb_typeof(p_value) = 'array' then
    select coalesce(jsonb_agg(public._audit_sanitize(value)), '[]'::jsonb)
    into v_result
    from jsonb_array_elements(p_value);
    return v_result;
  elsif jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~* '(bearer[[:space:]]+|eyj[a-z0-9_-]{12,}\.|sk-[a-z0-9_-]{12,}|service[_-]?role|api[_-]?key[[:space:]]*[=:]|password[[:space:]]*[=:]|token[[:space:]]*[=:])' then
    return '"[REDACTED]"'::jsonb;
  end if;
  return p_value;
end
$function$;

create or replace function public._audit_actor_context(
  p_row jsonb default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public.app_user_role();
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), '')
  );
  v_row_actor_kind text := nullif(p_row->>'actor_kind', '');
  v_row_actor_id uuid;
begin
  begin
    v_row_actor_id := nullif(p_row->>'actor_id', '')::uuid;
  exception when invalid_text_representation then
    v_row_actor_id := null;
  end;

  if v_row_actor_kind = 'system' then
    return jsonb_build_object(
      'actor_type', 'system',
      'actor_id', null,
      'system_principal', 'request_workflow',
      'attribution_status', 'system_attributed'
    );
  elsif v_row_actor_kind = 'portal' and coalesce(v_row_actor_id, v_uid) is not null then
    return jsonb_build_object(
      'actor_type', 'portal',
      'actor_id', coalesce(v_row_actor_id, v_uid),
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_role = 'employee' and v_uid is not null then
    return jsonb_build_object(
      'actor_type', 'employee',
      'actor_id', v_uid,
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_role is not null and v_uid is not null then
    return jsonb_build_object(
      'actor_type', 'staff',
      'actor_id', v_uid,
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_uid is not null then
    return jsonb_build_object(
      'actor_type', 'portal',
      'actor_id', v_uid,
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_jwt_role = 'service_role' or current_user = 'service_role' then
    return jsonb_build_object(
      'actor_type', 'service',
      'actor_id', null,
      'system_principal', 'supabase_service_role',
      'attribution_status', 'system_attributed'
    );
  end if;
  return jsonb_build_object(
    'actor_type', 'system',
    'actor_id', null,
    'system_principal', 'database_internal',
    'attribution_status', 'system_attributed'
  );
end
$function$;

-- Internal writer. It is inaccessible over the Data API.
create or replace function public._audit_write(
  p_event_type text,
  p_outcome text,
  p_entity_type text,
  p_entity_id text,
  p_request_id uuid,
  p_before_state jsonb,
  p_after_state jsonb,
  p_reason text,
  p_source text,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_row jsonb default null,
  p_system_principal text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor jsonb := public._audit_actor_context(p_actor_row);
  v_event_id uuid;
begin
  if p_event_type is null or btrim(p_event_type) = ''
     or p_entity_type is null or btrim(p_entity_type) = ''
     or p_source is null or btrim(p_source) = '' then
    raise exception 'invalid_audit_event';
  end if;
  if p_outcome not in ('success', 'denied', 'failure') then
    raise exception 'invalid_audit_outcome';
  end if;

  if p_system_principal is not null then
    v_actor := jsonb_build_object(
      'actor_type', 'system',
      'actor_id', null,
      'system_principal', p_system_principal,
      'attribution_status', 'system_attributed'
    );
  end if;

  insert into public.audit_events_v2 (
    actor_type,
    actor_id,
    system_principal,
    event_type,
    outcome,
    entity_type,
    entity_id,
    request_id,
    before_state,
    after_state,
    reason,
    source,
    correlation_id,
    metadata,
    attribution_status
  ) values (
    v_actor->>'actor_type',
    nullif(v_actor->>'actor_id', '')::uuid,
    nullif(v_actor->>'system_principal', ''),
    btrim(p_event_type),
    p_outcome,
    btrim(p_entity_type),
    nullif(btrim(p_entity_id), ''),
    p_request_id,
    public._audit_sanitize(p_before_state),
    public._audit_sanitize(p_after_state),
    case
      when nullif(btrim(p_reason), '') is null then null
      else public._audit_sanitize(to_jsonb(p_reason)) #>> '{}'
    end,
    btrim(p_source),
    case
      when nullif(coalesce(p_metadata, '{}'::jsonb)->>'correlation_id', '') is null then null
      when (p_metadata->>'correlation_id') ~* '^[0-9a-f-]{36}$'
        then (p_metadata->>'correlation_id')::uuid
      else null
    end,
    public._audit_sanitize(coalesce(p_metadata, '{}'::jsonb) - 'correlation_id'),
    v_actor->>'attribution_status'
  )
  returning event_id into v_event_id;
  return v_event_id;
end
$function$;

create or replace function public._audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_row jsonb := coalesce(v_new, v_old);
  v_entity_id text := coalesce(v_row->>'id', v_row->>'event_id');
  v_request_id uuid;
  v_reason text := coalesce(
    nullif(v_row->>'reason', ''),
    nullif(v_row->>'rejection_reason', ''),
    nullif(v_row->>'resolution_note', '')
  );
begin
  begin
    if tg_table_name = 'requests' then
      v_request_id := nullif(v_row->>'id', '')::uuid;
    elsif v_row ? 'request_id' then
      v_request_id := nullif(v_row->>'request_id', '')::uuid;
    end if;
  exception when invalid_text_representation then
    v_request_id := null;
  end;

  perform public._audit_write(
    lower(tg_op),
    'success',
    tg_table_name,
    v_entity_id,
    v_request_id,
    v_old,
    v_new,
    v_reason,
    'database_trigger:' || tg_table_name,
    jsonb_build_object('schema', tg_table_schema),
    v_row,
    null
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

do $triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'requests',
    'request_items',
    'request_events',
    'request_attachments',
    'assets',
    'asset_assignments',
    'asset_movements',
    'maintenance_records',
    'attachments',
    'consumable_transactions',
    'purchase_requests',
    'purchase_request_items',
    'stocktakes',
    'stocktake_items',
    'stocktake_events',
    'custody_reconciliation_cases',
    'employee_asset_return_requests',
    'role_permissions',
    'user_permissions'
  ]
  loop
    if to_regclass('public.' || v_table) is not null then
      execute format('drop trigger if exists trg_unified_audit on public.%I', v_table);
      execute format(
        'create trigger trg_unified_audit after insert or update or delete on public.%I for each row execute function public._audit_row_change()',
        v_table
      );
    end if;
  end loop;
end
$triggers$;

-- Explicit denied-event writer used by high-risk authorization administration.
create or replace function public._audit_capability_denial(
  p_event_type text,
  p_entity_type text,
  p_entity_id text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  perform public._audit_write(
    p_event_type,
    'denied',
    p_entity_type,
    p_entity_id,
    null,
    null,
    null,
    p_reason,
    'rpc:authorization_admin',
    '{}'::jsonb,
    null,
    null
  );
end
$function$;

create or replace function public.set_role_capability(
  p_role_key text,
  p_key text,
  p_allowed boolean
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_caller text := public.app_user_role();
  v_role uuid;
  v_perm uuid;
begin
  if v_caller is null or v_caller <> 'admin' then
    perform public._audit_capability_denial(
      'role_capability_change_attempt',
      'role',
      p_role_key,
      'not_authorized'
    );
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id into v_role from public.roles where key = p_role_key;
  select id into v_perm from public.permissions where key = p_key;
  if v_role is null or v_perm is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  delete from public.role_permissions
  where role_id = v_role and permission_id = v_perm;
  if p_allowed then
    insert into public.role_permissions(role_id, permission_id)
    values (v_role, v_perm);
  end if;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.set_user_capability(
  p_user uuid,
  p_key text,
  p_state text
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_caller text := public.app_user_role();
  v_perm uuid;
  v_target_role text;
begin
  if v_caller is null or v_caller <> 'admin' then
    perform public._audit_capability_denial(
      'user_capability_change_attempt',
      'app_user',
      p_user::text,
      'not_authorized'
    );
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user = auth.uid() then
    perform public._audit_capability_denial(
      'user_capability_change_attempt',
      'app_user',
      p_user::text,
      'cannot_modify_self'
    );
    return json_build_object('ok', false, 'error', 'cannot_modify_self');
  end if;
  if p_state not in ('allow', 'deny', 'inherit') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  select r.key into v_target_role
  from public.app_users u
  join public.roles r on r.id = u.role_id
  where u.id = p_user;
  if v_target_role = 'admin' then
    perform public._audit_capability_denial(
      'user_capability_change_attempt',
      'app_user',
      p_user::text,
      'cannot_modify_admin'
    );
    return json_build_object('ok', false, 'error', 'cannot_modify_admin');
  end if;
  select id into v_perm from public.permissions where key = p_key;
  if v_perm is null then return json_build_object('ok', false, 'error', 'not_found'); end if;

  delete from public.user_permissions
  where user_id = p_user and permission_id = v_perm;
  if p_state = 'allow' then
    insert into public.user_permissions(user_id, permission_id, allow)
    values (p_user, v_perm, true);
  elsif p_state = 'deny' then
    insert into public.user_permissions(user_id, permission_id, allow)
    values (p_user, v_perm, false);
  end if;
  return json_build_object('ok', true);
end
$function$;

-- Read-only request evidence. Financial values, storage paths, customer PII,
-- secrets, and tokens are deliberately absent.
create or replace function public.audit_request_evidence(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_role text := public.app_user_role();
  v_result jsonb;
begin
  if v_role not in ('admin', 'it_manager', 'auditor') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select jsonb_build_object(
    'ok', true,
    'request', jsonb_build_object(
      'id', r.id,
      'request_number', r.request_number,
      'request_type', r.request_type,
      'beneficiary_type', r.beneficiary_type,
      'beneficiary_employee_id', r.beneficiary_employee_id,
      'status', r.status,
      'pickup_date', r.pickup_date,
      'return_date', r.return_date,
      'created_at', r.created_at,
      'updated_at', r.updated_at
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id,
        'item_kind', ri.item_kind,
        'asset_id', ri.asset_id,
        'consumable_id', ri.consumable_id,
        'quantity', ri.quantity,
        'approved_quantity', ri.approved_quantity,
        'delivered_quantity', ri.delivered_quantity,
        'returned_quantity', ri.returned_quantity,
        'requested_description', ri.requested_description,
        'needs_purchase', ri.needs_purchase,
        'created_at', ri.created_at
      ) order by ri.created_at, ri.id)
      from public.request_items ri where ri.request_id = r.id
    ), '[]'::jsonb),
    'approvals', jsonb_build_object(
      'approved_by', r.approved_by,
      'approved_at', r.approved_at,
      'rejected_by', r.rejected_by,
      'rejected_at', r.rejected_at,
      'rejection_reason', public._audit_sanitize(to_jsonb(r.rejection_reason)) #>> '{}',
      'portal_approval_status', r.portal_approval_status,
      'portal_approved_by', r.portal_approved_by,
      'portal_approved_at', r.portal_approved_at,
      'portal_rejected_by', r.portal_rejected_by,
      'portal_rejected_at', r.portal_rejected_at,
      'portal_rejection_reason', public._audit_sanitize(to_jsonb(r.portal_rejection_reason)) #>> '{}'
    ),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', am.id,
        'asset_id', am.asset_id,
        'movement_type', am.movement_type,
        'from_status', am.from_status,
        'to_status', am.to_status,
        'from_location_id', am.from_location_id,
        'to_location_id', am.to_location_id,
        'from_employee_id', am.from_employee_id,
        'to_employee_id', am.to_employee_id,
        'performed_by', am.performed_by,
        'created_at', am.created_at
      ) order by am.created_at, am.id)
      from public.asset_movements am
      where am.asset_id in (
        select ri.asset_id from public.request_items ri
        where ri.request_id = r.id and ri.asset_id is not null
      )
    ), '[]'::jsonb),
    'custody', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', aa.id,
        'asset_id', aa.asset_id,
        'employee_id', aa.employee_id,
        'assigned_by', aa.assigned_by,
        'assigned_at', aa.assigned_at,
        'due_return_date', aa.due_return_date,
        'returned_at', aa.returned_at,
        'return_condition', aa.return_condition,
        'status', aa.status
      ) order by aa.assigned_at, aa.id)
      from public.asset_assignments aa
      where aa.asset_id in (
        select ri.asset_id from public.request_items ri
        where ri.request_id = r.id and ri.asset_id is not null
      )
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ra.id,
        'uploaded_by_kind', ra.uploaded_by_kind,
        'uploaded_by', ra.uploaded_by,
        'visible_to_customer', ra.visible_to_customer,
        'file_name', ra.file_name,
        'mime_type', ra.mime_type,
        'size_bytes', ra.size_bytes,
        'created_at', ra.created_at
      ) order by ra.created_at, ra.id)
      from public.request_attachments ra where ra.request_id = r.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', re.id,
        'event_type', re.event_type,
        'actor_type', re.actor_kind,
        'actor_id', re.actor_id,
        'message', public._audit_sanitize(to_jsonb(re.message)) #>> '{}',
        'metadata', public._audit_sanitize(re.metadata),
        'timestamp', re.created_at,
        'attribution_status', case
          when re.actor_id is null and re.actor_kind <> 'system'
            then 'legacy_unattributed'
          when re.actor_kind = 'system' then 'system_attributed'
          else 'attributed'
        end,
        'source', 'legacy:request_events'
      ) order by re.created_at, re.id)
      from public.request_events re where re.request_id = r.id
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_id', ae.event_id,
        'actor_type', ae.actor_type,
        'actor_id', ae.actor_id,
        'system_principal', ae.system_principal,
        'event_type', ae.event_type,
        'outcome', ae.outcome,
        'entity_type', ae.entity_type,
        'entity_id', ae.entity_id,
        'before', ae.before_state,
        'after', ae.after_state,
        'reason', ae.reason,
        'source', ae.source,
        'timestamp', ae.occurred_at,
        'attribution_status', ae.attribution_status
      ) order by ae.id)
      from public.audit_events_v2 ae
      where ae.request_id = r.id
         or (ae.entity_type = 'requests' and ae.entity_id = r.id::text)
    ), '[]'::jsonb)
  )
  into v_result
  from public.requests r
  where r.id = p_request_id;

  return coalesce(v_result, jsonb_build_object('ok', false, 'error', 'not_found'));
end
$function$;

create or replace function public.audit_legacy_events(
  p_limit integer default 100,
  p_before_id bigint default null
) returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() not in ('admin', 'it_manager', 'auditor')
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(row_data order by sort_time desc, sort_id desc)
      from (
        select
          al.created_at as sort_time,
          al.id as sort_id,
          jsonb_build_object(
            'legacy_id', al.id,
            'actor_type', case when al.changed_by is null then 'anonymous' else 'staff' end,
            'actor_id', al.changed_by,
            'event_type', al.action,
            'entity_type', al.table_name,
            'entity_id', al.record_id,
            'before', public._audit_sanitize(al.old_data),
            'after', public._audit_sanitize(al.new_data),
            'source', 'legacy:audit_logs',
            'timestamp', al.created_at,
            'attribution_status', case
              when al.changed_by is null then 'legacy_unattributed'
              else 'attributed'
            end
          ) as row_data
        from public.audit_logs al
        where p_before_id is null or al.id < p_before_id
        order by al.id desc
        limit least(greatest(coalesce(p_limit, 100), 1), 500)
      ) legacy
    ), '[]'::jsonb)
  end
$function$;

revoke all on function public._audit_reject_mutation() from public, anon, authenticated;
revoke all on function public._audit_sanitize(jsonb) from public, anon, authenticated;
revoke all on function public._audit_actor_context(jsonb) from public, anon, authenticated;
revoke all on function public._audit_write(
  text, text, text, text, uuid, jsonb, jsonb, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public._audit_row_change() from public, anon, authenticated;
revoke all on function public._audit_capability_denial(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.audit_request_evidence(uuid) from public, anon;
revoke all on function public.audit_legacy_events(integer, bigint) from public, anon;
grant execute on function public.audit_request_evidence(uuid) to authenticated;
grant execute on function public.audit_legacy_events(integer, bigint) to authenticated;

revoke all on function public.set_role_capability(text, text, boolean) from public, anon;
revoke all on function public.set_user_capability(uuid, text, text) from public, anon;
grant execute on function public.set_role_capability(text, text, boolean) to authenticated;
grant execute on function public.set_user_capability(uuid, text, text) to authenticated;

comment on table public.audit_events_v2 is
  'Append-only audit ledger for post-P1-05 events. Historical records remain in their original tables.';
comment on function public.audit_request_evidence(uuid) is
  'Non-financial request evidence bundle for admin, IT manager, and read-only auditor.';

commit;

-- === SOURCE: migrations/20260731171000_schema_contract_unified_audit.sql | sha256: 2306731c342be2f56a03d911d837fec3ea24a016c51cda46b4e999eb6229b5e7 ===
begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073105,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()',
    'public.stocktake_create(text,uuid,uuid,uuid)',
    'public.stocktake_scan(uuid,text,uuid)',
    'public.stocktake_submit(uuid,uuid)',
    'public.stocktake_review(uuid,text,text,uuid)',
    'public.stocktake_apply_adjustments(uuid,uuid)',
    'public.employee_my_requests()',
    'public.employee_my_request(uuid)',
    'public.employee_my_assets()',
    'public.employee_reply_request_clarification(uuid,text,uuid)',
    'public.employee_report_asset_issue(uuid,text,uuid)',
    'public.employee_request_asset_return(uuid,text,uuid)',
    'public.audit_request_evidence(uuid)',
    'public.audit_legacy_events(integer,bigint)'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731180000_risk_based_sod_delivery_proof.sql | sha256: 5161f002a01bf1a45327853720ab3cde6e88dca9784abcd18a7bfec5480b8bc1 ===
begin;

-- P1-06: risk-based segregation of duties and delivery evidence.
-- This migration is restrictive: legacy request_deliver is no longer exposed
-- to authenticated clients. All deliveries must use the evidence wrapper.

create table if not exists public.sod_operation_policies (
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
  ('manual_inventory_adjustment', 'high', 'use_reviewed_stocktake_workflow', true, null)
on conflict (operation_type) do nothing;

alter table public.sod_operation_policies enable row level security;
revoke all on public.sod_operation_policies from public, anon, authenticated;
grant select on public.sod_operation_policies to authenticated;

drop policy if exists sod_operation_policies_audit_read on public.sod_operation_policies;
create policy sod_operation_policies_audit_read
on public.sod_operation_policies
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'auditor')
);

alter table public.requests
  add column if not exists prepared_by uuid null references public.app_users(id),
  add column if not exists prepared_at timestamptz null,
  add column if not exists second_approved_by uuid null references public.app_users(id),
  add column if not exists second_approved_at timestamptz null,
  add column if not exists second_approval_reason text null,
  add column if not exists delivered_by uuid null references public.app_users(id),
  add column if not exists delivery_proof_id uuid null,
  add column if not exists risk_level_snapshot text null,
  add column if not exists risk_reason_snapshot text null;

alter table public.requests
  drop constraint if exists requests_risk_level_snapshot_check,
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

drop trigger if exists trg_requests_sod_stamp on public.requests;
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

create table if not exists public.request_delivery_otp_challenges (
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

create table if not exists public.request_delivery_proofs (
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
  drop constraint if exists requests_delivery_proof_fk,
  add constraint requests_delivery_proof_fk
  foreign key (delivery_proof_id)
  references public.request_delivery_proofs(id);

create index if not exists idx_request_delivery_proofs_request
  on public.request_delivery_proofs(request_id, created_at desc);

alter table public.request_delivery_proofs enable row level security;
revoke all on public.request_delivery_proofs from public, anon, authenticated;
grant select on public.request_delivery_proofs to authenticated;

drop policy if exists request_delivery_proofs_staff_read on public.request_delivery_proofs;
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
  add column if not exists second_approved_by uuid null references public.app_users(id),
  add column if not exists second_approved_at timestamptz null;

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

drop trigger if exists trg_purchase_receipt_sod_guard on public.purchase_request_items;
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

drop trigger if exists trg_consumable_manual_adjustment_guard on public.consumable_transactions;
create trigger trg_consumable_manual_adjustment_guard
before insert on public.consumable_transactions
for each row execute function public._consumable_manual_adjustment_guard();

drop trigger if exists trg_unified_audit on public.request_delivery_proofs;
create trigger trg_unified_audit
after insert or update or delete on public.request_delivery_proofs
for each row execute function public._audit_row_change();

drop trigger if exists trg_unified_audit on public.sod_operation_policies;
create trigger trg_unified_audit
after insert or update or delete on public.sod_operation_policies
for each row execute function public._audit_row_change();

commit;

-- === SOURCE: migrations/20260731181000_schema_contract_sod_delivery.sql | sha256: 047f90db47916f9cd565f153514144074cb5eaa8392897fb2d3435058c79493e ===
begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073106,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()',
    'public.stocktake_create(text,uuid,uuid,uuid)',
    'public.stocktake_scan(uuid,text,uuid)',
    'public.stocktake_submit(uuid,uuid)',
    'public.stocktake_review(uuid,text,text,uuid)',
    'public.stocktake_apply_adjustments(uuid,uuid)',
    'public.employee_my_requests()',
    'public.employee_my_request(uuid)',
    'public.employee_my_assets()',
    'public.employee_reply_request_clarification(uuid,text,uuid)',
    'public.employee_report_asset_issue(uuid,text,uuid)',
    'public.employee_request_asset_return(uuid,text,uuid)',
    'public.audit_request_evidence(uuid)',
    'public.audit_legacy_events(integer,bigint)',
    'public.request_secondary_approve(uuid,text,uuid)',
    'public.request_delivery_requirements(uuid)',
    'public.request_deliver_with_proof(uuid,jsonb,uuid)',
    'public.request_delivery_create_otp_challenge(uuid,text,uuid)',
    'public.request_delivery_verify_otp(uuid,text)'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731190000_pagination_performance.sql | sha256: 52831c99cb597e4730ede8758067a073b15a2967f6cc1dbfa3f1b921273e7ac1 ===
begin;

-- Cursor query support. Each index corresponds to a list query in src/lib that
-- orders by the timestamp and UUID as a deterministic tie-breaker.
create index if not exists idx_requests_created_id_desc
  on public.requests (created_at desc, id desc);
drop index if exists public.idx_requests_created_at;
create index if not exists idx_maintenance_reported_id_desc
  on public.maintenance_records (reported_at desc, id desc);
create index if not exists idx_purchase_requests_created_id_desc
  on public.purchase_requests (created_at desc, id desc);
create index if not exists idx_action_alerts_last_seen_id_desc
  on public.action_alert_instances (last_seen_at desc, id desc);
create index if not exists idx_audit_events_v2_occurred_id_desc
  on public.audit_events_v2 (occurred_at desc, id desc);
create index if not exists idx_assets_company
  on public.assets (company_id);
create index if not exists idx_consumables_company
  on public.consumables (company_id);
create index if not exists idx_consumables_location
  on public.consumables (location_id);
create index if not exists idx_consumables_name_id
  on public.consumables (name, id);

-- KPI values are computed over the full authorized relation, never the
-- currently loaded cursor page.
create or replace function public.request_operational_counts()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with visible as (
    select r.status, r.return_date
    from public.requests r
    where public.is_approved()
      and r.portal_approval_status not in (
        'pending_project_manager',
        'rejected_by_project_manager'
      )
  )
  select jsonb_build_object(
    'total', count(*),
    'review', count(*) filter (
      where status in ('draft', 'under_review', 'needs_clarification')
    ),
    'awaiting', count(*) filter (
      where status in (
        'approved', 'auto_provisioning', 'provisioned',
        'stock_shortage', 'preparing', 'ready_for_pickup'
      )
    ),
    'out', count(*) filter (
      where status in ('delivered', 'partially_returned')
    ),
    'completed', count(*) filter (where status = 'completed'),
    'overdue', count(*) filter (
      where status = 'overdue'
         or (
           status in ('delivered', 'partially_returned')
           and return_date < current_date
         )
    )
  )
  from visible
$function$;

create or replace function public.request_filter_options()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with visible as (
    select
      r.project_city,
      r.customer_id,
      r.customer_name_snapshot,
      r.responsible_employee_id
    from public.requests r
    where public.is_approved()
      and r.portal_approval_status not in (
        'pending_project_manager',
        'rejected_by_project_manager'
      )
  )
  select jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(city order by city)
      from (
        select distinct project_city as city
        from visible
        where project_city is not null and project_city <> ''
      ) city_rows
    ), '[]'::jsonb),
    'customers', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', customer_id, 'name', customer_name)
        order by customer_name
      )
      from (
        select distinct
          v.customer_id,
          coalesce(c.name, v.customer_name_snapshot) as customer_name
        from visible v
        left join public.customers c on c.id = v.customer_id
        where v.customer_id is not null
      ) customer_rows
    ), '[]'::jsonb),
    'responsible_ids', coalesce((
      select jsonb_agg(responsible_employee_id order by responsible_employee_id)
      from (
        select distinct responsible_employee_id
        from visible
        where responsible_employee_id is not null
      ) responsible_rows
    ), '[]'::jsonb)
  )
$function$;

create or replace function public.maintenance_operational_summary()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with scoped as (
    select
      m.status,
      m.cost,
      m.cost_recorded,
      coalesce(nullif(m.currency, ''), 'SAR') as currency
    from public.maintenance_records m
    where public.is_approved()
  ),
  aggregate as (
    select
      count(*) filter (where status = 'open') as open_count,
      count(*) filter (where status = 'in_progress') as in_progress_count,
      count(*) filter (where status = 'completed') as completed_count,
      count(*) as record_count,
      count(*) filter (where cost_recorded and cost is not null) as recorded_count,
      count(distinct currency) filter (where cost_recorded and cost is not null) as currencies,
      min(currency) filter (where cost_recorded and cost is not null) as currency,
      sum(cost) filter (where cost_recorded and cost is not null) as amount
    from scoped
  )
  select jsonb_build_object(
    'open', open_count,
    'in_progress', in_progress_count,
    'completed', completed_count,
    'cost', jsonb_build_object(
      'state', case
        when not public.is_financial_viewer() then 'forbidden'
        when record_count = 0 or recorded_count <> record_count then 'missing'
        when currencies <> 1 then 'mixed_currency'
        else 'available'
      end,
      'amount', case
        when public.is_financial_viewer()
          and record_count > 0
          and recorded_count = record_count
          and currencies = 1
        then amount
        else null
      end,
      'currency', case when currencies = 1 then currency else null end,
      'coverage_pct', case
        when not public.is_financial_viewer() or record_count = 0 then 0
        else round((recorded_count::numeric / record_count::numeric) * 100, 2)
      end,
      'used_records', case
        when public.is_financial_viewer() then recorded_count else 0
      end,
      'excluded_records', case
        when public.is_financial_viewer() then record_count - recorded_count
        else record_count
      end
    )
  )
  from aggregate
$function$;

create or replace function public.action_alert_operational_counts()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'needs_action', count(*) filter (where status in ('open', 'reopened')),
    'high_severity', count(*) filter (
      where status in ('open', 'reopened')
        and severity in ('critical', 'high')
    ),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'mine', count(*) filter (
      where assigned_to = auth.uid() and status <> 'auto_resolved'
    ),
    'resolved', count(*) filter (where status = 'auto_resolved'),
    'resolved_today', count(*) filter (
      where status = 'auto_resolved'
        and auto_resolved_at::date = current_date
    )
  )
  from public.action_alert_instances
  where public.is_approved()
$function$;

revoke all on function public.request_operational_counts() from public, anon;
revoke all on function public.request_filter_options() from public, anon;
revoke all on function public.maintenance_operational_summary() from public, anon;
revoke all on function public.action_alert_operational_counts() from public, anon;
grant execute on function public.request_operational_counts() to authenticated;
grant execute on function public.request_filter_options() to authenticated;
grant execute on function public.maintenance_operational_summary() to authenticated;
grant execute on function public.action_alert_operational_counts() to authenticated;

commit;

-- === SOURCE: migrations/20260731191000_schema_contract_pagination.sql | sha256: f62ae4c5ba01a766ec5746e20235f02057b33788f421cb0829b139064ff23112 ===
begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073107,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()',
    'public.stocktake_create(text,uuid,uuid,uuid)',
    'public.stocktake_scan(uuid,text,uuid)',
    'public.stocktake_submit(uuid,uuid)',
    'public.stocktake_review(uuid,text,text,uuid)',
    'public.stocktake_apply_adjustments(uuid,uuid)',
    'public.employee_my_requests()',
    'public.employee_my_request(uuid)',
    'public.employee_my_assets()',
    'public.employee_reply_request_clarification(uuid,text,uuid)',
    'public.employee_report_asset_issue(uuid,text,uuid)',
    'public.employee_request_asset_return(uuid,text,uuid)',
    'public.audit_request_evidence(uuid)',
    'public.audit_legacy_events(integer,bigint)',
    'public.request_secondary_approve(uuid,text,uuid)',
    'public.request_delivery_requirements(uuid)',
    'public.request_deliver_with_proof(uuid,jsonb,uuid)',
    'public.request_delivery_create_otp_challenge(uuid,text,uuid)',
    'public.request_delivery_verify_otp(uuid,text)',
    'public.request_operational_counts()',
    'public.request_filter_options()',
    'public.maintenance_operational_summary()',
    'public.action_alert_operational_counts()'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731200000_auth_session_security.sql | sha256: 4873b948aabe2ca813ed4670575078401170eccd3f84b621bedf8101b5b9a379 ===
begin;

-- The baseline snapshot contains the registration_settings schema but not its
-- singleton reference row. Re-seed it on clean replay without overwriting an
-- operator's existing configuration.
insert into public.registration_settings (id, mode)
values ('main', 'closed')
on conflict (id) do nothing;
grant execute on function public.registration_status() to anon, authenticated;
grant execute on function public.validate_registration_invite(text)
  to anon, authenticated;

-- Triggers attached to auth.users are outside the public-only baseline dump.
-- Restore the signup projection on a clean replay without replacing an
-- operator-managed trigger that is already present.
do $block$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'on_auth_user_created'
      and not tgisinternal
  ) then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end
$block$;

create table if not exists public.auth_security_policy (
  singleton boolean primary key default true check (singleton),
  admin_mfa_required boolean not null default false,
  sensitive_reauth_required boolean not null default false,
  reauth_max_age_seconds integer not null default 600
    check (reauth_max_age_seconds between 60 and 3600),
  session_idle_seconds integer not null default 1800
    check (session_idle_seconds between 300 and 86400),
  session_absolute_seconds integer not null default 28800
    check (session_absolute_seconds between 900 and 604800),
  sensitive_capabilities text[] not null default array[
    'asset.delete',
    'asset.import',
    'financial.view',
    'request.approve',
    'settings.manage',
    'stocktake.manage',
    'user.manage'
  ]::text[],
  updated_at timestamptz not null default now()
);

insert into public.auth_security_policy (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.auth_security_policy enable row level security;
revoke all on public.auth_security_policy from public, anon, authenticated;
grant select, update on public.auth_security_policy to service_role;

create or replace function public._auth_current_aal()
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select case
    when coalesce(auth.jwt() ->> 'aal', '') in ('aal1', 'aal2')
      then auth.jwt() ->> 'aal'
    else 'aal1'
  end
$function$;

create or replace function public._auth_last_method_at()
returns timestamptz
language sql
stable
security definer
set search_path to ''
as $function$
  select to_timestamp(max((entry ->> 'timestamp')::bigint))
  from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) entry
  where (entry ->> 'timestamp') ~ '^[0-9]+$'
$function$;

create or replace function public.auth_recent_reauthentication(
  p_max_age_seconds integer default null
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    public._auth_last_method_at() >=
      now() - make_interval(
        secs => coalesce(
          p_max_age_seconds,
          (select reauth_max_age_seconds
           from public.auth_security_policy where singleton)
        )
      ),
    false
  )
$function$;

create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.app_users u
    left join public.roles r on r.id = u.role_id
    cross join public.auth_security_policy p
    where u.id = auth.uid()
      and u.approval_status = 'approved'
      and (
        not p.admin_mfa_required
        or coalesce(r.key, '') not in ('admin', 'it_manager')
        or public._auth_current_aal() = 'aal2'
      )
  )
$function$;

create or replace function public.app_user_role()
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select r.key
  from public.app_users u
  join public.roles r on r.id = u.role_id
  where u.id = auth.uid()
    and public.is_approved()
$function$;

create or replace function public.current_user_has_capability(p_key text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select
    public.is_approved()
    and public.has_capability(auth.uid(), p_key)
    and (
      not policy.sensitive_reauth_required
      or not (p_key = any(policy.sensitive_capabilities))
      or (
        public._auth_current_aal() = 'aal2'
        and public.auth_recent_reauthentication(policy.reauth_max_age_seconds)
      )
    )
  from public.auth_security_policy policy
  where policy.singleton
$function$;

create or replace function public.my_capabilities()
returns setof text
language sql
stable
security definer
set search_path to ''
as $function$
  select p.key
  from public.permissions p
  where public.current_user_has_capability(p.key)
$function$;

create or replace function public.auth_security_state()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role text;
  v_status text;
  v_portal boolean := public.is_portal_user();
  v_policy public.auth_security_policy%rowtype;
  v_aal text := public._auth_current_aal();
begin
  select r.key, u.approval_status
    into v_role, v_status
  from public.app_users u
  left join public.roles r on r.id = u.role_id
  where u.id = auth.uid();

  select * into v_policy
  from public.auth_security_policy
  where singleton;

  return jsonb_build_object(
    'authenticated', auth.uid() is not null,
    'subject_kind', case when v_role is not null then 'staff'
                         when v_portal then 'portal'
                         else 'unknown' end,
    'approval_status', coalesce(v_status, case when v_portal then 'approved' else 'pending' end),
    'role', v_role,
    'aal', v_aal,
    'admin_mfa_required', v_policy.admin_mfa_required,
    'needs_mfa', v_policy.admin_mfa_required
      and coalesce(v_role, '') in ('admin', 'it_manager')
      and v_aal <> 'aal2',
    'sensitive_reauth_required', v_policy.sensitive_reauth_required,
    'reauth_recent', public.auth_recent_reauthentication(v_policy.reauth_max_age_seconds),
    'reauth_max_age_seconds', v_policy.reauth_max_age_seconds,
    'session_idle_seconds', v_policy.session_idle_seconds,
    'session_absolute_seconds', v_policy.session_absolute_seconds
  );
end
$function$;

create or replace function public.record_auth_security_event(
  p_event_type text,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_allowed constant text[] := array[
    'login_succeeded',
    'logout_requested',
    'session_expired',
    'mfa_enrollment_started',
    'mfa_enrolled',
    'mfa_verified',
    'reauth_succeeded'
  ];
begin
  if auth.uid() is null or not (p_event_type = any(v_allowed)) then
    return false;
  end if;

  insert into public.audit_events_v2 (
    event_id, actor_type, actor_id, event_type, outcome,
    entity_type, entity_id, source, metadata,
    attribution_status, occurred_at
  )
  values (
    gen_random_uuid(), 'staff', auth.uid(), 'auth.' || p_event_type, 'success',
    'auth_session', auth.uid()::text, 'client_security_event',
    public._audit_sanitize(
      jsonb_build_object(
        'aal', public._auth_current_aal(),
        'client_reported', true,
        'context', coalesce(p_metadata, '{}'::jsonb)
      )
    ),
    'attributed', now()
  );
  return true;
end
$function$;

revoke all on function public._auth_current_aal() from public, anon, authenticated;
revoke all on function public._auth_last_method_at() from public, anon, authenticated;
revoke all on function public.auth_recent_reauthentication(integer) from public, anon;
revoke all on function public.auth_security_state() from public, anon;
revoke all on function public.record_auth_security_event(text, jsonb) from public, anon;
grant execute on function public.auth_recent_reauthentication(integer) to authenticated;
grant execute on function public.auth_security_state() to authenticated;
grant execute on function public.record_auth_security_event(text, jsonb) to authenticated;

commit;

-- === SOURCE: migrations/20260731201000_schema_contract_auth_security.sql | sha256: a2fa350bba556007665c445c9085e66079e8fdcd4e41a8b77b6132bc5848676c ===
begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
select
  contract_key,
  2026073108,
  required_signatures || array[
    'public.auth_security_state()',
    'public.auth_recent_reauthentication(integer)',
    'public.record_auth_security_event(text,jsonb)'
  ]::text[],
  now()
from public.app_schema_versions
where contract_key = 'itam_app'
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731210000_request_maintenance_workflow.sql | sha256: 0da1780597d1de48c56fd43d8362c50da55296a7e10246df6957f01b6b44dffb ===
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
drop policy if exists request_operation_result_self on public.request_operation_results;
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
drop policy if exists request_amendments_staff_read on public.request_amendments;
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
drop policy if exists maintenance_time_read on public.maintenance_time_entries;
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
drop policy if exists maintenance_parts_read on public.maintenance_parts;
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

-- === SOURCE: migrations/20260731211000_schema_contract_request_maintenance.sql | sha256: de3208f4d3a8602dca1fc6343c4a05f13fc715cd067ab9fc6cc7014fa28f5adc ===
begin;

insert into public.app_schema_versions (
  contract_key, compatibility_version, required_signatures, applied_at
)
select
  contract_key,
  2026073109,
  required_signatures || array[
    'public.request_create_amendment(uuid,jsonb,text,uuid)',
    'public.request_review_amendment(uuid,text,text,uuid)',
    'public.request_execute_idempotent(uuid,text,uuid,jsonb)',
    'public.request_create_idempotent(uuid,jsonb)',
    'public.request_operation_result_lookup(uuid)',
    'public.maintenance_update_safe(uuid,jsonb,uuid)',
    'public.maintenance_add_time_entry(uuid,timestamp with time zone,timestamp with time zone,text,uuid)',
    'public.maintenance_plan_part(uuid,uuid,text,numeric,uuid)',
    'public.maintenance_confirm_handoff(uuid,uuid)',
    'public.maintenance_escalate_overdue()'
  ]::text[],
  now()
from public.app_schema_versions where contract_key = 'itam_app'
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260731220000_procurement_boundary.sql | sha256: bd11988332cf97898d2d358ada5a67b87f1ec89cc0cad2afd567532b7fd38352 ===
begin;

-- This is an integration boundary, not an ERP sub-ledger. The existing
-- purchase_requests aggregate remains the requisition. External PO, goods
-- receipt, invoice, and stock receipt references are separate documents.
create table if not exists public.procurement_document_refs (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  purchase_request_item_id uuid null references public.purchase_request_items(id),
  document_type text not null check (
    document_type in ('purchase_order', 'goods_receipt', 'invoice', 'stock_receipt')
  ),
  source_system text not null default 'external'
    check (length(btrim(source_system)) between 1 and 100),
  external_reference text not null
    check (length(btrim(external_reference)) between 1 and 200),
  document_status text not null default 'recorded'
    check (document_status in ('recorded', 'confirmed', 'cancelled')),
  stock_transaction_id uuid null references public.consumable_transactions(id),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  recorded_by uuid not null references auth.users(id),
  recorded_at timestamptz not null default now(),
  unique (source_system, document_type, external_reference),
  check (
    (document_type = 'stock_receipt' and stock_transaction_id is not null)
    or (document_type <> 'stock_receipt' and stock_transaction_id is null)
  )
);
create unique index if not exists uq_procurement_stock_receipt_transaction
  on public.procurement_document_refs(stock_transaction_id)
  where stock_transaction_id is not null;
create index if not exists idx_procurement_document_pr
  on public.procurement_document_refs(purchase_request_id, recorded_at desc);

create table if not exists public.procurement_integration_events (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  purchase_request_item_id uuid null references public.purchase_request_items(id),
  document_ref_id uuid null references public.procurement_document_refs(id),
  event_type text not null check (event_type in (
    'purchase_order_recorded',
    'goods_receipt_recorded',
    'goods_receipt_quantity_tracked',
    'invoice_recorded',
    'stock_receipt_posted'
  )),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  recorded_by uuid null references auth.users(id),
  occurred_at timestamptz not null default now()
);
create index if not exists idx_procurement_events_pr
  on public.procurement_integration_events(purchase_request_id, occurred_at desc);

create table if not exists public.procurement_operation_results (
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation_id)
);

alter table public.procurement_document_refs enable row level security;
alter table public.procurement_integration_events enable row level security;
alter table public.procurement_operation_results enable row level security;
revoke all on public.procurement_document_refs from public, anon, authenticated;
revoke all on public.procurement_integration_events from public, anon, authenticated;
revoke all on public.procurement_operation_results from public, anon, authenticated;
grant select on public.procurement_document_refs to authenticated;
grant select on public.procurement_integration_events to authenticated;
grant select on public.procurement_operation_results to authenticated;

drop policy if exists procurement_documents_read on public.procurement_document_refs;
create policy procurement_documents_read
on public.procurement_document_refs for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() <> 'employee'
  and (document_type <> 'invoice' or public.is_financial_viewer())
);
drop policy if exists procurement_events_read on public.procurement_integration_events;
create policy procurement_events_read
on public.procurement_integration_events for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() <> 'employee'
  and (
    event_type <> 'invoice_recorded'
    or public.is_financial_viewer()
  )
);
drop policy if exists procurement_operation_self on public.procurement_operation_results;
create policy procurement_operation_self
on public.procurement_operation_results for select to authenticated
using (
  actor_id = auth.uid()
  and public.is_approved()
  and public.app_user_role() <> 'employee'
);

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
set search_path to ''
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
begin
  if (
       not public.current_user_has_capability('purchase.manage')
       and public.app_user_role() <> 'warehouse_manager'
     )
     or p_operation_id is null
     or p_document_type not in (
       'purchase_order', 'goods_receipt', 'invoice', 'stock_receipt'
     )
     or coalesce(nullif(btrim(p_source_system), ''), '') = ''
     or coalesce(nullif(btrim(p_external_reference), ''), '') = ''
     or coalesce(p_document_status, 'recorded') not in (
       'recorded', 'confirmed', 'cancelled'
     )
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_document_type = 'invoice' and not public.is_financial_viewer() then
    return jsonb_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.procurement_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

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

-- Legacy received_quantity is only a goods-receipt tracking fact. Emit an
-- explicit no-stock event so downstream integrations cannot interpret it as a
-- stock ledger posting.
create or replace function public._procurement_legacy_receipt_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.received_quantity > old.received_quantity then
    insert into public.procurement_integration_events(
      purchase_request_id, purchase_request_item_id, event_type, payload, recorded_by
    ) values (
      new.purchase_request_id,
      new.id,
      'goods_receipt_quantity_tracked',
      jsonb_build_object(
        'quantity_delta', new.received_quantity - old.received_quantity,
        'tracked_total', new.received_quantity,
        'stock_effect', false,
        'semantic', 'goods_receipt_tracking_only'
      ),
      auth.uid()
    );
  end if;
  return new;
end
$function$;

drop trigger if exists trg_procurement_legacy_receipt_event
  on public.purchase_request_items;
drop trigger if exists trg_procurement_legacy_receipt_event on public.purchase_request_items;
create trigger trg_procurement_legacy_receipt_event
after update of received_quantity on public.purchase_request_items
for each row execute function public._procurement_legacy_receipt_event();

create or replace function public.purchase_request_procurement_state(
  p_purchase_request_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select case
    when not public.is_approved()
      or public.app_user_role() = 'employee' then
      jsonb_build_object('ok', false, 'error', 'not_authorized')
    when not exists (
      select 1 from public.purchase_requests where id = p_purchase_request_id
    ) then
      jsonb_build_object('ok', false, 'error', 'not_found')
    else jsonb_build_object(
      'ok', true,
      'purchase_request_id', p_purchase_request_id,
      'legacy_received_semantic', 'goods_receipt_tracking_only',
      'legacy_received_has_stock_effect', false,
      'purchase_orders', (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'purchase_order' and document_status <> 'cancelled'
      ),
      'goods_receipts', (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'goods_receipt' and document_status <> 'cancelled'
      ),
      'invoices', case when public.is_financial_viewer() then (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'invoice' and document_status <> 'cancelled'
      ) else null end,
      'stock_receipts', (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'stock_receipt' and document_status <> 'cancelled'
      )
    )
  end
$function$;

comment on column public.purchase_request_items.received_quantity is
  'Legacy goods-receipt quantity tracking only; it never posts stock. Stock changes require consumable_stock_move plus a separate stock_receipt document reference.';
comment on column public.purchase_requests.status is
  'Legacy received/partially_received statuses mean goods-receipt tracking only, never stock ledger posting.';
comment on table public.procurement_document_refs is
  'External procurement document boundary. References only; not an AP, GL, or ERP sub-ledger.';

revoke all on function public.procurement_record_external_document(
  uuid,uuid,text,text,text,text,uuid,jsonb,uuid
) from public, anon;
revoke all on function public._procurement_legacy_receipt_event()
  from public, anon, authenticated;
revoke all on function public.purchase_request_procurement_state(uuid)
  from public, anon;
grant execute on function public.procurement_record_external_document(
  uuid,uuid,text,text,text,text,uuid,jsonb,uuid
) to authenticated;
grant execute on function public.purchase_request_procurement_state(uuid)
  to authenticated;

commit;

-- === SOURCE: migrations/20260731221000_schema_contract_procurement.sql | sha256: 424464736cb33204a70b420bf3d3ebe5d1f6df662d558f37468ec01bac4dcf19 ===
begin;

insert into public.app_schema_versions (
  contract_key, compatibility_version, required_signatures, applied_at
)
select
  contract_key,
  2026073110,
  required_signatures || array[
    'public.procurement_record_external_document(uuid,uuid,text,text,text,text,uuid,jsonb,uuid)',
    'public.purchase_request_procurement_state(uuid)'
  ]::text[],
  now()
from public.app_schema_versions where contract_key = 'itam_app'
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;

-- === SOURCE: migrations/20260803070509_edit_1_request_fulfillment_simplification.sql | sha256: d3a5525125a601c32e206993ddb101725d1b472927a600aa75a4d517812e2f3c ===
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

-- === SOURCE: migrations/20260803081719_edit_1_employee_request_return_lifecycle.sql | sha256: 06b032e5e24ece1fac754184e1d1b7b3e3f6c010aae6182158d551da5049ae47 ===
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

-- === SOURCE: migrations/20260803082104_edit_1_employee_rental_delivery_state.sql | sha256: 477d419651716f224d823c6e4452d4af8f69ea73555022823325fb862969e5de ===
-- Purpose: EDIT 1 follow-up — rental employee assignments remain delivered until inspected return.
-- Security: request_deliver keeps its server-side role checks, row locks, asset assignment guard,
-- movements, and authenticated-only grant. Only the terminal status for non-sale requests changes.

begin;

CREATE OR REPLACE FUNCTION public.request_deliver(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_req public.requests%rowtype;
  v_emp public.employees%rowtype;
  v_target asset_status;
  v_uid uuid := auth.uid();
  v_asset_ids uuid[];
  v_cons_ids uuid[];
  v_cur_status asset_status;
  v_cur int;
  v_need int;
  v_next int;
  r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('approved','preparing','ready_for_pickup','provisioned') then
    return json_build_object('ok', false, 'error', 'state_not_deliverable');
  end if;
  if exists (select 1 from public.request_items where request_id = p_id and item_kind = 'custom' and coalesce(needs_purchase,false) = false) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;

  -- تحديد الحالة الهدف حسب الجهة المستفيدة (حارس فاشل-مغلق لطلب الموظف)
  if coalesce(v_req.beneficiary_type, 'customer') = 'employee' then
    if v_req.beneficiary_employee_id is null then
      return json_build_object('ok', false, 'error', 'no_beneficiary');
    end if;
    select * into v_emp from public.employees where id = v_req.beneficiary_employee_id;
    if not found or coalesce(v_emp.is_active, false) = false then
      return json_build_object('ok', false, 'error', 'beneficiary_inactive');
    end if;
    v_target := 'assigned'::asset_status;
  else
    v_target := case when v_req.request_type = 'sale' then 'sold'::asset_status else 'rented'::asset_status end;
  end if;

  select array_agg(asset_id) into v_asset_ids from public.request_items where request_id = p_id and item_kind = 'asset' and asset_id is not null;
  select array_agg(consumable_id) into v_cons_ids from public.request_items where request_id = p_id and item_kind = 'consumable' and consumable_id is not null;
  if v_asset_ids is not null then perform 1 from public.assets where id = any(v_asset_ids) order by id for update; end if;
  if v_cons_ids is not null then perform 1 from public.consumables where id = any(v_cons_ids) order by id for update; end if;

  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset'
             and (ri.quantity - coalesce(ri.delivered_quantity,0)) > 0 loop
    if r.status not in ('available','reserved') then
      return json_build_object('ok', false, 'error', 'asset_not_available');
    end if;
    -- عهدة موظف: نفس حارس asset_assign — لا عهدة نشطة قائمة على الأصل
    if v_target = 'assigned' and exists (
      select 1 from public.asset_assignments where asset_id = r.asset_id and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_assigned');
    end if;
  end loop;

  for r in select ri.consumable_id, sum(ri.quantity - coalesce(ri.delivered_quantity,0)) as need, c.quantity_on_hand as qty
           from public.request_items ri join public.consumables c on c.id = ri.consumable_id
           where ri.request_id = p_id and ri.item_kind = 'consumable'
           group by ri.consumable_id, c.quantity_on_hand loop
    if r.need > 0 and r.need > r.qty then
      return json_build_object('ok', false, 'error', 'insufficient_stock');
    end if;
  end loop;

  for r in select ri.id, ri.item_kind, ri.asset_id, ri.consumable_id, ri.quantity, ri.delivered_quantity
           from public.request_items ri where ri.request_id = p_id loop
    if coalesce(r.delivered_quantity,0) >= r.quantity then continue; end if;
    if r.item_kind = 'asset' then
      select status into v_cur_status from public.assets where id = r.asset_id;
      if v_target = 'assigned' then
        -- عهدة موظف: تعيين + سجل عهدة + حركة assign (نمط asset_assign حرفيًا)
        update public.assets set status = 'assigned', assigned_to_employee_id = v_req.beneficiary_employee_id, times_checked_out = coalesce(times_checked_out,0) + 1, last_out_at = now(), last_request_id = p_id where id = r.asset_id;
        insert into public.asset_assignments (asset_id, employee_id, due_return_date, status)
          values (r.asset_id, v_req.beneficiary_employee_id, v_req.return_date, 'active');
        insert into public.asset_movements (asset_id, movement_type, from_status, to_status, to_employee_id, performed_by, note)
          values (r.asset_id, 'assign', v_cur_status, 'assigned', v_req.beneficiary_employee_id, v_uid, 'تسليم طلب '||v_req.request_number||' (عهدة موظف)');
      else
        update public.assets set status = v_target, assigned_to_employee_id = null, times_checked_out = coalesce(times_checked_out,0) + 1, last_out_at = now(), last_request_id = p_id where id = r.asset_id;
        insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
          values (r.asset_id, 'status_change', v_cur_status, v_target, v_uid, 'تسليم طلب '||v_req.request_number||' (عميل)');
      end if;
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    elsif r.item_kind = 'consumable' then
      select quantity_on_hand into v_cur from public.consumables where id = r.consumable_id;
      v_need := (r.quantity - coalesce(r.delivered_quantity,0))::int;
      v_next := v_cur - v_need;
      insert into public.consumable_transactions (consumable_id, txn_type, quantity, previous_quantity, balance_after, reason, performed_by, related_employee_id, department_id)
        values (r.consumable_id, 'out', v_need, v_cur, v_next, 'تسليم طلب '||v_req.request_number, v_uid,
                case when v_target = 'assigned' then v_req.beneficiary_employee_id else null end,
                case when v_target = 'assigned' then v_emp.department_id else null end);
      update public.consumables set quantity_on_hand = v_next where id = r.consumable_id;
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    end if;
  end loop;

  -- يحتفظ التسليم بعهدة الموظف، ثم تمر الطلبات غير البيعية بفحص الإرجاع والإغلاق الصريح.
  update public.requests
    set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,
        delivered_at = now()
  where id = p_id;

  return json_build_object('ok', true);
end $function$;


revoke all on function public.request_deliver(uuid) from public, anon;
grant execute on function public.request_deliver(uuid) to authenticated;

commit;

-- === SOURCE: migrations/20260803083930_edit_1_return_assignment_condition_mapping.sql | sha256: a8b3a356cc3a926cae333277638563218f7b1874c8dfbdc3d9f3682c4f8ae562 ===
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

-- === SOURCE: migrations/20260803102808_edit_2_simplification.sql | sha256: 11d3624c84772b5a2c889750a680b69495a1792cf0dae57e4c72fe6f84edc411 ===
-- Edit 2: simplify customer-facing workflows, retire active use of the legacy
-- lost status, and add an idempotent, audited smart warehouse scan operation.
-- Risk: additive functions/table plus a transactional remediation of active rows.
-- Rollback: retain the audit/movement evidence; restore a prior application only
-- after an explicit data review. No records, audit rows, or enum values are dropped.
begin;

-- Keep the old enum label only because historical audit/movement columns use it.
-- Active assets cannot retain it: unresolved custody is deliberately fail-closed.
do $$
declare
  v_unsafe integer;
begin
  select count(*) into v_unsafe
  from public.assets a
  where a.status = 'lost'::public.asset_status
    and (
      exists (select 1 from public.asset_assignments aa where aa.asset_id = a.id and aa.status = 'active')
      or exists (
        select 1 from public.request_items ri
        join public.requests r on r.id = ri.request_id
        where ri.asset_id = a.id
          and r.status not in ('completed', 'cancelled', 'rejected')
          and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0)
      )
    );
  if v_unsafe > 0 then
    raise exception 'edit_2_lost_remediation_requires_custody_review:%', v_unsafe;
  end if;
end $$;

insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
select a.id, 'status_change', a.status, 'available'::public.asset_status, auth.uid(),
  'Edit 2 remediation: legacy missing status reviewed and returned to available stock'
from public.assets a
where a.status = 'lost'::public.asset_status;

update public.assets
set status = 'available'::public.asset_status,
    assigned_to_employee_id = null
where status = 'lost'::public.asset_status;

create or replace function public.asset_status_allowed(p_old public.asset_status, p_new public.asset_status)
returns boolean
language plpgsql
immutable
set search_path = public
as $function$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'available'      then p_new in ('assigned','reserved','in_maintenance','damaged','retired','rented','sold')
    when 'assigned'       then p_new in ('available','in_maintenance','damaged','retired','rented','sold')
    when 'reserved'       then p_new in ('available','assigned','in_maintenance','retired','rented','sold')
    when 'in_maintenance' then p_new in ('available','assigned','damaged','retired')
    when 'damaged'        then p_new in ('in_maintenance','retired','disposed')
    when 'retired'        then p_new in ('disposed')
    when 'rented'         then p_new in ('available','reserved','in_maintenance','damaged','retired','sold')
    when 'sold'           then p_new in ('available')
    when 'disposed'       then false
    else false
  end;
end
$function$;

-- A missing condition is never silently accepted as normal stock: it goes to
-- maintenance for authorized review, preserving the return inspection evidence.
create or replace function public.request_inspect_return(p_id uuid, p_lines jsonb)
returns json
language plpgsql
security definer
set search_path = public
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
  if v_role is null or v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return json_build_object('ok', false, 'error', 'invalid_return_inspection');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered', 'partially_returned', 'overdue') then
    return json_build_object('ok', false, 'error', 'state_not_returnable');
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_asset := nullif(v_line->>'asset_id', '')::uuid;
    v_cond := nullif(v_line->>'condition', '');
    v_notes := nullif(btrim(v_line->>'notes'), '');
    if v_asset is null or v_asset = any(v_seen) or v_cond not in ('sound', 'unsound', 'missing', 'needs_maintenance') then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
    if v_cond in ('unsound', 'missing', 'needs_maintenance') and v_notes is null then
      return json_build_object('ok', false, 'error', 'return_notes_required');
    end if;
    if not exists (select 1 from public.request_items ri where ri.request_id = p_id and ri.item_kind = 'asset' and ri.asset_id = v_asset and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0)) then
      return json_build_object('ok', false, 'error', 'invalid_return_inspection');
    end if;
    select status into v_cur from public.assets where id = v_asset for update;
    if v_cur not in ('rented', 'assigned') then return json_build_object('ok', false, 'error', 'invalid_return_inspection'); end if;
    v_seen := array_append(v_seen, v_asset);
  end loop;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_asset := (v_line->>'asset_id')::uuid;
    v_cond := v_line->>'condition';
    v_notes := nullif(btrim(v_line->>'notes'), '');
    select status into v_cur from public.assets where id = v_asset;
    v_new := case when v_cond = 'sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end;
    v_assignment_grade := case when v_cond = 'sound' then 'good' when v_cond = 'needs_maintenance' then 'fair' else 'poor' end;
    update public.assets set status = v_new, assigned_to_employee_id = null, last_return_condition = v_cond,
      last_return_at = now(), last_request_id = p_id,
      unsound_return_count = coalesce(unsound_return_count, 0) + case when v_cond in ('unsound', 'needs_maintenance') then 1 else 0 end
    where id = v_asset;
    insert into public.asset_movements(asset_id, movement_type, from_status, to_status, performed_by, note)
    values (v_asset, 'status_change', v_cur, v_new, auth.uid(), 'Request return inspection ' || v_req.request_number || ' — ' || v_cond || coalesce(' · ' || v_notes, ''));
    update public.asset_assignments set status = 'returned', returned_at = now(), return_condition = v_assignment_grade where asset_id = v_asset and status = 'active';
    if v_cond in ('unsound', 'missing', 'needs_maintenance') then
      insert into public.maintenance_records(asset_id, reported_by, problem_description)
      values (v_asset, auth.uid(), 'Returned device requires review for request ' || v_req.request_number || coalesce(' · ' || v_notes, ''));
    end if;
    update public.request_items set returned_quantity = quantity where request_id = p_id and item_kind = 'asset' and asset_id = v_asset;
    v_processed := v_processed + 1;
    if v_cond <> 'sound' then v_issues := v_issues + 1; end if;
  end loop;
  select count(*) into v_remaining from public.request_items ri where ri.request_id = p_id and ri.item_kind = 'asset' and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0);
  if v_remaining > 0 then update public.requests set status = 'partially_returned' where id = p_id;
  else update public.requests set status = 'returned', returned_at = now() where id = p_id; end if;
  perform public._request_add_event(p_id, 'inspected_return', 'staff', null, jsonb_build_object('processed', v_processed, 'issues', v_issues, 'remaining', v_remaining));
  return json_build_object('ok', true, 'processed', v_processed, 'issues', v_issues, 'remaining', v_remaining);
exception when invalid_text_representation then
  return json_build_object('ok', false, 'error', 'invalid_return_inspection');
end
$function$;
revoke all on function public.request_inspect_return(uuid, jsonb) from public, anon;
grant execute on function public.request_inspect_return(uuid, jsonb) to authenticated;

insert into public.permissions (key, grp, description)
values ('scan.warehouse_move', 'inventory', 'Move an eligible asset into or out of the warehouse by confirmed scan')
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'scan.warehouse_move'
where r.key in ('admin', 'it_manager', 'technician', 'warehouse_manager')
on conflict do nothing;

create table if not exists public.scan_warehouse_operations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  asset_id uuid not null references public.assets(id),
  action text not null check (action in ('entry', 'exit')),
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_id, operation_id)
);
alter table public.scan_warehouse_operations enable row level security;
revoke all on public.scan_warehouse_operations from public, anon, authenticated;

create or replace function public.scan_warehouse_move(p_asset_id uuid, p_action text, p_warehouse_id uuid, p_operation_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_asset public.assets%rowtype;
  v_result jsonb;
begin
  if not public.current_user_has_capability('scan.warehouse_move') then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_operation_id is null or p_action not in ('entry', 'exit') or p_warehouse_id is null then return jsonb_build_object('ok', false, 'error', 'invalid_scan_operation'); end if;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || ':' || p_operation_id::text, 0));
  select result into v_result from public.scan_warehouse_operations where actor_id = auth.uid() and operation_id = p_operation_id;
  if found then return v_result || jsonb_build_object('idempotent', true); end if;
  if not exists (select 1 from public.locations where id = p_warehouse_id) then return jsonb_build_object('ok', false, 'error', 'invalid_location'); end if;
  select * into v_asset from public.assets where id = p_asset_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'asset_not_found'); end if;
  if v_asset.status not in ('available', 'reserved') then return jsonb_build_object('ok', false, 'error', 'asset_state_blocks_movement'); end if;
  if p_action = 'entry' and v_asset.location_id = p_warehouse_id then return jsonb_build_object('ok', false, 'error', 'already_in_warehouse'); end if;
  if p_action = 'exit' and v_asset.location_id is distinct from p_warehouse_id then return jsonb_build_object('ok', false, 'error', 'not_in_warehouse'); end if;
  update public.assets set location_id = case when p_action = 'entry' then p_warehouse_id else null end where id = p_asset_id;
  insert into public.asset_movements(asset_id, movement_type, from_location_id, to_location_id, from_status, to_status, performed_by, note)
  values (p_asset_id, 'transfer', v_asset.location_id, case when p_action = 'entry' then p_warehouse_id else null end, v_asset.status, v_asset.status, auth.uid(), 'Confirmed smart warehouse scan: ' || p_action);
  v_result := jsonb_build_object('ok', true, 'asset_id', p_asset_id, 'action', p_action, 'status', v_asset.status, 'location_after', case when p_action = 'entry' then p_warehouse_id else null end);
  insert into public.scan_warehouse_operations(actor_id, operation_id, asset_id, action, result) values (auth.uid(), p_operation_id, p_asset_id, p_action, v_result);
  return v_result;
end
$function$;
revoke all on function public.scan_warehouse_move(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.scan_warehouse_move(uuid, text, uuid, uuid) to authenticated;

-- The Action Center contains only current operational queues. Legacy alerts are
-- auto-resolved by the next source-driven sync; no alert evidence is deleted.
create or replace function public.action_alerts_sync(p_candidates jsonb)
returns json language plpgsql security definer set search_path = public as $function$
declare
  v_role text := public.app_user_role(); v_keys text[]; c jsonb; v_id uuid; v_status text;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician','warehouse_manager') then return json_build_object('ok', false, 'error', 'not_allowed'); end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then return json_build_object('ok', false, 'error', 'bad_input'); end if;
  select coalesce(array_agg(x->>'stable_key'), '{}') into v_keys from jsonb_array_elements(p_candidates) x;
  for c in select * from jsonb_array_elements(p_candidates) loop
    if coalesce(c->>'stable_key','') = '' or c->>'alert_type' not in ('request_pending','request_preparing','request_ready_delivery','maint_overdue','maint_no_technician','consumable_below_threshold','stocktake_review') then continue; end if;
    select id, status into v_id, v_status from public.action_alert_instances where stable_key = c->>'stable_key';
    if v_id is null then
      insert into public.action_alert_instances (stable_key, alert_type, entity_type, entity_id, severity, metadata)
      values (c->>'stable_key', c->>'alert_type', coalesce(c->>'entity_type','general'), nullif(c->>'entity_id','')::uuid,
        case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else 'medium' end,
        jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int, 'due_at', c->'metadata'->>'due_at'))) returning id into v_id;
      insert into public.action_alert_events (alert_instance_id, event_type, actor_id) values (v_id, 'created', auth.uid());
    else
      update public.action_alert_instances set last_seen_at = now(), updated_at = now(), severity = case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else severity end,
        metadata = jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int, 'due_at', c->'metadata'->>'due_at')),
        status = case when status = 'auto_resolved' then 'reopened' else status end, reopened_at = case when status = 'auto_resolved' then now() else reopened_at end,
        auto_resolved_at = case when status = 'auto_resolved' then null else auto_resolved_at end, occurrence_count = case when status = 'auto_resolved' then occurrence_count + 1 else occurrence_count end where id = v_id;
      if v_status = 'auto_resolved' then insert into public.action_alert_events (alert_instance_id, event_type, actor_id) values (v_id, 'reopened', auth.uid()); end if;
    end if;
  end loop;
  insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
    select i.id, 'auto_resolved', auth.uid() from public.action_alert_instances i where i.status in ('open','in_progress','reopened') and not (i.stable_key = any(v_keys));
  update public.action_alert_instances set status = 'auto_resolved', auto_resolved_at = now(), updated_at = now() where status in ('open','in_progress','reopened') and not (stable_key = any(v_keys));
  return json_build_object('ok', true);
end;
$function$;
revoke all on function public.action_alerts_sync(jsonb) from public, anon;
grant execute on function public.action_alerts_sync(jsonb) to authenticated;

create or replace function public.action_alert_operational_counts()
returns jsonb language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'needs_action', count(*) filter (where status in ('open', 'reopened')),
    'high_severity', count(*) filter (where status in ('open', 'reopened') and severity in ('critical', 'high')),
    'in_progress', count(*) filter (where status = 'in_progress'),
    'mine', count(*) filter (where assigned_to = auth.uid() and status <> 'auto_resolved'),
    'resolved', count(*) filter (where status = 'auto_resolved'),
    'resolved_today', count(*) filter (where status = 'auto_resolved' and auto_resolved_at::date = current_date)
  ) from public.action_alert_instances
  where public.is_approved() and alert_type in ('request_pending','request_preparing','request_ready_delivery','maint_overdue','maint_no_technician','consumable_below_threshold','stocktake_review')
$function$;
revoke all on function public.action_alert_operational_counts() from public, anon;
grant execute on function public.action_alert_operational_counts() to authenticated;

create or replace function public.dashboard_operational_summary()
returns jsonb language sql stable security definer set search_path = public as $function$
with guard as (select public.is_approved() as allowed),
asset_counts as (select count(*) as total, count(*) filter (where status = 'available') as available, count(*) filter (where status = 'assigned') as assigned, count(*) filter (where status = 'in_maintenance') as in_maintenance, count(*) filter (where status = 'damaged') as damaged, count(*) filter (where status = 'retired') as retired from public.assets, guard where is_active and guard.allowed),
consumable_counts as (select count(*) filter (where reorder_level > 0 and quantity_on_hand <= reorder_level) as at_risk, count(*) filter (where quantity_on_hand = 0) as stockout, count(*) filter (where reorder_level <= 0) as without_threshold from public.consumables, guard where is_active and guard.allowed),
maintenance_counts as (select count(*) filter (where status in ('open','in_progress') and reported_at < now() - interval '14 days') as long_open, count(*) filter (where status in ('open','in_progress') and nullif(btrim(action_taken),'') is null and technician_id is null) as no_action, count(*) filter (where status in ('open','in_progress') and (reported_at < now() - interval '14 days' or (nullif(btrim(action_taken),'') is null and technician_id is null))) as followup from public.maintenance_records, guard where guard.allowed),
request_counts as (select count(*) filter (where status = 'under_review') as actionable, count(*) filter (where status = 'overdue' or (status in ('delivered','partially_returned') and return_date < (now() at time zone 'Asia/Riyadh')::date)) as overdue, count(*) filter (where status in ('approved','auto_provisioning','provisioned','stock_shortage','preparing')) as preparation, count(*) filter (where status = 'ready_for_pickup') as ready_delivery, count(*) filter (where status in ('delivered','partially_returned','overdue') and return_date <= (now() at time zone 'Asia/Riyadh')::date) as returns_due, count(*) filter (where status = 'returned') as returned_inspection from public.requests, guard where guard.allowed and portal_approval_status not in ('pending_project_manager','rejected_by_project_manager'))
select jsonb_build_object('assets', jsonb_build_object('total',a.total,'available',a.available,'assigned',a.assigned,'in_maintenance',a.in_maintenance,'damaged',a.damaged,'retired',a.retired), 'consumables',jsonb_build_object('at_risk',c.at_risk,'stockout',c.stockout,'without_threshold',c.without_threshold), 'maintenance',jsonb_build_object('long_open',m.long_open,'no_action',m.no_action,'followup',m.followup), 'requests',jsonb_build_object('actionable',r.actionable,'overdue',r.overdue,'preparation',r.preparation,'ready_delivery',r.ready_delivery,'returns_due',r.returns_due,'returned_inspection',r.returned_inspection)) from asset_counts a cross join consumable_counts c cross join maintenance_counts m cross join request_counts r
$function$;
revoke all on function public.dashboard_operational_summary() from public, anon;
grant execute on function public.dashboard_operational_summary() to authenticated;

commit;

-- === SOURCE: migrations/20260804103000_six_role_tasks_and_return_intake.sql | sha256: 0cb422beb482024885d1b70ce9f01dfa28349db33f6c5fcfdb65efb0fc1eb1cb ===
-- Purpose: complete the employee-return loop with a warehouse-only, idempotent
-- intake contract, and align stocktake read visibility to stocktake.manage.
-- Risk: additive tables/functions plus narrowly-scoped policy adjustment.
-- Rollback: revoke the two new function grants; retain completed-return and
-- movement/audit evidence. No existing asset, custody, or audit data is removed.

begin;

create table if not exists public.employee_return_intake_operations (
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  return_request_id uuid not null references public.employee_asset_return_requests(id),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation_id)
);
alter table public.employee_return_intake_operations enable row level security;
revoke all on public.employee_return_intake_operations from public, anon, authenticated;

create or replace function public.warehouse_employee_return_queue()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rr.id,
        'asset_id', rr.asset_id,
        'asset_tag', a.asset_tag,
        'asset_name', a.name,
        'employee_name', coalesce(e.full_name_ar, e.full_name),
        'reason', rr.reason,
        'status', rr.status,
        'requested_at', rr.requested_at
      ) order by rr.requested_at asc)
      from public.employee_asset_return_requests rr
      join public.assets a on a.id = rr.asset_id
      join public.employees e on e.id = rr.employee_id
      where rr.status in ('pending', 'acknowledged')
    ), '[]'::jsonb)
  end
$function$;

create or replace function public.warehouse_receive_employee_return(
  p_return_request_id uuid,
  p_condition text,
  p_note text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role text := public.app_user_role();
  v_actor uuid := auth.uid();
  v_return public.employee_asset_return_requests%rowtype;
  v_asset public.assets%rowtype;
  v_existing jsonb;
  v_result jsonb;
  v_next_status public.asset_status;
  v_grade text;
begin
  if v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_return_request_id is null or p_operation_id is null
    or p_condition not in ('sound', 'needs_maintenance', 'unsound') then
    return jsonb_build_object('ok', false, 'error', 'invalid_return_intake');
  end if;
  if p_condition <> 'sound' and nullif(btrim(coalesce(p_note, '')), '') is null then
    return jsonb_build_object('ok', false, 'error', 'return_notes_required');
  end if;

  select result into v_existing
  from public.employee_return_intake_operations
  where actor_id = v_actor and operation_id = p_operation_id;
  if found then return v_existing; end if;

  select * into v_return
  from public.employee_asset_return_requests
  where id = p_return_request_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_return.status not in ('pending', 'acknowledged') then
    return jsonb_build_object('ok', false, 'error', 'return_already_processed');
  end if;

  select * into v_asset from public.assets where id = v_return.asset_id for update;
  if not found or v_asset.assigned_to_employee_id is distinct from v_return.employee_id then
    return jsonb_build_object('ok', false, 'error', 'custody_mismatch');
  end if;
  perform 1 from public.asset_assignments aa
  where aa.id = v_return.assignment_id and aa.asset_id = v_return.asset_id
    and aa.employee_id = v_return.employee_id and aa.status = 'active'
  for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'custody_mismatch'); end if;

  v_next_status := case when p_condition = 'sound' then 'available'::public.asset_status else 'in_maintenance'::public.asset_status end;
  v_grade := case when p_condition = 'sound' then 'good' when p_condition = 'needs_maintenance' then 'fair' else 'poor' end;
  update public.assets
  set status = v_next_status,
      assigned_to_employee_id = null,
      last_return_condition = p_condition,
      last_return_at = now()
  where id = v_asset.id;
  update public.asset_assignments
  set status = 'returned', returned_at = now(), return_condition = v_grade
  where id = v_return.assignment_id;
  update public.employee_asset_return_requests
  set status = 'completed', resolved_by = v_actor, resolved_at = now(), resolution_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = v_return.id;
  insert into public.asset_movements(asset_id, movement_type, from_status, to_status, performed_by, note)
  values (v_asset.id, 'status_change', v_asset.status, v_next_status, v_actor,
    'Employee return intake' || case when nullif(btrim(coalesce(p_note, '')), '') is null then '' else ' · ' || btrim(p_note) end);
  if p_condition <> 'sound' then
    insert into public.maintenance_records(asset_id, reported_by, problem_description)
    values (v_asset.id, v_actor, 'Employee return intake requires maintenance' || coalesce(' · ' || nullif(btrim(p_note), ''), ''));
  end if;
  v_result := jsonb_build_object('ok', true, 'id', v_return.id, 'asset_id', v_asset.id);
  insert into public.employee_return_intake_operations(actor_id, operation_id, return_request_id, result)
  values (v_actor, p_operation_id, v_return.id, v_result);
  return v_result;
end
$function$;

revoke all on function public.warehouse_employee_return_queue() from public, anon;
revoke all on function public.warehouse_receive_employee_return(uuid, text, text, uuid) from public, anon;
grant execute on function public.warehouse_employee_return_queue() to authenticated;
grant execute on function public.warehouse_receive_employee_return(uuid, text, text, uuid) to authenticated;

do $policy$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stocktakes' and policyname = 'sel_stocktake_roles') then
    execute $sql$alter policy sel_stocktake_roles on public.stocktakes
      using (public.is_approved() and (public.app_user_role() = 'auditor' or public.current_user_has_capability('stocktake.manage')))$sql$;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stocktake_items' and policyname = 'sel_stocktake_roles') then
    execute $sql$alter policy sel_stocktake_roles on public.stocktake_items
      using (public.is_approved() and (public.app_user_role() = 'auditor' or public.current_user_has_capability('stocktake.manage')))$sql$;
  end if;
end
$policy$;

commit;

-- === SOURCE: migrations/20260805120000_edit_3_account_and_exact_asset_traceability.sql | sha256: 9cfb578bd35ce57eef7933bcb1fdcb5a190452aa9b0a2894bca4d3d80b61a0a1 ===
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

-- === SOURCE: migrations/20260806113000_edit_4_portal_availability_and_request_validation.sql | sha256: f063a4acd04e79238334ba5ce4124c5d16dd5e344650f6a70e591d48d3a8ae1c ===
-- EDIT 4: portal-safe availability and required request facts.
-- This migration is additive and transactional.  Availability is calculated
-- only in SECURITY DEFINER functions; the portal never receives asset-level
-- data, identifiers, locations, reservations, or financial information.
begin;

alter table public.request_items
  add column if not exists portal_model_id uuid references public.models(id),
  add column if not exists available_quantity_at_submission integer,
  add column if not exists shortage_quantity integer not null default 0,
  add column if not exists additional_quantity_requested boolean not null default false,
  add column if not exists availability_snapshot_at timestamptz;

alter table public.request_items
  drop constraint if exists request_items_shortage_quantity_check;
alter table public.request_items
  add constraint request_items_shortage_quantity_check check (shortage_quantity >= 0);
create index if not exists request_items_portal_model_id_idx on public.request_items(portal_model_id)
  where portal_model_id is not null;
create index if not exists request_items_consumable_open_reservation_idx
  on public.request_items(consumable_id, request_id) where consumable_id is not null;

-- The sole portal projection for a selected item.  It deliberately returns
-- just a type and aggregate ATP value after checking the authenticated
-- customer's existing catalog/category/company policy.
create or replace function public.portal_item_availability(
  p_item_type text,
  p_category_id uuid default null,
  p_model_id uuid default null,
  p_consumable_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_cid uuid := public.portal_customer_id();
  v_available integer := 0;
begin
  if v_cid is null or not (public._portal_settings(v_cid)).portal_enabled then
    return jsonb_build_object('ok', false, 'error', 'not_portal');
  end if;
  if p_item_type = 'durable' then
    if p_category_id is null or p_model_id is null or not exists (
      select 1 from public.portal_list_catalog() c
      where c.category_id = p_category_id and c.model_id = p_model_id
    ) then
      return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed');
    end if;
    select count(*)::int into v_available
    from public.assets a
    where a.category_id = p_category_id
      and a.model_id = p_model_id
      and a.is_active and a.archived_at is null
      and a.status = 'available'
      and a.assigned_to_employee_id is null
      and not exists (select 1 from public.asset_assignments aa where aa.asset_id = a.id and aa.status = 'active')
      and not exists (
        select 1 from public.request_asset_allocations ra
        where ra.asset_id = a.id and ra.state in ('selected', 'prepared', 'delivered')
      );
  elsif p_item_type = 'consumable' then
    if p_consumable_id is null or not exists (
      select 1 from public.portal_list_consumables() c where c.consumable_id = p_consumable_id
    ) then
      return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed');
    end if;
    select greatest(c.quantity_on_hand - coalesce((
      select sum(greatest(ri.quantity - coalesce(ri.delivered_quantity, 0), 0))::int
      from public.request_items ri
      join public.requests r on r.id = ri.request_id
      where ri.consumable_id = c.id
        and r.status in ('under_review', 'approved', 'auto_provisioning', 'provisioned', 'stock_shortage', 'preparing', 'ready_for_pickup')
        and r.portal_approval_status <> 'rejected_by_project_manager'
    ), 0), 0) into v_available
    from public.consumables c where c.id = p_consumable_id and c.is_active;
    if not found then return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed'); end if;
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_item_type');
  end if;
  return jsonb_build_object('ok', true, 'item_type', p_item_type, 'available_quantity', coalesce(v_available, 0));
end $function$;

-- The previous function is intentionally replaced (not overloaded) so every
-- portal client invokes the same validated submission path.
drop function if exists public.portal_add_item(uuid, text, text, text, numeric, text, boolean, boolean, uuid, text);
drop function if exists public.portal_add_item(uuid, text, text, text, numeric, text, boolean, boolean, uuid, text, uuid, uuid, boolean);
create function public.portal_add_item(
  p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text,
  p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean,
  p_preferred_company_id uuid default null, p_category_key text default null,
  p_model_id uuid default null, p_consumable_id uuid default null,
  p_additional_quantity_requested boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_req public.requests%rowtype; v_result jsonb; v_available integer; v_category text; v_category_id uuid;
begin
  if v_cid is null or v_role = 'viewer' then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_quantity is null or p_quantity < 1 or p_quantity <> floor(p_quantity) then return jsonb_build_object('ok', false, 'error', 'invalid_quantity'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid or v_req.status <> 'draft' then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_requested_kind = 'consumable' then
    select public.portal_item_availability('consumable', null, null, p_consumable_id) into v_result;
    if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
    select cat.name_ar into v_category from public.consumables c join public.categories cat on cat.id=c.category_id where c.id=p_consumable_id;
    v_available := (v_result->>'available_quantity')::int;
    if p_quantity > v_available and not coalesce(p_additional_quantity_requested, false) then return jsonb_build_object('ok', false, 'error', 'additional_quantity_acknowledgement_required'); end if;
    insert into public.request_items(request_id,item_kind,requested_kind,requested_description,requested_category,consumable_id,quantity,preferred_model,accept_alternative,needs_purchase,additional_quantity_requested)
    values(p_request_id,'consumable','consumable',nullif(btrim(p_requested_description),''),coalesce(v_category,nullif(btrim(p_requested_category),'')),p_consumable_id,p_quantity,null,false,false,coalesce(p_additional_quantity_requested,false));
  elsif p_requested_kind = 'existing_asset' then
    -- Resolve the selected model's category server-side; no client category or
    -- company value participates in the availability decision.
    if p_model_id is null then return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed'); end if;
    select m.category_id into strict v_category_id from public.models m where m.id = p_model_id;
    select public.portal_item_availability('durable', v_category_id, p_model_id, null) into v_result;
    if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
    v_available := (v_result->>'available_quantity')::int;
    if p_quantity > v_available and not coalesce(p_additional_quantity_requested, false) then return jsonb_build_object('ok', false, 'error', 'additional_quantity_acknowledgement_required'); end if;
    insert into public.request_items(request_id,item_kind,requested_kind,requested_description,requested_category,quantity,preferred_model,portal_model_id,accept_alternative,needs_purchase,additional_quantity_requested)
    values(p_request_id,'custom','existing_asset',nullif(btrim(p_requested_description),''),nullif(btrim(p_requested_category),''),p_quantity,nullif(btrim(p_preferred_model),''),p_model_id,coalesce(p_accept_alternative,true),false,coalesce(p_additional_quantity_requested,false));
  elsif p_requested_kind = 'custom' then
    if nullif(btrim(p_requested_description),'') is null then return jsonb_build_object('ok', false, 'error', 'description_required'); end if;
    insert into public.request_items(request_id,item_kind,requested_kind,requested_description,requested_category,quantity,accept_alternative,needs_purchase)
    values(p_request_id,'custom','custom',nullif(btrim(p_requested_description),''),nullif(btrim(p_requested_category),''),p_quantity,coalesce(p_accept_alternative,false),coalesce(p_needs_purchase,false));
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_kind');
  end if;
  return jsonb_build_object('ok', true);
exception when no_data_found then return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed');
end $function$;

create or replace function public.portal_create_request(
  p_project_name text, p_project_city text, p_contact_phone text, p_contact_email text,
  p_request_type text, p_pickup_date date, p_return_date date, p_notes text
) returns json language plpgsql security definer set search_path = public, pg_temp
as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_id uuid; v_phone text; v_email text; v_name text;
begin
  if v_cid is null or v_role = 'viewer' or not (public._portal_settings(v_cid)).portal_enabled then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  if nullif(btrim(p_project_name),'') is null or length(btrim(p_project_name)) > 160 then return jsonb_build_object('ok',false,'error','project_name_required'); end if;
  if nullif(btrim(p_project_city),'') is null or length(btrim(p_project_city)) > 120 then return jsonb_build_object('ok',false,'error','city_required'); end if;
  if p_pickup_date is null then return jsonb_build_object('ok',false,'error','delivery_date_required'); end if;
  if p_pickup_date < (now() at time zone 'Asia/Riyadh')::date then return jsonb_build_object('ok',false,'error','delivery_date_in_past'); end if;
  select phone into v_phone from public.customer_portal_users where id=auth.uid() and is_active;
  select email into v_email from auth.users where id=auth.uid(); select name into v_name from public.customers where id=v_cid;
  if nullif(btrim(v_phone),'') is null then return jsonb_build_object('ok',false,'error','phone_required'); end if;
  insert into public.requests(customer_id,customer_name_snapshot,contact_phone_snapshot,contact_email_snapshot,project_name,project_city,request_type,status,request_source,submitted_by,pickup_date,return_date,notes,created_by)
  values(v_cid,v_name,v_phone,v_email,btrim(p_project_name),btrim(p_project_city),'rental','draft','client_portal',auth.uid(),p_pickup_date,p_return_date,nullif(btrim(p_notes),''),auth.uid()) returning id into v_id;
  return jsonb_build_object('ok',true,'id',v_id);
end $function$;

create or replace function public.portal_submit_request(p_request_id uuid)
returns json language plpgsql security definer set search_path = public, pg_temp
as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype; v_s public.customer_portal_settings; v_line record; v_available jsonb; v_qty int; v_shortage int := 0; v_requires_return boolean;
begin
  if v_cid is null or v_role = 'viewer' then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  v_s := public._portal_settings(v_cid); if not v_s.portal_enabled then return jsonb_build_object('ok',false,'error','portal_disabled'); end if;
  select * into v_req from public.requests where id=p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid or v_req.status <> 'draft' or v_req.portal_approval_status <> 'not_required' then return jsonb_build_object('ok',false,'error','invalid_state'); end if;
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

revoke all on function public.portal_item_availability(text,uuid,uuid,uuid), public.portal_add_item(uuid,text,text,text,numeric,text,boolean,boolean,uuid,text,uuid,uuid,boolean), public.portal_create_request(text,text,text,text,text,date,date,text), public.portal_submit_request(uuid) from public, anon;
grant execute on function public.portal_item_availability(text,uuid,uuid,uuid), public.portal_add_item(uuid,text,text,text,numeric,text,boolean,boolean,uuid,text,uuid,uuid,boolean), public.portal_create_request(text,text,text,text,text,date,date,text), public.portal_submit_request(uuid) to authenticated;
commit;

-- === SOURCE: migrations/20260806160000_edit_4_inventory_scope_and_discrepancy_review.sql | sha256: 91eb3d4d9553ab35dc15398118dc931f08a33cab2c8f86bade1d25988558aec4 ===
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
drop function if exists public.stocktake_create(text,uuid,uuid,uuid,text,uuid);
create or replace function public.stocktake_create(
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

create or replace function public.stocktake_decide_item(p_stocktake_id uuid,p_item_id uuid,p_decision text,p_note text,p_operation_id uuid)
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

-- === SOURCE: migrations/20260806161000_edit_4_inventory_review_role_hardening.sql | sha256: df24aeab054df5fa46d1c0bba6c3fe5010150f159c5c00c0a32a8e0f547cdaa7 ===
-- EDIT 4 follow-up: only Managers may close a submitted physical inventory.
begin;
create or replace function public.stocktake_review(p_stocktake_id uuid,p_decision text,p_reason text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_existing jsonb; v_take public.stocktakes%rowtype; v_result jsonb;
begin
  if not public._stocktake_can_review() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_operation_id is null or p_decision <> 'rejected' or coalesce(length(btrim(p_reason)),0)<3 then raise exception 'invalid_review' using errcode='22023'; end if;
  v_existing:=public._stocktake_existing_operation(p_operation_id,'review'); if v_existing is not null then return v_existing; end if;
  select * into v_take from public.stocktakes where id=p_stocktake_id for update; if not found or v_take.status<>'in_progress' or v_take.review_state<>'submitted' then raise exception 'stocktake_not_reviewable' using errcode='22023'; end if;
  update public.stocktakes set review_state='rejected',reviewed_at=now(),reviewed_by=auth.uid() where id=p_stocktake_id;
  perform public._stocktake_event(p_stocktake_id,'reviewed',p_operation_id,null,jsonb_build_object('review_state',v_take.review_state),jsonb_build_object('review_state','rejected'),p_reason);
  v_result:=jsonb_build_object('ok',true,'id',p_stocktake_id,'decision','rejected'); return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'review',v_result);
end $function$;
revoke all on function public.stocktake_review(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.stocktake_review(uuid,text,text,uuid) to authenticated;
commit;

-- === SOURCE: migrations/20260806161100_edit_4_inventory_create_compatibility.sql | sha256: 36dc9cf3b424b0a35a12c6b933e73eca45bfda130d7d1ba4e3b454d9ed481822 ===
begin;
create function public.stocktake_create(p_title text,p_location_id uuid,p_operation_id uuid,p_correction_of uuid)
returns jsonb language sql security definer set search_path = '' as $function$
  select public.stocktake_create(p_title,p_location_id,p_operation_id,p_correction_of,'full',null);
$function$;
revoke all on function public.stocktake_create(text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.stocktake_create(text,uuid,uuid,uuid) to authenticated;
commit;

-- === SOURCE: migrations/20260808130036_fix_automation_enqueue_integer_priority.sql | sha256: d544475132a81dcc00e18e8b9d3cbdd7f46f88ba2856b67c50bcf3d5b83424a2 ===
-- Purpose: restore Staging Auth sign-up and notification triggers whose priority
-- literals are typed as integer while the internal helper accepts smallint.
-- Risk: low; adds a service-role-only compatibility overload and delegates to
-- the existing bounded smallint implementation.
-- Rollback: DROP FUNCTION public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,integer);

begin;

create or replace function public.automation_edit5_enqueue(
  p_event_key text,
  p_event_type text,
  p_recipient_id uuid,
  p_recipient_email text,
  p_recipient_role text,
  p_reference_type text,
  p_reference_id uuid,
  p_template_key text,
  p_payload jsonb,
  p_priority integer
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_priority not between -32768 and 32767 then
    raise exception 'invalid_automation_priority' using errcode = '22023';
  end if;

  return public.automation_edit5_enqueue(
    p_event_key,
    p_event_type,
    p_recipient_id,
    p_recipient_email,
    p_recipient_role,
    p_reference_type,
    p_reference_id,
    p_template_key,
    p_payload,
    p_priority::smallint
  );
end;
$function$;

revoke all on function public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,integer)
  from public, anon, authenticated;
grant execute on function public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,integer)
  to service_role;

commit;

-- === SOURCE: migrations/20260808133000_fix_exact_ready_state_transition.sql | sha256: fba68a1749c87356d5aa06b3acde00f1067110b1fba10dc7067b50b3112c4d1b ===
-- Purpose: preserve the legal approved -> preparing -> ready_for_pickup
-- transition required by the exact-allocation readiness workflow.
-- Security impact: retains the existing SECURITY DEFINER role, exact-selection,
-- and idempotent-dispatch guards; no grants, RLS policies, or data are broadened.

begin;

create or replace function public.request_confirm_ready(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to public
as $function$
declare
  v_role text := public.app_user_role();
  v_req public.requests%rowtype;
  v_bad boolean;
begin
  if v_role not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select * into v_req from public.requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('approved', 'provisioned', 'preparing') then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if exists (
    select 1 from public.request_items ri
    where ri.request_id = p_id
      and ri.item_kind = 'custom'
      and ri.requested_kind <> 'existing_asset'
      and not coalesce(ri.needs_purchase, false)
  ) then
    return jsonb_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;

  select exists(
    select 1 from public.request_items ri
    where ri.request_id = p_id
      and (ri.item_kind = 'asset' or (ri.item_kind = 'custom' and ri.requested_kind = 'existing_asset'))
      and (select count(*) from public.request_asset_allocations a
           where a.request_item_id = ri.id and a.state in ('selected', 'prepared')) <> ri.quantity
  ) into v_bad;
  if v_bad then return jsonb_build_object('ok', false, 'error', 'exact_assets_required'); end if;

  update public.request_asset_allocations
  set state = 'prepared', prepared_by = auth.uid(), prepared_at = now(), updated_at = now()
  where request_id = p_id and state = 'selected';

  -- The authoritative state machine disallows approved -> ready_for_pickup.
  -- Keep this intermediate transition explicit, including provisioned requests.
  if v_req.status <> 'preparing' then
    update public.requests set status = 'preparing' where id = p_id;
  end if;
  update public.requests
  set status = 'ready_for_pickup',
      prepared_by = coalesce(prepared_by, auth.uid()),
      prepared_at = coalesce(prepared_at, now())
  where id = p_id;

  perform public._request_add_event(p_id, 'devices_ready_confirmed', 'staff', null, jsonb_build_object('exact_assets', true));
  return jsonb_build_object('ok', true, 'status', 'ready_for_pickup');
end
$function$;

revoke all on function public.request_confirm_ready(uuid) from public, anon;
grant execute on function public.request_confirm_ready(uuid) to authenticated;

commit;

-- === SOURCE: migrations/20260808140000_fix_stocktake_snapshot_model_fields.sql | sha256: 941f5330667bbe7048a3656a2feae471c887b64200814cb856bb11ea57b75b6a ===
-- Repair stocktake snapshots after the assets model details were normalized.
-- Additive/forward-only: retain the original count and review workflow.
begin;

create or replace function public.stocktake_create(
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
  select v_id,a.id,'asset',true,a.status,a.location_id,a.asset_tag,a.name,a.serial_number,a.rfid_tag,coalesce(c.name_ar,c.name),m.brand,m.model_name
  from public.assets a left join public.categories c on c.id=a.category_id left join public.models m on m.id=a.model_id
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
    select p_stocktake_id,a.id,'asset',false,a.status,a.location_id,a.asset_tag,a.name,a.serial_number,a.rfid_tag,coalesce(c.name_ar,c.name),m.brand,m.model_name,true,true,now(),auth.uid(),v_take.location_id,btrim(p_identifier),'unexpected' from public.assets a left join public.categories c on c.id=a.category_id left join public.models m on m.id=a.model_id where a.id=v_asset.id returning * into v_item;
  end if;
  perform public._stocktake_refresh_counts(p_stocktake_id); perform public._stocktake_event(p_stocktake_id,'scanned',p_operation_id,v_item.id,null,jsonb_build_object('asset_id',v_asset.id,'classification',v_classification,'count_round',v_item.count_round),null);
  v_result:=jsonb_build_object('ok',true,'item_id',v_item.id,'asset_id',v_asset.id,'asset_tag',v_item.snapshot_asset_tag,'asset_name',v_item.snapshot_asset_name,'classification',v_classification,'count_round',v_item.count_round); return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'scan',v_result);
end $function$;

revoke all on function public.stocktake_create(text,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.stocktake_scan(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.stocktake_create(text,uuid,uuid,uuid,text,uuid) to authenticated;
grant execute on function public.stocktake_scan(uuid,text,uuid) to authenticated;

commit;

-- === SOURCE: migrations/20260808180000_revoke_trigger_guard_execute.sql | sha256: c1e65b6e6b3c67d592114e6ae76930d8b7171f403394487ccef1701ec8d2524f ===
-- Purpose: remove public RPC execution from an internal request-status trigger guard.
-- Risk: the guard is invoked only by its table trigger; no application caller should execute it directly.
-- Rollback: grant execute only to an explicitly justified role after reviewing the trigger contract.

begin;

revoke all on function public.request_exact_assets_ready_guard() from public, anon, authenticated;

commit;

-- === PRODUCTION RECONCILIATION: target table-grant convergence ===
-- Purpose: preserve the verified Staging direct-table ACL contract after the
-- Production-only source sequence. RLS remains the authorization boundary;
-- these grants only restore the Data API entrypoints that Staging exposes.
-- Risk: no data, policy, ownership, or anon privilege is changed. Each target
-- table retains its existing RLS policies and role predicates.
-- Rollback: revoke only the listed privileges after reviewing the matching
-- Staging contract; do not disable RLS or broaden anon access.

begin;

grant delete, insert, references, trigger, truncate, update
  on table public.action_alert_events, public.action_alert_instances
  to authenticated;

grant references, select, trigger, truncate, update
  on table public.purchase_request_items
  to authenticated;

grant delete, insert, references, select, trigger, truncate, update
  on table public.purchase_request_sequences
  to authenticated;

grant delete, references, trigger, truncate, update
  on table public.purchase_requests
  to authenticated;

grant delete, insert, references, trigger, truncate
  on table public.request_attachments
  to authenticated;

commit;
