-- FINAL DB APPROVAL REQUIRED — local only, do not apply with db push.
-- Decision: warehouse_manager operates through request fulfilment and scan flows;
-- it has no documented direct-custody use case outside those workflows.
-- This removes it from the three generic asset custody RPC guards only.
-- Rollback SQL is documented in docs/qa/migration-drift-safety.md.

do $migration$
declare
  target record;
  definition text;
begin
  for target in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array['asset_assign', 'asset_return', 'asset_change_status'])
  loop
    definition := pg_get_functiondef(target.oid);
    if position($roles$'admin','it_manager','technician','warehouse_manager'$roles$ in definition) > 0 then
      definition := replace(
        definition,
        $roles$'admin','it_manager','technician','warehouse_manager'$roles$,
        $roles$'admin','it_manager','technician'$roles$
      );
      execute definition;
    end if;
  end loop;
end
$migration$;
