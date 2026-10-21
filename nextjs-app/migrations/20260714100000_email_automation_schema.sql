-- ADR-004 / ITAM Email Automation V1
-- Purpose: exactly three private automation tables plus secure enqueue/claim/freeze/result RPCs.
-- Risk: additive local-only SQL; MUST NOT be applied remotely before REMOTE TEST-MODE APPROVAL.
-- Drift rule: apply as exact reviewed SQL after backup; never use supabase db push.
-- Rollback: docs/automation/rollback-runbook.md

begin;

create table if not exists public.automation_outbox (
  id uuid primary key default gen_random_uuid(),
  logical_message_key text not null,
  event_key text not null,
  event_type text not null,
  recipient_type text not null,
  recipient_ref uuid,
  recipient_email text not null,
  reference_type text not null,
  reference_id uuid,
  template_key text not null,
  language text not null default 'ar',
  payload jsonb not null default '{}'::jsonb,
  frozen_from text,
  frozen_to text[],
  frozen_cc text[],
  frozen_bcc text[],
  frozen_reply_to text,
  frozen_subject text,
  frozen_html text,
  frozen_text text,
  snapshot_frozen_at timestamptz,
  priority smallint not null default 0,
  scheduled_for timestamptz not null default now(),
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 4,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  provider text not null default 'resend',
  provider_message_id text,
  error_code text,
  sanitized_error text,
  test_mode boolean,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_outbox_event_key_key unique (event_key),
  constraint automation_outbox_logical_key_length_check check (length(logical_message_key) between 1 and 500),
  constraint automation_outbox_event_key_length_check check (length(event_key) between 1 and 500),
  constraint automation_outbox_recipient_email_length_check check (length(recipient_email) between 3 and 320),
  constraint automation_outbox_status_check check (
    status in ('pending','processing','sent','failed','cancelled','delivery_unknown')
  ),
  constraint automation_outbox_language_check check (language in ('ar','en')),
  constraint automation_outbox_attempt_count_check check (attempt_count >= 0),
  constraint automation_outbox_max_attempts_check check (max_attempts between 1 and 10),
  constraint automation_outbox_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint automation_outbox_snapshot_check check (
    snapshot_frozen_at is null
    or (
      frozen_from is not null
      and coalesce(array_length(frozen_to, 1), 0) = 1
      and frozen_subject is not null
      and frozen_html is not null
      and frozen_text is not null
    )
  )
);

create index if not exists automation_outbox_claim_idx
  on public.automation_outbox (priority desc, next_attempt_at, scheduled_for, created_at)
  where status = 'pending';
create index if not exists automation_outbox_lock_idx
  on public.automation_outbox (locked_at)
  where status = 'processing';
create index if not exists automation_outbox_provider_message_idx
  on public.automation_outbox (provider, provider_message_id)
  where provider_message_id is not null;
create index if not exists automation_outbox_reference_idx
  on public.automation_outbox (reference_type, reference_id, created_at desc);

create index if not exists automation_assets_warranty_scan_idx
  on public.assets (warranty_end)
  where is_active and warranty_end is not null;
create index if not exists automation_maintenance_status_updated_scan_idx
  on public.maintenance_records (status, updated_at)
  where status in ('open','in_progress');
create index if not exists automation_app_users_role_recipient_idx
  on public.app_users (role_id)
  where is_active and approval_status = 'approved';

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  job text not null,
  mode text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  scanned integer not null default 0,
  enqueued integer not null default 0,
  claimed integer not null default 0,
  sent integer not null default 0,
  failed integer not null default 0,
  duplicates integer not null default 0,
  delivery_unknown integer not null default 0,
  sanitized_error text,
  worker_version text not null,
  created_at timestamptz not null default now(),
  constraint automation_runs_job_check check (job in ('scanner','sender','health')),
  constraint automation_runs_mode_check check (mode in ('scan','send','health')),
  constraint automation_runs_status_check check (status in ('running','succeeded','failed','skipped')),
  constraint automation_runs_counts_check check (
    scanned >= 0 and enqueued >= 0 and claimed >= 0 and sent >= 0
    and failed >= 0 and duplicates >= 0 and delivery_unknown >= 0
  )
);

