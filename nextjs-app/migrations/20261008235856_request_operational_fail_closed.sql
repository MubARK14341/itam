-- Purpose: deny unapproved, inactive and non-staff callers before the five
-- exact-asset request RPCs read or mutate workflow/custody evidence.
-- Evidence: an authenticated pending actor could select/reserve an owned TEST
-- device through request_allocate_asset. Portal/pending callers also reached
-- preparation, readiness, delivery and return validation through NULL roles.
-- Risk: only entry guards change. Existing accepted staff roles, arguments,
-- locks, validation, custody transactions, signatures and grants stay intact.
-- Rollback: replace the reviewed five function bodies only while retaining an
-- equivalent fail-closed approved/active staff gate. Do not restore the prior
-- nullable NOT IN authorization. No rows, RLS policies or constraints are rewritten.

begin;

do $migration$
declare
  v_target record;
  v_definition text;
  v_replacement text;
begin
  for v_target in
    select * from (values
      ('public.request_allocate_asset(uuid,uuid,uuid)',
       'if v_role not in (''admin'',''it_manager'',''technician'',''warehouse_manager'') or p_operation_id is null then'),
      ('public.request_prepare_allocated_assets(uuid,uuid)',
       'if v_role not in (''admin'',''it_manager'',''technician'',''warehouse_manager'') or p_operation_id is null then'),
      ('public.request_confirm_ready(uuid)',
       'if v_role not in (''admin'', ''it_manager'', ''technician'', ''warehouse_manager'') then'),
      ('public.request_deliver_with_proof(uuid,jsonb,uuid)',
       'if v_role not in (''admin'',''it_manager'',''technician'',''warehouse_manager'') or p_operation_id is null then'),
      ('public.request_inspect_return(uuid,jsonb)',
       'if v_role not in (''admin'',''it_manager'',''technician'',''warehouse_manager'') then')
    ) as targets(signature, anchor)
  loop
    v_definition := pg_get_functiondef(v_target.signature::regprocedure);
    v_replacement := replace(v_target.anchor, 'if v_role',
      'if public.is_approved() is distinct from true or v_role is null or v_role');
    if position(v_replacement in v_definition) = 0 then
      if position(v_target.anchor in v_definition) = 0 then
        raise exception 'request authorization guard differs from reviewed definition: %', v_target.signature;
      end if;
      execute replace(v_definition, v_target.anchor, v_replacement);
    end if;
  end loop;
end;
$migration$;

commit;
