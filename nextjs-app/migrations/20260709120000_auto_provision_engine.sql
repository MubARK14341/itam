-- =====================================================================
-- Purpose: محرك التجهيز التلقائي — بعد اعتماد الطلب يبحث النظام في الأصول المتاحة،
--          يطابق (تصنيف + شركة/ماركة + موديل) بنفس منطق assetMatchesNeed، يستبعد غير
--          المتاح/المحجوز/الخارج/المرتبط بطلب نشط، يحجز العدد المطلوب ويربطه بالطلب
--          بأرقامه التسلسلية، ثم يعرضه لمدير المستودع للمراجعة. النقص لا يكسر الطلب:
--          يُلبّى المتاح ويُضبط الطلب stock_shortage مع حدث بالتفاصيل.
-- What:
--   1) توسيع حالات requests: auto_provisioning / provisioned / stock_shortage (CHECK + machine).
--   2) _request_auto_provision(uuid): المحرك (داخلي، بلا حارس دور — يُستدعى بعد الاعتماد أو عبر الغلاف).
--   3) request_auto_provision(uuid): غلاف عام بحارس أدوار العمليات (زر إعادة تجهيز).
--   4) request_shortage_fulfill_available(uuid): قرار «تجهيز المتاح فقط» (يُسقِط أسطر النقص).
--   5) request_approve: يستدعي التجهيز التلقائي فور الاعتماد.
--   6) request_deliver: يقبل التسليم من حالة provisioned أيضًا.
-- Risk:    متوسط — يوسّع آلة الحالات ويضيف دوالّ؛ التجهيز ذرّي (FOR UPDATE SKIP LOCKED)،
--          يتجاوز RLS بحكم SECURITY DEFINER، بلا أي حقل مالي، بلا كسر لتدفّق موجود.
-- Rollback: إعادة الدوال لتعريفها السابق + إزالة الحالات الجديدة من CHECK/machine (يدوي).
-- =====================================================================

-- 1) الحالات الجديدة على العمود --------------------------------------------
alter table public.requests drop constraint if exists requests_status_check;
alter table public.requests add constraint requests_status_check
  check (status = any (array[
    'draft','under_review','approved','rejected','preparing','ready_for_pickup',
    'delivered','partially_returned','returned','completed','cancelled','overdue',
    'needs_clarification','auto_provisioning','provisioned','stock_shortage'
  ]));

-- 2) آلة انتقالات الحالة (إضافة الحالات الثلاث — لا حذف انتقال قائم) ---------
create or replace function public.request_status_allowed(p_old text, p_new text)
returns boolean language plpgsql immutable set search_path = public as $func$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'draft'               then p_new in ('under_review','approved','rejected','cancelled')
    when 'under_review'        then p_new in ('approved','rejected','cancelled','needs_clarification')
    when 'needs_clarification' then p_new in ('under_review','approved','rejected','cancelled')
    when 'approved'            then p_new in ('preparing','ready_for_pickup','delivered','completed','rejected','cancelled','auto_provisioning','provisioned','stock_shortage')
    when 'auto_provisioning'   then p_new in ('provisioned','stock_shortage','approved','preparing','rejected','cancelled')
    when 'provisioned'         then p_new in ('preparing','ready_for_pickup','delivered','completed','stock_shortage','approved','rejected','cancelled')
    when 'stock_shortage'      then p_new in ('provisioned','preparing','ready_for_pickup','delivered','completed','approved','rejected','cancelled')
    when 'preparing'           then p_new in ('ready_for_pickup','delivered','completed','rejected','cancelled','provisioned','stock_shortage')
    when 'ready_for_pickup'    then p_new in ('delivered','completed','rejected','cancelled')
    when 'delivered'           then p_new in ('partially_returned','returned','completed','overdue')
    when 'partially_returned'  then p_new in ('returned','completed','overdue')
    when 'returned'            then p_new in ('completed')
    when 'overdue'             then p_new in ('partially_returned','returned','completed')
    when 'completed'           then false
    when 'rejected'            then false
    when 'cancelled'           then false
    else false
  end;
end $func$;

