-- ============================================================================
--  Inventory defaults — القيم الافتراضية للمخزون (على مستوى النظام).
--  إضافي وآمن تمامًا: جدول جديد بصف واحد (id='main'). لا backfill، لا DROP/TRUNCATE/DELETE.
--  الغرض: يخزّن قيمًا تُستخدم كقيم أولية عند إنشاء عناصر جديدة (أصل/مستهلك):
--    • default_location_id  — موقع المستودع الافتراضي (FK → locations، ON DELETE SET NULL).
--    • default_reorder_level — حد إعادة الطلب الافتراضي (>= 0؛ 0 = غير محدّد).
--  لا يلمس أي بيانات موجودة ولا يفرض أي قيمة على السجلات الحالية — قيم أولية للنماذج فقط.
--  RLS: قراءة لكل معتمد (is_approved) لتُملأ النماذج للفنّي أيضًا؛ التعديل admin/it_manager فقط.
--       pending/rejected → NULL. anon محجوب ({authenticated}). نفس نمط notification_settings.
--  Risk: منخفض — جدول جديد معزول، لا اعتمادية عكسية، لا أعمدة مالية.
--  Rollback: drop table if exists public.inventory_settings cascade;
--            drop function if exists public.inventory_settings_stamp();
-- ============================================================================

create table if not exists public.inventory_settings (
  id                    text primary key default 'main',
  default_location_id   uuid references public.locations(id) on delete set null,
  default_reorder_level integer not null default 0,
  updated_by            uuid,
  updated_at            timestamptz not null default now(),
  constraint inventory_settings_singleton      check (id = 'main'),
  constraint inventory_settings_reorder_nonneg check (default_reorder_level >= 0)
);

-- صف الإعدادات الوحيد بالقيم الافتراضية (idempotent) — لا يلمس أي بيانات أخرى.
insert into public.inventory_settings (id) values ('main')
  on conflict (id) do nothing;

-- ختم المُعدِّل + وقت التعديل بالخادم (يتجاهل أي قيمة من العميل) — نفس نمط notification_settings.
create or replace function public.inventory_settings_stamp()
returns trigger language plpgsql set search_path = public as $func$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $func$;

drop trigger if exists trg_inventory_settings_stamp on public.inventory_settings;
create trigger trg_inventory_settings_stamp before insert or update on public.inventory_settings
  for each row execute function public.inventory_settings_stamp();

-- RLS: قراءة لكل معتمد؛ pending/rejected → NULL؛ anon محجوب. الكتابة: admin/it_manager فقط. لا DELETE.
alter table public.inventory_settings enable row level security;

drop policy if exists sel_auth on public.inventory_settings;
create policy sel_auth on public.inventory_settings
  for select to authenticated using (public.is_approved());

drop policy if exists ins_mgr on public.inventory_settings;
create policy ins_mgr on public.inventory_settings
  for insert to authenticated
  with check (public.app_user_role() = any (array['admin','it_manager']));

drop policy if exists upd_mgr on public.inventory_settings;
create policy upd_mgr on public.inventory_settings
  for update to authenticated
  using (public.app_user_role() = any (array['admin','it_manager']))
  with check (public.app_user_role() = any (array['admin','it_manager']));

-- تحصين امتيازات مستوى الجدول (defense-in-depth) — revoke anon + grant authenticated.
revoke all on public.inventory_settings from anon;
grant select, insert, update on public.inventory_settings to authenticated;

comment on table public.inventory_settings is
  'القيم الافتراضية للمخزون (على مستوى النظام). صف واحد id=main. RLS: قراءة لكل معتمد، تعديل admin/it_manager. قيم أولية للنماذج فقط — لا تفرض على البيانات الحالية.';
