-- ============================================================================
--  نظام سجل المسح التشغيلي للمستودع (Scan Logs)
--  إضافي وآمن بالكامل — لا DROP / لا TRUNCATE / لا DELETE / لا فتح anon.
--  الجدول append-only: سياسات INSERT + SELECT فقط (لا UPDATE / لا DELETE).
--  يُسجّل كل عمليات المسح: بحث/دخول/خروج + الفشل (not_found/error/blocked).
--  لا يغيّر حالة أصل ولا يتجاوز مسار طلبات العملاء (request_deliver/return يبقى المصدر الوحيد للتسليم).
-- ============================================================================

create table if not exists public.scan_logs (
  id            uuid primary key default gen_random_uuid(),
  scan_mode     text not null check (scan_mode in ('search','entry','exit')),
  result        text not null check (result in ('found','not_found','error','blocked')),
  item_kind     text     check (item_kind is null or item_kind in ('asset','consumable','unknown')),
  asset_id      uuid references public.assets(id) on delete set null,
  consumable_id uuid references public.consumables(id) on delete set null,
  scanned_value text not null,
  matched_by    text check (
    matched_by is null or matched_by in
    ('qr_token','asset_tag','serial_number','rfid_tag','barcode','sku','name','manual')
  ),
  location_id   uuid references public.locations(id) on delete set null,
  notes         text,
  error_code    text,
  performed_by  uuid,
  created_at    timestamptz not null default now()
);

-- فهارس للاستعلامات الشائعة (التاريخ + الفلترة حسب الوضع/النتيجة + الربط بالعنصر)
create index if not exists idx_scan_logs_created_at   on public.scan_logs (created_at desc);
create index if not exists idx_scan_logs_mode_result  on public.scan_logs (scan_mode, result);
create index if not exists idx_scan_logs_asset        on public.scan_logs (asset_id)      where asset_id is not null;
create index if not exists idx_scan_logs_consumable   on public.scan_logs (consumable_id) where consumable_id is not null;

-- ختم المنفّذ بالخادم: نتجاهل أي performed_by يرسله العميل ونضع auth.uid() دائمًا (يمنع التزوير).
create or replace function public.scan_logs_stamp_actor()
returns trigger language plpgsql set search_path = public as $func$
begin
  new.performed_by := auth.uid();
  return new;
end $func$;

drop trigger if exists trg_scan_logs_stamp_actor on public.scan_logs;
create trigger trg_scan_logs_stamp_actor before insert on public.scan_logs
  for each row execute function public.scan_logs_stamp_actor();

-- RLS: القراءة والإدراج مقصوران على الأدوار التشغيلية (admin / it_manager / technician).
--  app_user_role() يُرجع NULL لغير المعتمدين (pending/rejected) → محجوبون تلقائيًا.
--  السياسات على دور {authenticated} فقط → anon محجوب.
--  viewer/auditor لا يقرؤون ولا يدرجون سجلات المسح.
--  لا سياسة UPDATE ولا DELETE → السجل غير قابل للتعديل أو الحذف (append-only، لا حذف حقيقي).
alter table public.scan_logs enable row level security;

drop policy if exists sel_ops on public.scan_logs;
create policy sel_ops on public.scan_logs
  for select to authenticated
  using (public.app_user_role() = any (array['admin','it_manager','technician']));

drop policy if exists ins_ops on public.scan_logs;
create policy ins_ops on public.scan_logs
  for insert to authenticated
  with check (public.app_user_role() = any (array['admin','it_manager','technician']));

comment on table public.scan_logs is
  'سجل عمليات المسح التشغيلي (بحث/دخول/خروج) + الفشل. append-only، RLS للأدوار التشغيلية فقط. لا يغيّر حالة الأصول ولا يتجاوز طلبات العملاء.';