create index if not exists automation_runs_job_started_idx
  on public.automation_runs (job, started_at desc);

create table if not exists public.automation_delivery_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text,
  provider_message_id text,
  outbox_id uuid references public.automation_outbox(id) on delete set null,
  event_type text not null,
  event_at timestamptz not null default now(),
  health_key text,
  severity text,
  sanitized_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint automation_delivery_events_identity_check check (
    provider_event_id is not null or health_key is not null
  ),
  constraint automation_delivery_events_severity_check check (
    severity is null or severity in ('info','warning','critical')
  ),
  constraint automation_delivery_events_payload_check check (
    jsonb_typeof(sanitized_payload) = 'object'
  )
);

create unique index if not exists automation_delivery_events_provider_event_uq
  on public.automation_delivery_events (provider, provider_event_id)
  where provider_event_id is not null;
create unique index if not exists automation_delivery_events_health_key_uq
  on public.automation_delivery_events (health_key)
  where health_key is not null;
create index if not exists automation_delivery_events_message_idx
  on public.automation_delivery_events (provider, provider_message_id, event_at desc)
  where provider_message_id is not null;
create index if not exists automation_delivery_events_outbox_idx
  on public.automation_delivery_events (outbox_id, event_at desc)
  where outbox_id is not null;

alter table public.automation_outbox enable row level security;
alter table public.automation_outbox force row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_runs force row level security;
alter table public.automation_delivery_events enable row level security;
alter table public.automation_delivery_events force row level security;

revoke all on table public.automation_outbox from public, anon, authenticated;
revoke all on table public.automation_runs from public, anon, authenticated;
revoke all on table public.automation_delivery_events from public, anon, authenticated;
grant all on table public.automation_outbox to service_role;
grant all on table public.automation_runs to service_role;
grant all on table public.automation_delivery_events to service_role;

create or replace function public.automation_sanitize_error(p_error text)
returns text
language sql
immutable
set search_path = public
as $function$
  select left(
    regexp_replace(
      coalesce(p_error, ''),
      '(re_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9_-]+|Bearer[[:space:]]+[^[:space:]]+|apikey[=:][^[:space:]]+|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})',
      '[redacted]',
      'gi'
    ),
    500
  );
$function$;

create or replace function public.automation_touch_outbox()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

create or replace function public.automation_payload_has_financial_field(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $function$
declare
  v_key text;
  v_child jsonb;
begin
  if p_value is null then
    return false;
  elsif jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value)
    loop
      if v_key ~* '(^|_)(cost|price|amount|currency|invoice|salvage|annual_rate|unit_cost|total_price)(_|$)'
         or public.automation_payload_has_financial_field(v_child) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value)
    loop
      if public.automation_payload_has_financial_field(v_child) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$function$;

create or replace function public.automation_guard_frozen_snapshot()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if old.snapshot_frozen_at is not null and (
    new.snapshot_frozen_at is distinct from old.snapshot_frozen_at
    or new.logical_message_key is distinct from old.logical_message_key
    or new.event_key is distinct from old.event_key
    or new.event_type is distinct from old.event_type
    or new.recipient_type is distinct from old.recipient_type
    or new.recipient_ref is distinct from old.recipient_ref
    or new.recipient_email is distinct from old.recipient_email
    or new.reference_type is distinct from old.reference_type
    or new.reference_id is distinct from old.reference_id
    or new.template_key is distinct from old.template_key
    or new.language is distinct from old.language
    or new.payload is distinct from old.payload
    or new.frozen_from is distinct from old.frozen_from
    or new.frozen_to is distinct from old.frozen_to
    or new.frozen_cc is distinct from old.frozen_cc
    or new.frozen_bcc is distinct from old.frozen_bcc
    or new.frozen_reply_to is distinct from old.frozen_reply_to
    or new.frozen_subject is distinct from old.frozen_subject
    or new.frozen_html is distinct from old.frozen_html
    or new.frozen_text is distinct from old.frozen_text
    or new.test_mode is distinct from old.test_mode
  ) then
    raise exception 'automation_snapshot_immutable' using errcode = '55000';
  end if;
  return new;
