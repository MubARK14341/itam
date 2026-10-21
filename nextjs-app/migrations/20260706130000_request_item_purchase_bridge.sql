-- ============================================================================
--  Client Portal — Phase 4: جسر «عنصر طلب → طلب شراء» (request item → purchase request)
--  إضافي وآمن بالكامل. الهدف: تحويل بند احتياج غير مُلبّى (item_kind='custom') إلى
--  بند في «طلب شراء» draft (تجهيز/متابعة فقط) — دون أي أثر على المخزون إطلاقًا.
--
--  قواعد صلبة (مطابقة لروح purchase_requests و request foundation):
--   • المخزون لا يتغير هنا — لا توريد، لا نقص كمية، لا تغيير حالة أصل.
--   • لا تحويل تلقائي — بفعل موظف صاحب صلاحية request.approve (أو admin/it_manager).
--   • منع التحويل المكرر لنفس البند (فهرس فريد على source_request_item_id + حارس في الـRPC).
--   • البوابة لا ترى طلب الشراء ولا رقمه: حدث 'purchase_requested' خارج قائمة أحداث
--     البوابة المُبيّضة (portal_get_request)، والعميل يرى فقط fulfillment='procuring'
--     (جارٍ التوفير) لأن needs_purchase=true — وهذا مُخطَّط أصلاً في المرحلة 2.
--   • purchase_request_items يتبع نمط HIGH-1: SELECT بأعمدة صريحة — نمنح الجديدة صراحةً.
--  ✅ لا DROP/DELETE على بيانات · لا anon · لا لمس منطق المخزون · لا تبعيات جديدة.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) توسيع purchase_request_items ليقبل بند «وصف حر» (بلا مستهلك) مصدره بند طلب
-- ---------------------------------------------------------------------------
--    consumable_id كان NOT NULL — نجعله nullable ليقبل بند الوصف الحر (custom).
alter table public.purchase_request_items alter column consumable_id drop not null;

--    وصف حر للبند (يُملأ من requested_description/category للبند المصدر).
alter table public.purchase_request_items add column if not exists description text;

--    رابط المصدر: بند الطلب الذي وُلِّد منه هذا البند (لمنع التكرار + عرض الرابط للموظف).
alter table public.purchase_request_items
  add column if not exists source_request_item_id uuid references public.request_items(id);

--    CHECK: كل بند إمّا مستهلك (consumable_id) أو وصف حر (description) — لا فراغ.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pr_items_consumable_or_description'
      and conrelid = 'public.purchase_request_items'::regclass
  ) then
    alter table public.purchase_request_items
      add constraint pr_items_consumable_or_description
      check (consumable_id is not null or (description is not null and btrim(description) <> ''));
  end if;
end $$;

--    منع التحويل المكرر لنفس بند الطلب على مستوى القاعدة (فهرس فريد جزئي).
create unique index if not exists uq_pr_items_source_request_item
  on public.purchase_request_items(source_request_item_id)
  where source_request_item_id is not null;
create index if not exists idx_pr_items_source_request_item
  on public.purchase_request_items(source_request_item_id);

--    نمط HIGH-1: منح SELECT صريح للأعمدة الجديدة (بلا unit_cost — يبقى مالياً محمياً).
grant select (description, source_request_item_id)
  on public.purchase_request_items to authenticated;

-- ---------------------------------------------------------------------------
-- 2) RPC: تحويل بند احتياج (custom) إلى بند طلب شراء draft
--    p_pr_id = null  ⇒ ينشئ طلب شراء draft جديد.
--    p_pr_id != null ⇒ يضيف البند إلى طلب شراء draft قائم (يجب أن يكون draft).
-- ---------------------------------------------------------------------------
create or replace function public.request_item_convert_to_pr(p_item_id uuid, p_pr_id uuid default null)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role      text := public.app_user_role();
  v_item      public.request_items%rowtype;
  v_req       public.requests%rowtype;
  v_pr_id     uuid;
  v_pr_number text;
  v_pr_status text;
  v_desc      text;
  v_company   text;
  v_notes     text;
  v_parts     text[] := array[]::text[];
