-- ============================================================================
--  إصلاح أمني: حصر قراءة مرفقات الفواتير المالية على admin/it_manager فقط
--  (warranty_invoice / purchase_invoice / consumable_invoice / replenishment_invoice)
--  دون كسر: صورة الجهاز (asset_photo) · مرفقات الصيانة (kind='invoice'/'device_photo'/null) ·
--  المرفقات العامة (kind=null). إضافي/تحديث سياسات فقط — لا DROP TABLE/TRUNCATE/DELETE، لا anon، لا bucket public.
--
--  دفاع بطبقتين:
--   (1) جدول attachments: إخفاء صفوف الفواتير المالية عن غير الماليين ⇒ لا يتسرّب storage_path.
--   (2) storage.objects: إخفاء كائنات الفواتير (حسب مقطع المسار) ⇒ يُغلق سرد/توقيع الملف مباشرةً.
--  مسارات الصيانة لا تحوي مقطع kind (maintenance/<id>/<ts>_name) فلا تتأثر.
-- ============================================================================

-- (1) سياسة قراءة جدول attachments — kind-aware (آمنة لقيمة NULL عبر <> all)
drop policy if exists sel_auth on public.attachments;
create policy sel_auth on public.attachments for select to authenticated
using (
  public.is_approved()
  and (
    public.app_user_role() in ('admin','it_manager')
    or coalesce(kind,'') <> all (array['warranty_invoice','purchase_invoice','consumable_invoice','replenishment_invoice'])
  )
);

-- (2) سياسة قراءة كائنات التخزين — path-aware (نفس الدور؛ تبقى authenticated فقط، لا anon)
drop policy if exists attachments_auth_read on storage.objects;
create policy attachments_auth_read on storage.objects for select to authenticated
using (
  bucket_id = 'attachments'
  and (
    public.app_user_role() in ('admin','it_manager')
    or (
          name not like '%/warranty_invoice/%'
      and name not like '%/purchase_invoice/%'
      and name not like '%/consumable_invoice/%'
      and name not like '%/replenishment_invoice/%'
    )
  )
);
