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