begin
  -- (أ) الصلاحية: request.approve أو admin/it_manager (يستبعد viewer/technician بلا صلاحية والبوابة).
  if not (public.current_user_has_capability('request.approve') or v_role in ('admin','it_manager')) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  -- (ب) بند الطلب — يجب أن يكون custom (احتياج غير مُلبّى) وغير مُسلَّم.
  select * into v_item from public.request_items where id = p_item_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_item.item_kind <> 'custom' then return json_build_object('ok', false, 'error', 'not_custom'); end if;
  if coalesce(v_item.delivered_quantity, 0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered'); end if;

  -- (ج) منع التكرار: بند طلب واحد يُحوَّل مرة واحدة فقط.
  if exists (select 1 from public.purchase_request_items where source_request_item_id = p_item_id) then
    return json_build_object('ok', false, 'error', 'already_converted');
  end if;

  -- (د) الطلب الأب — في حالة عمل مشروعة (قبل التسليم)، مطابقة لحالات request_item_fulfill.
  select * into v_req from public.requests where id = v_item.request_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('under_review','needs_clarification','approved','preparing') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  -- (هـ) طلب الشراء الهدف: جديد (draft) أو قائم (يجب أن يكون draft).
  if p_pr_id is null then
    insert into public.purchase_requests (supplier_id, notes)
    values (null, 'طلب شراء مرتبط بالطلب ' || v_req.request_number)
    returning id, request_number into v_pr_id, v_pr_number;   -- المُحفِّز يختم الرقم/الطالب/الحالة=draft
  else
    select id, request_number, status into v_pr_id, v_pr_number, v_pr_status
    from public.purchase_requests where id = p_pr_id for update;
    if v_pr_id is null then return json_build_object('ok', false, 'error', 'pr_not_found'); end if;
    if v_pr_status <> 'draft' then return json_build_object('ok', false, 'error', 'pr_not_draft'); end if;
  end if;

  -- (و) الوصف + سياق (الموديل/الشركة المفضلة/رقم الطلب المصدر) في notes.
  v_desc := coalesce(nullif(btrim(v_item.requested_description), ''),
                     nullif(btrim(v_item.requested_category), ''), 'عنصر مطلوب');
  if nullif(btrim(v_item.preferred_model), '') is not null then
    v_parts := v_parts || ('الموديل: ' || btrim(v_item.preferred_model));
  end if;
  if v_item.preferred_company_id is not null then
    select name into v_company from public.companies where id = v_item.preferred_company_id;
    if v_company is not null then v_parts := v_parts || ('الشركة المفضلة: ' || v_company); end if;
  end if;
  v_parts := v_parts || ('من الطلب ' || v_req.request_number);
  v_notes := array_to_string(v_parts, ' · ');

  -- (ز) إدراج بند طلب الشراء — وصف حر بلا مستهلك، الكمية كما هي (لا رفع)، بلا unit_cost.
  insert into public.purchase_request_items
    (purchase_request_id, consumable_id, description, requested_quantity, notes, source_request_item_id)
  values
    (v_pr_id, null, v_desc, greatest(coalesce(v_item.quantity, 1), 1), v_notes, p_item_id);

  -- (ح) وسم بند الطلب needs_purchase=true ⇒ البوابة ترى «جارٍ التوفير» (procuring) تلقائياً.
  update public.request_items set needs_purchase = true where id = p_item_id;

  -- (ط) حدث سجل — للموظفين فقط (خارج قائمة أحداث البوابة المُبيّضة).
  perform public._request_add_event(
    v_item.request_id, 'purchase_requested', 'staff', null,
    jsonb_build_object('item_id', p_item_id, 'pr_id', v_pr_id, 'pr_number', v_pr_number));

  return json_build_object('ok', true, 'pr_id', v_pr_id, 'pr_number', v_pr_number);
end $func$;

revoke all on function public.request_item_convert_to_pr(uuid, uuid) from public, anon;
grant execute on function public.request_item_convert_to_pr(uuid, uuid) to authenticated;

comment on function public.request_item_convert_to_pr(uuid, uuid) is
  'يحوّل بند احتياج (custom) إلى بند طلب شراء draft (جديد أو قائم). لا يلمس المخزون، لا تحويل مكرر، needs_purchase=true. البوابة لا ترى طلب الشراء.';
