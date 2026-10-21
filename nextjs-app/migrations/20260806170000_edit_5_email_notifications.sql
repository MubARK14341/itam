-- EDIT 5 — Reliable transactional email and daily task digests.
-- Purpose: extend the existing ADR-004 automation outbox (do not create a
--          second queue) with safe delivery states, suppression, settings,
--          role-gated monitoring, and canonical request/account enqueue hooks.
-- Risk: additive schema/functions/triggers only; no data deletion or RLS disable.
-- Rollback: revoke the EDIT 5 RPCs/triggers and leave immutable delivery/audit
--           evidence intact.  This migration is Staging-only until separately approved.

begin;

alter table public.automation_outbox
  add column if not exists recipient_name text,
  add column if not exists recipient_role text,
  add column if not exists related_entity_type text,
  add column if not exists related_entity_id uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists failed_at timestamptz;
alter table public.automation_outbox alter column max_attempts set default 6;

alter table public.automation_outbox
  drop constraint if exists automation_outbox_status_check;
alter table public.automation_outbox
  add constraint automation_outbox_status_check check (
    status in ('pending','processing','sent','delivered','failed','cancelled','suppressed','delivery_unknown')
  );

create index if not exists automation_outbox_recipient_idx
  on public.automation_outbox (recipient_ref, created_at desc);
create index if not exists automation_outbox_lease_idx
  on public.automation_outbox (lease_expires_at)
  where status = 'processing';

