-- ============================================================================
--  MEDIUM-2 (Phase 2) — Storage write policies: role/path-aware
--  APPLIED 2026-07-01 (version 20260701141909). Mirror of the live migration.
--
--  يستبدل سياسات الكتابة العامة الثلاث على storage.objects (bucket=attachments)
--  بسياسات حسب الدور ونوع الملف — مطابقة لحماية القراءة (attachments_auth_read):
--    • مسارات الفواتير المالية (warranty_invoice/purchase_invoice/
--      consumable_invoice/replenishment_invoice) → admin/it_manager فقط.
--    • بقية المرفقات التشغيلية → admin/it_manager/technician.
--    • viewer/auditor/pending/rejected/anon → لا كتابة.
--  إضافي/غير مدمّر: سياسات فقط — لا حذف كائنات/صفوف، الـ bucket يبقى خاصًا.
--  سياسة القراءة attachments_auth_read لم تُمسّ.
-- ============================================================================

drop policy if exists attachments_auth_insert on storage.objects;
drop policy if exists attachments_auth_update on storage.objects;
drop policy if exists attachments_auth_delete on storage.objects;

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