-- 3) المحرك الداخلي --------------------------------------------------------
create or replace function public._request_auto_provision(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $func$
declare
  v_uid   uuid := auth.uid();
  v_req   public.requests%rowtype;
  v_need  record;
  v_qty   int;
  v_matched int;
  a       record;
  v_reserved int := 0;
  v_short    int := 0;
  v_new_status text;
  v_has_need boolean := false;
begin
  select * into v_req from public.requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('approved','auto_provisioning','provisioned','stock_shortage','preparing') then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;

  for v_need in
    select * from public.request_items
    where request_id = p_id and item_kind = 'custom' and requested_kind = 'existing_asset'
      and asset_id is null and coalesce(needs_purchase, false) = false
    for update
  loop
    v_has_need := true;
    v_qty := greatest(1, coalesce(v_need.quantity, 1))::int;
    v_matched := 0;

    for a in
      select asset.id
      from public.assets asset
      left join public.categories c on c.id = asset.category_id
      left join public.models m on m.id = asset.model_id
      where asset.status = 'available'
        and (v_need.requested_category is null
             or coalesce(nullif(btrim(c.name_ar),''), nullif(btrim(c.name),''), '—') = v_need.requested_category)
        and (v_need.preferred_company_id is null
             or asset.company_id = v_need.preferred_company_id)
        and (v_need.preferred_model is null
             or coalesce(
                  nullif(btrim(concat_ws(' ', nullif(btrim(m.brand),''), nullif(btrim(m.model_name),''))),''),
                  nullif(btrim(asset.name),''), '—') = v_need.preferred_model)
        and not exists (
          select 1 from public.request_items ri2
          join public.requests r2 on r2.id = ri2.request_id
          where ri2.asset_id = asset.id
            and r2.status not in ('rejected','cancelled','completed','returned')
        )
      order by asset.created_at asc nulls last
      for update of asset skip locked
      limit v_qty
    loop
      v_matched := v_matched + 1;
      update public.assets set status = 'reserved' where id = a.id;
      insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
        values (a.id, 'status_change', 'available', 'reserved', v_uid, 'تجهيز تلقائي للطلب '||v_req.request_number);
      insert into public.request_items (request_id, item_kind, asset_id, quantity,
        requested_kind, requested_description, requested_category, preferred_company_id, preferred_model)
        values (p_id, 'asset', a.id, 1,
          v_need.requested_kind, v_need.requested_description, v_need.requested_category,
          v_need.preferred_company_id, v_need.preferred_model);
    end loop;

    v_reserved := v_reserved + v_matched;
    if v_matched >= v_qty then
      delete from public.request_items where id = v_need.id;                      -- مُلبّى بالكامل
    elsif v_matched > 0 then
      update public.request_items set quantity = v_qty - v_matched where id = v_need.id;  -- باقٍ غير مُلبّى
      v_short := v_short + (v_qty - v_matched);
    else
      v_short := v_short + v_qty;                                                 -- لا متاح
    end if;
  end loop;

  if not v_has_need then
    v_new_status := v_req.status;
  elsif v_short > 0 then
    v_new_status := 'stock_shortage';
  elsif v_reserved > 0 then
    v_new_status := 'provisioned';
  else
    v_new_status := v_req.status;
  end if;

  if v_new_status is distinct from v_req.status then
    update public.requests set status = v_new_status where id = p_id;
  end if;

  perform public._request_add_event(p_id, 'auto_provisioned', 'system', null,
    jsonb_build_object('reserved', v_reserved, 'short', v_short, 'status', v_new_status));

  return jsonb_build_object('ok', true, 'reserved', v_reserved, 'short', v_short, 'status', v_new_status);
end $func$;

revoke all on function public._request_auto_provision(uuid) from public;

-- 4) الغلاف العام (زر إعادة التجهيز في الواجهة) ----------------------------
create or replace function public.request_auto_provision(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $func$
declare v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager','technician','warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  return public._request_auto_provision(p_id);
end $func$;

revoke all on function public.request_auto_provision(uuid) from public;
grant execute on function public.request_auto_provision(uuid) to authenticated;

-- 5) قرار النقص: تجهيز المتاح فقط (يُسقِط أسطر الاحتياج غير المُلبّاة) -------
create or replace function public.request_shortage_fulfill_available(p_id uuid)
returns json language plpgsql security definer set search_path to 'public' as $func$
declare v_role text := public.app_user_role(); v_req public.requests%rowtype;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'stock_shortage' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  delete from public.request_items
   where request_id = p_id and item_kind = 'custom' and requested_kind = 'existing_asset'
     and asset_id is null and coalesce(needs_purchase, false) = false;
  update public.requests set status = 'provisioned' where id = p_id;
  perform public._request_add_event(p_id, 'shortage_fulfill_available', 'staff', null, '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

revoke all on function public.request_shortage_fulfill_available(uuid) from public;
grant execute on function public.request_shortage_fulfill_available(uuid) to authenticated;

-- 6) request_approve: تجهيز تلقائي فور الاعتماد ----------------------------
create or replace function public.request_approve(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_uid uuid := auth.uid(); v_prov jsonb;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'approved',
      responsible_employee_id = coalesce(responsible_employee_id, v_uid)
  where id = p_id and status in ('draft','under_review','needs_clarification');
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  v_prov := public._request_auto_provision(p_id);
  return json_build_object('ok', true, 'provision', v_prov);
end $func$;

-- 7) request_deliver يقبل التسليم من provisioned أيضًا ----------------------
do $mig3$
declare def text;
begin
  select pg_get_functiondef('public.request_deliver(uuid)'::regprocedure) into def;
  if position($q$'approved','preparing','ready_for_pickup','provisioned'$q$ in def) = 0 then
    def := replace(def,
      $q$'approved','preparing','ready_for_pickup'$q$,
      $q$'approved','preparing','ready_for_pickup','provisioned'$q$);
    execute def;
  end if;
end $mig3$;
