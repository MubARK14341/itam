-- Purpose: enforce staff-registration admission in the database, make invite
-- consumption concurrency-safe, and move registration administration behind
-- validated, self-authorizing RPCs.
-- Risk: staff signup now fails closed when registration configuration is
-- missing/invalid, closed, out of slots, outside the domain allowlist, or uses
-- an invalid invite. Customer-portal self-registration remains available.
-- Rollback: restore the prior handle_new_user definition and manager DML
-- grants/policies, then remove these RPCs, constraints, indexes, and triggers.

begin;

-- Existing configuration is valid on Staging. These constraints keep trusted
-- maintenance paths from reintroducing values that the admission gate cannot
-- safely interpret.
alter table public.registration_settings
  drop constraint if exists registration_settings_remaining_slots_check;
alter table public.registration_settings
  add constraint registration_settings_remaining_slots_check
  check (remaining_slots between 0 and 1000000);

alter table public.registration_settings
  drop constraint if exists registration_settings_default_role_check;
alter table public.registration_settings
  add constraint registration_settings_default_role_check
  check (default_requested_role in ('it_manager', 'employee', 'warehouse_manager', 'viewer'));

alter table public.registration_settings
  drop constraint if exists registration_settings_message_length_check;
alter table public.registration_settings
  add constraint registration_settings_message_length_check
  check (
    length(message_ar) <= 2000
    and length(message_en) <= 2000
  );

alter table public.registration_invites
  drop constraint if exists registration_invites_default_role_check;
alter table public.registration_invites
  add constraint registration_invites_default_role_check
  check (default_role in ('it_manager', 'employee', 'warehouse_manager', 'viewer'));

alter table public.registration_invites
  drop constraint if exists registration_invites_usage_bounds_check;
alter table public.registration_invites
  add constraint registration_invites_usage_bounds_check
  check (
    used_count >= 0
    and (max_uses is null or (max_uses between 1 and 100000 and used_count <= max_uses))
  );

alter table public.registration_invites
  drop constraint if exists registration_invites_label_length_check;
alter table public.registration_invites
  add constraint registration_invites_label_length_check
  check (length(label) <= 200);

create unique index if not exists registration_invites_code_lower_uniq
on public.registration_invites (lower(code));

create or replace function public.registration_settings_update_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_mode text;
  v_require_email_verification boolean;
  v_remaining_slots integer;
  v_default_role text;
  v_message_ar text;
  v_message_en text;
begin
  if coalesce(public.current_user_has_capability('settings.manage'), false) is not true then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or jsonb_typeof(p_input->'require_email_verification') is distinct from 'boolean'
     or coalesce(p_input->>'remaining_slots', '') !~ '^(0|[1-9][0-9]*)$' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  v_mode := p_input->>'mode';
  v_default_role := p_input->>'default_requested_role';
  if v_mode not in ('closed', 'open_with_approval', 'gradual', 'invite_only')
     or v_default_role not in ('it_manager', 'employee', 'warehouse_manager', 'viewer') then
    return json_build_object('ok', false, 'error', 'invalid_registration_configuration');
  end if;

  begin
    v_require_email_verification := (p_input->>'require_email_verification')::boolean;
    v_remaining_slots := (p_input->>'remaining_slots')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end;
  if v_remaining_slots > 1000000 then
    return json_build_object('ok', false, 'error', 'remaining_slots_out_of_range');
  end if;

  v_message_ar := nullif(btrim(p_input->>'message_ar'), '');
  v_message_en := nullif(btrim(p_input->>'message_en'), '');
  if length(v_message_ar) > 2000 or length(v_message_en) > 2000 then
    return json_build_object('ok', false, 'error', 'message_too_long');
  end if;

  update public.registration_settings
  set mode = v_mode,
      require_email_verification = v_require_email_verification,
      remaining_slots = v_remaining_slots,
      default_requested_role = v_default_role,
      message_ar = v_message_ar,
      message_en = v_message_en,
      updated_at = now(),
      updated_by = auth.uid()
  where id = 'main';
  if not found then
    return json_build_object('ok', false, 'error', 'registration_settings_missing');
  end if;

  return json_build_object('ok', true);
end
$function$;

create or replace function public.registration_invite_create_atomic(p_input jsonb)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
  v_code text;
  v_label text;
  v_default_role text;
  v_max_uses integer;
  v_expires_at timestamptz;
  v_is_active boolean;
