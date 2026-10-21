-- ============================================================================
--  Client Portal — Phase 1 (3/3): عناصر "احتياج مقابل تلبية" + ربط المخزون + حارس التلبية
--  item_kind يقبل قيمة ثالثة 'custom' = سطر احتياج غير مُلبّى.
--  حلقات المخزون في request_deliver/request_start_preparing تفلتر أصلاً على
--  item_kind in ('asset','consumable') فتتجاهل 'custom' تلقائياً ⇒ صفر لمس للمنطق.
--  الأعمدة الجديدة تحتاج GRANT SELECT صريحاً (request_items خاضع لنمط HIGH-1).
--  ✅ إضافي وآمن: العناصر القديمة asset/consumable تبقى صالحة · لا DROP/DELETE بيانات · لا anon.
-- ============================================================================

-- 1) توسيع item_kind ليقبل 'custom'
alter table public.request_items drop constraint if exists request_items_item_kind_check;
alter table public.request_items add constraint request_items_item_kind_check
  check (item_kind in ('asset','consumable','custom'));

-- 2) أعمدة "الاحتياج المطلوب" (بجانب asset_id/consumable_id = مرجع التلبية)
alter table public.request_items add column if not exists requested_kind text not null default 'existing_asset';
alter table public.request_items add column if not exists requested_description text null;
alter table public.request_items add column if not exists requested_category text null;
alter table public.request_items add column if not exists preferred_company_id uuid null references public.companies(id);
alter table public.request_items add column if not exists preferred_model text null;
alter table public.request_items add column if not exists accept_alternative boolean not null default true;
alter table public.request_items add column if not exists needs_purchase boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'request_items_requested_kind_check' and conrelid = 'public.request_items'::regclass) then
    alter table public.request_items add constraint request_items_requested_kind_check
      check (requested_kind in ('existing_asset','consumable','custom'));
  end if;
end $$;

-- 3) إعادة تعريف kind_ref لتسمح بـ custom بلا مراجع (asset/consumable كما هي حرفياً)
alter table public.request_items drop constraint if exists request_items_kind_ref;
alter table public.request_items add constraint request_items_kind_ref check (
  (item_kind = 'asset'      and asset_id is not null and consumable_id is null) or
  (item_kind = 'consumable' and consumable_id is not null and asset_id is null) or
  (item_kind = 'custom'     and asset_id is null and consumable_id is null)
);

-- 4) منح SELECT صريح للأعمدة الجديدة (نمط HIGH-1: SELECT على مستوى الجدول مسحوب)
grant select (requested_kind, requested_description, requested_category,
              preferred_company_id, preferred_model, accept_alternative, needs_purchase)
  on public.request_items to authenticated;

-- 5) ربط عنصر بالمخزون (موظف) — يحوّل custom → asset/consumable + حدث
create or replace function public.request_item_fulfill(p_item_id uuid, p_asset_id uuid default null, p_consumable_id uuid default null)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_item public.request_items%rowtype; v_req public.requests%rowtype; v_astatus asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if (p_asset_id is null) = (p_consumable_id is null) then
    return json_build_object('ok', false, 'error', 'exactly_one_ref'); end if;
  select * into v_item from public.request_items where id = p_item_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  select * into v_req from public.requests where id = v_item.request_id for update;
  if v_req.status not in ('under_review','needs_clarification','approved','preparing') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  if coalesce(v_item.delivered_quantity,0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered'); end if;
  if p_asset_id is not null then
    select status into v_astatus from public.assets where id = p_asset_id;
    if v_astatus is null then return json_build_object('ok', false, 'error', 'asset_not_found'); end if;
    if v_astatus not in ('available','reserved') then
      return json_build_object('ok', false, 'error', 'asset_not_available'); end if;
    update public.request_items set item_kind = 'asset', asset_id = p_asset_id, consumable_id = null, needs_purchase = false where id = p_item_id;
  else
    perform 1 from public.consumables where id = p_consumable_id;
    if not found then return json_build_object('ok', false, 'error', 'consumable_not_found'); end if;
    update public.request_items set item_kind = 'consumable', consumable_id = p_consumable_id, asset_id = null, needs_purchase = false where id = p_item_id;
  end if;
  perform public._request_add_event(v_item.request_id, 'item_fulfilled', 'staff', null,
    jsonb_build_object('item_id', p_item_id, 'kind', case when p_asset_id is not null then 'asset' else 'consumable' end));
  return json_build_object('ok', true);
end $func$;

-- 6) فكّ الربط (موظف) — يعيد العنصر إلى custom + حدث
create or replace function public.request_item_unfulfill(p_item_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_item public.request_items%rowtype;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_item from public.request_items where id = p_item_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if coalesce(v_item.delivered_quantity,0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered'); end if;
  update public.request_items set item_kind = 'custom', asset_id = null, consumable_id = null where id = p_item_id;
  perform public._request_add_event(v_item.request_id, 'item_unfulfilled', 'staff', null, jsonb_build_object('item_id', p_item_id));
  return json_build_object('ok', true);
end $func$;

-- 7) حارس التلبية في بدء التجهيز — يمنع التقدّم مع عناصر custom غير معلّمة needs_purchase
--    (نسخة مطابقة للحالية + الحارس فقط. العناصر القديمة كلها asset/consumable ⇒ لا تتأثر.)
create or replace function public.request_start_preparing(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'approved' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  if exists (select 1 from public.request_items where request_id = p_id and item_kind = 'custom' and coalesce(needs_purchase,false) = false) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items'); end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'available' for update of a loop
    update public.assets set status = 'reserved' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'available', 'reserved', v_uid, 'حجز لطلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'preparing' where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- 8) حارس التلبية في التسليم — نفس الشرط (نسخة مطابقة للحالية حرفياً + سطر الحارس فقط)
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
  if exists (select 1 from public.request_items where request_id = p_id and item_kind = 'custom' and coalesce(needs_purchase,false) = false) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;
  v_target := case when v_req.request_type = 'sale' then 'sold'::asset_status else 'rented'::asset_status end;

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

  update public.requests
    set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,
        delivered_at = now()
  where id = p_id;

  return json_build_object('ok', true);
end $func$;

-- الصلاحيات: authenticated فقط. سحب anon صراحةً.
revoke all on function public.request_item_fulfill(uuid, uuid, uuid) from public, anon;
revoke all on function public.request_item_unfulfill(uuid) from public, anon;
revoke all on function public.request_start_preparing(uuid) from public, anon;
revoke all on function public.request_deliver(uuid) from public, anon;
grant execute on function public.request_item_fulfill(uuid, uuid, uuid) to authenticated;
grant execute on function public.request_item_unfulfill(uuid) to authenticated;
grant execute on function public.request_start_preparing(uuid) to authenticated;
grant execute on function public.request_deliver(uuid) to authenticated;
