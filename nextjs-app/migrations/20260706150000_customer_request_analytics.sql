-- ============================================================================
--  Batch 6 (2/…) — تحليلات طلبات العملاء (RPCs آمنة للتقارير) + قدرة + فهارس.
--  إضافي وآمن بالكامل: لا DROP بيانات · لا anon · لا service_role · لا لمس منطق
--  المخزون/المرفقات/جسر الشراء/اعتماد مدير المشروع (قراءة الأعمدة فقط).
--
--  المبدأ الأمني:
--   • كل RPC داخلي محكوم بالقدرة الجديدة report.customer_requests (current_user_has_capability)
--     ويفشل مغلقًا (not_authorized) — الواجهة ليست مصدر الأمان.
--   • RPC البوابة portal_get_request_dashboard معزول بنفس شرط portal_list_requests
--     (PM/viewer كل طلبات العميل؛ authorized_requester طلباته فقط) + portal_enabled.
--   • لا مخرجات مالية إطلاقًا: أعمدة request_items.unit_price/total_price محجوبة (HIGH-1)
--     ولا تُقرأ هنا؛ ولا asset_id/consumable_id/internal_notes/storage_path/أرقام PR في أي مخرج.
--   • الفلاتر تُتحقق وتفشل مغلقة (invalid_filters) على أي إدخال غير صالح (لا تجاهل صامت).
--   • مقاييس التوقيت تُرجع null عند تعذّر الحساب (صفوف قديمة بلا أحداث) — لا اختراع أرقام.
--   • completed_at غير مخزّن على requests ⇒ يُشتق من request_events(status_changed→'completed').
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) القدرة الجديدة (grp=reports) — نمط 20260705160000. idempotent عبر UNIQUE(key).
--    الأدوار: admin/it_manager/auditor/viewer (ليس technician — يُمنح لاحقًا per-user
--    عبر set_user_capability). admin كامل دائمًا في has_capability بلا حاجة لصف.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, grp, description) values
  ('report.customer_requests', 'reports', 'عرض تقارير طلبات العملاء')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where p.key = 'report.customer_requests' and r.key in ('admin','it_manager','auditor','viewer')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2) فهارس إضافية (create index if not exists) — لتسريع التجميع/الفلترة.
--    ملاحظة: idx_request_attachments_request(request_id, created_at) موجود أصلًا
--    (20260706120000) ⇒ لا نُعيد إنشاءه. idx_requests_responsible أحادي العمود موجود
--    (20260706100100)؛ المركّب أدناه إضافي (لا حذف — إضافي فقط).
-- ---------------------------------------------------------------------------
create index if not exists idx_requests_source_customer_status_created
  on public.requests(request_source, customer_id, status, created_at);
create index if not exists idx_requests_customer_pmstatus_created
  on public.requests(customer_id, portal_approval_status, created_at);
create index if not exists idx_requests_responsible_created
  on public.requests(responsible_employee_id, created_at);
create index if not exists idx_request_items_request_kind_purchase
  on public.request_items(request_id, item_kind, needs_purchase);
create index if not exists idx_request_events_request_type_created
  on public.request_events(request_id, event_type, created_at);

-- ---------------------------------------------------------------------------
-- 3) مُرشِّح داخلي مشترك — يُرجع صفوف requests المطابقة للفلاتر. يتحقق من الصلاحية
--    القيمية للفلاتر ويرفع 22023 عند إدخال غير صالح (يلتقطه المستدعي كـ invalid_filters).
--    داخلي بحت: revoke عن الجميع (يُستدعى فقط من دوال التقارير SECURITY DEFINER).
-- ---------------------------------------------------------------------------
create or replace function public._crq_filter(p_filters jsonb)
returns setof public.requests
language plpgsql stable security definer set search_path = public as $func$
declare
  v_date_from date; v_date_to date; v_customer uuid; v_responsible uuid;
  v_type text; v_status text; v_source text; v_pm text; v_city text;
begin
  -- تحويلات قد تفشل ⇒ نرفعها كـ 22023 (invalid_filters) بدل خطأ 500.
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
  -- قوائم بيضاء صريحة (لا حقن قيم في SQL — كلها مقيّدة بمعاملات).
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
  where (v_date_from   is null or r.created_at >= v_date_from)
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

