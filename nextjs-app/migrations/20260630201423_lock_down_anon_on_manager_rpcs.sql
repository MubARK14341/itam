-- إزالة صلاحية anon عن الدوال الإدارية/الحساسة (Supabase يمنحها تلقائيًا للـ anon)
-- تبقى registration_status و validate_registration_invite متاحتين للـ anon (لا تكشفان أسرارًا).
revoke execute on function public.is_approved() from anon;
revoke execute on function public.approve_user(uuid, text) from anon;
revoke execute on function public.reject_user(uuid, text) from anon;
revoke execute on function public.reset_user_pending(uuid) from anon;
revoke execute on function public.list_registration_requests(text) from anon;