begin
  if coalesce(public.current_user_has_capability('settings.manage'), false) is not true then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or p_input ? 'code'
     or jsonb_typeof(p_input->'is_active') is distinct from 'boolean' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  v_label := nullif(btrim(p_input->>'label'), '');
  v_default_role := p_input->>'default_role';
  if length(v_label) > 200
     or v_default_role not in ('it_manager', 'employee', 'warehouse_manager', 'viewer') then
    return json_build_object('ok', false, 'error', 'invalid_invite_configuration');
  end if;

  begin
    v_max_uses := nullif(p_input->>'max_uses', '')::integer;
    v_expires_at := nullif(p_input->>'expires_at', '')::timestamptz;
    v_is_active := (p_input->>'is_active')::boolean;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end;
  if (v_max_uses is not null and (v_max_uses < 1 or v_max_uses > 100000))
     or (v_is_active and v_expires_at is not null and v_expires_at <= now()) then
    return json_build_object('ok', false, 'error', 'invalid_invite_lifetime');
  end if;

  -- The browser never chooses invitation secrets. A full UUID supplies 122+
  -- random bits after version/variant bits and is stored without separators.
  v_code := upper(replace(gen_random_uuid()::text, '-', ''));
  insert into public.registration_invites (
    code, label, default_role, max_uses, expires_at, is_active, created_by
  ) values (
    v_code, v_label, v_default_role, v_max_uses, v_expires_at, v_is_active, auth.uid()
  )
  returning id into v_id;

  return json_build_object('ok', true, 'id', v_id, 'code', v_code);
end
$function$;

create or replace function public.registration_invite_update_atomic(
  p_invite_id uuid,
  p_input jsonb
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_label text;
  v_default_role text;
  v_max_uses integer;
  v_expires_at timestamptz;
  v_is_active boolean;
  v_used_count integer;
begin
  if coalesce(public.current_user_has_capability('settings.manage'), false) is not true then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_invite_id is null or p_input is null or jsonb_typeof(p_input) <> 'object'
     or p_input ? 'code' or p_input ? 'used_count'
     or jsonb_typeof(p_input->'is_active') is distinct from 'boolean' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  v_label := nullif(btrim(p_input->>'label'), '');
  v_default_role := p_input->>'default_role';
  if length(v_label) > 200
     or v_default_role not in ('it_manager', 'employee', 'warehouse_manager', 'viewer') then
    return json_build_object('ok', false, 'error', 'invalid_invite_configuration');
  end if;
  begin
    v_max_uses := nullif(p_input->>'max_uses', '')::integer;
    v_expires_at := nullif(p_input->>'expires_at', '')::timestamptz;
    v_is_active := (p_input->>'is_active')::boolean;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end;
  if (v_max_uses is not null and (v_max_uses < 1 or v_max_uses > 100000))
     or (v_is_active and v_expires_at is not null and v_expires_at <= now()) then
    return json_build_object('ok', false, 'error', 'invalid_invite_lifetime');
  end if;

  select used_count into v_used_count
  from public.registration_invites
  where id = p_invite_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'invite_not_found');
  end if;
  if v_max_uses is not null and v_max_uses < v_used_count then
    return json_build_object('ok', false, 'error', 'max_uses_below_used_count');
  end if;

  update public.registration_invites
  set label = v_label,
      default_role = v_default_role,
      max_uses = v_max_uses,
      expires_at = v_expires_at,
      is_active = v_is_active
  where id = p_invite_id;

  return json_build_object('ok', true, 'id', p_invite_id);
end
$function$;

