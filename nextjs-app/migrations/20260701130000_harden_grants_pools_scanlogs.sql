-- ============================================================================
--  تحصين امتيازات مستوى الجدول (defense-in-depth) لـ asset_pools و scan_logs
--  لمطابقة نمط بقية الجداول (companies/customers/requests/...): revoke anon + grant authenticated.
--  RLS يبقى خط الدفاع الأساسي؛ هذا يمنع انكشافًا صامتًا لو حدث تراجع مستقبلي في RLS.
--  إضافي وآمن تمامًا — لا DROP/DELETE/TRUNCATE، لا تعديل بيانات.
-- ============================================================================

revoke all on public.asset_pools from anon;
grant select, insert, update, delete on public.asset_pools to authenticated;

revoke all on public.scan_logs from anon;
grant select, insert, update, delete on public.scan_logs to authenticated;
