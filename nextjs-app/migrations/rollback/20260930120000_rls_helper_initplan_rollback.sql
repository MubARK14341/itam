-- Rollback for 20260930120000_rls_helper_initplan.sql: unwrap the (SELECT helper()) calls so every
-- public policy evaluates the helpers per row again. Policy logic is identical either way. Calls that
-- were already wrapped before the migration are unwrapped too, which only affects speed.

begin;

create function pg_temp.rls_unwrap(expr text) returns text
language sql immutable as $unwrap$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               expr,
               '\( SELECT (public\.)?(is_approved|app_user_role|current_employee_id|is_portal_user|is_financial_viewer)\(\) AS [a-z_]+\)',
               '\2()', 'g'),
             '\( SELECT (public\.)?current_user_has_capability\((''[^'']*''::text)\) AS [a-z_]+\)',
             'current_user_has_capability(\2)', 'g'),
           '\( SELECT auth\.uid\(\) AS uid\)',
           'auth.uid()', 'g')
$unwrap$;

do $rls_helper_initplan_rollback$
declare
  r record;
  v_using text;
  v_check text;
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
    v_using := case when r.using_expr is null then null else pg_temp.rls_unwrap(r.using_expr) end;
    v_check := case when r.check_expr is null then null else pg_temp.rls_unwrap(r.check_expr) end;
    if v_using is distinct from r.using_expr then
      execute format('alter policy %I on %I.%I using (%s)', r.polname, r.nspname, r.relname, v_using);
    end if;
    if v_check is distinct from r.check_expr then
      execute format('alter policy %I on %I.%I with check (%s)', r.polname, r.nspname, r.relname, v_check);
    end if;
  end loop;
end
$rls_helper_initplan_rollback$;

commit;
