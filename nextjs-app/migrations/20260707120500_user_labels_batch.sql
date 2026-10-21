-- =====================================================================
-- RC1 patch — دالة دفعة لأسماء المنفّذين (تُنهي N+1 على user_label)
-- سجل النشاط ومُحلّل فلاتر المسؤول كانا يستدعيان user_label مرة لكل معرّف
-- (دورة Promise.all) => جولة شبكة لكل منفّذ متمايز. نضيف user_labels(uuid[])
-- تُعيد كل التسميات في استدعاء واحد، بنفس بوابة user_label تمامًا:
-- الأسماء لـ admin/it_manager فقط، ولا شيء لغيرهم (fail-closed).
-- إضافي بحت: لا تعديل على user_label ولا على الصلاحيات/RLS. التراجع: drop function.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.user_labels(p_ids uuid[])
 RETURNS TABLE(id uuid, label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select u.id, coalesce(nullif(u.full_name, ''), u.email)
  from public.app_users u
  where u.id = any(p_ids)
    and public.app_user_role() in ('admin','it_manager')
$function$;

revoke all on function public.user_labels(uuid[]) from public;
revoke all on function public.user_labels(uuid[]) from anon;
grant execute on function public.user_labels(uuid[]) to authenticated, service_role;
