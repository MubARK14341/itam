-- ============================================================================
--  إغلاق خطر تجاوز منطق المخزون: كل انتقالات حالة الطلب المؤثّرة تصبح عبر RPC خادمي
--  ذرّي (SECURITY DEFINER + transaction واحدة) يتحقق من الدور/الاعتماد/الحالة/التوفّر
--  وينفّذ كل التأثيرات معًا أو يتراجع بالكامل.
--  + قفل على مستوى العمود: العميل (authenticated) لا يملك UPDATE على requests.status
--    ولا على أعمدة التدقيق/التوقيت ولا على كميات request_items — فلا يمكنه تجاوز الـ RPC.
--  ✅ لا DROP/TRUNCATE/DELETE · ✅ لا anon · ✅ لا service_role في الواجهة · إضافي وآمن.
--  يبقى requests_guard_status كحارس انتقالات + بوابة المدير + ختم التدقيق (دفاع متعدّد الطبقات).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) قفل الكتابة المباشرة على الأعمدة الحسّاسة (status/timestamps/audit/quantities)
--    نسحب UPDATE الكامل ثم نمنح فقط أعمدة بيانات الطلب الوصفية (قابلة للتعديل مستقبلًا).
--    الـ RPCs تعمل بصلاحية المالك (postgres) فتكتب الأعمدة المحجوبة.
-- ---------------------------------------------------------------------------
revoke update on public.requests from authenticated;
grant update (
  customer_id, customer_name_snapshot, contact_phone_snapshot,
  project_name, project_city, request_type, pickup_date, return_date, notes, internal_notes
) on public.requests to authenticated;

-- بنود الطلب: العميل يُدرج عند الإنشاء ويحذف بنود المسودّة فقط؛ الكميات تُحدَّث عبر RPC حصراً.
revoke update on public.request_items from authenticated;

