-- Purpose: Mirror the reviewed archived_at column grant in disposable local E2E
-- rebuilds. The original 20260810020000 migration stays Production-manual-only.
-- Risk: Local-only SELECT on one non-financial marker; RLS is unchanged. Never
-- run this bootstrap against a hosted database or grant whole-table SELECT.
-- Rollback: Rebuild the disposable local fixture, or revoke this column grant.

begin;

grant select (archived_at) on table public.assets to authenticated;

do $local_grant_assertions$
begin
  if has_table_privilege('authenticated', 'public.assets', 'SELECT')
     or has_column_privilege('authenticated', 'public.assets', 'purchase_cost', 'SELECT')
     or has_column_privilege('authenticated', 'public.assets', 'salvage_rate', 'SELECT') then
    raise exception 'local bootstrap must preserve the financial column boundary';
  end if;
  if has_column_privilege('anon', 'public.assets', 'archived_at', 'SELECT') then
    raise exception 'local bootstrap must not grant anonymous asset access';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.assets'::regclass) then
    raise exception 'local bootstrap requires asset RLS';
  end if;
end
$local_grant_assertions$;

commit;
