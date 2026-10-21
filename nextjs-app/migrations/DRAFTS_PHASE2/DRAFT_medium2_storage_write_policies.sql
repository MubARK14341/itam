-- ============================================================================
-- MEDIUM-2 — تقوية سياسات الكتابة على Storage (bucket = attachments)
-- FINAL (بعد فحص السياسات الحيّة 2026-07-01) — بانتظار تأكيد التطبيق النهائي.
-- ============================================================================
--
-- الهدف:
--   منع أي مستخدم معتمد من رفع/استبدال/حذف ملفات بحرّية في مسارات حسّاسة.
--   الكتابة تصبح حسب الدور ونوع الملف:
--     • مسارات الفواتير المالية (warranty_invoice / purchase_invoice /
--       consumable_invoice / replenishment_invoice) → admin / it_manager فقط.
--     • بقية مسارات المرفقات التشغيلية (صورة جهاز، مرفق صيانة، عام) →
--       admin / it_manager / technician (نفس canWrite في التطبيق).
--     • viewer / auditor / pending / rejected / anon → لا كتابة إطلاقًا.
--   (القراءة محميّة مسبقًا عبر attachments_auth_read — تبقى كما هي، لا تُمسّ.)
--
-- الحالة الحيّة المؤكَّدة (pg_policies على storage.objects):
--   attachments_auth_read   (SELECT) → role/path-aware  ✅ نُبقيها.
--   attachments_auth_insert (INSERT) → bucket_id='attachments' فقط  ⚠️ يُستبدل.
--   attachments_auth_update (UPDATE) → bucket_id='attachments' فقط  ⚠️ يُستبدل.
--   attachments_auth_delete (DELETE) → bucket_id='attachments' فقط  ⚠️ يُستبدل.
--
-- ماذا يغيّر:
--   يحذف سياسات الكتابة الثلاث العامة ويعيد إنشاءها path-aware + role-aware.
--   لا يمسّ سياسة القراءة، ولا أي كائن/ملف مخزّن.
--
-- Destructive؟  ❌ لا. لا يحذف ملفات ولا صفوفًا. يستبدل *سياسات* الكتابة فقط.
--
-- ----------------------------------------------------------------------------
-- (0) حذف سياسات الكتابة العامة الحالية (أسماء مؤكَّدة من الفحص الحيّ)
-- ----------------------------------------------------------------------------
drop policy if exists attachments_auth_insert on storage.objects;
drop policy if exists attachments_auth_update on storage.objects;
drop policy if exists attachments_auth_delete on storage.objects;

-- ----------------------------------------------------------------------------
-- (1) سياسات كتابة جديدة — path-aware + role-aware، على bucket=attachments فقط.
--     المسار المالي (يحوي /<financial_kind>/) → admin/it_manager فقط،
--     غيره → admin/it_manager/technician. (نفس نمط attachments_auth_read.)
-- ----------------------------------------------------------------------------

-- INSERT (رفع)
create policy attachments_auth_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'attachments'
  and (
    case
      when (name like '%/warranty_invoice/%'
         or name like '%/purchase_invoice/%'
         or name like '%/consumable_invoice/%'
         or name like '%/replenishment_invoice/%')
        then public.app_user_role() in ('admin','it_manager')
      else public.app_user_role() in ('admin','it_manager','technician')
    end
  )
);

-- UPDATE (استبدال/تحريك)
create policy attachments_auth_update on storage.objects for update to authenticated
using (
  bucket_id = 'attachments'
  and (
    case
      when (name like '%/warranty_invoice/%'
         or name like '%/purchase_invoice/%'
         or name like '%/consumable_invoice/%'
         or name like '%/replenishment_invoice/%')
        then public.app_user_role() in ('admin','it_manager')
      else public.app_user_role() in ('admin','it_manager','technician')
    end
  )
)
with check (
  bucket_id = 'attachments'
  and (
    case
      when (name like '%/warranty_invoice/%'
         or name like '%/purchase_invoice/%'
         or name like '%/consumable_invoice/%'
         or name like '%/replenishment_invoice/%')
        then public.app_user_role() in ('admin','it_manager')
      else public.app_user_role() in ('admin','it_manager','technician')
    end
  )
);

-- DELETE (حذف)
create policy attachments_auth_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'attachments'
  and (
    case
      when (name like '%/warranty_invoice/%'
         or name like '%/purchase_invoice/%'
         or name like '%/consumable_invoice/%'
         or name like '%/replenishment_invoice/%')
        then public.app_user_role() in ('admin','it_manager')
      else public.app_user_role() in ('admin','it_manager','technician')
    end
  )
);

-- ============================================================================
-- Rollback Plan (يعيد الوضع الحيّ السابق بالضبط):
--   drop policy if exists attachments_auth_insert on storage.objects;
--   drop policy if exists attachments_auth_update on storage.objects;
--   drop policy if exists attachments_auth_delete on storage.objects;
--   create policy attachments_auth_insert on storage.objects for insert to authenticated
--     with check (bucket_id = 'attachments');
--   create policy attachments_auth_update on storage.objects for update to authenticated
--     using (bucket_id = 'attachments') with check (bucket_id = 'attachments');
--   create policy attachments_auth_delete on storage.objects for delete to authenticated
--     using (bucket_id = 'attachments');
--
-- Test Plan (Smoke):
--   [admin]      رفع صورة جهاز + فاتورة شراء ⇒ ينجح.
--   [it_manager] رفع/استبدال/حذف فاتورة مالية ⇒ ينجح.
--   [technician] رفع صورة جهاز/مرفق صيانة ⇒ ينجح؛ رفع/حذف فاتورة مالية ⇒ يُرفض.
--   [viewer]     أي رفع/حذف ⇒ يُرفض.
--   [anon]       لا وصول (bucket خاص).
--   القراءة (توقيع روابط) للمدراء ما زالت تعمل (لم تُمسّ).
--
-- مخاطر التطبيق:
--   • تُطبَّق في معاملة واحدة (apply_migration) ⇒ لا نافذة بلا سياسة.
--   • أسماء الأنواع في المسار (name LIKE '%/<kind>/%') مطابقة لسياسة القراءة الحالية.
--   • viewer/auditor يفقدان الكتابة (كانا يكتبان بالخطأ) — سلوك مقصود، لا يكسر تدفقًا مشروعًا
--     (الرفع يتم فقط من نماذج canWrite = admin/it_manager/technician).
--   • لا خطر على الملفات الحالية (لا حذف كائنات).
-- ============================================================================
