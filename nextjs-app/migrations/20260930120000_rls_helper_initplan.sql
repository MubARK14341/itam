-- Purpose: evaluate row-independent RLS helper calls once per statement (an InitPlan) instead of
-- once per row. Every staff table's policy calls SECURITY DEFINER helpers such as is_approved() and
-- app_user_role(); those are never inlined, so each call is a separate query per row and per joined
-- table. On Staging the asset list with its 8 embeds spent 393 ms in the database; the same query
-- with the helpers evaluated once took ~6 ms.
--
-- Semantics: unchanged. Only zero-argument helpers that depend on nothing but auth.uid()/JWT claims
-- (is_approved, app_user_role, current_employee_id, is_portal_user, is_financial_viewer, auth.uid)
-- and current_user_has_capability('<literal>') are wrapped as (SELECT fn()). They are STABLE and
-- constant within a statement, so evaluating them once yields the same result. Helpers that take a
-- row value (attachment/storage checks, split_part, …) are left untouched. Only the public schema.
--
-- Risk: low; the migration asserts that no bare wrapped-helper call remains and aborts otherwise.
-- Rollback: migrations/rollback/20260930120000_rls_helper_initplan_rollback.sql unwraps the calls.

begin;

create function pg_temp.rls_wrap(expr text) returns text
language sql immutable as $wrap$
  -- A call is wrapped only when it is not already the target of "SELECT " and is not the tail of a
  -- longer identifier (so public.fn() is matched from "public." and never again from "fn").
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               expr,
               '(?<!SELECT )(?<![[:alnum:]_.])(public\.)?(is_approved|app_user_role|current_employee_id|is_portal_user|is_financial_viewer)\(\)',
               '( SELECT public.\2() AS \2)', 'g'),
             '(?<!SELECT )(?<![[:alnum:]_.])(public\.)?current_user_has_capability\((''[^'']*''::text)\)',
             '( SELECT public.current_user_has_capability(\2) AS current_user_has_capability)', 'g'),
           '(?<!SELECT )(?<![[:alnum:]_.])auth\.uid\(\)',
           '( SELECT auth.uid() AS uid)', 'g')
$wrap$;

do $rls_helper_initplan$
declare
  r record;
  v_using text;
  v_check text;
  v_changed integer := 0;
  v_remaining integer;
begin
  for r in
    select n.nspname, c.relname, p.polname,
           pg_get_expr(p.polqual, p.polrelid) as using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
  loop
    v_using := case when r.using_expr is null then null else pg_temp.rls_wrap(r.using_expr) end;
    v_check := case when r.check_expr is null then null else pg_temp.rls_wrap(r.check_expr) end;
    if v_using is distinct from r.using_expr then
      execute format('alter policy %I on %I.%I using (%s)', r.polname, r.nspname, r.relname, v_using);
    end if;
    if v_check is distinct from r.check_expr then
      execute format('alter policy %I on %I.%I with check (%s)', r.polname, r.nspname, r.relname, v_check);
    end if;
    if v_using is distinct from r.using_expr or v_check is distinct from r.check_expr then
      v_changed := v_changed + 1;
    end if;
  end loop;

  select count(*) into v_remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
        ~ '(?<!SELECT )(?<![[:alnum:]_.])(public\.)?(is_approved|app_user_role|current_employee_id|is_portal_user|is_financial_viewer)\(\)';
  if v_remaining > 0 then
    raise exception 'rls_helper_initplan: % policies still call a helper per row', v_remaining;
  end if;
  raise notice 'rls_helper_initplan: % policies now evaluate helpers once per statement', v_changed;
end
$rls_helper_initplan$;

commit;
