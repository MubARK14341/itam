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
