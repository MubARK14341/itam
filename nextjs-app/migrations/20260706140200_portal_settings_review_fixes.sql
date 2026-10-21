-- ============================================================================
--  Client Portal — Phase 5 fixes (from adversarial review). إضافي وآمن، لا بيانات.
--  (F1) portal_add_item: التصنيف كان يُفرَض على معامل مُهمَل (p_category_key) بينما
--       تُخزَّن قيمة حرّة (p_requested_category) بلا قيد ⇒ تجاوز كامل لقائمة التصنيفات.
--       الإصلاح: عند وجود قائمة سماح ⇒ يجب مفتاح صالح، وتُشتق التسمية المخزّنة من القائمة.
--  (F3) portal_submit_request: إعادة إرسال طلب «بانتظار PM» (يبقى draft) بعد إطفاء
--       require_pm كان يتركه under_review + pending_project_manager (حالة عالقة).
--       الإصلاح: لا يُسمح بالإرسال إلا إذا portal_approval_status='not_required'.
--  (F2) portal_pm_reject_request + portal_remove_item + portal_reply_clarification:
--       أُضيف حارس portal_enabled (اتساقًا مع بقية دوال البوابة).
--  (F5) request_reject + request_cancel: أُضيف حارس pending_project_manager (اتساقًا
--       مع request_approve) — الفريق لا يتصرّف بطلب ما زال بانتظار مدير المشروع.
--  نُسَخ مطابقة للدوال الحيّة + الحُرّاس فقط. لا لمس منطق المخزون.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (F1) portal_add_item — فرض التصنيف على القيمة المخزّنة نفسها + اشتقاق التسمية.
-- ---------------------------------------------------------------------------
create or replace function public.portal_add_item(
  p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text,
  p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean,
  p_preferred_company_id uuid default null, p_category_key text default null
) returns json language plpgsql security definer set search_path = public as $func$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_kind text; v_cat_label text;
  v_company_count int; v_category_count int; v_needs boolean := coalesce(p_needs_purchase, false);
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;

  -- (أ) عنصر غير متوفر (needs_purchase) يتطلب allow_custom_item_requests.
  if v_needs and not v_s.allow_custom_item_requests then
    return json_build_object('ok', false, 'error', 'custom_item_not_allowed'); end if;

  -- (ب) الشركة المفضّلة — يجب أن تكون ضمن قائمة السماح؛ والقائمة الفارغة تمنع أي شركة.
  if p_preferred_company_id is not null then
    select count(*) into v_company_count from public.customer_allowed_companies where customer_id = v_cid;
    if v_company_count = 0 then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
    if not exists (select 1 from public.customer_allowed_companies
                   where customer_id = v_cid and company_id = p_preferred_company_id) then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
  end if;

  -- (ج) التصنيف — يُفرَض على القيمة المخزّنة: قائمة سماح غير فارغة ⇒ يجب مفتاح صالح،
  --     وتُشتق التسمية من القائمة (نتجاهل تسمية العميل الحرّة). فارغة ⇒ لا قيد.
  select count(*) into v_category_count from public.customer_allowed_categories where customer_id = v_cid;
  if v_category_count > 0 then
    if nullif(btrim(p_category_key),'') is null
       or not exists (select 1 from public.customer_allowed_categories
                      where customer_id = v_cid and category_key = p_category_key) then
      return json_build_object('ok', false, 'error', 'category_not_allowed');
    end if;
    select coalesce(category_label_ar, category_label_en, category_key)
      into v_cat_label
      from public.customer_allowed_categories
      where customer_id = v_cid and category_key = p_category_key;
  else
    v_cat_label := nullif(p_requested_category, '');
  end if;

  v_kind := case when p_requested_kind = 'consumable' then 'consumable' else 'custom' end;
  insert into public.request_items (
    request_id, item_kind, requested_kind, requested_description, requested_category,
    quantity, preferred_model, preferred_company_id, accept_alternative, needs_purchase
  ) values (
    p_request_id, 'custom', v_kind, nullif(p_requested_description,''), v_cat_label,
    greatest(coalesce(p_quantity,1), 1), nullif(p_preferred_model,''), p_preferred_company_id,
    coalesce(p_accept_alternative, true), v_needs
  );
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- (F3) portal_submit_request — لا يُرسَل إلا طلب لم يُرسَل بعد (not_required).
-- ---------------------------------------------------------------------------
create or replace function public.portal_submit_request(p_request_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_items int; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  -- لا يُرسَل إلا طلب مسودّة لم يُرسَل بعد (يمنع إعادة الإرسال لطلب بانتظار/معتمد/مرفوض من PM).
  if v_req.status <> 'draft' or v_req.portal_approval_status <> 'not_required' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  select count(*) into v_items from public.request_items where request_id = p_request_id;
  if v_items = 0 then return json_build_object('ok', false, 'error', 'no_items'); end if;

  if v_role = 'authorized_requester' and v_s.require_project_manager_approval then
    update public.requests
      set portal_approval_status = 'pending_project_manager',
          portal_approval_requested_by = v_uid, portal_approval_requested_at = now()
      where id = p_request_id;
    perform public._request_add_event(p_request_id, 'portal_pm_approval_requested', 'portal', null, '{}'::jsonb);
    return json_build_object('ok', true, 'pending_pm', true);
  end if;

  if v_role = 'project_manager' and v_s.require_project_manager_approval then
    update public.requests
      set status = 'under_review',
          portal_approval_status = 'approved_by_project_manager',
          portal_approved_by = v_uid, portal_approved_at = now()
      where id = p_request_id;
  else
    update public.requests set status = 'under_review' where id = p_request_id;
  end if;
  perform public._request_add_event(p_request_id, 'submitted', 'portal', null, '{}'::jsonb);
  return json_build_object('ok', true, 'pending_pm', false);
end $func$;

-- ---------------------------------------------------------------------------
-- (F2) portal_pm_reject_request — حارس portal_enabled (اتساقًا مع pm_approve).
-- ---------------------------------------------------------------------------
create or replace function public.portal_pm_reject_request(p_request_id uuid, p_reason text)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role is distinct from 'project_manager' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' or v_req.portal_approval_status <> 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests
    set status = 'cancelled',
        portal_approval_status = 'rejected_by_project_manager',
        portal_rejected_by = v_uid, portal_rejected_at = now(),
        portal_rejection_reason = nullif(btrim(p_reason),'')
    where id = p_request_id;
  perform public._request_add_event(p_request_id, 'portal_pm_rejected', 'portal', nullif(btrim(p_reason),''), '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- (F2) portal_remove_item — حارس portal_enabled.
-- ---------------------------------------------------------------------------
create or replace function public.portal_remove_item(p_item_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select r.* into v_req from public.request_items ri join public.requests r on r.id = ri.request_id where ri.id = p_item_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  delete from public.request_items where id = p_item_id;
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- (F2) portal_reply_clarification — حارس portal_enabled.
-- ---------------------------------------------------------------------------
create or replace function public.portal_reply_clarification(p_request_id uuid, p_message text)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'needs_clarification' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests set status = 'under_review' where id = p_request_id;
  perform public._request_add_event(p_request_id, 'clarification_reply', 'portal', p_message, '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- (F5) request_reject — حارس pending_project_manager (اتساقًا مع request_approve).
--      نسخة مطابقة للحيّة + الحارس فقط (تحرير الأصول المحجوزة كما هو).
-- ---------------------------------------------------------------------------
create or replace function public.request_reject(p_id uuid, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $func$
declare v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','needs_clarification','approved','preparing','ready_for_pickup') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  -- طلب بانتظار مدير المشروع لا يتصرّف به الفريق (يقرّره مدير المشروع في البوابة).
  if v_req.portal_approval_status = 'pending_project_manager' then
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
-- (F5) request_cancel — حارس pending_project_manager.
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
  if v_req.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'reserved' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'reserved', 'available', v_uid, 'إلغاء طلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'cancelled' where id = p_id;
  return json_build_object('ok', true);
end $func$;
