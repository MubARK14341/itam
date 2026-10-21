-- ============================================================================
--  طلبات الموظفين الداخلية (عهدة) — RC1 patch 2026-07-08
--  الغرض: مسار ثالث للطلبات = موظف داخلي يطلب احتياجًا (كيبورد/شاشة/لابتوب…)
--  وعند التسليم تُسجَّل العهدة باسمه (asset_assignments + status='assigned')
--  بدل مسار العميل (rented/sold). المستهلكات تُصرف مع related_employee_id.
--  المكوّنات:
--   1) requests.beneficiary_type ('customer'|'employee') + beneficiary_employee_id → employees
--   2) توسيع request_type بقيمة 'internal' (للطلبات الداخلية فقط — قيد تكامل يربطها)
--   3) request_deliver: تفريع عهدة الموظف (نسخة مطابقة لمسار العميل حرفيًا + الفرع الجديد)
--      طلب الموظف يكتمل فورًا عند التسليم (completed) — الإرجاع لاحقًا عبر asset_return.
--   4) _crq_filter: استثناء الطلبات الداخلية من تقارير/تحليلات طلبات العملاء.
--  المخاطرة: منخفضة — إضافي بالكامل؛ الصفوف القائمة default='customer' فلا تتأثر؛
--  البوابة لا تمرر request_type='internal' (portal_create_request يحوّله إلى rental)
--  وطلبات الموظفين customer_id=null فلا تظهر في portal_list_requests إطلاقًا.
--  التراجع: إعادة تعريف request_deliver/_crq_filter بنسخة 20260706100200/20260706150000
--  (الأعمدة تبقى — إضافية غير مؤذية).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) أعمدة الجهة المستفيدة على requests (الجدول ليس ضمن نمط HIGH-1 — لا grant عمودي)
-- ----------------------------------------------------------------------------
alter table public.requests add column if not exists beneficiary_type text not null default 'customer';
alter table public.requests add column if not exists beneficiary_employee_id uuid null references public.employees(id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'requests_beneficiary_type_check' and conrelid = 'public.requests'::regclass) then
    alter table public.requests add constraint requests_beneficiary_type_check
      check (beneficiary_type in ('customer','employee'));
  end if;
end $$;

create index if not exists idx_requests_beneficiary_employee
  on public.requests(beneficiary_employee_id) where beneficiary_employee_id is not null;

-- ----------------------------------------------------------------------------
-- 2) توسيع نوع الطلب بقيمة 'internal' + قيد تكامل الجهة المستفيدة
--    (كل الصفوف القائمة beneficiary_type='customer' + beneficiary_employee_id=null
--     + request_type ضمن الأربعة القديمة ⇒ تمر جميعها)
-- ----------------------------------------------------------------------------
alter table public.requests drop constraint if exists requests_request_type_check;
alter table public.requests add constraint requests_request_type_check
  check (request_type in ('rental','sale','service','mixed','internal'));

alter table public.requests drop constraint if exists requests_beneficiary_chk;
alter table public.requests add constraint requests_beneficiary_chk check (
  (beneficiary_type = 'customer' and beneficiary_employee_id is null and request_type <> 'internal')
  or
  (beneficiary_type = 'employee' and beneficiary_employee_id is not null
   and request_type = 'internal' and customer_id is null)
);