-- ---------------------------------------------------------------------------
-- 2) الرفض — مدير فقط + تحرير الأصول المحجوزة (ذرّي)
-- ---------------------------------------------------------------------------
create or replace function public.request_reject(p_id uuid, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','approved','preparing','ready_for_pickup') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'reserved' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'reserved', 'available', v_uid, 'رفض طلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'rejected', rejection_reason = nullif(p_reason,'') where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 3) بدء التجهيز — يحجز الأصول المتاحة (available→reserved)
-- ---------------------------------------------------------------------------
create or replace function public.request_start_preparing(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'approved' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'available' for update of a loop
    update public.assets set status = 'reserved' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'available', 'reserved', v_uid, 'حجز لطلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'preparing' where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 4) جاهز للتسليم
-- ---------------------------------------------------------------------------
create or replace function public.request_mark_ready(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'preparing' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests set status = 'ready_for_pickup' where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 5) التسليم/الخروج — ذرّي كل-أو-لا-شيء:
--    تحقّق دور+حالة، قفل صفوف المخزون، تحقّق شامل (أصول available/reserved + كفاية المستهلكات)،
--    ثم تنفيذ كل التأثيرات (rented/sold + حركات + نقص مستهلك + delivered_quantity) + تقدّم الحالة.
--    أي نقص → يُعاد خطأ قبل أي تعديل (لا حالة جزئية). أي خطأ منظومي → rollback تلقائي.
-- ---------------------------------------------------------------------------
create or replace function public.request_deliver(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_caller text := public.app_user_role();
  v_req public.requests%rowtype;
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
  v_target := case when v_req.request_type = 'sale' then 'sold'::asset_status else 'rented'::asset_status end;

  -- قفل صفوف المخزون المعنيّة (ترتيب id ثابت) لمنع سباقات التخصيص/البيع المزدوج والـ oversell
  select array_agg(asset_id) into v_asset_ids from public.request_items where request_id = p_id and item_kind = 'asset' and asset_id is not null;
  select array_agg(consumable_id) into v_cons_ids from public.request_items where request_id = p_id and item_kind = 'consumable' and consumable_id is not null;
  if v_asset_ids is not null then perform 1 from public.assets where id = any(v_asset_ids) order by id for update; end if;
  if v_cons_ids is not null then perform 1 from public.consumables where id = any(v_cons_ids) order by id for update; end if;

  -- (1) تحقّق الأصول (فردي) — يجب أن تكون available/reserved
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset'
             and (ri.quantity - coalesce(ri.delivered_quantity,0)) > 0 loop
    if r.status not in ('available','reserved') then
      return json_build_object('ok', false, 'error', 'asset_not_available');
    end if;
  end loop;

  -- (1) تحقّق المستهلكات (تجميعي لكل مستهلك) — كفاية الرصيد
  for r in select ri.consumable_id, sum(ri.quantity - coalesce(ri.delivered_quantity,0)) as need, c.quantity_on_hand as qty
           from public.request_items ri join public.consumables c on c.id = ri.consumable_id
           where ri.request_id = p_id and ri.item_kind = 'consumable'
           group by ri.consumable_id, c.quantity_on_hand loop
    if r.need > 0 and r.need > r.qty then
      return json_build_object('ok', false, 'error', 'insufficient_stock');
    end if;
  end loop;

  -- (2) تنفيذ — قراءة طازجة لكل صف (يدعم تكرار نفس المستهلك بأمان)
  for r in select ri.id, ri.item_kind, ri.asset_id, ri.consumable_id, ri.quantity, ri.delivered_quantity
           from public.request_items ri where ri.request_id = p_id loop
    if coalesce(r.delivered_quantity,0) >= r.quantity then continue; end if; -- مُسلَّم سابقًا
    if r.item_kind = 'asset' then
      select status into v_cur_status from public.assets where id = r.asset_id;
      update public.assets set status = v_target, assigned_to_employee_id = null where id = r.asset_id;
      insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
        values (r.asset_id, 'status_change', v_cur_status, v_target, v_uid, 'تسليم طلب '||v_req.request_number||' (عميل)');
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    elsif r.item_kind = 'consumable' then
      select quantity_on_hand into v_cur from public.consumables where id = r.consumable_id;
      v_need := (r.quantity - coalesce(r.delivered_quantity,0))::int;
      v_next := v_cur - v_need;
      insert into public.consumable_transactions (consumable_id, txn_type, quantity, previous_quantity, balance_after, reason, performed_by)
        values (r.consumable_id, 'out', v_need, v_cur, v_next, 'تسليم طلب '||v_req.request_number, v_uid);
      update public.consumables set quantity_on_hand = v_next where id = r.consumable_id;
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    end if;
  end loop;

  -- (3) تقدّم الحالة: بيع → مكتمل · غير ذلك → تم التسليم
  update public.requests
    set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,
        delivered_at = now()
  where id = p_id;

  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 6) الإرجاع (تأجير) — يعيد المؤجَّر إلى المخزون؛ لا يرجع المستهلك (ذرّي)
-- ---------------------------------------------------------------------------
create or replace function public.request_return(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid();
  r record; v_outstanding int := 0;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered','partially_returned') then
    return json_build_object('ok', false, 'error', 'state_not_returnable'); end if;
  for r in select ri.id, ri.asset_id, ri.delivered_quantity, a.status
           from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset'
             and coalesce(ri.delivered_quantity,0) > coalesce(ri.returned_quantity,0)
           for update of a loop
    if r.status = 'rented' then
      update public.assets set status = 'available' where id = r.asset_id;
      insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
        values (r.asset_id, 'status_change', 'rented', 'available', v_uid, 'إرجاع طلب '||v_req.request_number);
      update public.request_items set returned_quantity = delivered_quantity where id = r.id;
    else
      v_outstanding := v_outstanding + 1; -- ليس مؤجَّرًا (مباع/خرج بنحو آخر) — لا يرجع
    end if;
  end loop;
  if v_outstanding > 0 then
    update public.requests set status = 'partially_returned' where id = p_id;
  else
    update public.requests set status = 'returned', returned_at = now() where id = p_id;
  end if;
  return json_build_object('ok', true, 'outstanding', v_outstanding);
end $func$;

-- ---------------------------------------------------------------------------
-- 7) الإكمال — يحرّر أي أصل مؤجَّر لا يزال خارجًا قبل الإغلاق (لا أصول عالقة)
-- ---------------------------------------------------------------------------
create or replace function public.request_complete(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered','partially_returned','returned') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  for r in select ri.id, ri.asset_id, ri.delivered_quantity, a.status
           from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'rented' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'rented', 'available', v_uid, 'إكمال طلب '||v_req.request_number);
    update public.request_items set returned_quantity = delivered_quantity where id = r.id;
  end loop;
  update public.requests set status = 'completed' where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 8) الإلغاء — قبل التسليم فقط + تحرير الأصول المحجوزة (ذرّي)
-- ---------------------------------------------------------------------------
create or replace function public.request_cancel(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','approved','preparing','ready_for_pickup') then
    return json_build_object('ok', false, 'error', 'cannot_cancel_after_deliver'); end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'reserved' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'reserved', 'available', v_uid, 'إلغاء طلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'cancelled' where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 9) الصلاحيات: authenticated فقط؛ سحب anon صراحةً (إعادة التعريف تُعيد المنح الافتراضي)
-- ---------------------------------------------------------------------------
do $do$
declare fn text;
begin
  foreach fn in array array[
    'request_reject(uuid, text)','request_start_preparing(uuid)','request_mark_ready(uuid)',
    'request_deliver(uuid)','request_return(uuid)','request_complete(uuid)','request_cancel(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public;', fn);
    execute format('revoke execute on function public.%s from anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $do$;
