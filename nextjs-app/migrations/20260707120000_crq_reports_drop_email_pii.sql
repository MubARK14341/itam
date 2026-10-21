-- =====================================================================
-- RC1 patch — منع تسريب PII (بريد الموظف) في تقارير طلبات العملاء
-- المشكلة: get_customer_request_operational_report و get_customer_request_analytics
--   كانتا تستخدمان coalesce(u.full_name, u.email) كتسمية للموظف المسؤول.
--   عند غياب الاسم يظهر البريد الإلكتروني الداخلي في التقرير/التوزيعات وتصدير CSV
--   لأي مستخدم يملك القدرة report.customer_requests — متجاوزًا بوابة user_label
--   التي تكشف الأسماء لـ admin/it_manager فقط.
-- الإصلاح: إسقاط بديل البريد؛ الاسم فقط وإلا '—'. لا تغيير في التوقيع/الصلاحيات/RLS.
-- المخاطرة: منخفضة (تصحيح إخراج فقط). التراجع: إعادة تعريف الدالتين بنسخة 20260706150000.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.get_customer_request_operational_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    'responsible_name',      coalesce(u.full_name, '—'),
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
end $function$;

CREATE OR REPLACE FUNCTION public.get_customer_request_analytics(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_summary json; v_breakdowns json; v_timing json;
begin
  if not public.current_user_has_capability('report.customer_requests') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  with f as materialized (select * from public._crq_filter(p_filters))
  select json_build_object(
    'total_requests',           (select count(*) from f),
    'client_portal_requests',   (select count(*) filter (where request_source = 'client_portal') from f),
    'internal_requests',        (select count(*) filter (where request_source = 'internal') from f),
    'open_requests',            (select count(*) filter (where status not in ('completed','returned','cancelled','rejected') and portal_approval_status not in ('rejected_by_project_manager','pending_project_manager')) from f),
    'completed_requests',       (select count(*) filter (where status in ('completed','returned')) from f),
    'rejected_requests',        (select count(*) filter (where status = 'rejected' or portal_approval_status = 'rejected_by_project_manager') from f),
    'needs_clarification',      (select count(*) filter (where status = 'needs_clarification') from f),
    'pending_project_manager',  (select count(*) filter (where portal_approval_status = 'pending_project_manager') from f),
    'pending_internal_review',  (select count(*) filter (where status in ('draft','under_review') and portal_approval_status <> 'pending_project_manager') from f),
    'in_progress',              (select count(*) filter (where status in ('approved','preparing','ready_for_pickup','delivered','partially_returned','overdue')) from f),
    'needs_purchase_items',     (select count(*) from public.request_items ri where ri.request_id in (select id from f) and ri.needs_purchase),
    'attachments_count',        (select count(*) from public.request_attachments ra where ra.request_id in (select id from f))
  ) into v_summary;
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
                                   from (select coalesce(u.full_name, '—') k, count(*) c
                                         from f left join public.app_users u on u.id = f.responsible_employee_id
                                         group by coalesce(u.full_name, '—')) t)
  ) into v_breakdowns;
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
end $function$;