end;
$function$;

do $block$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_automation_outbox_guard_frozen'
      and tgrelid = 'public.automation_outbox'::regclass
  ) then
    create trigger trg_automation_outbox_guard_frozen
      before update on public.automation_outbox
      for each row execute function public.automation_guard_frozen_snapshot();
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_automation_outbox_touch'
      and tgrelid = 'public.automation_outbox'::regclass
  ) then
    create trigger trg_automation_outbox_touch
      before update on public.automation_outbox
      for each row execute function public.automation_touch_outbox();
  end if;
end;
$block$;

create or replace function public.automation_record_health(
  p_health_key text,
  p_event_type text,
  p_severity text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
begin
  if p_severity not in ('info','warning','critical') then
    raise exception 'invalid_health_severity' using errcode = '22023';
  end if;
  insert into public.automation_delivery_events (
    provider, event_type, event_at, health_key, severity, sanitized_payload
  ) values (
    'internal', p_event_type, now(), p_health_key, p_severity, coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (health_key) where health_key is not null
  do update set
    event_at = excluded.event_at,
    severity = excluded.severity,
    sanitized_payload = excluded.sanitized_payload
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.automation_enqueue(
  p_logical_message_key text,
  p_event_key text,
  p_event_type text,
  p_recipient_type text,
  p_recipient_ref uuid,
  p_recipient_email text,
  p_reference_type text,
  p_reference_id uuid,
  p_template_key text,
  p_language text,
  p_payload jsonb,
  p_priority smallint default 0,
  p_scheduled_for timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
  v_email text := lower(nullif(btrim(p_recipient_email), ''));
  v_existing public.automation_outbox;
begin
  if p_language not in ('ar','en') then
    raise exception 'invalid_automation_language' using errcode = '22023';
  end if;
  if length(coalesce(p_logical_message_key, '')) not between 1 and 500
     or length(coalesce(p_event_key, '')) not between 1 and 500 then
    raise exception 'invalid_automation_key_length' using errcode = '22023';
  end if;
  if public.automation_payload_has_financial_field(coalesce(p_payload, '{}'::jsonb)) then
    perform public.automation_record_health(
      'financial-payload-blocked:' || md5(p_event_key),
      'financial_payload_blocked',
      'critical',
      jsonb_build_object('event_type', p_event_type, 'reference_type', p_reference_type, 'reference_id', p_reference_id)
    );
    return null;
  end if;
  if v_email is null then
    perform public.automation_record_health(
      'missing-email:' || p_event_key,
      'missing_recipient_email',
      'critical',
      jsonb_strip_nulls(jsonb_build_object(
        'event_type', p_event_type,
        'recipient_type', p_recipient_type,
        'reference_type', p_reference_type,
        'reference_id', p_reference_id
      ))
    );
    return null;
  end if;
  insert into public.automation_outbox (
    logical_message_key, event_key, event_type,
    recipient_type, recipient_ref, recipient_email,
    reference_type, reference_id, template_key, language, payload,
    priority, scheduled_for, next_attempt_at
  ) values (
    p_logical_message_key, p_event_key, p_event_type,
    p_recipient_type, p_recipient_ref, v_email,
    p_reference_type, p_reference_id, p_template_key, p_language,
    coalesce(p_payload, '{}'::jsonb), p_priority,
    coalesce(p_scheduled_for, now()), coalesce(p_scheduled_for, now())
  )
  on conflict (event_key) do nothing
  returning id into v_id;
  if v_id is null then
    select * into v_existing
    from public.automation_outbox
    where event_key = p_event_key;

    if v_existing.logical_message_key is distinct from p_logical_message_key
       or v_existing.event_type is distinct from p_event_type
       or v_existing.recipient_type is distinct from p_recipient_type
       or v_existing.recipient_ref is distinct from p_recipient_ref
       or v_existing.recipient_email is distinct from v_email
       or v_existing.reference_type is distinct from p_reference_type
       or v_existing.reference_id is distinct from p_reference_id
       or v_existing.template_key is distinct from p_template_key
       or v_existing.language is distinct from p_language
       or v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb) then
      perform public.automation_record_health(
        'automation-event-key-conflict:' || md5(p_event_key),
        'automation_event_key_conflict',
        'critical',
        jsonb_build_object('event_type', p_event_type, 'reference_type', p_reference_type, 'reference_id', p_reference_id)
      );
    end if;
  end if;
  return v_id;
end;
$function$;

create or replace function public.automation_start_run(
  p_run_key text,
  p_job text,
  p_mode text,
  p_worker_version text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare v_id uuid;
begin
  insert into public.automation_runs (run_key, job, mode, worker_version)
  values (p_run_key, p_job, p_mode, p_worker_version)
  on conflict (run_key) do nothing
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.automation_finish_run(
  p_run_id uuid,
  p_status text,
  p_scanned integer default 0,
  p_enqueued integer default 0,
  p_claimed integer default 0,
  p_sent integer default 0,
  p_failed integer default 0,
  p_duplicates integer default 0,
  p_delivery_unknown integer default 0,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  if p_status not in ('succeeded','failed','skipped') then
    raise exception 'invalid_run_status' using errcode = '22023';
  end if;
  update public.automation_runs
  set status = p_status,
      finished_at = now(),
      scanned = greatest(coalesce(p_scanned, 0), 0),
      enqueued = greatest(coalesce(p_enqueued, 0), 0),
      claimed = greatest(coalesce(p_claimed, 0), 0),
      sent = greatest(coalesce(p_sent, 0), 0),
      failed = greatest(coalesce(p_failed, 0), 0),
      duplicates = greatest(coalesce(p_duplicates, 0), 0),
      delivery_unknown = greatest(coalesce(p_delivery_unknown, 0), 0),
      sanitized_error = nullif(public.automation_sanitize_error(p_error), '')
  where id = p_run_id and status = 'running';
end;
$function$;

create or replace function public.automation_claim_outbox(
  p_limit integer,
  p_lock_token uuid
)
returns setof public.automation_outbox
language sql
security definer
set search_path = public
as $function$
  with candidates as (
    select id
    from public.automation_outbox
    where status = 'pending'
      and scheduled_for <= now()
      and next_attempt_at <= now()
    order by priority desc, next_attempt_at, created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 100)
  )
  update public.automation_outbox o
  set status = 'processing',
      locked_at = now(),
      lock_token = p_lock_token,
      attempt_count = o.attempt_count + 1,
      error_code = null,
      sanitized_error = null
  from candidates c
  where o.id = c.id
  returning o.*;
$function$;

create or replace function public.automation_freeze_outbox(
  p_outbox_id uuid,
  p_lock_token uuid,
  p_from text,
  p_to text[],
  p_cc text[],
  p_bcc text[],
  p_reply_to text,
  p_subject text,
  p_html text,
  p_text text,
  p_test_mode boolean
)
returns public.automation_outbox
language plpgsql
security definer
set search_path = public
as $function$
declare v_row public.automation_outbox;
begin
  select * into v_row
  from public.automation_outbox
  where id = p_outbox_id and status = 'processing' and lock_token = p_lock_token
  for update;
  if not found then
    raise exception 'automation_lock_mismatch' using errcode = '55000';
  end if;
  if v_row.snapshot_frozen_at is null then
    if nullif(btrim(p_from), '') is null
       or coalesce(array_length(p_to, 1), 0) <> 1
       or nullif(p_subject, '') is null
       or nullif(p_html, '') is null
       or nullif(p_text, '') is null then
      raise exception 'invalid_automation_snapshot' using errcode = '22023';
    end if;
    update public.automation_outbox
    set frozen_from = p_from,
        frozen_to = p_to,
        frozen_cc = coalesce(p_cc, '{}'::text[]),
        frozen_bcc = coalesce(p_bcc, '{}'::text[]),
        frozen_reply_to = nullif(btrim(p_reply_to), ''),
        frozen_subject = p_subject,
        frozen_html = p_html,
        frozen_text = p_text,
        snapshot_frozen_at = now(),
        test_mode = p_test_mode
    where id = p_outbox_id
    returning * into v_row;
  end if;
  return v_row;
end;
$function$;

create or replace function public.automation_complete_attempt(
  p_outbox_id uuid,
  p_lock_token uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_error text default null,
  p_next_attempt_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.automation_outbox;
  v_status text;
begin
  select * into v_row
  from public.automation_outbox
  where id = p_outbox_id and status = 'processing' and lock_token = p_lock_token
  for update;
  if not found then
    raise exception 'automation_lock_mismatch' using errcode = '55000';
  end if;
  if p_outcome = 'sent' then
    v_status := 'sent';
  elsif p_outcome = 'retry' and v_row.attempt_count < v_row.max_attempts then
    v_status := 'pending';
  elsif p_outcome = 'delivery_unknown' then
    v_status := 'delivery_unknown';
  elsif p_outcome = 'failed' or p_outcome = 'retry' then
    v_status := 'failed';
  elsif p_outcome = 'release' then
    v_status := 'pending';
  else
    raise exception 'invalid_automation_outcome' using errcode = '22023';
  end if;
  update public.automation_outbox
  set status = v_status,
      provider_message_id = coalesce(nullif(p_provider_message_id, ''), provider_message_id),
      error_code = nullif(left(coalesce(p_error_code, ''), 100), ''),
      sanitized_error = nullif(public.automation_sanitize_error(p_error), ''),
      next_attempt_at = case
        when v_status = 'pending' then greatest(coalesce(p_next_attempt_at, now()), now())
        else next_attempt_at
      end,
      attempt_count = case when p_outcome = 'release' then greatest(attempt_count - 1, 0) else attempt_count end,
      sent_at = case when v_status = 'sent' then now() else sent_at end,
      locked_at = null,
      lock_token = null
  where id = p_outbox_id;
  return v_status;
end;
$function$;

create or replace function public.automation_reconcile_stuck(
  p_locked_before timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_pending integer := 0;
  v_unknown integer := 0;
begin
  update public.automation_outbox
  set status = 'pending', locked_at = null, lock_token = null, next_attempt_at = now(),
      attempt_count = greatest(attempt_count - 1, 0),
      error_code = 'stuck_before_freeze', sanitized_error = 'Recovered before provider snapshot freeze'
  where status = 'processing'
    and locked_at < p_locked_before
    and snapshot_frozen_at is null;
  get diagnostics v_pending = row_count;

  update public.automation_outbox
  set status = 'delivery_unknown', locked_at = null, lock_token = null,
      error_code = 'stuck_after_freeze', sanitized_error = 'Provider acceptance requires reconciliation'
  where status = 'processing'
    and locked_at < p_locked_before
    and snapshot_frozen_at is not null;
  get diagnostics v_unknown = row_count;

  return jsonb_build_object('recovered_pending', v_pending, 'delivery_unknown', v_unknown);
end;
$function$;

create or replace function public.automation_record_delivery_event(
  p_provider text,
  p_provider_event_id text,
  p_provider_message_id text,
  p_event_type text,
  p_event_at timestamptz,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_outbox_id uuid;
  v_id uuid;
begin
  select id into v_outbox_id
  from public.automation_outbox
  where provider = p_provider and provider_message_id = p_provider_message_id
  order by created_at desc
  limit 1;

  insert into public.automation_delivery_events (
    provider, provider_event_id, provider_message_id, outbox_id,
    event_type, event_at, sanitized_payload
  ) values (
    p_provider, p_provider_event_id, p_provider_message_id, v_outbox_id,
    p_event_type, coalesce(p_event_at, now()), coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (provider, provider_event_id) where provider_event_id is not null
  do nothing
  returning id into v_id;

  if v_outbox_id is null then
    perform public.automation_record_health(
      'unmatched-provider-message:' || left(coalesce(p_provider_message_id, 'missing'), 80),
      'unmatched_provider_message',
      'warning',
      jsonb_build_object('provider', p_provider, 'event_type', p_event_type)
    );
  elsif p_event_type in ('email.failed', 'email.bounced', 'email.complained', 'email.suppressed') then
    update public.automation_outbox
    set status = 'failed',
        error_code = left(p_event_type, 100),
        sanitized_error = 'Provider delivery event: ' || left(p_event_type, 100)
    where id = v_outbox_id and status in ('sent', 'delivery_unknown');
  elsif p_event_type = 'email.delivered' then
    update public.automation_outbox
    set status = 'sent'
    where id = v_outbox_id and status = 'delivery_unknown';
  end if;
  return v_id;
end;
$function$;

revoke all on function public.automation_sanitize_error(text) from public, anon, authenticated;
revoke all on function public.automation_touch_outbox() from public, anon, authenticated;
revoke all on function public.automation_payload_has_financial_field(jsonb) from public, anon, authenticated;
revoke all on function public.automation_guard_frozen_snapshot() from public, anon, authenticated;
revoke all on function public.automation_record_health(text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.automation_enqueue(text,text,text,text,uuid,text,text,uuid,text,text,jsonb,smallint,timestamptz) from public, anon, authenticated;
revoke all on function public.automation_start_run(text,text,text,text) from public, anon, authenticated;
revoke all on function public.automation_finish_run(uuid,text,integer,integer,integer,integer,integer,integer,integer,text) from public, anon, authenticated;
revoke all on function public.automation_claim_outbox(integer,uuid) from public, anon, authenticated;
revoke all on function public.automation_freeze_outbox(uuid,uuid,text,text[],text[],text[],text,text,text,text,boolean) from public, anon, authenticated;
revoke all on function public.automation_complete_attempt(uuid,uuid,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.automation_reconcile_stuck(timestamptz) from public, anon, authenticated;
revoke all on function public.automation_record_delivery_event(text,text,text,text,timestamptz,jsonb) from public, anon, authenticated;

grant execute on function public.automation_sanitize_error(text) to service_role;
grant execute on function public.automation_record_health(text,text,text,jsonb) to service_role;
grant execute on function public.automation_enqueue(text,text,text,text,uuid,text,text,uuid,text,text,jsonb,smallint,timestamptz) to service_role;
grant execute on function public.automation_start_run(text,text,text,text) to service_role;
grant execute on function public.automation_finish_run(uuid,text,integer,integer,integer,integer,integer,integer,integer,text) to service_role;
grant execute on function public.automation_claim_outbox(integer,uuid) to service_role;
grant execute on function public.automation_freeze_outbox(uuid,uuid,text,text[],text[],text[],text,text,text,text,boolean) to service_role;
grant execute on function public.automation_complete_attempt(uuid,uuid,text,text,text,text,timestamptz) to service_role;
grant execute on function public.automation_reconcile_stuck(timestamptz) to service_role;
grant execute on function public.automation_record_delivery_event(text,text,text,text,timestamptz,jsonb) to service_role;

comment on table public.automation_outbox is
  'ADR-004: one immutable email snapshot per message x recipient; no frontend access.';
comment on table public.automation_runs is
  'ADR-004: scanner/sender/health execution ledger.';
comment on table public.automation_delivery_events is
  'ADR-004: provider webhook dedupe and durable health evidence.';

commit;
