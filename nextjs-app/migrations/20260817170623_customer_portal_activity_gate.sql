-- Purpose: make customer administration RPC-only and make the portal identity
-- boundary fail closed for inactive, unapproved, or explicitly disabled customers.
-- Risk: authenticated direct customer writes are removed. Disabled portal accounts
-- can still resolve portal_get_context() to render the disabled-state UI, but every
-- operational portal helper now receives a null access identity.
-- Rollback: restore the former customer DML grants/policies and prior portal identity
-- helpers. Do not restore the inactive-customer portal bypass.

create or replace function public._portal_settings(p_customer_id uuid)
returns public.customer_portal_settings
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v public.customer_portal_settings;
begin
  select * into v
  from public.customer_portal_settings
  where customer_id = p_customer_id;

  if not found then
    v.customer_id                      := p_customer_id;
    v.portal_enabled                   := false;
    v.allow_rental_requests            := true;
    v.allow_purchase_requests          := true;
    v.allow_maintenance_requests       := true;
    v.allow_custom_requests            := true;
    v.allow_custom_item_requests       := true;
    v.allow_attachments                := true;
    v.require_project_manager_approval := false;
  end if;

  if not exists (
    select 1
    from public.customers c
    where c.id = p_customer_id
      and c.is_active = true
      and coalesce(c.approval_status, 'approved') = 'approved'
  ) then
    v.portal_enabled := false;
  end if;
  return v;
end
$function$;

-- Account identity is intentionally internal. It lets portal_get_context render a
-- disabled state without granting any operational portal RPC an access identity.
create or replace function public.portal_account_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
  select cpu.customer_id
  from public.customer_portal_users cpu
  where cpu.id = auth.uid()
    and cpu.is_active = true;
$function$;

-- This is the central operational identity boundary used by portal RPCs and storage
-- policies. Unknown, inactive, unapproved, and disabled customers all fail closed.
create or replace function public.portal_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $function$
  select cpu.customer_id
  from public.customer_portal_users cpu
  join public.customers c on c.id = cpu.customer_id
  join public.customer_portal_settings s on s.customer_id = cpu.customer_id
  where cpu.id = auth.uid()
    and cpu.is_active = true
    and c.is_active = true
    and coalesce(c.approval_status, 'approved') = 'approved'
    and s.portal_enabled = true;
$function$;

create or replace function public.portal_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $function$
  select cpu.portal_role
  from public.customer_portal_users cpu
  where cpu.id = auth.uid()
    and cpu.is_active = true
    and cpu.customer_id = public.portal_customer_id();
$function$;

create or replace function public.is_portal_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select public.portal_customer_id() is not null;
$function$;

create or replace function public.portal_get_context()
returns json
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_cid uuid := public.portal_account_customer_id();
  v_role text;
  v_name text;
  v_contact text;
  v_s public.customer_portal_settings;
  v_companies int;
  v_categories int;
begin
  if v_cid is null then
    return json_build_object('ok', false, 'error', 'not_portal');
  end if;

  select c.name, pu.contact_name, pu.portal_role
  into v_name, v_contact, v_role
  from public.customer_portal_users pu
  join public.customers c on c.id = pu.customer_id
  where pu.id = auth.uid()
    and pu.is_active = true;

  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then
    return json_build_object(
      'ok', true,
      'customer_name', v_name,
      'contact_name', v_contact,
      'portal_role', v_role,
      'portal_enabled', false,
      'disabled', true,
      'allow_rental_requests', false,
      'allow_purchase_requests', false,
      'allow_maintenance_requests', false,
      'allow_custom_requests', false,
      'allow_custom_item_requests', false,
      'allow_attachments', false,
      'require_project_manager_approval', false,
      'allowed_companies_count', 0,
      'allowed_categories_count', 0
    );
  end if;

  select count(*) into v_companies
  from public.customer_allowed_companies
  where customer_id = v_cid;
  select count(*) into v_categories
  from public.customer_allowed_categories
  where customer_id = v_cid;

  return json_build_object(
    'ok', true,
    'customer_name', v_name,
    'contact_name', v_contact,
    'portal_role', v_role,
    'portal_enabled', true,
    'disabled', false,
    'allow_rental_requests', v_s.allow_rental_requests,
    'allow_purchase_requests', v_s.allow_purchase_requests,
    'allow_maintenance_requests', v_s.allow_maintenance_requests,
    'allow_custom_requests', v_s.allow_custom_requests,
    'allow_custom_item_requests', v_s.allow_custom_item_requests,
    'allow_attachments', v_s.allow_attachments,
    'require_project_manager_approval', v_s.require_project_manager_approval,
    'allowed_companies_count', v_companies,
    'allowed_categories_count', v_categories
  );
end
$function$;

