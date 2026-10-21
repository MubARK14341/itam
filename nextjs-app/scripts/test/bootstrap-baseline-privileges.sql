-- TEST ONLY — never apply to production.
--
-- The generated 2026-07-07 baseline intentionally contains public-schema
-- structure, functions, triggers, and RLS policies but no GRANT/REVOKE state.
-- A clean Supabase restore therefore needs this explicit privilege bootstrap
-- before the committed post-baseline migrations are replayed.
--
-- This reproduces the hardened starting posture from dev-only/secure_rls.sql:
-- no direct anon table/sequence access, authenticated table access constrained
-- by RLS, and no implicit PUBLIC function execution. The financial column
-- correction migration is replayed immediately after this file.

begin;

revoke all on all tables in schema public from public, anon;
revoke all on all sequences in schema public from public, anon;

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all privileges on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;

-- Purchase tables were created after HIGH-1b but before the schema-only snapshot.
-- Restore their canonical READ boundary from 20260705132000_purchase_requests
-- and the two operational columns from 20260706130000_request_item_purchase_bridge.
-- Later migrations retain their own explicit column grants; unit_cost is read
-- only through purchase_request_items_financial, including for administrators.
revoke select on public.purchase_request_items from authenticated;
revoke select (unit_cost) on public.purchase_request_items from authenticated;
grant select (id, purchase_request_id, consumable_id, requested_quantity, received_quantity,
              suggested_quantity, notes, created_at, updated_at, description, source_request_item_id)
  on public.purchase_request_items to authenticated;

do $purchase_read_boundary$
begin
  if has_table_privilege('authenticated', 'public.purchase_request_items', 'SELECT')
     or has_column_privilege('authenticated', 'public.purchase_request_items', 'unit_cost', 'SELECT')
     or has_column_privilege('anon', 'public.purchase_request_items', 'unit_cost', 'SELECT') then
    raise exception 'local bootstrap must preserve the purchase financial column boundary';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.purchase_request_items'::regclass) then
    raise exception 'local bootstrap requires purchase item RLS';
  end if;
end
$purchase_read_boundary$;

-- A schema-only restore otherwise leaves PostgreSQL's default PUBLIC EXECUTE
-- grant on every restored function. Start closed, then expose application RPCs
-- only to authenticated callers. Trigger and private helper functions are not
-- callable through PostgREST.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to authenticated, service_role;

do $bootstrap_privileges$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.prorettype = 'trigger'::regtype
        or p.proname like '\_%' escape '\'
      )
  loop
    execute format(
      'revoke execute on function %s from authenticated;',
      v_function
    );
  end loop;
end
$bootstrap_privileges$;

-- These two validation entrypoints are intentionally public before sign-in.
grant execute on function public.validate_portal_invite(text) to anon, authenticated;
grant execute on function public.validate_registration_invite(text) to anon, authenticated;

-- QR lookup is the sole anonymous operational endpoint.
grant execute on function public.public_asset_by_token(text) to anon, authenticated;

commit;
