-- ============================================================================
--  المرحلة: نظام طلبات العملاء — إضافة حالتي الأصل rented (مؤجَّر) و sold (مُباع)
--  إضافي وآمن: ALTER TYPE ADD VALUE فقط — لا DROP · لا حذف بيانات · لا تغيير صفوف.
--  تُطبَّق منفصلة عن الدوال التي تستخدم القيمة (لتفادي قيد same-transaction في Postgres).
-- ============================================================================

alter type public.asset_status add value if not exists 'rented';
alter type public.asset_status add value if not exists 'sold';