create or replace function public.registration_invite_set_active(
  p_invite_id uuid,
  p_is_active boolean
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce(public.current_user_has_capability('settings.manage'), false) is not true then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_invite_id is null or p_is_active is null then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  update public.registration_invites
  set is_active = p_is_active
  where id = p_invite_id
    and (
      not p_is_active
      or (
        (expires_at is null or expires_at > now())
        and (max_uses is null or used_count < max_uses)
      )
    );
  if not found then
    if exists (select 1 from public.registration_invites where id = p_invite_id) then
      return json_build_object('ok', false, 'error', 'invite_not_activatable');
    end if;
    return json_build_object('ok', false, 'error', 'invite_not_found');
  end if;

  return json_build_object('ok', true, 'id', p_invite_id);
end
$function$;

-- Internal claim operation used only by the Auth trigger. Holding the settings
-- row lock makes mode changes and gradual capacity deterministic; invite rows
-- are locked before counters are checked and incremented.
create or replace function public._registration_staff_claim(
  p_user_id uuid,
  p_email text,
  p_invite_code text
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_mode text;
  v_remaining_slots integer;
  v_allowed_domains text[];
  v_requested_role text;
  v_code text := nullif(btrim(p_invite_code), '');
  v_invite record;
begin
  if p_user_id is null or nullif(btrim(p_email), '') is null then
    raise exception 'invalid_staff_registration_identity' using errcode = '22023';
  end if;

  select mode, remaining_slots, allowed_domains, default_requested_role
  into v_mode, v_remaining_slots, v_allowed_domains, v_requested_role
  from public.registration_settings
  where id = 'main'
  for update;

  if not found or v_mode is null then
    raise exception 'staff_registration_configuration_missing' using errcode = '22023';
  end if;
  if v_mode = 'closed' then
    raise exception 'staff_registration_closed' using errcode = '22023';
  end if;
  if v_mode not in ('open_with_approval', 'gradual', 'invite_only')
     or v_requested_role is null
     or v_requested_role not in ('it_manager', 'employee', 'warehouse_manager', 'viewer') then
    raise exception 'staff_registration_configuration_invalid' using errcode = '22023';
  end if;

  if coalesce(cardinality(v_allowed_domains), 0) > 0
     and not exists (
       select 1
       from unnest(v_allowed_domains) as domain(value)
       where lower(ltrim(btrim(domain.value), '@')) = lower(split_part(p_email, '@', 2))
     ) then
    raise exception 'staff_registration_domain_not_allowed' using errcode = '22023';
  end if;

  if v_mode = 'invite_only' and v_code is null then
    raise exception 'staff_registration_invite_required' using errcode = '22023';
  end if;
  if v_mode = 'gradual' and v_remaining_slots <= 0 then
    raise exception 'staff_registration_capacity_exhausted' using errcode = '22023';
  end if;

  if v_code is not null then
    select id, default_role, max_uses, used_count
    into v_invite
    from public.registration_invites
    where lower(code) = lower(v_code)
      and is_active = true
      and (expires_at is null or expires_at > now())
      and (max_uses is null or used_count < max_uses)
    limit 1
    for update;
    if not found then
      raise exception 'staff_registration_invite_invalid' using errcode = '22023';
    end if;
    if v_invite.default_role not in ('it_manager', 'employee', 'warehouse_manager', 'viewer') then
      raise exception 'staff_registration_invite_invalid' using errcode = '22023';
    end if;

    v_requested_role := v_invite.default_role;
    update public.registration_invites
    set used_count = used_count + 1
    where id = v_invite.id;
    insert into public.registration_invite_uses (invite_id, user_id, email)
    values (v_invite.id, p_user_id, p_email);
  end if;

  if v_mode = 'gradual' then
    update public.registration_settings
    set remaining_slots = remaining_slots - 1
    where id = 'main' and remaining_slots > 0;
    if not found then
      raise exception 'staff_registration_capacity_exhausted' using errcode = '22023';
    end if;
  end if;

  return v_requested_role;
end
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_full_name text := nullif(meta->>'full_name','');
  v_phone text := nullif(meta->>'phone','');
  v_note text := nullif(meta->>'registration_note','');
  v_code text := nullif(meta->>'invite_code','');
  v_dept uuid;
  v_requested_role text;
  v_pinvite record;
  v_new_cust uuid;
begin
  if coalesce(meta->>'user_type','') = 'portal' then
    if btrim(coalesce(v_phone,'')) = '' then
      raise exception 'phone is required for portal registration' using errcode = '23514';
    end if;
    if v_code is not null then
      select * into v_pinvite
      from public.customer_portal_invites
      where lower(code) = lower(coalesce(v_code,''))
        and is_active = true and expires_at > now() and used_count < max_uses
      order by created_at desc
      limit 1
      for update;
      if not found then
        raise exception 'invalid_portal_invite' using errcode = '22023';
      end if;
      insert into public.customer_portal_users (
        id, customer_id, contact_name, phone, portal_role, invited_by
      ) values (
        new.id, v_pinvite.customer_id,
        coalesce(v_full_name, split_part(new.email,'@',1)),
        v_phone, v_pinvite.portal_role, v_pinvite.created_by
      );
      update public.customer_portal_invites
      set used_count = used_count + 1
      where id = v_pinvite.id;
      return new;
    end if;

    insert into public.customers (
      name, phone, email, city, approval_status, is_active, created_by
    ) values (
      coalesce(nullif(meta->>'company_name',''), v_full_name, split_part(new.email,'@',1)),
      v_phone, new.email, nullif(meta->>'city',''), 'pending', true, new.id
    )
    returning id into v_new_cust;
    insert into public.customer_portal_users (
      id, customer_id, contact_name, phone, portal_role
    ) values (
      new.id, v_new_cust,
      coalesce(v_full_name, split_part(new.email,'@',1)), v_phone, 'project_manager'
    );
    return new;
  end if;

  begin
    v_dept := (meta->>'department_id')::uuid;
  exception when others then
    v_dept := null;
  end;

  -- requested_role in user metadata is intentionally ignored. Only validated
  -- server configuration or an atomically claimed invite can suggest a role.
  v_requested_role := public._registration_staff_claim(new.id, new.email, v_code);

  insert into public.app_users (
    id, email, role_id, full_name, phone, department_id,
    registration_note, requested_role, approval_status, is_active
  ) values (
    new.id, new.email,
    (select id from public.roles where key = 'viewer'),
    v_full_name, v_phone, v_dept, v_note,
    v_requested_role, 'pending', true
  )
  on conflict (id) do nothing;

  return new;
end
$function$;

revoke all on function public.registration_settings_update_atomic(jsonb)
from public, anon;
revoke all on function public.registration_invite_create_atomic(jsonb)
from public, anon;
revoke all on function public.registration_invite_update_atomic(uuid, jsonb)
from public, anon;
revoke all on function public.registration_invite_set_active(uuid, boolean)
from public, anon;
grant execute on function public.registration_settings_update_atomic(jsonb)
to authenticated, service_role;
grant execute on function public.registration_invite_create_atomic(jsonb)
to authenticated, service_role;
grant execute on function public.registration_invite_update_atomic(uuid, jsonb)
to authenticated, service_role;
grant execute on function public.registration_invite_set_active(uuid, boolean)
to authenticated, service_role;

revoke all on function public._registration_staff_claim(uuid, text, text)
from public, anon, authenticated;
revoke all on function public.handle_new_user()
from public, anon, authenticated;

revoke insert, update, delete on
  public.registration_settings,
  public.registration_invites,
  public.registration_invite_uses
from public, anon, authenticated;

drop policy if exists ins_mgr on public.registration_settings;
drop policy if exists upd_mgr on public.registration_settings;
drop policy if exists del_mgr on public.registration_settings;
drop policy if exists ins_mgr on public.registration_invites;
drop policy if exists upd_mgr on public.registration_invites;
drop policy if exists del_mgr on public.registration_invites;
drop policy if exists ins_mgr on public.registration_invite_uses;
drop policy if exists upd_mgr on public.registration_invite_uses;
drop policy if exists del_mgr on public.registration_invite_uses;

-- Registration codes are bearer secrets. Extend the shared audit sanitizer so
-- the exact `code` column is redacted without hiding operational cause codes.
create or replace function public._audit_sanitize(p_value jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value) = 'object' then
    select coalesce(jsonb_object_agg(
      key,
      case
        when key ~* '(^code$|secret|token|password|authorization|api[_-]?key|cookie|signature|private[_-]?key|purchase[_-]?cost|unit[_-]?cost|unit[_-]?price|total[_-]?price|annual[_-]?rate|salvage[_-]?rate|invoice|email|phone|contact|customer[_-]?name|storage[_-]?path|notes?|message|description)'
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

drop trigger if exists trg_unified_audit on public.registration_settings;
create trigger trg_unified_audit
after insert or update or delete on public.registration_settings
for each row execute function public._audit_row_change();

drop trigger if exists trg_unified_audit on public.registration_invites;
create trigger trg_unified_audit
after insert or update or delete on public.registration_invites
for each row execute function public._audit_row_change();

drop trigger if exists trg_unified_audit on public.registration_invite_uses;
create trigger trg_unified_audit
after insert or update or delete on public.registration_invite_uses
for each row execute function public._audit_row_change();

commit;
