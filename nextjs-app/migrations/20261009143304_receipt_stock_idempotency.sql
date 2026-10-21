-- Purpose: prevent duplicate goods receipts and stock movements after retries.
-- Risk: additive wrappers reuse the existing operation registry and original
-- business RPCs. Browser access to the original non-idempotent entrypoints is
-- revoked, so publish the matching client during the authorized write pause.
-- Rollback: retain these protections and the original function definitions;
-- contain affected writes while fixing the client. Do not regrant browser access
-- to the original RPCs or delete audit, stock or operation records.

begin;

create or replace function public.purchase_request_item_receive_idempotent(
  p_item_id uuid,
  p_qty numeric,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_existing public.request_operation_results%rowtype;
  v_fingerprint text;
  v_result jsonb;
begin
  if v_uid is null or public.is_approved() is distinct from true or public.app_user_role() is null
     or public.app_user_role() not in ('admin', 'it_manager', 'technician', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_operation_id is null then
    return jsonb_build_object('ok', false, 'error', 'operation_id_required');
  end if;
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'p_item_id', p_item_id, 'p_qty', pg_catalog.trim_scale(p_qty)
  )::text, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select * into v_existing from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then
    if v_existing.operation_type <> 'purchase_receipt'
       or v_existing.result #>> '{_operation,input_fingerprint}' is distinct from v_fingerprint then
      return jsonb_build_object('ok', false, 'error', 'operation_id_conflict');
    end if;
    return v_existing.result;
  end if;

  -- The original locked RPC and its SoD/procurement/audit triggers remain the
  -- authority. It tracks receipt quantities; it never changes stock.
  v_result := public.purchase_request_item_receive(p_item_id, p_qty)::jsonb;
  if coalesce((v_result->>'ok')::boolean, false) is not true then return v_result; end if;
  v_result := v_result || jsonb_build_object('_operation', jsonb_build_object(
    'type', 'purchase_receipt', 'target_id', p_item_id,
    'input_fingerprint', v_fingerprint
  ));
  insert into public.request_operation_results(actor_id, operation_id, operation_type, request_id, result)
  values (v_uid, p_operation_id, 'purchase_receipt', null, v_result);
  return v_result;
end;
$function$;

create or replace function public.consumable_stock_move_idempotent(
  p_consumable_id uuid,
  p_type text,
  p_quantity integer,
  p_operation_id uuid,
  p_reason text default null,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_invoice_number text default null,
  p_invoice_date date default null,
  p_employee_id uuid default null,
  p_department_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_existing public.request_operation_results%rowtype;
  v_fingerprint text;
  v_balance integer;
  v_result jsonb;
begin
  if v_uid is null or public.is_approved() is distinct from true or public.app_user_role() is null
     or public.app_user_role() not in ('admin', 'it_manager', 'technician') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    return jsonb_build_object('ok', false, 'error', 'operation_id_required');
  end if;
  if p_type = 'adjust' then
    raise exception 'manual_adjustment_requires_stocktake' using errcode = '23514';
  end if;
  if p_type not in ('in', 'out') or p_type is null then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  -- Preserve the financial boundary even when returning a recorded result.
  if public.is_financial_viewer() is distinct from true
     and (p_unit_cost is not null or p_invoice_number is not null or p_invoice_date is not null) then
    raise exception 'financial_fields_forbidden' using errcode = '42501';
  end if;
  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'p_consumable_id', p_consumable_id, 'p_type', p_type, 'p_quantity', p_quantity,
    'p_reason', p_reason, 'p_unit_cost', pg_catalog.trim_scale(p_unit_cost), 'p_supplier_id', p_supplier_id,
    'p_invoice_number', p_invoice_number, 'p_invoice_date', p_invoice_date,
    'p_employee_id', p_employee_id, 'p_department_id', p_department_id
  )::text, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select * into v_existing from public.request_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then
    if v_existing.operation_type <> 'consumable_stock_move'
       or v_existing.result #>> '{_operation,input_fingerprint}' is distinct from v_fingerprint then
      return jsonb_build_object('ok', false, 'error', 'operation_id_conflict');
    end if;
    return v_existing.result;
  end if;

  -- Retain the existing row locks, non-negative balance and append-only ledger.
  v_balance := public.consumable_stock_move(
    p_consumable_id, p_type, p_quantity, p_reason, p_unit_cost, p_supplier_id,
    p_invoice_number, p_invoice_date, p_employee_id, p_department_id
  );
  v_result := jsonb_build_object('ok', true, 'balance_after', v_balance,
    '_operation', jsonb_build_object('type', 'consumable_stock_move',
      'target_id', p_consumable_id, 'input_fingerprint', v_fingerprint));
  insert into public.request_operation_results(actor_id, operation_id, operation_type, request_id, result)
  values (v_uid, p_operation_id, 'consumable_stock_move', null, v_result);
  return v_result;
end;
$function$;

revoke all on function public.purchase_request_item_receive_idempotent(uuid,numeric,uuid)
from public, anon;
revoke all on function public.consumable_stock_move_idempotent(uuid,text,integer,uuid,text,numeric,uuid,text,date,uuid,uuid)
from public, anon;
grant execute on function public.purchase_request_item_receive_idempotent(uuid,numeric,uuid) to authenticated;
grant execute on function public.consumable_stock_move_idempotent(uuid,text,integer,uuid,text,numeric,uuid,text,date,uuid,uuid) to authenticated;

-- Preserve signatures for owner/internal callers; close the direct browser
-- bypass only after the new wrappers exist, in this same release transaction.
revoke execute on function public.purchase_request_item_receive(uuid,numeric)
from public, anon, authenticated;
revoke execute on function public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid)
from public, anon, authenticated;

commit;
