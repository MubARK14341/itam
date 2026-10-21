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
