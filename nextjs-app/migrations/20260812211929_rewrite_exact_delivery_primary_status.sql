-- Purpose: align exact-proof delivery with the canonical current asset status contract.
-- Risk: rewrites only the legacy status targets inside the existing privileged RPC;
--       its exact-allocation, custody, proof, audit, and idempotency logic is retained.
-- Rollback: restore the prior request_deliver_with_proof definition only after
--           reconciling any deliveries created with canonical reserved status.

begin;

do $rewrite_exact_delivery$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.request_deliver_with_proof(uuid,jsonb,uuid)'::regprocedure)
  into v_definition;

  if position($q$v_target:='assigned'::public.asset_status;$q$ in v_definition) > 0 then
    v_definition := replace(
      v_definition,
      $q$v_target:='assigned'::public.asset_status;$q$,
      $q$v_target:='reserved'::public.asset_status;$q$
    );
    v_definition := replace(
      v_definition,
      $q$v_target:=case when v_req.request_type='sale' then 'sold'::public.asset_status else 'rented'::public.asset_status end;$q$,
      $q$v_target:='reserved'::public.asset_status;$q$
    );
    v_definition := replace(
      v_definition,
      $q$v_target='assigned'$q$,
      $q$v_req.beneficiary_type='employee'$q$
    );
    v_definition := replace(
      v_definition,
      $q$v_current,'assigned',v_req.beneficiary_employee_id$q$,
      $q$v_current,'reserved',v_req.beneficiary_employee_id$q$
    );
    execute v_definition;
  elsif position($q$v_target:='reserved'::public.asset_status;$q$ in v_definition) = 0
     or position($q$v_req.beneficiary_type='employee'$q$ in v_definition) = 0 then
    raise exception 'request_deliver_with_proof_contract_unexpected';
  end if;
end
$rewrite_exact_delivery$;

revoke all on function public.request_deliver_with_proof(uuid,jsonb,uuid) from public, anon;
grant execute on function public.request_deliver_with_proof(uuid,jsonb,uuid) to authenticated;

commit;
