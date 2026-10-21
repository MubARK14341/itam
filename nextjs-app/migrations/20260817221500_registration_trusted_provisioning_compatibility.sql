-- Purpose: preserve trusted service-role Auth provisioning while keeping all
-- public staff signups behind the database-enforced registration admission gate.
-- Risk: service-role Auth creation bypasses public registration mode/slot/domain
-- checks but can create only a pending viewer request; user metadata roles remain
-- ignored. Browser roles still cannot execute this internal function directly.
-- Rollback: restore _registration_staff_claim from the immediately prior migration.

begin;

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

  -- Auth Admin operations carry a service_role request claim. Preserve that
  -- trusted provisioning path without trusting any requested role or invite in
  -- user metadata; the resulting application account is still pending/viewer.
  if auth.role() = 'service_role' then
    return 'viewer';
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

revoke all on function public._registration_staff_claim(uuid, text, text)
from public, anon, authenticated, service_role;

commit;