-- ###########################################################################
--  4) تحليلات (ملخص + توزيعات + توقيتات) — للفريق الداخلي المخوّل فقط
-- ###########################################################################
create or replace function public.get_customer_request_analytics(p_filters jsonb default '{}'::jsonb)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_summary json; v_breakdowns json; v_timing json;
begin
  if not public.current_user_has_capability('report.customer_requests') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  -- الملخص
  with f as materialized (select * from public._crq_filter(p_filters))
  select json_build_object(
    'total_requests',           (select count(*) from f),
    'client_portal_requests',   (select count(*) filter (where request_source = 'client_portal') from f),
    'internal_requests',        (select count(*) filter (where request_source = 'internal') from f),
    -- «مفتوح» للفريق = نشِط ويراه الفريق فعليًا: يستبعد المنتهي (completed/returned/cancelled/rejected)
    -- ويستبعد المعلّق/المرفوض من مدير المشروع (مطابق لاستبعاد التقرير التشغيلي — الفريق لا يراها).
    'open_requests',            (select count(*) filter (where status not in ('completed','returned','cancelled','rejected') and portal_approval_status not in ('rejected_by_project_manager','pending_project_manager')) from f),
    -- «مكتمل» يشمل returned (الإرجاع = انتهاء دورة التأجير) — مطابقة لمعالجة لوحة البوابة.
    'completed_requests',       (select count(*) filter (where status in ('completed','returned')) from f),
    'rejected_requests',        (select count(*) filter (where status = 'rejected' or portal_approval_status = 'rejected_by_project_manager') from f),
    'needs_clarification',      (select count(*) filter (where status = 'needs_clarification') from f),
    'pending_project_manager',  (select count(*) filter (where portal_approval_status = 'pending_project_manager') from f),
    'pending_internal_review',  (select count(*) filter (where status in ('draft','under_review') and portal_approval_status <> 'pending_project_manager') from f),
    'in_progress',              (select count(*) filter (where status in ('approved','preparing','ready_for_pickup','delivered','partially_returned','overdue')) from f),
    'needs_purchase_items',     (select count(*) from public.request_items ri where ri.request_id in (select id from f) and ri.needs_purchase),
    'attachments_count',        (select count(*) from public.request_attachments ra where ra.request_id in (select id from f))
  ) into v_summary;

  -- التوزيعات (كل توزيع مصفوفة {key, count} تنازليًا)
  with f as materialized (select * from public._crq_filter(p_filters))
  select json_build_object(
    'by_status',                  (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select status k, count(*) c from f group by status) t),
    'by_request_type',            (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select request_type k, count(*) c from f group by request_type) t),
    'by_source',                  (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select request_source k, count(*) c from f group by request_source) t),
    'by_portal_approval_status',  (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select portal_approval_status k, count(*) c from f group by portal_approval_status) t),
    'by_city',                    (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select coalesce(project_city,'—') k, count(*) c from f group by coalesce(project_city,'—')) t),
    'by_customer',                (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json)
                                   from (select coalesce(cu.name, f.customer_name_snapshot, '—') k, count(*) c
                                         from f left join public.customers cu on cu.id = f.customer_id
                                         group by coalesce(cu.name, f.customer_name_snapshot, '—')) t),
    'by_responsible_employee',    (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json)
                                   from (select coalesce(u.full_name, u.email, '—') k, count(*) c
                                         from f left join public.app_users u on u.id = f.responsible_employee_id
                                         group by coalesce(u.full_name, u.email, '—')) t)
  ) into v_breakdowns;

  -- التوقيتات (بالساعات، رقم عشري واحد؛ null عند عدم القابلية للحساب)
  with f as materialized (select * from public._crq_filter(p_filters))
  select json_build_object(
    'avg_time_to_pm_approval',    (select round(avg(extract(epoch from (portal_approved_at - portal_approval_requested_at)) / 3600.0)::numeric, 1)
                                   from f where portal_approved_at is not null and portal_approval_requested_at is not null),
    'avg_time_to_approval',       (select round(avg(extract(epoch from (approved_at - created_at)) / 3600.0)::numeric, 1)
                                   from f where approved_at is not null),
    'avg_time_to_internal_review',(select round(avg(extract(epoch from (fa.first_action - tr.team_received)) / 3600.0)::numeric, 1)
                                   from f
                                   join lateral (
                                     select min(e.created_at) first_action from public.request_events e
                                     where e.request_id = f.id
                                       and ( (e.actor_kind = 'staff' and e.event_type = 'clarification_requested')
                                          or (e.event_type = 'status_changed' and e.metadata->>'to' in ('approved','rejected','needs_clarification')) )
                                   ) fa on true
                                   join lateral (
                                     select coalesce(
                                       f.portal_approved_at,
                                       (select min(e2.created_at) from public.request_events e2 where e2.request_id = f.id and e2.event_type = 'submitted'),
                                       f.created_at) team_received
                                   ) tr on true
                                   where fa.first_action is not null and fa.first_action >= tr.team_received),
    'avg_time_to_completion',     (select round(avg(extract(epoch from (ce.completed_at - f.created_at)) / 3600.0)::numeric, 1)
                                   from f
                                   join lateral (
                                     select min(e.created_at) completed_at from public.request_events e
                                     where e.request_id = f.id and e.event_type = 'status_changed' and e.metadata->>'to' = 'completed'
                                   ) ce on true
                                   where ce.completed_at is not null),
    'oldest_open_request_days',   (select floor(extract(epoch from (now() - min(created_at))) / 86400.0)::int
                                   from f where status not in ('completed','returned','cancelled','rejected') and portal_approval_status not in ('rejected_by_project_manager','pending_project_manager'))
  ) into v_timing;

  return json_build_object('ok', true, 'summary', v_summary, 'breakdowns', v_breakdowns, 'timing', v_timing);