create table if not exists public.email_suppressions (
  normalized_email text primary key,
  reason text not null check (reason in ('permanent_bounce','complaint','invalid_recipient')),
  provider_event_id text,
  suppressed_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table public.email_suppressions enable row level security;
alter table public.email_suppressions force row level security;
revoke all on public.email_suppressions from public, anon, authenticated;
grant all on public.email_suppressions to service_role;

create table if not exists public.email_automation_settings (
  id text primary key default 'main' check (id = 'main'),
  email_enabled boolean not null default true,
  test_mode boolean not null default true,
  daily_digest_enabled boolean not null default true,
  working_days smallint[] not null default array[0,1,2,3,4]::smallint[],
  digest_hour_riyadh smallint not null default 9 check (digest_hour_riyadh = 9),
  request_events_enabled boolean not null default true,
  return_reminders_enabled boolean not null default true,
  account_events_enabled boolean not null default true,
  daily_warning_threshold integer not null default 80 check (daily_warning_threshold > 0),
  monthly_warning_threshold integer not null default 2500 check (monthly_warning_threshold > 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.email_automation_settings (id)
values ('main') on conflict (id) do nothing;
alter table public.email_automation_settings enable row level security;
alter table public.email_automation_settings force row level security;
revoke all on public.email_automation_settings from public, anon, authenticated;
grant all on public.email_automation_settings to service_role;

create or replace function public.automation_edit5_is_manager()
returns boolean language sql stable security definer set search_path = public as $function$
  select public.is_approved() and public.app_user_role() in ('admin','it_manager')
$function$;

create or replace function public.automation_edit5_audit(p_event text, p_outcome text default 'success', p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $function$
begin
  perform public._audit_write(
    p_event, p_outcome, 'automation_outbox', null, null, null, null, null,
    'edit5_email', coalesce(p_metadata, '{}'::jsonb), null, 'email_automation'
  );
end $function$;

-- Service/trigger-only helper.  Existing automation_enqueue remains the single
-- durable outbox writer and provides deterministic per-recipient dedupe.
create or replace function public.automation_edit5_enqueue(
  p_event_key text, p_event_type text, p_recipient_id uuid, p_recipient_email text,
  p_recipient_role text, p_reference_type text, p_reference_id uuid,
  p_template_key text, p_payload jsonb, p_priority smallint default 0
) returns uuid language plpgsql security definer set search_path = public as $function$
declare v_id uuid; v_email text := lower(nullif(btrim(p_recipient_email), ''));
begin
  if v_email is null then return null; end if;
  if exists (select 1 from public.email_suppressions where normalized_email = v_email) then
    return null;
  end if;
  v_id := public.automation_enqueue(
    p_event_key || ':' || coalesce(p_recipient_id::text, encode(extensions.digest(v_email, 'sha256'), 'hex')),
    p_event_key || ':' || coalesce(p_recipient_id::text, encode(extensions.digest(v_email, 'sha256'), 'hex')),
    p_event_type, coalesce(p_recipient_role, 'user'), p_recipient_id, v_email,
    p_reference_type, p_reference_id, p_template_key, 'ar',
    jsonb_strip_nulls(coalesce(p_payload, '{}'::jsonb)), p_priority, now()
  );
  if v_id is not null then
    update public.automation_outbox
    set recipient_role = p_recipient_role,
        related_entity_type = p_reference_type,
        related_entity_id = p_reference_id
    where id = v_id;
    perform public.automation_edit5_audit('notification_enqueued', 'success', jsonb_build_object('notification_id', v_id, 'event_type', p_event_type));
  end if;
  return v_id;
end $function$;

create or replace function public.automation_edit5_request_recipient(p_request public.requests)
returns table(user_id uuid, email text, role_key text)
language plpgsql security definer set search_path = public as $function$
begin
  if p_request.request_source = 'client_portal' then
    return query select null::uuid, lower(nullif(btrim(p_request.contact_email_snapshot), '')), 'portal_customer';
  else
    return query
      select u.id, lower(u.email), r.key
      from public.app_users u join public.roles r on r.id = u.role_id
      where u.id = p_request.created_by and u.is_active and u.approval_status = 'approved';
  end if;
end $function$;

create or replace function public.automation_edit5_request_event_enqueue()
returns trigger language plpgsql security definer set search_path = public as $function$
declare r record; u record; v_template text; v_event text; v_priority smallint := 10;
begin
  -- A portal submission is the authoritative customer request-created point;
  -- internal creation is emitted only when the canonical request reaches review.
  if tg_op = 'INSERT' then
    if new.status <> 'under_review' then return new; end if;
    if new.request_source = 'client_portal' then
      for r in select * from public.automation_edit5_request_recipient(new) loop
        perform public.automation_edit5_enqueue('request-created/' || new.id::text || '/customer', 'request_created', r.user_id, r.email, r.role_key, 'request', new.id, 'portal_request_created_customer', jsonb_build_object('request_number',new.request_number,'project_name',new.project_name,'city',new.project_city,'pickup_date',new.pickup_date,'return_date',new.return_date,'link','/client-portal/requests/' || new.id::text), 20);
      end loop;
      for u in select au.id,au.email,ro.key from public.app_users au join public.roles ro on ro.id=au.role_id where au.is_active and au.approval_status='approved' and ro.key in ('it_manager','admin','warehouse_manager') loop
        perform public.automation_edit5_enqueue('request-created/' || new.id::text || '/internal', 'request_created_internal', u.id, u.email, u.key, 'request', new.id, 'portal_request_created_internal', jsonb_build_object('request_number',new.request_number,'project_name',new.project_name,'city',new.project_city,'link','/requests/' || new.id::text), 20);
      end loop;
    end if;
    return new;
  end if;
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'under_review' and new.request_source <> 'client_portal' then
    for r in select * from public.automation_edit5_request_recipient(new) loop
      perform public.automation_edit5_enqueue('internal-request-created/' || new.id::text, 'internal_request_created', r.user_id, r.email, r.role_key, 'request', new.id, 'internal_request_created_requester', jsonb_build_object('request_number',new.request_number,'link','/my-requests'), 15);
    end loop;
    for u in select au.id,au.email,ro.key from public.app_users au join public.roles ro on ro.id=au.role_id where au.is_active and au.approval_status='approved' and ro.key in ('it_manager','admin') loop
      perform public.automation_edit5_enqueue('internal-request-created/' || new.id::text || '/manager', 'internal_request_created_manager', u.id,u.email,u.key,'request',new.id,'internal_request_created_manager',jsonb_build_object('request_number',new.request_number,'link','/alerts'),15);
    end loop;
  elsif new.status in ('needs_clarification','approved','rejected','cancelled','ready_for_pickup') then
    v_event := new.status;
    v_template := case new.status when 'needs_clarification' then 'request_needs_clarification' when 'approved' then 'request_approved' when 'rejected' then 'request_rejected' when 'cancelled' then 'request_cancelled' else 'request_ready_for_pickup' end;
    for r in select * from public.automation_edit5_request_recipient(new) loop
      perform public.automation_edit5_enqueue(v_event || '/' || new.id::text, v_event, r.user_id,r.email,r.role_key,'request',new.id,v_template,jsonb_strip_nulls(jsonb_build_object('request_number',new.request_number,'pickup_date',new.pickup_date,'return_date',new.return_date,'reason',case when new.status='rejected' then new.rejection_reason else null end,'link',case when new.request_source='client_portal' then '/client-portal/requests/' || new.id::text else '/my-requests' end)), v_priority);
    end loop;
  end if;
  return new;
end $function$;

drop trigger if exists trg_automation_edit5_request_event on public.requests;
create trigger trg_automation_edit5_request_event
after insert or update of status on public.requests
for each row execute function public.automation_edit5_request_event_enqueue();

create or replace function public.automation_edit5_shortage_enqueue()
returns trigger language plpgsql security definer set search_path = public as $function$
declare v_request public.requests%rowtype; u record;
begin
  if coalesce(new.shortage_quantity, 0) <= 0 then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.shortage_quantity, 0) = coalesce(new.shortage_quantity, 0) then return new; end if;
  select * into v_request from public.requests where id = new.request_id;
  if not found then return new; end if;
  for u in select au.id,au.email,ro.key from public.app_users au join public.roles ro on ro.id=au.role_id where au.is_active and au.approval_status='approved' and ro.key in ('it_manager','admin','warehouse_manager') loop
    perform public.automation_edit5_enqueue('shortage/' || new.id::text || '/' || new.shortage_quantity::text,'additional_quantity_required',u.id,u.email,u.key,'request',new.request_id,'additional_quantity_required_internal',jsonb_build_object('request_number',v_request.request_number,'summary','Shortage quantity: ' || new.shortage_quantity::text,'link','/requests/' || new.request_id::text),15);
  end loop;
  return new;
end $function$;
drop trigger if exists trg_automation_edit5_shortage on public.request_items;
create trigger trg_automation_edit5_shortage after insert or update of shortage_quantity on public.request_items for each row execute function public.automation_edit5_shortage_enqueue();

create or replace function public.automation_edit5_account_enqueue()
returns trigger language plpgsql security definer set search_path = public as $function$
declare u record; v_template text; v_event text;
begin
  if tg_op = 'INSERT' and coalesce(new.approval_status,'pending') = 'pending' then
    perform public.automation_edit5_enqueue('account-pending/' || new.id::text,'account_pending',new.id,new.email,'user','app_user',new.id,'account_pending_user',jsonb_build_object('link','/login'),20);
    for u in select au.id,au.email,ro.key from public.app_users au join public.roles ro on ro.id=au.role_id where au.is_active and au.approval_status='approved' and ro.key in ('it_manager','admin') loop
      perform public.automation_edit5_enqueue('account-pending/' || new.id::text || '/manager','account_pending_manager',u.id,u.email,u.key,'app_user',new.id,'account_pending_manager',jsonb_build_object('link','/settings'),20);
    end loop;
  elsif tg_op='UPDATE' and new.approval_status is distinct from old.approval_status and new.approval_status in ('approved','rejected') then
    v_event := 'account_' || new.approval_status;
    v_template := case when new.approval_status='approved' then 'account_approved' else 'account_rejected' end;
    perform public.automation_edit5_enqueue(v_event || '/' || new.id::text,v_event,new.id,new.email,'user','app_user',new.id,v_template,jsonb_build_object('link',case when new.approval_status='approved' then '/dashboard' else '/login' end),20);
  end if;
  return new;
end $function$;
drop trigger if exists trg_automation_edit5_account on public.app_users;
create trigger trg_automation_edit5_account after insert or update of approval_status on public.app_users for each row execute function public.automation_edit5_account_enqueue();

-- Lease-aware claim: same SKIP LOCKED concurrency control, now with an
-- explicit expiry that the recovery routine can use without double sending.
create or replace function public.automation_claim_outbox(p_limit integer,p_lock_token uuid)
returns setof public.automation_outbox language sql security definer set search_path = public as $function$
  with candidates as (
    select id from public.automation_outbox
    where status='pending' and scheduled_for<=now() and next_attempt_at<=now()
    order by priority desc,next_attempt_at,created_at for update skip locked
    limit least(greatest(coalesce(p_limit,1),1),100)
  ) update public.automation_outbox o
  set status='processing',locked_at=now(),lease_expires_at=now()+interval '15 minutes',lock_token=p_lock_token,
      attempt_count=o.attempt_count+1,error_code=null,sanitized_error=null
  from candidates c where o.id=c.id returning o.*;
$function$;

create or replace function public.automation_edit5_record_delivery_event(
  p_provider text,p_provider_event_id text,p_provider_message_id text,p_event_type text,p_event_at timestamptz,p_payload jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = public as $function$
declare v_id uuid; v_outbox public.automation_outbox;
begin
  select * into v_outbox from public.automation_outbox where provider=p_provider and provider_message_id=p_provider_message_id order by created_at desc limit 1;
  insert into public.automation_delivery_events(provider,provider_event_id,provider_message_id,outbox_id,event_type,event_at,sanitized_payload)
  values(p_provider,p_provider_event_id,p_provider_message_id,v_outbox.id,p_event_type,coalesce(p_event_at,now()),coalesce(p_payload,'{}'::jsonb))
  on conflict (provider,provider_event_id) where provider_event_id is not null do nothing returning id into v_id;
  if v_id is null then return null; end if;
  if v_outbox.id is null then return v_id; end if;
  if p_event_type='email.delivered' then
    update public.automation_outbox set status='delivered',delivered_at=now() where id=v_outbox.id and status in ('sent','delivery_unknown');
  elsif p_event_type in ('email.bounced','email.complained','email.suppressed') then
    update public.automation_outbox set status='suppressed',failed_at=now(),error_code=left(p_event_type,100),sanitized_error='Permanent provider delivery event' where id=v_outbox.id;
    insert into public.email_suppressions(normalized_email,reason,provider_event_id) values(lower(v_outbox.recipient_email),case when p_event_type='email.complained' then 'complaint' else 'permanent_bounce' end,p_provider_event_id) on conflict(normalized_email) do update set last_seen_at=now(),provider_event_id=excluded.provider_event_id;
    perform public.automation_edit5_audit('address_suppressed','success',jsonb_build_object('notification_id',v_outbox.id));
  elsif p_event_type='email.failed' then
    update public.automation_outbox set status='failed',failed_at=now(),error_code='email.failed',sanitized_error='Provider delivery failure' where id=v_outbox.id and status in ('sent','delivery_unknown');
  end if;
  return v_id;
end $function$;

create or replace function public.automation_email_settings_get()
returns jsonb language plpgsql security definer set search_path = public as $function$
declare s public.email_automation_settings;
begin
  if not public.automation_edit5_is_manager() then raise exception 'not_authorized' using errcode='42501'; end if;
  select * into s from public.email_automation_settings where id='main';
  return jsonb_build_object('email_enabled',s.email_enabled,'test_mode',s.test_mode,'daily_digest_enabled',s.daily_digest_enabled,'working_days',s.working_days,'digest_time','09:00 Asia/Riyadh','request_events_enabled',s.request_events_enabled,'return_reminders_enabled',s.return_reminders_enabled,'account_events_enabled',s.account_events_enabled,'daily_warning_threshold',s.daily_warning_threshold,'monthly_warning_threshold',s.monthly_warning_threshold);
end $function$;

create or replace function public.automation_email_settings_update(p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = public as $function$
begin
  if not public.automation_edit5_is_manager() then raise exception 'not_authorized' using errcode='42501'; end if;
  update public.email_automation_settings set
    email_enabled=coalesce((p_settings->>'email_enabled')::boolean,email_enabled),
    test_mode=coalesce((p_settings->>'test_mode')::boolean,test_mode),
    daily_digest_enabled=coalesce((p_settings->>'daily_digest_enabled')::boolean,daily_digest_enabled),
    request_events_enabled=coalesce((p_settings->>'request_events_enabled')::boolean,request_events_enabled),
    return_reminders_enabled=coalesce((p_settings->>'return_reminders_enabled')::boolean,return_reminders_enabled),
    account_events_enabled=coalesce((p_settings->>'account_events_enabled')::boolean,account_events_enabled),
    daily_warning_threshold=greatest(1,coalesce((p_settings->>'daily_warning_threshold')::integer,daily_warning_threshold)),
    monthly_warning_threshold=greatest(1,coalesce((p_settings->>'monthly_warning_threshold')::integer,monthly_warning_threshold)),
    updated_by=auth.uid(),updated_at=now() where id='main';
  perform public.automation_edit5_audit('email_settings_changed','success',jsonb_build_object('test_mode_changed',p_settings ? 'test_mode'));
  return public.automation_email_settings_get();
end $function$;

create or replace function public.automation_delivery_overview()
returns jsonb language plpgsql security definer set search_path = public as $function$
declare v jsonb;
begin
  if not public.automation_edit5_is_manager() then raise exception 'not_authorized' using errcode='42501'; end if;
  select jsonb_build_object(
    'sent_today',count(*) filter(where status in ('sent','delivered') and sent_at >= date_trunc('day',now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh'),
    'delivered_today',count(*) filter(where status='delivered' and delivered_at >= date_trunc('day',now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh'),
    'pending',count(*) filter(where status in ('pending','processing')),
    'failed',count(*) filter(where status='failed'),
    'suppressed', (select count(*) from public.email_suppressions),
    'last_dispatch',(select max(finished_at) from public.automation_runs where job='sender' and status='succeeded'),
    'last_digest',(select max(created_at) from public.automation_outbox where event_type like 'daily-%')
  ) into v from public.automation_outbox;
  return v;
end $function$;

create or replace function public.automation_delivery_recent(p_limit integer default 30)
returns table(id uuid,status text,template_key text,event_type text,recipient_email text,provider_message_id text,safe_error text,created_at timestamptz,sent_at timestamptz)
language plpgsql security definer set search_path = public as $function$
begin
  if not public.automation_edit5_is_manager() then raise exception 'not_authorized' using errcode='42501'; end if;
  return query select o.id,o.status,o.template_key,o.event_type,o.recipient_email,o.provider_message_id,o.sanitized_error,o.created_at,o.sent_at from public.automation_outbox o order by o.created_at desc limit least(greatest(coalesce(p_limit,30),1),100);
end $function$;

create or replace function public.automation_delivery_action(p_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path = public as $function$
declare v public.automation_outbox;
begin
  if not public.automation_edit5_is_manager() then raise exception 'not_authorized' using errcode='42501'; end if;
  select * into v from public.automation_outbox where id=p_id for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if p_action='retry' and v.status='failed' and v.attempt_count < v.max_attempts then
    update public.automation_outbox set status='pending',next_attempt_at=now(),failed_at=null where id=v.id;
    perform public.automation_edit5_audit('notification_manually_retried','success',jsonb_build_object('notification_id',v.id));
  elsif p_action='cancel' and v.status='pending' then
    update public.automation_outbox set status='cancelled' where id=v.id;
    perform public.automation_edit5_audit('notification_cancelled','success',jsonb_build_object('notification_id',v.id));
  else raise exception 'invalid_notification_action' using errcode='22023'; end if;
  return jsonb_build_object('ok',true);
end $function$;

revoke all on function public.automation_edit5_is_manager(),public.automation_edit5_audit(text,text,jsonb),public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,smallint),public.automation_edit5_request_recipient(public.requests),public.automation_edit5_request_event_enqueue(),public.automation_edit5_shortage_enqueue(),public.automation_edit5_account_enqueue(),public.automation_edit5_record_delivery_event(text,text,text,text,timestamptz,jsonb),public.automation_email_settings_get(),public.automation_email_settings_update(jsonb),public.automation_delivery_overview(),public.automation_delivery_recent(integer),public.automation_delivery_action(uuid,text) from public,anon,authenticated;
grant execute on function public.automation_email_settings_get(),public.automation_email_settings_update(jsonb),public.automation_delivery_overview(),public.automation_delivery_recent(integer),public.automation_delivery_action(uuid,text) to authenticated;
grant execute on function public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,smallint),public.automation_edit5_record_delivery_event(text,text,text,text,timestamptz,jsonb),public.automation_claim_outbox(integer,uuid) to service_role;

commit;
