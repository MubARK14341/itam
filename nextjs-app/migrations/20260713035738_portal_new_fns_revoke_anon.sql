-- ============================================================================
-- Migration: تصحيح تصاريح — إزالة منح EXECUTE المباشر لـ anon على دوال البوابة الثلاث الجديدة.
-- Purpose: Supabase يمنح EXECUTE افتراضيًا لـ anon عند إنشاء الدوال (ALTER DEFAULT PRIVILEGES)، لذا
--          revoke from public في الترحيل السابق لا يكفي — هذا يزيل المنح المباشر (كنمط بقية دوال البوابة).
-- Risk: تصاريح فقط (revoke). لا drop، لا تغيير جسم دالة، لا anon expansion (بل تقليص). عديم الأثر عند التكرار.
-- Verify: has_function_privilege('anon', ..., 'execute') = false بعد التطبيق (أُثبت حيًّا).
-- ============================================================================
revoke all on function public.portal_get_profile()                     from anon;
revoke all on function public.portal_update_profile(text, text, text)  from anon;
revoke all on function public.portal_list_catalog()                    from anon;
