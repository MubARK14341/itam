-- Purpose: make supplier metadata and category membership one serialized,
-- DB-authorized operation instead of several independently committed browser writes.
-- Risk: direct authenticated DML is removed; the replacement RPCs preserve the
-- existing admin/IT-manager authorization and retain read access for approved users.
-- Rollback: restore the former write policies/grants and drop the two RPCs.

create or replace function public.supplier_save_atomic(
  p_supplier_id uuid,
  p_input jsonb
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid;
  v_name text := nullif(btrim(p_input->>'name'), '');
  v_name_ar text := nullif(btrim(p_input->>'name_ar'), '');
  v_category_ids uuid[] := '{}'::uuid[];
  v_is_active boolean;
begin
  if auth.uid() is null
     or public.app_user_role() not in ('admin', 'it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  if p_input is null
     or jsonb_typeof(p_input) <> 'object'
     or v_name is null
     or length(v_name) > 200
     or length(coalesce(v_name_ar, '')) > 200
     or length(coalesce(p_input->>'contact_person', '')) > 200
     or length(coalesce(p_input->>'email', '')) > 320
     or length(coalesce(p_input->>'phone', '')) > 64
     or length(coalesce(p_input->>'address', '')) > 2000
     or length(coalesce(p_input->>'notes', '')) > 10000
     or (p_input ? 'is_active' and jsonb_typeof(p_input->'is_active') <> 'boolean')
     or (p_input ? 'category_ids' and jsonb_typeof(p_input->'category_ids') <> 'array') then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if jsonb_array_length(coalesce(p_input->'category_ids', '[]'::jsonb)) > 500 then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  v_is_active := coalesce((p_input->>'is_active')::boolean, true);

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(p_input->'category_ids', '[]'::jsonb)) as item(value)
    where item.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_category');
  end if;

  select coalesce(array_agg(distinct item.value::uuid), '{}'::uuid[])
  into v_category_ids
  from jsonb_array_elements_text(coalesce(p_input->'category_ids', '[]'::jsonb)) as item(value);

  if exists (
    select 1
    from unnest(v_category_ids) as requested(id)
    left join public.categories c on c.id = requested.id
    where c.id is null
  ) then
    return json_build_object('ok', false, 'error', 'invalid_category');
  end if;

  if p_supplier_id is null then
    insert into public.suppliers (
      name, name_ar, contact_person, phone, email, address, notes, is_active
    ) values (
      v_name,
      coalesce(v_name_ar, v_name),
      nullif(btrim(p_input->>'contact_person'), ''),
      nullif(btrim(p_input->>'phone'), ''),
      nullif(btrim(p_input->>'email'), ''),
      nullif(btrim(p_input->>'address'), ''),
      nullif(btrim(p_input->>'notes'), ''),
      v_is_active
    )
    returning id into v_id;
  else
    perform 1
    from public.suppliers
    where id = p_supplier_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'not_found');
    end if;

    update public.suppliers
    set name = v_name,
        name_ar = coalesce(v_name_ar, v_name),
        contact_person = nullif(btrim(p_input->>'contact_person'), ''),
        phone = nullif(btrim(p_input->>'phone'), ''),
        email = nullif(btrim(p_input->>'email'), ''),
        address = nullif(btrim(p_input->>'address'), ''),
        notes = nullif(btrim(p_input->>'notes'), ''),
        is_active = v_is_active,
        updated_at = now()
    where id = p_supplier_id;
    v_id := p_supplier_id;
  end if;

  delete from public.supplier_categories
  where supplier_id = v_id
    and not (category_id = any(v_category_ids));

  insert into public.supplier_categories (supplier_id, category_id)
  select v_id, category_id
  from unnest(v_category_ids) as requested(category_id)
  on conflict (supplier_id, category_id) do nothing;

  return json_build_object('ok', true, 'id', v_id);
end
$function$;

create or replace function public.supplier_set_active(
  p_supplier_id uuid,
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
  if p_supplier_id is null or p_is_active is null then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;

  update public.suppliers
  set is_active = p_is_active,
      updated_at = now()
  where id = p_supplier_id
  returning id into v_id;

  if v_id is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object('ok', true, 'id', v_id);
end
$function$;

drop policy if exists del_mgr on public.supplier_categories;
drop policy if exists ins_mgr on public.supplier_categories;
drop policy if exists upd_mgr on public.supplier_categories;
drop policy if exists del_admin on public.suppliers;
drop policy if exists ins_ops on public.suppliers;
drop policy if exists upd_admin on public.suppliers;

drop trigger if exists trg_unified_audit on public.suppliers;
create trigger trg_unified_audit
after insert or update or delete on public.suppliers
for each row execute function public._audit_row_change();

drop trigger if exists trg_unified_audit on public.supplier_categories;
create trigger trg_unified_audit
after insert or update or delete on public.supplier_categories
for each row execute function public._audit_row_change();

revoke insert, update, delete on table public.suppliers
  from public, anon, authenticated;
revoke insert, update, delete on table public.supplier_categories
  from public, anon, authenticated;

revoke all on function public.supplier_save_atomic(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.supplier_set_active(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.supplier_save_atomic(uuid, jsonb)
  to authenticated;
grant execute on function public.supplier_set_active(uuid, boolean)
  to authenticated;

comment on function public.supplier_save_atomic(uuid, jsonb) is
  'Atomically creates/updates one supplier and replaces its category membership.';
comment on function public.supplier_set_active(uuid, boolean) is
  'Role-gated supplier activation toggle after direct browser DML was removed.';
