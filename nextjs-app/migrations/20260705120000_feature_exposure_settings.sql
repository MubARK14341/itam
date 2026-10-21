-- ============================================================================
--  Feature Exposure Settings — تحكم المدير بنسبة الإظهار التدريجي (Phase 2).
--  إضافي وآمن تمامًا: جدول جديد بصف واحد (id='main'). لا backfill، لا DROP/TRUNCATE/DELETE.
--  level = النسبة الموحدة لكل الموظفين (10..100 بخطوة 10)؛
--  NULL = ثوابت Phase 1 لكل دور (سلوك اليوم بالضبط) — الترحيل لا يغيّر شيئًا حتى يقرر admin.
--  طبقة عرض فقط — RBAC/RLS تبقى مصدر الأمان الوحيد؛ admin مثبّت على 100 في الكود.
--  RLS: قراءة لكل معتمد (is_approved) حتى يقرأ كل موظف النسبة المطبقة عليه؛
--       التعديل لـ admin حصرًا (قرار المستخدم 2026-07-05). anon محجوب.
-- ============================================================================

create table if not exists public.feature_exposure_settings (
  id          text primary key default 'main',
  enabled     boolean not null default true,
  level       integer,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  -- صف واحد فقط (Singleton) + النسبة إما NULL أو مضاعف 10 ضمن 10..100.
  constraint feature_exposure_settings_singleton check (id = 'main'),
  constraint feature_exposure_settings_level_valid
    check (level is null or (level between 10 and 100 and level % 10 = 0))
);

-- صف الإعدادات الوحيد بالقيم الافتراضية (idempotent) — enabled=true و level=NULL = سلوك اليوم.
insert into public.feature_exposure_settings (id) values ('main')
  on conflict (id) do nothing;

-- ختم المُعدِّل + وقت التعديل بالخادم (يتجاهل أي قيمة من العميل) — نفس نمط notification_settings.
create or replace function public.feature_exposure_settings_stamp()
returns trigger language plpgsql set search_path = public as $func$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $func$;

drop trigger if exists trg_feature_exposure_settings_stamp on public.feature_exposure_settings;
create trigger trg_feature_exposure_settings_stamp
  before insert or update on public.feature_exposure_settings
  for each row execute function public.feature_exposure_settings_stamp();

-- RLS: قراءة لكل معتمد؛ الكتابة admin فقط؛ لا DELETE.
alter table public.feature_exposure_settings enable row level security;

drop policy if exists sel_auth on public.feature_exposure_settings;
create policy sel_auth on public.feature_exposure_settings
  for select to authenticated using (public.is_approved());

drop policy if exists ins_admin on public.feature_exposure_settings;
create policy ins_admin on public.feature_exposure_settings
  for insert to authenticated
  with check (public.app_user_role() = 'admin');

drop policy if exists upd_admin on public.feature_exposure_settings;
create policy upd_admin on public.feature_exposure_settings
  for update to authenticated
  using (public.app_user_role() = 'admin')
  with check (public.app_user_role() = 'admin');

-- تحصين امتيازات مستوى الجدول (defense-in-depth) — revoke anon + grant authenticated.
revoke all on public.feature_exposure_settings from anon;
grant select, insert, update on public.feature_exposure_settings to authenticated;

comment on table public.feature_exposure_settings is
  'نسبة الإظهار التدريجي الموحدة للموظفين (Phase 2). صف واحد id=main. level NULL = ثوابت الأدوار (سلوك اليوم). RLS: قراءة لكل معتمد، تعديل admin فقط. طبقة عرض لا أمان.';
