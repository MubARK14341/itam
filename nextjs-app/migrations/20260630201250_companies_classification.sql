-- ============================================================================
--  المرحلة: تصنيف «الشركة / العلامة التجارية» للأصول والمستهلكات
--  Company = الشركة المُصنِّعة/العلامة (ليست المورد Supplier)
--  إضافي وآمن: company_id اختياري (nullable) — لا backfill عشوائي، لا حذف.
-- ============================================================================

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  normalized_name text null unique,
  notes text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- علاقات اختيارية (nullable) — لا تكسر الـ 636 أصل ولا الـ 18 مستهلك
alter table public.assets       add column if not exists company_id uuid;
alter table public.consumables  add column if not exists company_id uuid;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'assets_company_id_fkey') then
    alter table public.assets add constraint assets_company_id_fkey
      foreign key (company_id) references public.companies(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'consumables_company_id_fkey') then
    alter table public.consumables add constraint consumables_company_id_fkey
      foreign key (company_id) references public.companies(id) on delete set null;
  end if;
end $do$;

-- صلاحيات الجدول: authenticated فقط (RLS يحرس) — لا anon
revoke all on public.companies from anon;
grant select, insert, update, delete on public.companies to authenticated;
alter table public.companies enable row level security;

-- قراءة لكل مستخدم معتمد · كتابة admin/it_manager · حذف admin (لكن المنهجية: تعطيل لا حذف)
drop policy if exists sel_auth on public.companies;
drop policy if exists ins_mgr on public.companies;
drop policy if exists upd_mgr on public.companies;
drop policy if exists del_mgr on public.companies;
create policy sel_auth on public.companies for select to authenticated
  using (public.is_approved());
create policy ins_mgr on public.companies for insert to authenticated
  with check (public.app_user_role() in ('admin','it_manager'));
create policy upd_mgr on public.companies for update to authenticated
  using (public.app_user_role() in ('admin','it_manager'))
  with check (public.app_user_role() in ('admin','it_manager'));
create policy del_mgr on public.companies for delete to authenticated
  using (public.app_user_role() = 'admin');

-- بذرة شركات/علامات معروفة (idempotent عبر unique name)
insert into public.companies (name) values
  ('Apple'),('Epson'),('HP'),('Dell'),('Lenovo'),('Honeywell'),('Zebra'),
  ('TP-LINK'),('Canon'),('Brother'),('HITI'),('Matica'),('Zenius'),
  ('STC'),('Mobily'),('Zain'),('Cisco'),('Hikvision'),('Dahua'),
  ('Microsoft'),('Samsung'),('Honor'),('Generic')
on conflict (name) do nothing;
