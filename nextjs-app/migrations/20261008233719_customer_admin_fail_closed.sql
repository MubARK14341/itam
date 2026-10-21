-- Purpose: close nullable-role authorization in customer administration RPCs.
-- Portal/pending/inactive staff actors cannot save, activate or approve clients.
-- Existing signatures, validation, row locks, writes and responses are retained.
-- Additive, no table/RLS/data rewrite; verified local application only.
-- Rollback: restore the prior definitions only after supplying an equivalent
-- fail-closed actor gate. Never restore the nullable NOT IN authorization alone.
begin;

do $migration$
declare
  v_signature text;
  v_definition text;
  v_security_definer boolean;
  v_config text[];
  v_anchor text := $guard$or public.app_user_role() not in ('admin', 'it_manager') then$guard$;
  v_guard text := $guard$or public.is_approved() is distinct from true
     or public.app_user_role() is null
     or public.app_user_role() not in ('admin', 'it_manager') then$guard$;
begin
  foreach v_signature in array array[
    'public.customer_save_atomic(uuid,jsonb)',
    'public.customer_set_active(uuid,boolean)',
    'public.approve_customer(uuid,boolean)'
  ] loop
    select pg_catalog.pg_get_functiondef(p.oid), p.prosecdef, p.proconfig
    into v_definition, v_security_definer, v_config
    from pg_catalog.pg_proc p
    where p.oid = v_signature::regprocedure;
    if not coalesce(v_security_definer, false)
       or not coalesce('search_path=public' = any(v_config), false) then
      raise exception 'Customer administration function configuration differs from the reviewed contract: %', v_signature;
    end if;
    if position(v_guard in v_definition) > 0 then
      continue;
    end if;
    if position(v_anchor in v_definition) = 0 then
      raise exception 'Customer administration actor guard differs from the reviewed contract: %', v_signature;
    end if;
    execute replace(v_definition, v_anchor, v_guard);
  end loop;
end;
$migration$;

revoke all on function public.customer_save_atomic(uuid, jsonb) from public, anon;
revoke all on function public.customer_set_active(uuid, boolean) from public, anon;
revoke all on function public.approve_customer(uuid, boolean) from public, anon;
grant execute on function public.customer_save_atomic(uuid, jsonb) to authenticated;
grant execute on function public.customer_set_active(uuid, boolean) to authenticated;
grant execute on function public.approve_customer(uuid, boolean) to authenticated;

commit;
