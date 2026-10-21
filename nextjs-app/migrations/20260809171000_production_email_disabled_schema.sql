-- Purpose: Production-only port of the reviewed email-automation schema, with
-- email delivery and all automatic enqueue categories disabled at launch.
-- Risk: additive schema/functions/triggers only; this does not create cron jobs,
-- invoke an Edge Function, configure a provider, or modify existing outbox rows.
-- Rollback: disable the Edit 5 triggers/RPCs; preserve immutable audit and outbox
-- evidence. Do not enable email until the separate delivery activation runbook is approved.
--
-- Derived from the reviewed 20260806170000 Edit 5 schema migration. It intentionally
-- excludes the Staging-only scheduler and manager test-email RPC. The enqueue helper
-- is fail-closed while email_enabled is false, so ordinary business workflows remain
-- operational without creating new delivery work.

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
  email_enabled boolean not null default false,
  test_mode boolean not null default false,
  daily_digest_enabled boolean not null default false,
  working_days smallint[] not null default array[0,1,2,3,4]::smallint[],
  digest_hour_riyadh smallint not null default 9 check (digest_hour_riyadh = 9),
  request_events_enabled boolean not null default false,
  return_reminders_enabled boolean not null default false,
  account_events_enabled boolean not null default false,
  daily_warning_threshold integer not null default 80 check (daily_warning_threshold > 0),
  monthly_warning_threshold integer not null default 2500 check (monthly_warning_threshold > 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.email_automation_settings (
  id, email_enabled, test_mode, daily_digest_enabled,
  request_events_enabled, return_reminders_enabled, account_events_enabled
)
values ('main', false, false, false, false, false, false)
on conflict (id) do nothing;
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

-- Service/trigger-only helper. It is deliberately fail-closed for the initial
-- Production launch: no new rows are queued until a manager explicitly enables
-- the reviewed feature in a later approved activation window.
create or replace function public.automation_edit5_enqueue(
  p_event_key text, p_event_type text, p_recipient_id uuid, p_recipient_email text,
  p_recipient_role text, p_reference_type text, p_reference_id uuid,
  p_template_key text, p_payload jsonb, p_priority smallint default 0
) returns uuid language plpgsql security definer set search_path = public as $function$
declare v_id uuid; v_email text := lower(nullif(btrim(p_recipient_email), ''));
begin
  if not exists (select 1 from public.email_automation_settings where id = 'main' and email_enabled) then
    return null;
  end if;
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
  if not exists (select 1 from public.email_automation_settings where id = 'main' and email_enabled and request_events_enabled) then return new; end if;
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
create trigger trg_automation_edit5_request_event after insert or update of status on public.requests for each row execute function public.automation_edit5_request_event_enqueue();

create or replace function public.automation_edit5_shortage_enqueue()
returns trigger language plpgsql security definer set search_path = public as $function$
declare v_request public.requests%rowtype; u record;
begin
  if not exists (select 1 from public.email_automation_settings where id = 'main' and email_enabled and request_events_enabled) then return new; end if;
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
  if not exists (select 1 from public.email_automation_settings where id = 'main' and email_enabled and account_events_enabled) then return new; end if;
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

-- === PRODUCTION RECONCILIATION: target function-grant convergence ===
-- Purpose: replace PostgreSQL's default PUBLIC EXECUTE with the verified
-- Staging allow-list. The Staging-only manager test-email RPC is deliberately
-- excluded because Production email remains disabled for the initial launch.
-- Risk: execution is narrowed to the exact named roles plus four existing
-- Staging PUBLIC compatibility helpers; table RLS, ownership, function bodies,
-- and data are unchanged.
-- Rollback: restore only the reviewed Staging function allow-list. Do not
-- reintroduce broad PUBLIC EXECUTE as a compatibility shortcut.
begin;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
grant execute on function public._consumable_manual_adjustment_guard(), public._purchase_receipt_sod_guard(), public._request_sod_stamp(), public.inventory_settings_stamp() to public;
grant execute on function public._consumable_manual_adjustment_guard(), public._purchase_receipt_sod_guard(), public._request_sod_stamp(), public.app_schema_compatibility(), public.inventory_settings_stamp(), public.public_asset_by_token(p_token text), public.registration_status(), public.validate_portal_invite(p_code text), public.validate_registration_invite(p_code text) to anon;
grant execute on function public._consumable_manual_adjustment_guard(), public._purchase_receipt_sod_guard(), public._request_sod_stamp(), public.action_alert_assign(p_id uuid, p_user uuid), public.action_alert_note(p_id uuid, p_note text), public.action_alert_operational_counts(), public.action_alert_start(p_id uuid), public.action_alerts_sync(p_candidates jsonb), public.admin_user_has_capability(p_user uuid, p_key text), public.app_schema_compatibility(), public.app_user_role(), public.approve_customer(p_customer_id uuid, p_approve boolean), public.approve_user(p_user_id uuid, p_role_key text), public.asset_assign(p_asset_id uuid, p_employee_id uuid, p_due_date date), public.asset_change_status(p_asset_id uuid, p_to_status asset_status, p_note text), public.asset_create_atomic(p_input jsonb), public.asset_move_atomic(p_asset_id uuid, p_to_location_id uuid, p_to_department_id uuid), public.asset_return(p_asset_id uuid, p_condition text), public.asset_status_allowed(p_old asset_status, p_new asset_status), public.asset_update_atomic(p_asset_id uuid, p_input jsonb), public.assets_financial(p_ids uuid[]), public.attachment_object_registered(p_name text), public.audit_legacy_events(p_limit integer, p_before_id bigint), public.audit_request_evidence(p_request_id uuid), public.auth_recent_reauthentication(p_max_age_seconds integer), public.auth_security_state(), public.automation_delivery_action(p_id uuid, p_action text), public.automation_delivery_overview(), public.automation_delivery_recent(p_limit integer), public.automation_email_settings_get(), public.automation_email_settings_update(p_settings jsonb), public.can_read_attachment_object(p_name text), public.consumable_create_with_opening_stock(p_input jsonb), public.consumable_stock_move(p_consumable_id uuid, p_type text, p_quantity integer, p_reason text, p_unit_cost numeric, p_supplier_id uuid, p_invoice_number text, p_invoice_date date, p_employee_id uuid, p_department_id uuid), public.consumable_txn_financial(p_ids uuid[]), public.consumable_txn_financial_detail(p_ids uuid[]), public.consumables_financial(p_ids uuid[]), public.create_customer_portal_invite(p_customer_id uuid, p_portal_role text, p_valid_days integer, p_max_uses integer), public.current_employee_id(), public.current_user_has_capability(p_key text), public.current_user_id(), public.custody_reconciliation_list(), public.custody_reconciliation_refresh(), public.custody_reconciliation_update_case(p_case_id uuid, p_status text, p_assigned_to uuid, p_resolution_code text, p_resolution_notes text, p_evidence_ref text), public.dashboard_operational_summary(), public.depreciation_financial(), public.employee_my_assets(), public.employee_my_request(p_request_id uuid), public.employee_my_requests(), public.employee_my_return_requests(), public.employee_reply_request_clarification(p_request_id uuid, p_message text, p_operation_id uuid), public.employee_report_asset_issue(p_asset_id uuid, p_description text, p_operation_id uuid), public.employee_request_asset_return(p_asset_id uuid, p_reason text, p_operation_id uuid), public.financial_data_quality_list(p_limit integer, p_offset integer), public.financial_data_quality_summary(), public.get_customer_portal_settings(p_customer_id uuid), public.get_customer_request_analytics(p_filters jsonb), public.get_customer_request_operational_report(p_filters jsonb), public.get_customer_request_timeseries(p_filters jsonb), public.import_inventory(p_items jsonb), public.inventory_settings_stamp(), public.is_approved(), public.is_financial_viewer(), public.is_portal_user(), public.list_customer_portal_invites(p_customer_id uuid), public.list_customer_portal_users(p_customer_id uuid), public.list_registration_requests(p_status text), public.maintenance_add_time_entry(p_maintenance_id uuid, p_started_at timestamp with time zone, p_ended_at timestamp with time zone, p_note text, p_operation_id uuid), public.maintenance_confirm_handoff(p_id uuid, p_operation_id uuid), public.maintenance_create_atomic(p_input jsonb), public.maintenance_escalate_overdue(), public.maintenance_financial(p_ids uuid[]), public.maintenance_financial_detail(p_ids uuid[]), public.maintenance_financial_truth(p_ids uuid[]), public.maintenance_operational_summary(), public.maintenance_plan_part(p_maintenance_id uuid, p_consumable_id uuid, p_description text, p_planned_quantity numeric, p_operation_id uuid), public.maintenance_update_atomic(p_id uuid, p_input jsonb), public.maintenance_update_safe(p_id uuid, p_input jsonb, p_operation_id uuid), public.my_capabilities(), public.next_asset_tag(p_category_id uuid), public.next_purchase_request_number(), public.next_request_number(), public.portal_add_item(p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text, p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean, p_preferred_company_id uuid, p_category_key text, p_model_id uuid, p_consumable_id uuid, p_additional_quantity_requested boolean), public.portal_can_read_request_attachment(p_name text), public.portal_can_upload_request_attachment(p_name text), public.portal_create_request(p_project_name text, p_project_city text, p_contact_phone text, p_contact_email text, p_request_type text, p_pickup_date date, p_return_date date, p_notes text), public.portal_customer_id(), public.portal_get_context(), public.portal_get_profile(), public.portal_get_request(p_request_id uuid), public.portal_get_request_attachment_path(p_attachment_id uuid), public.portal_get_request_dashboard(), public.portal_item_availability(p_item_type text, p_category_id uuid, p_model_id uuid, p_consumable_id uuid), public.portal_list_allowed_categories(), public.portal_list_allowed_companies(), public.portal_list_catalog(), public.portal_list_consumables(), public.portal_list_request_attachments(p_request_id uuid), public.portal_list_requests(), public.portal_pm_approve_request(p_request_id uuid), public.portal_pm_reject_request(p_request_id uuid, p_reason text), public.portal_register_request_attachment(p_request_id uuid, p_file_name text, p_storage_path text), public.portal_remove_item(p_item_id uuid), public.portal_reply_clarification(p_request_id uuid, p_message text), public.portal_submit_request(p_request_id uuid), public.portal_update_profile(p_contact_name text, p_phone text, p_city text), public.portal_user_role(), public.procurement_record_external_document(p_purchase_request_id uuid, p_purchase_request_item_id uuid, p_document_type text, p_source_system text, p_external_reference text, p_document_status text, p_stock_transaction_id uuid, p_metadata jsonb, p_operation_id uuid), public.public_asset_by_token(p_token text), public.purchase_request_item_receive(p_item_id uuid, p_qty numeric), public.purchase_request_items_financial(p_pr_ids uuid[]), public.purchase_request_procurement_state(p_purchase_request_id uuid), public.purchase_request_set_status(p_id uuid, p_to text), public.purchase_requests_create_from_shortages(p_items jsonb), public.record_auth_security_event(p_event_type text, p_metadata jsonb), public.registration_status(), public.reject_user(p_user_id uuid, p_reason text), public.request_allocate_asset(p_request_item_id uuid, p_asset_id uuid, p_operation_id uuid), public.request_approve(p_id uuid), public.request_asset_allocation_summary(p_request_id uuid), public.request_attachment_registered(p_name text), public.request_attachment_staff_can_read(p_name text), public.request_auto_provision(p_id uuid), public.request_cancel(p_id uuid), public.request_change_reserved_asset(p_item_id uuid, p_new_asset_id uuid, p_operation_id uuid), public.request_complete(p_id uuid), public.request_confirm_ready(p_id uuid), public.request_create_amendment(p_request_id uuid, p_patch jsonb, p_reason text, p_operation_id uuid), public.request_create_employee_self(p_status text, p_project_name text, p_pickup_date date, p_return_date date, p_notes text, p_items jsonb), public.request_create_idempotent(p_operation_id uuid, p_input jsonb), public.request_create_staff(p_status text, p_customer_id uuid, p_customer_name text, p_contact_phone text, p_project_name text, p_project_city text, p_request_type text, p_pickup_date date, p_return_date date, p_notes text, p_internal_notes text, p_items jsonb), public.request_deliver(p_id uuid), public.request_deliver_with_proof(p_id uuid, p_proof jsonb, p_operation_id uuid), public.request_delivery_create_otp_challenge(p_request_id uuid, p_provider text, p_operation_id uuid), public.request_delivery_requirements(p_request_id uuid), public.request_delivery_verify_otp(p_challenge_id uuid, p_code text), public.request_execute_idempotent(p_request_id uuid, p_operation_type text, p_operation_id uuid, p_payload jsonb), public.request_filter_options(), public.request_inspect_return(p_id uuid, p_lines jsonb), public.request_item_convert_to_pr(p_item_id uuid, p_pr_id uuid), public.request_item_fulfill(p_item_id uuid, p_asset_id uuid, p_consumable_id uuid), public.request_item_unfulfill(p_item_id uuid), public.request_items_financial(p_request_ids uuid[]), public.request_mark_ready(p_id uuid), public.request_operation_result_lookup(p_operation_id uuid), public.request_operational_counts(), public.request_prepare_allocated_assets(p_request_id uuid, p_operation_id uuid), public.request_reject(p_id uuid, p_reason text), public.request_request_clarification(p_id uuid, p_message text), public.request_return(p_id uuid), public.request_review_amendment(p_amendment_id uuid, p_decision text, p_review_reason text, p_operation_id uuid), public.request_secondary_approve(p_id uuid, p_reason text, p_operation_id uuid), public.request_set_responsible(p_id uuid, p_user_id uuid), public.request_shortage_fulfill_available(p_id uuid), public.request_start_preparing(p_id uuid), public.request_status_allowed(p_old text, p_new text), public.request_submit(p_id uuid), public.request_transition_allowed(p_from text, p_to text), public.reset_user_pending(p_user_id uuid), public.revoke_customer_portal_invite(p_invite_id uuid), public.scan_warehouse_move(p_asset_id uuid, p_action text, p_warehouse_id uuid, p_operation_id uuid), public.set_customer_allowed_categories(p_customer_id uuid, p_categories jsonb), public.set_customer_allowed_companies(p_customer_id uuid, p_company_ids uuid[]), public.set_customer_portal_user_active(p_user_id uuid, p_active boolean), public.set_role_capability(p_role_key text, p_key text, p_allowed boolean), public.set_user_capability(p_user uuid, p_key text, p_state text), public.staff_register_request_attachment(p_request_id uuid, p_file_name text, p_storage_path text, p_visible_to_customer boolean), public.staff_register_request_attachment_v2(p_request_id uuid, p_file_name text, p_storage_path text, p_visible_to_customer boolean, p_classification text, p_functional_type text), public.staff_set_request_attachment_visibility(p_attachment_id uuid, p_visible boolean), public.stocktake_apply_adjustments(p_stocktake_id uuid, p_operation_id uuid), public.stocktake_create(p_title text, p_location_id uuid, p_operation_id uuid, p_correction_of uuid), public.stocktake_create(p_title text, p_location_id uuid, p_operation_id uuid, p_correction_of uuid, p_scope_kind text, p_scope_category_id uuid), public.stocktake_decide_item(p_stocktake_id uuid, p_item_id uuid, p_decision text, p_note text, p_operation_id uuid), public.stocktake_detail(p_stocktake_id uuid), public.stocktake_list(), public.stocktake_recount_item(p_stocktake_id uuid, p_item_id uuid, p_reason text, p_operation_id uuid), public.stocktake_review(p_stocktake_id uuid, p_decision text, p_reason text, p_operation_id uuid), public.stocktake_scan(p_stocktake_id uuid, p_identifier text, p_operation_id uuid), public.stocktake_set_variance_reason(p_stocktake_id uuid, p_item_id uuid, p_reason text, p_operation_id uuid), public.stocktake_start(p_stocktake_id uuid, p_operation_id uuid), public.stocktake_submit(p_stocktake_id uuid, p_operation_id uuid), public.update_customer_portal_settings(p_customer_id uuid, p_portal_enabled boolean, p_allow_rental boolean, p_allow_purchase boolean, p_allow_maintenance boolean, p_allow_custom boolean, p_allow_custom_item boolean, p_allow_attachments boolean, p_require_pm boolean), public.user_label(uid uuid), public.user_labels(p_ids uuid[]), public.validate_portal_invite(p_code text), public.validate_registration_invite(p_code text), public.warehouse_employee_return_queue(), public.warehouse_receive_employee_return(p_return_request_id uuid, p_condition text, p_note text, p_operation_id uuid) to authenticated;
grant execute on function public._audit_actor_context(p_row jsonb), public._audit_capability_denial(p_event_type text, p_entity_type text, p_entity_id text, p_reason text), public._audit_reject_mutation(), public._audit_row_change(), public._audit_sanitize(p_value jsonb), public._audit_write(p_event_type text, p_outcome text, p_entity_type text, p_entity_id text, p_request_id uuid, p_before_state jsonb, p_after_state jsonb, p_reason text, p_source text, p_metadata jsonb, p_actor_row jsonb, p_system_principal text), public._auth_current_aal(), public._auth_last_method_at(), public._consumable_manual_adjustment_guard(), public._crq_filter(p_filters jsonb), public._custody_reconciliation_refresh(), public._maintenance_completion_guard(), public._maintenance_sla_stamp(), public._portal_settings(p_customer_id uuid), public._procurement_legacy_receipt_event(), public._purchase_receipt_sod_guard(), public._request_actor_kind(), public._request_add_event(p_request_id uuid, p_event_type text, p_actor_kind text, p_message text, p_metadata jsonb), public._request_auto_provision(p_id uuid), public._request_delivery_risk(p_request_id uuid), public._request_item_scope_change_guard(), public._request_release_reservations(p_id uuid, p_reason text), public._request_scope_change_guard(), public._request_sod_stamp(), public._stocktake_can_manage(), public._stocktake_can_read(), public._stocktake_can_review(), public._stocktake_event(p_stocktake_id uuid, p_event_type text, p_operation_id uuid, p_item_id uuid, p_before jsonb, p_after jsonb, p_reason text), public._stocktake_existing_operation(p_operation_id uuid, p_action text), public._stocktake_record_operation(p_operation_id uuid, p_stocktake_id uuid, p_action text, p_result jsonb), public._stocktake_refresh_counts(p_stocktake_id uuid), public.action_alert_assign(p_id uuid, p_user uuid), public.action_alert_note(p_id uuid, p_note text), public.action_alert_operational_counts(), public.action_alert_start(p_id uuid), public.action_alerts_sync(p_candidates jsonb), public.admin_user_has_capability(p_user uuid, p_key text), public.app_schema_compatibility(), public.app_user_role(), public.approve_customer(p_customer_id uuid, p_approve boolean), public.approve_user(p_user_id uuid, p_role_key text), public.assert_asset_custody_consistency(), public.assert_employee_has_no_active_custody(), public.asset_assign(p_asset_id uuid, p_employee_id uuid, p_due_date date), public.asset_change_status(p_asset_id uuid, p_to_status asset_status, p_note text), public.asset_create_atomic(p_input jsonb), public.asset_move_atomic(p_asset_id uuid, p_to_location_id uuid, p_to_department_id uuid), public.asset_pools_stamp_creator(), public.asset_pools_touch_updated(), public.asset_return(p_asset_id uuid, p_condition text), public.asset_status_allowed(p_old asset_status, p_new asset_status), public.asset_update_atomic(p_asset_id uuid, p_input jsonb), public.assets_assign_tag(), public.assets_financial(p_ids uuid[]), public.assets_guard_custody_transition(), public.assets_guard_future_integrity(), public.assets_guard_serial_exempt(), public.assets_guard_status(), public.attachment_object_registered(p_name text), public.attachments_guard_classification(), public.audit_legacy_events(p_limit integer, p_before_id bigint), public.audit_request_evidence(p_request_id uuid), public.audit_trigger(), public.auth_recent_reauthentication(p_max_age_seconds integer), public.auth_security_state(), public.automation_claim_outbox(p_limit integer, p_lock_token uuid), public.automation_complete_attempt(p_outbox_id uuid, p_lock_token uuid, p_outcome text, p_provider_message_id text, p_error_code text, p_error text, p_next_attempt_at timestamp with time zone), public.automation_custody_delivery_enqueue(), public.automation_delivery_action(p_id uuid, p_action text), public.automation_delivery_overview(), public.automation_delivery_recent(p_limit integer), public.automation_edit5_account_enqueue(), public.automation_edit5_audit(p_event text, p_outcome text, p_metadata jsonb), public.automation_edit5_enqueue(p_event_key text, p_event_type text, p_recipient_id uuid, p_recipient_email text, p_recipient_role text, p_reference_type text, p_reference_id uuid, p_template_key text, p_payload jsonb, p_priority integer), public.automation_edit5_enqueue(p_event_key text, p_event_type text, p_recipient_id uuid, p_recipient_email text, p_recipient_role text, p_reference_type text, p_reference_id uuid, p_template_key text, p_payload jsonb, p_priority smallint), public.automation_edit5_is_manager(), public.automation_edit5_record_delivery_event(p_provider text, p_provider_event_id text, p_provider_message_id text, p_event_type text, p_event_at timestamp with time zone, p_payload jsonb), public.automation_edit5_request_event_enqueue(), public.automation_edit5_request_recipient(p_request requests), public.automation_edit5_shortage_enqueue(), public.automation_email_settings_get(), public.automation_email_settings_update(p_settings jsonb), public.automation_enqueue(p_logical_message_key text, p_event_key text, p_event_type text, p_recipient_type text, p_recipient_ref uuid, p_recipient_email text, p_reference_type text, p_reference_id uuid, p_template_key text, p_language text, p_payload jsonb, p_priority smallint, p_scheduled_for timestamp with time zone), public.automation_finish_run(p_run_id uuid, p_status text, p_scanned integer, p_enqueued integer, p_claimed integer, p_sent integer, p_failed integer, p_duplicates integer, p_delivery_unknown integer, p_error text), public.automation_freeze_outbox(p_outbox_id uuid, p_lock_token uuid, p_from text, p_to text[], p_cc text[], p_bcc text[], p_reply_to text, p_subject text, p_html text, p_text text, p_test_mode boolean), public.automation_guard_frozen_snapshot(), public.automation_maintenance_opened_enqueue(), public.automation_payload_has_financial_field(p_value jsonb), public.automation_reconcile_stuck(p_locked_before timestamp with time zone), public.automation_record_delivery_event(p_provider text, p_provider_event_id text, p_provider_message_id text, p_event_type text, p_event_at timestamp with time zone, p_payload jsonb), public.automation_record_health(p_health_key text, p_event_type text, p_severity text, p_payload jsonb), public.automation_sanitize_error(p_error text), public.automation_start_run(p_run_key text, p_job text, p_mode text, p_worker_version text), public.automation_touch_outbox(), public.can_read_attachment_object(p_name text), public.complete_attachment_scan(p_bucket text, p_storage_path text, p_verdict text, p_provider text, p_reason text, p_content_sha256 text), public.consumable_create_with_opening_stock(p_input jsonb), public.consumable_stock_move(p_consumable_id uuid, p_type text, p_quantity integer, p_reason text, p_unit_cost numeric, p_supplier_id uuid, p_invoice_number text, p_invoice_date date, p_employee_id uuid, p_department_id uuid), public.consumable_transactions_guard_financial(), public.consumable_txn_financial(p_ids uuid[]), public.consumable_txn_financial_detail(p_ids uuid[]), public.consumables_financial(p_ids uuid[]), public.consumables_guard_financial(), public.create_customer_portal_invite(p_customer_id uuid, p_portal_role text, p_valid_days integer, p_max_uses integer), public.current_employee_id(), public.current_user_has_capability(p_key text), public.current_user_id(), public.custody_asset_is_consistent(p_asset_id uuid), public.custody_reconciliation_list(), public.custody_reconciliation_refresh(), public.custody_reconciliation_update_case(p_case_id uuid, p_status text, p_assigned_to uuid, p_resolution_code text, p_resolution_notes text, p_evidence_ref text), public.dashboard_operational_summary(), public.depreciation_financial(), public.employee_my_assets(), public.employee_my_request(p_request_id uuid), public.employee_my_requests(), public.employee_my_return_requests(), public.employee_reply_request_clarification(p_request_id uuid, p_message text, p_operation_id uuid), public.employee_report_asset_issue(p_asset_id uuid, p_description text, p_operation_id uuid), public.employee_request_asset_return(p_asset_id uuid, p_reason text, p_operation_id uuid), public.feature_exposure_settings_stamp(), public.financial_data_quality_list(p_limit integer, p_offset integer), public.financial_data_quality_summary(), public.get_customer_portal_settings(p_customer_id uuid), public.get_customer_request_analytics(p_filters jsonb), public.get_customer_request_operational_report(p_filters jsonb), public.get_customer_request_timeseries(p_filters jsonb), public.handle_new_user(), public.has_capability(p_user uuid, p_key text), public.import_inventory(p_items jsonb), public.inventory_settings_stamp(), public.is_approved(), public.is_financial_viewer(), public.is_portal_user(), public.list_customer_portal_invites(p_customer_id uuid), public.list_customer_portal_users(p_customer_id uuid), public.list_registration_requests(p_status text), public.maintenance_add_time_entry(p_maintenance_id uuid, p_started_at timestamp with time zone, p_ended_at timestamp with time zone, p_note text, p_operation_id uuid), public.maintenance_confirm_handoff(p_id uuid, p_operation_id uuid), public.maintenance_create_atomic(p_input jsonb), public.maintenance_escalate_overdue(), public.maintenance_financial(p_ids uuid[]), public.maintenance_financial_detail(p_ids uuid[]), public.maintenance_financial_truth(p_ids uuid[]), public.maintenance_guard_financial(), public.maintenance_operational_summary(), public.maintenance_plan_part(p_maintenance_id uuid, p_consumable_id uuid, p_description text, p_planned_quantity numeric, p_operation_id uuid), public.maintenance_update_atomic(p_id uuid, p_input jsonb), public.maintenance_update_safe(p_id uuid, p_input jsonb, p_operation_id uuid), public.my_capabilities(), public.next_asset_tag(p_category_id uuid), public.next_purchase_request_number(), public.next_request_number(), public.notification_settings_stamp(), public.portal_add_item(p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text, p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean, p_preferred_company_id uuid, p_category_key text, p_model_id uuid, p_consumable_id uuid, p_additional_quantity_requested boolean), public.portal_can_read_request_attachment(p_name text), public.portal_can_upload_request_attachment(p_name text), public.portal_create_request(p_project_name text, p_project_city text, p_contact_phone text, p_contact_email text, p_request_type text, p_pickup_date date, p_return_date date, p_notes text), public.portal_customer_id(), public.portal_get_context(), public.portal_get_profile(), public.portal_get_request(p_request_id uuid), public.portal_get_request_attachment_path(p_attachment_id uuid), public.portal_get_request_dashboard(), public.portal_item_availability(p_item_type text, p_category_id uuid, p_model_id uuid, p_consumable_id uuid), public.portal_list_allowed_categories(), public.portal_list_allowed_companies(), public.portal_list_catalog(), public.portal_list_consumables(), public.portal_list_request_attachments(p_request_id uuid), public.portal_list_requests(), public.portal_pm_approve_request(p_request_id uuid), public.portal_pm_reject_request(p_request_id uuid, p_reason text), public.portal_register_request_attachment(p_request_id uuid, p_file_name text, p_storage_path text), public.portal_remove_item(p_item_id uuid), public.portal_reply_clarification(p_request_id uuid, p_message text), public.portal_submit_request(p_request_id uuid), public.portal_update_profile(p_contact_name text, p_phone text, p_city text), public.portal_user_role(), public.pr_items_guard_financial(), public.procurement_record_external_document(p_purchase_request_id uuid, p_purchase_request_item_id uuid, p_document_type text, p_source_system text, p_external_reference text, p_document_status text, p_stock_transaction_id uuid, p_metadata jsonb, p_operation_id uuid), public.public_asset_by_token(p_token text), public.purchase_request_item_receive(p_item_id uuid, p_qty numeric), public.purchase_request_items_financial(p_pr_ids uuid[]), public.purchase_request_procurement_state(p_purchase_request_id uuid), public.purchase_request_set_status(p_id uuid, p_to text), public.purchase_requests_create_from_shortages(p_items jsonb), public.purchase_requests_stamp(), public.record_auth_security_event(p_event_type text, p_metadata jsonb), public.registration_status(), public.reject_user(p_user_id uuid, p_reason text), public.request_allocate_asset(p_request_item_id uuid, p_asset_id uuid, p_operation_id uuid), public.request_approve(p_id uuid), public.request_asset_allocation_summary(p_request_id uuid), public.request_attachment_registered(p_name text), public.request_attachment_staff_can_read(p_name text), public.request_auto_provision(p_id uuid), public.request_cancel(p_id uuid), public.request_change_reserved_asset(p_item_id uuid, p_new_asset_id uuid, p_operation_id uuid), public.request_complete(p_id uuid), public.request_confirm_ready(p_id uuid), public.request_create_amendment(p_request_id uuid, p_patch jsonb, p_reason text, p_operation_id uuid), public.request_create_employee_self(p_status text, p_project_name text, p_pickup_date date, p_return_date date, p_notes text, p_items jsonb), public.request_create_idempotent(p_operation_id uuid, p_input jsonb), public.request_create_staff(p_status text, p_customer_id uuid, p_customer_name text, p_contact_phone text, p_project_name text, p_project_city text, p_request_type text, p_pickup_date date, p_return_date date, p_notes text, p_internal_notes text, p_items jsonb), public.request_deliver(p_id uuid), public.request_deliver_with_proof(p_id uuid, p_proof jsonb, p_operation_id uuid), public.request_delivery_activate_otp(p_challenge_id uuid, p_code text, p_external_message_id text, p_expires_at timestamp with time zone), public.request_delivery_create_otp_challenge(p_request_id uuid, p_provider text, p_operation_id uuid), public.request_delivery_requirements(p_request_id uuid), public.request_delivery_verify_otp(p_challenge_id uuid, p_code text), public.request_exact_assets_ready_guard(), public.request_execute_idempotent(p_request_id uuid, p_operation_type text, p_operation_id uuid, p_payload jsonb), public.request_filter_options(), public.request_inspect_return(p_id uuid, p_lines jsonb), public.request_item_convert_to_pr(p_item_id uuid, p_pr_id uuid), public.request_item_fulfill(p_item_id uuid, p_asset_id uuid, p_consumable_id uuid), public.request_item_unfulfill(p_item_id uuid), public.request_items_financial(p_request_ids uuid[]), public.request_mark_ready(p_id uuid), public.request_operation_result_lookup(p_operation_id uuid), public.request_operational_counts(), public.request_prepare_allocated_assets(p_request_id uuid, p_operation_id uuid), public.request_ready_issue(p_id uuid), public.request_reject(p_id uuid, p_reason text), public.request_request_clarification(p_id uuid, p_message text), public.request_return(p_id uuid), public.request_review_amendment(p_amendment_id uuid, p_decision text, p_review_reason text, p_operation_id uuid), public.request_secondary_approve(p_id uuid, p_reason text, p_operation_id uuid), public.request_set_responsible(p_id uuid, p_user_id uuid), public.request_shortage_fulfill_available(p_id uuid), public.request_start_preparing(p_id uuid), public.request_status_allowed(p_old text, p_new text), public.request_submit(p_id uuid), public.request_transition_allowed(p_from text, p_to text), public.requests_assign_number(), public.requests_guard_status(), public.requests_log_status_event(), public.reset_user_pending(p_user_id uuid), public.revoke_customer_portal_invite(p_invite_id uuid), public.scan_logs_stamp_actor(), public.scan_warehouse_move(p_asset_id uuid, p_action text, p_warehouse_id uuid, p_operation_id uuid), public.set_customer_allowed_categories(p_customer_id uuid, p_categories jsonb), public.set_customer_allowed_companies(p_customer_id uuid, p_company_ids uuid[]), public.set_customer_portal_user_active(p_user_id uuid, p_active boolean), public.set_role_capability(p_role_key text, p_key text, p_allowed boolean), public.set_updated_at(), public.set_user_capability(p_user uuid, p_key text, p_state text), public.staff_register_request_attachment(p_request_id uuid, p_file_name text, p_storage_path text, p_visible_to_customer boolean), public.staff_register_request_attachment_v2(p_request_id uuid, p_file_name text, p_storage_path text, p_visible_to_customer boolean, p_classification text, p_functional_type text), public.staff_set_request_attachment_visibility(p_attachment_id uuid, p_visible boolean), public.stocktake_apply_adjustments(p_stocktake_id uuid, p_operation_id uuid), public.stocktake_create(p_title text, p_location_id uuid, p_operation_id uuid, p_correction_of uuid), public.stocktake_create(p_title text, p_location_id uuid, p_operation_id uuid, p_correction_of uuid, p_scope_kind text, p_scope_category_id uuid), public.stocktake_decide_item(p_stocktake_id uuid, p_item_id uuid, p_decision text, p_note text, p_operation_id uuid), public.stocktake_detail(p_stocktake_id uuid), public.stocktake_list(), public.stocktake_recount_item(p_stocktake_id uuid, p_item_id uuid, p_reason text, p_operation_id uuid), public.stocktake_review(p_stocktake_id uuid, p_decision text, p_reason text, p_operation_id uuid), public.stocktake_scan(p_stocktake_id uuid, p_identifier text, p_operation_id uuid), public.stocktake_set_variance_reason(p_stocktake_id uuid, p_item_id uuid, p_reason text, p_operation_id uuid), public.stocktake_start(p_stocktake_id uuid, p_operation_id uuid), public.stocktake_submit(p_stocktake_id uuid, p_operation_id uuid), public.update_customer_portal_settings(p_customer_id uuid, p_portal_enabled boolean, p_allow_rental boolean, p_allow_purchase boolean, p_allow_maintenance boolean, p_allow_custom boolean, p_allow_custom_item boolean, p_allow_attachments boolean, p_require_pm boolean), public.user_label(uid uuid), public.user_labels(p_ids uuid[]), public.validate_portal_invite(p_code text), public.validate_registration_invite(p_code text), public.warehouse_employee_return_queue(), public.warehouse_receive_employee_return(p_return_request_id uuid, p_condition text, p_note text, p_operation_id uuid) to service_role;
commit;