create or replace function public.customer_save_atomic(
  p_customer_id uuid,
  p_input jsonb
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_name text := nullif(btrim(p_input->>'name'), '');
  v_is_active boolean;
begin
  if v_actor is null
     or public.app_user_role() not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  if p_input is null
     or jsonb_typeof(p_input) <> 'object'
     or v_name is null
     or length(v_name) > 200
     or length(coalesce(p_input->>'contact_person', '')) > 200
     or length(coalesce(p_input->>'phone', '')) > 64
     or length(coalesce(p_input->>'email', '')) > 320
     or length(coalesce(p_input->>'city', '')) > 200
     or length(coalesce(p_input->>'address', '')) > 2000
     or length(coalesce(p_input->>'notes', '')) > 10000
     or (p_input ? 'is_active' and jsonb_typeof(p_input->'is_active') <> 'boolean')
     or exists (
       select 1
       from unnest(array[
         'name', 'contact_person', 'phone', 'email', 'city', 'address', 'notes'
       ]) as field(name)
       where p_input ? field.name
         and jsonb_typeof(p_input->field.name) not in ('string', 'null')
     ) then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  v_is_active := coalesce((p_input->>'is_active')::boolean, true);

  if p_customer_id is null then
    insert into public.customers (
      name,
      contact_person,
      phone,
      email,
      city,
      address,
      notes,
      is_active,
      approval_status,
      created_by
    ) values (
      v_name,
      nullif(btrim(p_input->>'contact_person'), ''),
      nullif(btrim(p_input->>'phone'), ''),
      nullif(btrim(p_input->>'email'), ''),
      nullif(btrim(p_input->>'city'), ''),
      nullif(btrim(p_input->>'address'), ''),
      nullif(btrim(p_input->>'notes'), ''),
      v_is_active,
      'approved',
      v_actor
    )
    returning id into v_id;
  else
    select id into v_id
    from public.customers
    where id = p_customer_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'not_found');
    end if;

    update public.customers
    set name = v_name,
        contact_person = nullif(btrim(p_input->>'contact_person'), ''),
        phone = nullif(btrim(p_input->>'phone'), ''),
        email = nullif(btrim(p_input->>'email'), ''),
        city = nullif(btrim(p_input->>'city'), ''),
        address = nullif(btrim(p_input->>'address'), ''),
        notes = nullif(btrim(p_input->>'notes'), ''),
        is_active = v_is_active,
        updated_at = now()
    where id = v_id;
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$function$;

create or replace function public.customer_set_active(
  p_customer_id uuid,
  p_is_active boolean
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null
     or public.app_user_role() not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_customer_id is null or p_is_active is null then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;

  update public.customers
  set is_active = p_is_active,
      updated_at = now()
  where id = p_customer_id
  returning id into v_id;

  if v_id is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object('ok', true, 'id', v_id);
end
$function$;

create or replace function public.approve_customer(
  p_customer_id uuid,
  p_approve boolean
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null
     or public.app_user_role() not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_customer_id is null or p_approve is null then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;

  select id into v_id
  from public.customers
  where id = p_customer_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_approve then
    update public.customers
    set approval_status = 'approved',
        is_active = true,
        updated_at = now()
    where id = v_id;
    insert into public.customer_portal_settings (customer_id, portal_enabled)
    values (v_id, true)
    on conflict (customer_id) do update
    set portal_enabled = true,
        updated_at = now();
  else
    update public.customers
    set approval_status = 'rejected',
        is_active = false,
        updated_at = now()
    where id = v_id;
    update public.customer_portal_settings
    set portal_enabled = false,
        updated_at = now()
    where customer_id = v_id;
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$function$;

drop policy if exists ins_mgr on public.customers;
drop policy if exists upd_mgr on public.customers;
drop policy if exists del_admin on public.customers;

revoke insert, update, delete on table public.customers
  from public, anon, authenticated;

revoke all on function public.portal_account_customer_id()
  from public, anon, authenticated, service_role;
revoke all on function public._portal_settings(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.portal_customer_id()
  from public, anon, authenticated, service_role;
revoke all on function public.portal_user_role()
  from public, anon, authenticated, service_role;
revoke all on function public.is_portal_user()
  from public, anon, authenticated, service_role;
revoke all on function public.portal_get_context()
  from public, anon, authenticated, service_role;
revoke all on function public.customer_save_atomic(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.customer_set_active(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.approve_customer(uuid, boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.portal_customer_id() to authenticated;
grant execute on function public.portal_user_role() to authenticated;
grant execute on function public.is_portal_user() to authenticated;
grant execute on function public.portal_get_context() to authenticated;
grant execute on function public.customer_save_atomic(uuid, jsonb) to authenticated;
grant execute on function public.customer_set_active(uuid, boolean) to authenticated;
grant execute on function public.approve_customer(uuid, boolean) to authenticated;

comment on function public.portal_account_customer_id() is
  'Internal identity helper used only to render the disabled portal context.';
comment on function public.portal_customer_id() is
  'Fail-closed operational portal identity for active, approved, enabled customers.';
comment on function public.customer_save_atomic(uuid, jsonb) is
  'Role-gated atomic customer create/update after direct browser DML was removed.';
comment on function public.customer_set_active(uuid, boolean) is
  'Role-gated activation toggle enforced by the central portal identity boundary.';