exception when sqlstate '22023' then
  return json_build_object('ok', false, 'error', 'invalid_filters');
end $func$;

-- ###########################################################################
--  5) سلسلة زمنية (day/week/month) — أعداد لكل حاوية زمنية
-- ###########################################################################
create or replace function public.get_customer_request_timeseries(p_filters jsonb default '{}'::jsonb)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_gran text; v_series json;
begin
  if not public.current_user_has_capability('report.customer_requests') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  v_gran := coalesce(nullif(p_filters->>'granularity',''), 'day');
  if v_gran not in ('day','week','month') then
    return json_build_object('ok', false, 'error', 'invalid_filters');
  end if;

  with f as materialized (select * from public._crq_filter(p_filters)),
  ev as (
    select date_trunc(v_gran, created_at) b, 'created'::text m from f
    union all
    select date_trunc(v_gran, rejected_at), 'rejected' from f where rejected_at is not null
    union all
    select date_trunc(v_gran, portal_approval_requested_at), 'pending_pm' from f where portal_approval_requested_at is not null
    union all
    select date_trunc(v_gran, e.created_at), 'submitted' from public.request_events e join f on f.id = e.request_id where e.event_type = 'submitted'
    union all
    select date_trunc(v_gran, e.created_at), 'completed' from public.request_events e join f on f.id = e.request_id where e.event_type = 'status_changed' and e.metadata->>'to' = 'completed'
  ),
  agg as (
    select b,
      count(*) filter (where m = 'created')    created_count,
      count(*) filter (where m = 'submitted')  submitted_count,
      count(*) filter (where m = 'completed')  completed_count,
      count(*) filter (where m = 'rejected')   rejected_count,
      count(*) filter (where m = 'pending_pm') pending_pm_count
    from ev group by b
  )
  select coalesce(json_agg(json_build_object(
    'bucket', to_char(b, 'YYYY-MM-DD'),
    'created_count', created_count, 'submitted_count', submitted_count,
    'completed_count', completed_count, 'rejected_count', rejected_count, 'pending_pm_count', pending_pm_count
  ) order by b), '[]'::json) into v_series from agg;

  return json_build_object('ok', true, 'granularity', v_gran, 'series', v_series);
exception when sqlstate '22023' then
  return json_build_object('ok', false, 'error', 'invalid_filters');
end $func$;

