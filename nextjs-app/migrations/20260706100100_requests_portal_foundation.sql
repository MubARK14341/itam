-- ============================================================================
--  Client Portal — Phase 1 (2/3): أساس الطلبات (مصدر + مسؤول + توضيح + بوابة اعتماد بالقدرة)
--  إضافي وآمن: أعمدة جديدة + حالة needs_clarification + توسيع الانتقالات +
--  تحويل بوابة الاعتماد/الرفض إلى صلاحية request.approve
--  (المبذورة = admin/it_manager ⇒ صفر انحدار، وقابلة للمنح لفني محدد من الإعدادات).
--  ✅ لا DROP/DELETE على بيانات · لا anon · لا لمس منطق المخزون.
-- ============================================================================

-- 1) أعمدة جديدة على requests (SELECT على مستوى الجدول ممنوح أصلاً ⇒ مرئية للموظفين تلقائياً)
alter table public.requests add column if not exists request_source text not null default 'internal';
alter table public.requests add column if not exists submitted_by uuid null;
alter table public.requests add column if not exists responsible_employee_id uuid null references public.app_users(id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'requests_request_source_check' and conrelid = 'public.requests'::regclass) then
    alter table public.requests add constraint requests_request_source_check check (request_source in ('internal','client_portal'));
  end if;
end $$;
create index if not exists idx_requests_source on public.requests(request_source);
create index if not exists idx_requests_submitted_by on public.requests(submitted_by);
create index if not exists idx_requests_responsible on public.requests(responsible_employee_id);

-- 2) حالة needs_clarification (توسيع CHECK — إضافي، لا حذف قيم)
alter table public.requests drop constraint if exists requests_status_check;
alter table public.requests add constraint requests_status_check
  check (status in ('draft','under_review','approved','rejected','preparing',
                    'ready_for_pickup','delivered','partially_returned','returned',
                    'completed','cancelled','overdue','needs_clarification'));

-- 3) توسيع انتقالات الحالة (إضافة needs_clarification فقط — لا حذف انتقال قائم)
create or replace function public.request_status_allowed(p_old text, p_new text)
returns boolean language plpgsql immutable set search_path = public as $func$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'draft'               then p_new in ('under_review','approved','rejected','cancelled')
    when 'under_review'        then p_new in ('approved','rejected','cancelled','needs_clarification')
    when 'needs_clarification' then p_new in ('under_review','approved','rejected','cancelled')
    when 'approved'            then p_new in ('preparing','ready_for_pickup','delivered','completed','rejected','cancelled')
    when 'preparing'           then p_new in ('ready_for_pickup','delivered','completed','rejected','cancelled')
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

-- 4) حارس الحالة: بوابة الاعتماد/الرفض عبر القدرة request.approve (المبذورة = admin/it_manager)
--    باقي المنطق (شرعية الانتقال + ختم أعمدة التدقيق) كما هو حرفياً.
create or replace function public.requests_guard_status()
returns trigger language plpgsql set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if new.status is distinct from old.status then
    if not public.request_status_allowed(old.status, new.status) then
      raise exception 'انتقال حالة طلب غير مسموح: % → %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status in ('approved','rejected') and not public.current_user_has_capability('request.approve') then
      raise exception 'الاعتماد/الرفض يتطلب صلاحية اعتماد الطلبات' using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'approved' then
      new.approved_by := auth.uid(); new.approved_at := now();
      new.rejected_by := null; new.rejected_at := null; new.rejection_reason := null;
    elsif new.status = 'rejected' then
      new.rejected_by := auth.uid(); new.rejected_at := now();
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    else
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
      new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at;
      new.rejection_reason := old.rejection_reason;
    end if;
  else
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at;
    new.rejection_reason := old.rejection_reason;
  end if;
  return new;
end $func$;

-- 5) request_approve: بوابة القدرة + ختم المسؤول (أول من يعتمد). approved_by/at يختمهما الحارس.
create or replace function public.request_approve(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_uid uuid := auth.uid();
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'approved',
      responsible_employee_id = coalesce(responsible_employee_id, v_uid)
  where id = p_id and status in ('draft','under_review','needs_clarification');
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  return json_build_object('ok', true);
end $func$;

-- 6) request_reject: بوابة القدرة + تحرير الأصول المحجوزة (منطق التحرير كما هو حرفياً)
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
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'reserved' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'reserved', 'available', v_uid, 'رفض طلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'rejected', rejection_reason = nullif(p_reason,'') where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- 7) طلب توضيح — under_review → needs_clarification (+ حدث برسالة للعميل)
create or replace function public.request_request_clarification(p_id uuid, p_message text default null)
returns json language plpgsql security definer set search_path = public as $func$
declare v_req public.requests%rowtype;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'under_review' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  update public.requests set status = 'needs_clarification' where id = p_id;
  perform public._request_add_event(p_id, 'clarification_requested', 'staff', p_message, '{}'::jsonb);
  return json_build_object('ok', true);
end $func$;

-- 8) تعيين المسؤول — يتطلب صلاحية الاعتماد + هدف موظف معتمد (+ حدث)
create or replace function public.request_set_responsible(p_id uuid, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_ok boolean;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select coalesce(approval_status,'approved') = 'approved' into v_ok from public.app_users where id = p_user_id;
  if not coalesce(v_ok, false) then
    return json_build_object('ok', false, 'error', 'invalid_user');
  end if;
  update public.requests set responsible_employee_id = p_user_id where id = p_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  perform public._request_add_event(p_id, 'responsible_assigned', 'staff', null, jsonb_build_object('user_id', p_user_id));
  return json_build_object('ok', true);
end $func$;

-- الصلاحيات: authenticated فقط (الحُرّاس داخل الدوال). سحب anon صراحةً.
revoke all on function public.request_approve(uuid) from public, anon;
revoke all on function public.request_reject(uuid, text) from public, anon;
revoke all on function public.request_request_clarification(uuid, text) from public, anon;
revoke all on function public.request_set_responsible(uuid, uuid) from public, anon;
grant execute on function public.request_approve(uuid) to authenticated;
grant execute on function public.request_reject(uuid, text) to authenticated;
grant execute on function public.request_request_clarification(uuid, text) to authenticated;
grant execute on function public.request_set_responsible(uuid, uuid) to authenticated;
