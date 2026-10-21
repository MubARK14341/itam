-- ============================================================================
--  Client Portal — Hardening: فحوص الملكية null-safe (fail-closed)
--  مشكلتان من نفس الصنف (منطق SQL الثلاثي: NULL <> x = NULL، وفي PL/pgSQL شرط
--  IF بقيمة NULL يُعامَل كـ FALSE فيسقط فرع الرفض = fail-OPEN):
--    (1) `submitted_by <> auth.uid()`: تُعيد NULL للطلبات الداخلية (submitted_by فارغ)
--        → نظريًا يتصرّف authorized_requester بطلب داخلي لعميله لو عرف مُعرّفه.
--    (2) `customer_id <> v_cid`: عمود customer_id قابل لـ NULL؛ لو صار طلب بلا عميل
--        (customer_id فارغ) لتجاوز أي مستخدم بوابة فحص الملكية لو عرف المُعرّف.
--  القوائم أصلًا fail-closed (positive equality في WHERE تُقصي NULL) فلا تتغيّر.
--
--  الإصلاح: استبدال `<>` بـ `IS DISTINCT FROM` في فحصَي submitted_by و customer_id
--  في دوال البوابة الخمس التي تستخدم الفحص السلبي — بلا أي تغيير سلوكي آخر:
--    • مع طلب صحيح لنفس العميل/الطالب: IS DISTINCT FROM = false → لا يُرفض (كما كان).
--    • مع طلب بلا عميل/داخلي (NULL): IS DISTINCT FROM = true → يُرفض (كان يمرّ خطأً).
--    • مع طلب عميل/زميل آخر: IS DISTINCT FROM = true → يُرفض (كما كان).
--    • project_manager / viewer: شرط submitted_by لا يُقيّم (v_role مختلف) → كما هو.
--  ✅ إضافي وآمن: CREATE OR REPLACE فقط (يحافظ على الصلاحيات) · لا جداول/بيانات · لا anon.
--  (اكتُشف فحص customer_id عبر تدقيق أمني عدائي قبل تطبيق مرفقات الطلبات Phase 3.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 3) تفاصيل طلب (رأس + عناصر + أحداث) — مُبيّضة بالكامل
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_request(p_request_id uuid)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;

  return json_build_object('ok', true,
    'request', json_build_object(
      'id', v_req.id, 'request_number', v_req.request_number, 'status', v_req.status,
      'request_type', v_req.request_type, 'project_name', v_req.project_name, 'project_city', v_req.project_city,
      'contact_phone', v_req.contact_phone_snapshot, 'contact_email', v_req.contact_email_snapshot,
      'pickup_date', v_req.pickup_date, 'return_date', v_req.return_date,
      'notes', v_req.notes, 'created_at', v_req.created_at, 'rejection_reason', v_req.rejection_reason
    ),
    'items', coalesce((
      select json_agg(json_build_object(
        'id', ri.id,
        'requested_kind', ri.requested_kind,
        'requested_description', ri.requested_description,
        'requested_category', ri.requested_category,
        'preferred_model', ri.preferred_model,
        'accept_alternative', ri.accept_alternative,
        'needs_purchase', ri.needs_purchase,
        'quantity', ri.quantity,
        'fulfillment', case
          when ri.delivered_quantity > 0 then 'delivered'
          when ri.item_kind in ('asset','consumable') then 'preparing'
          when ri.needs_purchase then 'procuring'
          else 'reviewing' end
      ) order by ri.created_at)
      from public.request_items ri where ri.request_id = p_request_id
    ), '[]'::json),
    'events', coalesce((
      select json_agg(json_build_object(
        'event_type', e.event_type,
        'to_status', case when e.event_type = 'status_changed' then e.metadata->>'to' else null end,
        'message', case when e.event_type in ('clarification_requested','clarification_reply') then e.message else null end,
        'created_at', e.created_at
      ) order by e.created_at)
      from public.request_events e
      where e.request_id = p_request_id
        and e.event_type in ('status_changed','clarification_requested','clarification_reply','submitted')
    ), '[]'::json)
  );
end $func$;

-- ---------------------------------------------------------------------------
-- 5) إضافة عنصر احتياج (draft فقط) — العميل لا يضيف existing_asset إطلاقاً
-- ---------------------------------------------------------------------------
create or replace function public.portal_add_item(
  p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text,
  p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean
) returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype; v_kind text;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  v_kind := case when p_requested_kind = 'consumable' then 'consumable' else 'custom' end;
  insert into public.request_items (
    request_id, item_kind, requested_kind, requested_description, requested_category,
    quantity, preferred_model, accept_alternative, needs_purchase
  ) values (
    p_request_id, 'custom', v_kind, nullif(p_requested_description,''), nullif(p_requested_category,''),
    greatest(coalesce(p_quantity,1), 1), nullif(p_preferred_model,''),
    coalesce(p_accept_alternative, true), coalesce(p_needs_purchase, false)
  );
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 6) حذف عنصر (draft فقط، لطلب العميل)
-- ---------------------------------------------------------------------------
create or replace function public.portal_remove_item(p_item_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select r.* into v_req from public.request_items ri join public.requests r on r.id = ri.request_id where ri.id = p_item_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  delete from public.request_items where id = p_item_id;
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 7) إرسال الطلب (draft → under_review) + حدث submitted
-- ---------------------------------------------------------------------------
create or replace function public.portal_submit_request(p_request_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype; v_items int;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  select count(*) into v_items from public.request_items where request_id = p_request_id;
  if v_items = 0 then return json_build_object('ok', false, 'error', 'no_items'); end if;
  update public.requests set status = 'under_review' where id = p_request_id;
  perform public._request_add_event(p_request_id, 'submitted', 'portal', null, '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 8) الرد على طلب توضيح (needs_clarification → under_review) + حدث
-- ---------------------------------------------------------------------------
create or replace function public.portal_reply_clarification(p_request_id uuid, p_message text)
returns json language plpgsql security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'needs_clarification' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests set status = 'under_review' where id = p_request_id;
  perform public._request_add_event(p_request_id, 'clarification_reply', 'portal', p_message, '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- الصلاحيات: authenticated فقط (CREATE OR REPLACE يحافظ عليها؛ نعيد ضبطها احتياطًا)
-- ---------------------------------------------------------------------------
do $do$
declare fn text;
begin
  foreach fn in array array[
    'portal_get_request(uuid)',
    'portal_add_item(uuid, text, text, text, numeric, text, boolean, boolean)',
    'portal_remove_item(uuid)',
    'portal_submit_request(uuid)',
    'portal_reply_clarification(uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $do$;
