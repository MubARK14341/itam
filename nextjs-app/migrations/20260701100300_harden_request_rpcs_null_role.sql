-- إصلاح ثغرة تصعيد صلاحيات على دوال الطلبات (مطابق fix_null_role_guard_privilege_escalation):
--  • الحارس «if v_caller not in (...)» يفشل عندما v_caller = NULL (anon أو pending بلا دور)
--    لأن «NULL not in (...)» = NULL وتعتبره IF كـ false فيتجاوز الحارس ويُنفّذ التحديث.
--    الإصلاح: فحص NULL صراحةً.
--  • create or replace يُعيد منح EXECUTE الافتراضي من Supabase لـ anon — لذا نسحبه صراحةً.
--    next_request_number أيضًا: لا يستدعيه إلا المحفّز (مسار INSERT المحكوم بـ RLS).

create or replace function public.request_approve(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'approved', approved_by = auth.uid(), approved_at = now(),
      rejected_by = null, rejected_at = null, rejection_reason = null, updated_at = now()
  where id = p_id and status in ('draft','under_review');
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  return json_build_object('ok', true);
end $func$;

create or replace function public.request_reject(p_id uuid, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(),
      rejection_reason = nullif(p_reason, ''), updated_at = now()
  where id = p_id and status in ('draft','under_review','approved','preparing','ready_for_pickup');
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  return json_build_object('ok', true);
end $func$;

-- سحب صلاحية anon صراحةً (إعادة التعريف تُعيد المنح الافتراضي)
revoke execute on function public.request_approve(uuid) from anon;
revoke execute on function public.request_reject(uuid, text) from anon;
revoke execute on function public.next_request_number() from anon;