-- ----------------------------------------------------------------------------
-- 3) request_deliver — نسخة 20260706100200 حرفيًا + تفريع عهدة الموظف:
--    • beneficiary_type='employee' ⇒ الأصل → 'assigned' + assigned_to_employee_id
--      + صف asset_assignments(active, due_return_date=return_date) + حركة 'assign'
--      (نفس أعمدة asset_assign في 20260703201000)، والمستهلك يُصرف مع
--      related_employee_id/department_id، والطلب → completed فورًا.
--    • beneficiary_type='customer' ⇒ السلوك الحالي دون أي تغيير (rented/sold).
-- ----------------------------------------------------------------------------
create or replace function public.request_deliver(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
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
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('approved','preparing','ready_for_pickup') then
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
        update public.assets set status = 'assigned', assigned_to_employee_id = v_req.beneficiary_employee_id where id = r.asset_id;
        insert into public.asset_assignments (asset_id, employee_id, due_return_date, status)
          values (r.asset_id, v_req.beneficiary_employee_id, v_req.return_date, 'active');
        insert into public.asset_movements (asset_id, movement_type, from_status, to_status, to_employee_id, performed_by, note)
          values (r.asset_id, 'assign', v_cur_status, 'assigned', v_req.beneficiary_employee_id, v_uid, 'تسليم طلب '||v_req.request_number||' (عهدة موظف)');
      else
        update public.assets set status = v_target, assigned_to_employee_id = null where id = r.asset_id;
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

  -- طلب الموظف يكتمل فورًا (العهدة تعيش في asset_assignments والإرجاع عبر asset_return)
  update public.requests
    set status = case when coalesce(v_req.beneficiary_type,'customer') = 'employee' or v_req.request_type = 'sale' then 'completed' else 'delivered' end,
        delivered_at = now()
  where id = p_id;

  return json_build_object('ok', true);
end $func$;

revoke all on function public.request_deliver(uuid) from public, anon;
grant execute on function public.request_deliver(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) _crq_filter — نسخة 20260706150000 حرفيًا + استثناء الطلبات الداخلية للموظفين
--    (تقارير «طلبات العملاء» لا تلوّثها طلبات العهدة الداخلية)
-- ----------------------------------------------------------------------------
create or replace function public._crq_filter(p_filters jsonb)
returns setof public.requests
language plpgsql stable security definer set search_path = public as $func$
declare
  v_date_from date; v_date_to date; v_customer uuid; v_responsible uuid;
  v_type text; v_status text; v_source text; v_pm text; v_city text;
begin
  begin
    v_date_from   := nullif(p_filters->>'date_from','')::date;
    v_date_to     := nullif(p_filters->>'date_to','')::date;
    v_customer    := nullif(p_filters->>'customer_id','')::uuid;
    v_responsible := nullif(p_filters->>'responsible_employee_id','')::uuid;
  exception when others then
    raise exception 'invalid_filters' using errcode = '22023';
  end;
  v_type   := nullif(p_filters->>'request_type','');
  v_status := nullif(p_filters->>'status','');
  v_source := nullif(p_filters->>'source','');
  v_pm     := nullif(p_filters->>'portal_approval_status','');
  v_city   := nullif(p_filters->>'city','');
  if v_type is not null and v_type not in ('rental','sale','service','mixed') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;
  if v_source is not null and v_source not in ('internal','client_portal') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;
  if v_pm is not null and v_pm not in ('not_required','pending_project_manager','approved_by_project_manager','rejected_by_project_manager') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;
  if v_status is not null and v_status not in
     ('draft','under_review','approved','rejected','preparing','ready_for_pickup',
      'delivered','partially_returned','returned','completed','cancelled','overdue','needs_clarification') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;

  return query
  select r.* from public.requests r
  where r.request_type <> 'internal'                      -- طلبات الموظفين الداخلية خارج تقارير العملاء
    and coalesce(r.beneficiary_type,'customer') = 'customer'
    and (v_date_from   is null or r.created_at >= v_date_from)
    and (v_date_to     is null or r.created_at < (v_date_to + 1))
    and (v_customer    is null or r.customer_id = v_customer)
    and (v_responsible is null or r.responsible_employee_id = v_responsible)
    and (v_type        is null or r.request_type = v_type)
    and (v_status      is null or r.status = v_status)
    and (v_source      is null or r.request_source = v_source)
    and (v_pm          is null or r.portal_approval_status = v_pm)
    and (v_city        is null or r.project_city = v_city);
end $func$;
revoke all on function public._crq_filter(jsonb) from public, anon, authenticated;
