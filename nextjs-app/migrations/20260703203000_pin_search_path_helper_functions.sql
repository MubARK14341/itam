-- تحصين (LOW): تثبيت search_path على الدوال المساعدة/الـ triggers التي رصدها
-- مستشار أمان Supabase (function_search_path_mutable).
-- دالة بلا search_path مثبّت يمكن التلاعب بمسار تحليل أسمائها عبر schemas أخرى.
-- ALTER FUNCTION يحافظ على جسم الدالة كما هو — تغيير إعداد فقط.
-- (audit_trigger و handle_new_user — وهما SECURITY DEFINER — مثبّتتان مسبقًا.)

alter function public.set_updated_at() set search_path = public;
alter function public.current_user_id() set search_path = public;
alter function public.next_asset_tag(uuid) set search_path = public;
alter function public.assets_assign_tag() set search_path = public;
alter function public.asset_status_allowed(asset_status, asset_status) set search_path = public;
alter function public.assets_guard_status() set search_path = public;
alter function public.requests_assign_number() set search_path = public;
alter function public.request_status_allowed(text, text) set search_path = public;
