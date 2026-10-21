-- ============================================================================
--  المرحلة: RFID + توريد/صرف المستهلك بتفاصيل مالية لكل عملية
--  إضافي وآمن بالكامل: لا DROP · لا حذف · لا تعديل بيانات · لا فتح RLS للـ anon
--  المرفقات تستخدم جدول attachments الحالي (entity_type + kind) — بلا تغيير سكيمته.
-- ============================================================================

-- 1) RFID اختياري للأصول والمستهلكات (nullable — لا يمسّ الـ636 أصل ولا الـ18 مستهلك)
alter table public.assets      add column if not exists rfid_tag text;
alter table public.consumables add column if not exists rfid_tag text;

-- فهرس فريد جزئي (يمنع تكرار RFID غير الفارغ) — العمودان جديدان فكلاهما NULL حاليًا (لا تعارض)
create unique index if not exists assets_rfid_tag_uniq
  on public.assets (lower(rfid_tag)) where rfid_tag is not null and rfid_tag <> '';
create unique index if not exists consumables_rfid_tag_uniq
  on public.consumables (lower(rfid_tag)) where rfid_tag is not null and rfid_tag <> '';
-- فهرس بحث للمطابقة المباشرة (المستخدم في الماسح)
create index if not exists assets_rfid_tag_idx on public.assets (rfid_tag);
create index if not exists consumables_rfid_tag_idx on public.consumables (rfid_tag);

-- 2) تفاصيل عملية توريد/صرف المستهلك على جدول الحركات الموجود (Additive)
--    quantity/balance_after/reason/related_employee_id/related_asset_id/performed_by/created_at موجودة مسبقًا.
alter table public.consumable_transactions add column if not exists unit_cost numeric;
alter table public.consumable_transactions add column if not exists total_cost numeric;
alter table public.consumable_transactions add column if not exists supplier_id uuid;
alter table public.consumable_transactions add column if not exists invoice_number text;
alter table public.consumable_transactions add column if not exists invoice_date date;
alter table public.consumable_transactions add column if not exists previous_quantity integer;
alter table public.consumable_transactions add column if not exists department_id uuid;
alter table public.consumable_transactions add column if not exists location_id uuid;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname='consumable_txn_supplier_fkey') then
    alter table public.consumable_transactions add constraint consumable_txn_supplier_fkey
      foreign key (supplier_id) references public.suppliers(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='consumable_txn_department_fkey') then
    alter table public.consumable_transactions add constraint consumable_txn_department_fkey
      foreign key (department_id) references public.departments(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='consumable_txn_location_fkey') then
    alter table public.consumable_transactions add constraint consumable_txn_location_fkey
      foreign key (location_id) references public.locations(id) on delete set null;
  end if;
end $do$;

create index if not exists consumable_txn_consumable_idx
  on public.consumable_transactions (consumable_id, created_at desc);

-- ملاحظة: لا تغيير على RLS — الأعمدة الجديدة ترث سياسات الجداول الحالية
-- (sel_auth=is_approved، ins_ops/upd_ops لـ admin/it_manager/technician). والمرفقات على bucket خاص.
