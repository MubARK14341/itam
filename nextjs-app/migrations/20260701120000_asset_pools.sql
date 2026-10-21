-- ============================================================================
--  Asset Pools — تجميع أصول متشابهة تحت اسم واحد (للتجميع/الفلترة/التقارير فقط).
--  إضافي وآمن: جدول جديد + عمود nullable على assets. لا backfill، لا DROP/TRUNCATE/DELETE.
--  Pool ≠ مستهلك، ≠ مورد، ≠ شركة. الأصول القديمة تبقى pool_id = null.
--  RLS يطابق companies: قراءة لكل معتمد، إنشاء/تعديل لـ admin/it_manager فقط، لا حذف حقيقي.
-- ============================================================================

create table if not exists public.asset_pools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  name_ar     text,
  category_id uuid references public.categories(id),
  company_id  uuid references public.companies(id),
  description text,
  is_active   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ربط الأصل بمجموعة (اختياري تمامًا). on delete set null احتياط — لا نحذف Pools فعليًا.
alter table public.assets add column if not exists pool_id uuid references public.asset_pools(id) on delete set null;

create index if not exists idx_assets_pool         on public.assets(pool_id) where pool_id is not null;
create index if not exists idx_asset_pools_active   on public.asset_pools(is_active);
-- منع تكرار اسم Pool نشط (غير حسّاس لحالة الأحرف). لا يمسّ الأسماء العربية (يقارن lower فقط).
create unique index if not exists uq_asset_pools_name_active on public.asset_pools(lower(name)) where is_active;

-- ختم منشئ المجموعة بالخادم (يتجاهل أي قيمة من العميل) — نفس نمط scan_logs.
create or replace function public.asset_pools_stamp_creator()
returns trigger language plpgsql set search_path = public as $func$
begin
  new.created_by := auth.uid();
  return new;
end $func$;

drop trigger if exists trg_asset_pools_stamp_creator on public.asset_pools;
create trigger trg_asset_pools_stamp_creator before insert on public.asset_pools
  for each row execute function public.asset_pools_stamp_creator();

-- تحديث updated_at تلقائيًا عند أي تعديل.
create or replace function public.asset_pools_touch_updated()
returns trigger language plpgsql set search_path = public as $func$
begin
  new.updated_at := now();
  return new;
end $func$;

drop trigger if exists trg_asset_pools_touch_updated on public.asset_pools;
create trigger trg_asset_pools_touch_updated before update on public.asset_pools
  for each row execute function public.asset_pools_touch_updated();

-- RLS: قراءة لكل معتمد (is_approved) → technician/viewer يقرؤون؛ pending/rejected يُرجع NULL؛ anon محجوب ({authenticated}).
--  إنشاء/تعديل: admin/it_manager فقط. لا سياسة DELETE (لا حذف حقيقي — استخدم is_active=false).
alter table public.asset_pools enable row level security;

drop policy if exists sel_auth on public.asset_pools;
create policy sel_auth on public.asset_pools
  for select to authenticated using (public.is_approved());

drop policy if exists ins_mgr on public.asset_pools;
create policy ins_mgr on public.asset_pools
  for insert to authenticated
  with check (public.app_user_role() = any (array['admin','it_manager']));

drop policy if exists upd_mgr on public.asset_pools;
create policy upd_mgr on public.asset_pools
  for update to authenticated
  using (public.app_user_role() = any (array['admin','it_manager']))
  with check (public.app_user_role() = any (array['admin','it_manager']));

comment on table public.asset_pools is
  'تجميع أصول متشابهة (للتجميع/الفلترة/التقارير). RLS: قراءة لكل معتمد، كتابة admin/it_manager، لا حذف حقيقي.';