-- ###########################################################################
--  6) تقرير تشغيلي (صفوف آمنة) — يستبعد المعلّق/المرفوض من مدير المشروع (مطابقة رؤية الفريق)
-- ###########################################################################
create or replace function public.get_customer_request_operational_report(p_filters jsonb default '{}'::jsonb)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_rows json;
begin
  if not public.current_user_has_capability('report.customer_requests') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  with f as materialized (select * from public._crq_filter(p_filters)),
  base as (
    select r.* from f r
    where r.portal_approval_status not in ('pending_project_manager','rejected_by_project_manager')
    order by r.created_at desc
    limit 1000
  )
  select coalesce(json_agg(json_build_object(
    'request_number',        b.request_number,
    'customer_name',         coalesce(cu.name, b.customer_name_snapshot, '—'),
    'project_name',          b.project_name,
    'project_city',          b.project_city,
    'request_type',          b.request_type,
    'status',                b.status,
    'portal_approval_status',b.portal_approval_status,
    'responsible_name',      coalesce(u.full_name, u.email),
    'created_at',            b.created_at,
    'approved_at',           b.approved_at,
    'completed_at',          (select min(e.created_at) from public.request_events e where e.request_id = b.id and e.event_type = 'status_changed' and e.metadata->>'to' = 'completed'),
    'items_count',           (select count(*) from public.request_items ri where ri.request_id = b.id),
    'needs_purchase_count',  (select count(*) from public.request_items ri where ri.request_id = b.id and ri.needs_purchase),
    'attachments_count',     (select count(*) from public.request_attachments ra where ra.request_id = b.id),
    'last_event_at',         (select max(e.created_at) from public.request_events e where e.request_id = b.id)
  ) order by b.created_at desc), '[]'::json) into v_rows
  from base b
  left join public.customers cu on cu.id = b.customer_id
  left join public.app_users u  on u.id  = b.responsible_employee_id;

  return json_build_object('ok', true, 'rows', v_rows);
exception when sqlstate '22023' then
  return json_build_object('ok', false, 'error', 'invalid_filters');
end $func$;

-- ###########################################################################
--  7) لوحة البوابة (ملخص العميل الحالي) — عزل مطابق لـ portal_list_requests
-- ###########################################################################
create or replace function public.portal_get_request_dashboard()
returns json language plpgsql stable security definer set search_path = public as $func$
declare
  v_cid uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_s public.customer_portal_settings;
  v_result json;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;

  -- mine = طلبات هذا العميل وفق الدور (PM/viewer الكل؛ authorized_requester طلباته فقط)
  with mine as (
    select r.* from public.requests r
    where r.customer_id = v_cid
      and (v_role in ('project_manager','viewer') or r.submitted_by = auth.uid())
  ),
  recent as (select * from mine order by created_at desc limit 5)
  select json_build_object(
    'ok', true,
    'portal_role', v_role,
    'total_my_requests',   (select count(*) from mine),
    'open_requests',       (select count(*) from mine where status not in ('completed','returned','rejected','cancelled') and portal_approval_status <> 'rejected_by_project_manager'),
    'waiting_pm_approval', (select count(*) from mine where portal_approval_status = 'pending_project_manager'),
    'needs_clarification', (select count(*) from mine where status = 'needs_clarification'),
    'in_progress',         (select count(*) from mine where status in ('approved','preparing','ready_for_pickup','delivered','partially_returned','overdue')),
    'completed',           (select count(*) from mine where status in ('completed','returned')),
    'rejected',            (select count(*) from mine where status = 'rejected' or portal_approval_status = 'rejected_by_project_manager'),
    'counts_by_status',    (select coalesce(json_agg(json_build_object('status', status, 'portal_approval_status', portal_approval_status, 'count', c)), '[]'::json)
                            from (select status, portal_approval_status, count(*) c from mine group by status, portal_approval_status) t),
    'recent_requests',     (select coalesce(json_agg(json_build_object(
                              'id', id, 'request_number', request_number, 'status', status,
                              'portal_approval_status', portal_approval_status, 'request_type', request_type,
                              'project_name', project_name, 'created_at', created_at,
                              'item_count', (select count(*) from public.request_items ri where ri.request_id = recent.id)
                            ) order by created_at desc), '[]'::json) from recent)
  ) into v_result;

  return v_result;
end $func$;

-- ---------------------------------------------------------------------------
-- 8) الصلاحيات — authenticated فقط (الحُرّاس داخل الدوال). لا anon. _crq_filter داخلي.
-- ---------------------------------------------------------------------------
do $do$
declare fn text;
begin
  foreach fn in array array[
    'get_customer_request_analytics(jsonb)',
    'get_customer_request_timeseries(jsonb)',
    'get_customer_request_operational_report(jsonb)',
    'portal_get_request_dashboard()'
  ] loop
    execute format('revoke all on function public.%s from public, anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $do$;

comment on function public.get_customer_request_analytics(jsonb) is
  'Batch 6: ملخص/توزيعات/توقيتات طلبات العملاء. محكوم بـ report.customer_requests. بلا ماليات/أصول/PR.';
comment on function public.portal_get_request_dashboard() is
  'Batch 6: لوحة ملخص العميل (بوابة). عزل مطابق لـ portal_list_requests. بلا ماليات/مخزون/PR/أصول.';
