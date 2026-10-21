-- Purpose: EDIT 1 follow-up — rental employee assignments remain delivered until inspected return.
-- Security: request_deliver keeps its server-side role checks, row locks, asset assignment guard,
-- movements, and authenticated-only grant. Only the terminal status for non-sale requests changes.

begin;

CREATE OR REPLACE FUNCTION public.request_deliver(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_req public.requests%rowtype;
  v_emp public.employees%rowtype;
  v_target asset_status;
  v_uid uuid := auth.uid();
  v_asset_ids uuid[];
  v_cons_ids uuid[];
  v_cur_status asset_status;
  v_cur int;
  v_need int;
  v_next int;
  r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('approved','preparing','ready_for_pickup','provisioned') then
    return json_build_object('ok', false, 'error', 'state_not_deliverable');
  end if;
  if exists (select 1 from public.request_items where request_id = p_id and item_kind = 'custom' and coalesce(needs_purchase,false) = false) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;

  -- تحديد الحالة الهدف حسب الجهة المستفيدة (حارس فاشل-مغلق لطلب الموظف)
  if coalesce(v_req.beneficiary_type, 'customer') = 'employee' then
    if v_req.beneficiary_employee_id is null then
      return json_build_object('ok', false, 'error', 'no_beneficiary');
    end if;
    select * into v_emp from public.employees where id = v_req.beneficiary_employee_id;
    if not found or coalesce(v_emp.is_active, false) = false then
      return json_build_object('ok', false, 'error', 'beneficiary_inactive');
    end if;
    v_target := 'assigned'::asset_status;
  else
    v_target := case when v_req.request_type = 'sale' then 'sold'::asset_status else 'rented'::asset_status end;
  end if;

  select array_agg(asset_id) into v_asset_ids from public.request_items where request_id = p_id and item_kind = 'asset' and asset_id is not null;
  select array_agg(consumable_id) into v_cons_ids from public.request_items where request_id = p_id and item_kind = 'consumable' and consumable_id is not null;
  if v_asset_ids is not null then perform 1 from public.assets where id = any(v_asset_ids) order by id for update; end if;
  if v_cons_ids is not null then perform 1 from public.consumables where id = any(v_cons_ids) order by id for update; end if;

  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset'
             and (ri.quantity - coalesce(ri.delivered_quantity,0)) > 0 loop
    if r.status not in ('available','reserved') then
      return json_build_object('ok', false, 'error', 'asset_not_available');
    end if;
    -- عهدة موظف: نفس حارس asset_assign — لا عهدة نشطة قائمة على الأصل
    if v_target = 'assigned' and exists (
      select 1 from public.asset_assignments where asset_id = r.asset_id and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_assigned');
    end if;
  end loop;

  for r in select ri.consumable_id, sum(ri.quantity - coalesce(ri.delivered_quantity,0)) as need, c.quantity_on_hand as qty
           from public.request_items ri join public.consumables c on c.id = ri.consumable_id
           where ri.request_id = p_id and ri.item_kind = 'consumable'
           group by ri.consumable_id, c.quantity_on_hand loop
    if r.need > 0 and r.need > r.qty then
      return json_build_object('ok', false, 'error', 'insufficient_stock');
    end if;
  end loop;

  for r in select ri.id, ri.item_kind, ri.asset_id, ri.consumable_id, ri.quantity, ri.delivered_quantity
           from public.request_items ri where ri.request_id = p_id loop
    if coalesce(r.delivered_quantity,0) >= r.quantity then continue; end if;
    if r.item_kind = 'asset' then
      select status into v_cur_status from public.assets where id = r.asset_id;
      if v_target = 'assigned' then
        -- عهدة موظف: تعيين + سجل عهدة + حركة assign (نمط asset_assign حرفيًا)
        update public.assets set status = 'assigned', assigned_to_employee_id = v_req.beneficiary_employee_id, times_checked_out = coalesce(times_checked_out,0) + 1, last_out_at = now(), last_request_id = p_id where id = r.asset_id;
        insert into public.asset_assignments (asset_id, employee_id, due_return_date, status)
          values (r.asset_id, v_req.beneficiary_employee_id, v_req.return_date, 'active');
        insert into public.asset_movements (asset_id, movement_type, from_status, to_status, to_employee_id, performed_by, note)
          values (r.asset_id, 'assign', v_cur_status, 'assigned', v_req.beneficiary_employee_id, v_uid, 'تسليم طلب '||v_req.request_number||' (عهدة موظف)');
      else
        update public.assets set status = v_target, assigned_to_employee_id = null, times_checked_out = coalesce(times_checked_out,0) + 1, last_out_at = now(), last_request_id = p_id where id = r.asset_id;
        insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
          values (r.asset_id, 'status_change', v_cur_status, v_target, v_uid, 'تسليم طلب '||v_req.request_number||' (عميل)');
      end if;
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    elsif r.item_kind = 'consumable' then
      select quantity_on_hand into v_cur from public.consumables where id = r.consumable_id;
      v_need := (r.quantity - coalesce(r.delivered_quantity,0))::int;
      v_next := v_cur - v_need;
      insert into public.consumable_transactions (consumable_id, txn_type, quantity, previous_quantity, balance_after, reason, performed_by, related_employee_id, department_id)
        values (r.consumable_id, 'out', v_need, v_cur, v_next, 'تسليم طلب '||v_req.request_number, v_uid,
                case when v_target = 'assigned' then v_req.beneficiary_employee_id else null end,
                case when v_target = 'assigned' then v_emp.department_id else null end);
      update public.consumables set quantity_on_hand = v_next where id = r.consumable_id;
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    end if;
  end loop;

  -- يحتفظ التسليم بعهدة الموظف، ثم تمر الطلبات غير البيعية بفحص الإرجاع والإغلاق الصريح.
  update public.requests
    set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,
        delivered_at = now()
  where id = p_id;

  return json_build_object('ok', true);
end $function$;


revoke all on function public.request_deliver(uuid) from public, anon;
grant execute on function public.request_deliver(uuid) to authenticated;

commit;
