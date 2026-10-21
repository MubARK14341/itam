-- ============================================================================
--  تحصين دورة حالة الطلب على مستوى القاعدة (مثل آلة حالات الأصول assets_guard_status)
--  يغلق ثغرات المراجعة:
--   • BLOCKER: فنّي يعتمد/يرفض طلبًا عبر UPDATE مباشر متجاوزًا RPC المدير.
--   • HIGH: لا حارس انتقالات لحالة الطلب (قفزات غير قانونية draft→delivered…).
--   • MEDIUM: تزوير approved_by/rejected_by عبر التحديث المباشر.
--  الحلّ: request_status_allowed(old,new) + محفّز BEFORE UPDATE يَفرض:
--   (1) شرعية الانتقال، (2) حصر approved/rejected بالمدير، (3) ختم أعمدة التدقيق بالخادم.
--  لا يكسر مسار التطبيق (كل انتقالات الواجهة قانونية). إضافي وآمن — لا حذف بيانات.
-- ============================================================================

create or replace function public.request_status_allowed(p_old text, p_new text)
returns boolean language plpgsql immutable as $func$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'draft'              then p_new in ('under_review','approved','rejected','cancelled')
    when 'under_review'       then p_new in ('approved','rejected','cancelled')
    when 'approved'           then p_new in ('preparing','ready_for_pickup','delivered','completed','rejected','cancelled')
    when 'preparing'          then p_new in ('ready_for_pickup','delivered','completed','rejected','cancelled')
    when 'ready_for_pickup'   then p_new in ('delivered','completed','rejected','cancelled')
    when 'delivered'          then p_new in ('partially_returned','returned','completed','overdue')
    when 'partially_returned' then p_new in ('returned','completed','overdue')
    when 'returned'           then p_new in ('completed')
    when 'overdue'            then p_new in ('partially_returned','returned','completed')
    when 'completed'          then false
    when 'rejected'           then false
    when 'cancelled'          then false
    else false
  end;
end $func$;

create or replace function public.requests_guard_status()
returns trigger language plpgsql set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if new.status is distinct from old.status then
    -- (1) شرعية الانتقال
    if not public.request_status_allowed(old.status, new.status) then
      raise exception 'انتقال حالة طلب غير مسموح: % → %', old.status, new.status using errcode = 'check_violation';
    end if;
    -- (2) الاعتماد/الرفض مقصوران على المدير (يمنع تجاوز RPC من فني عبر UPDATE مباشر)
    if new.status in ('approved','rejected') and (v_caller is null or v_caller not in ('admin','it_manager')) then
      raise exception 'الاعتماد/الرفض مقصور على المدير' using errcode = 'insufficient_privilege';
    end if;
    -- (3) ختم أعمدة التدقيق بالخادم (تمنع تزوير approved_by/rejected_by من العميل)
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
    -- لا تغيير حالة → امنع العبث بأعمدة التدقيق على أي تحديث آخر
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at;
    new.rejection_reason := old.rejection_reason;
  end if;
  return new;
end $func$;

drop trigger if exists trg_requests_guard_status on public.requests;
create trigger trg_requests_guard_status before update on public.requests
  for each row execute function public.requests_guard_status();
