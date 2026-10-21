-- ============================================================================
--  Notifications / Alerts — إعدادات التنبيهات داخل النظام (In-App فقط).
--  إضافي وآمن تمامًا: جدول جديد بصف واحد (id='main'). لا backfill، لا DROP/TRUNCATE/DELETE.
--  لا إرسال إيميل، لا Scheduled Jobs، لا Push. التنبيهات تُحسب ديناميكيًا في طبقة التطبيق
--  من بيانات موجودة (consumables/requests/maintenance) — هذا الجدول يخزّن التفضيلات فقط.
--  RLS: قراءة لكل معتمد (is_approved) حتى يعمل عرض التنبيهات للفنّي/المشاهد أيضًا؛
--       التعديل لـ admin/it_manager فقط. pending/rejected → NULL. anon محجوب ({authenticated}).
-- ============================================================================

create table if not exists public.notification_settings (
  id                          text primary key default 'main',
  low_stock_enabled           boolean not null default true,
  out_of_stock_enabled        boolean not null default true,
  overdue_requests_enabled    boolean not null default true,
  pending_approval_enabled    boolean not null default true,
  maintenance_due_enabled     boolean not null default true,
  overdue_grace_days          integer not null default 0,
  maintenance_due_window_days integer not null default 14,
  in_app_enabled              boolean not null default true,
  email_enabled               boolean not null default false,
  updated_by                  uuid,
  updated_at                  timestamptz not null default now(),
  -- صف واحد فقط (Singleton) + حراسة قيم العتبات ضد السالب.
  constraint notification_settings_singleton    check (id = 'main'),
  constraint notification_settings_grace_nonneg  check (overdue_grace_days >= 0),
  constraint notification_settings_window_nonneg check (maintenance_due_window_days >= 0)
);

-- صف الإعدادات الوحيد بالقيم الافتراضية (idempotent) — لا يلمس أي بيانات أخرى.
insert into public.notification_settings (id) values ('main')
  on conflict (id) do nothing;

-- ختم المُعدِّل + وقت التعديل بالخادم (يتجاهل أي قيمة من العميل) — نفس نمط asset_pools/scan_logs.
create or replace function public.notification_settings_stamp()
returns trigger language plpgsql set search_path = public as $func$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $func$;

drop trigger if exists trg_notification_settings_stamp on public.notification_settings;
create trigger trg_notification_settings_stamp before insert or update on public.notification_settings
  for each row execute function public.notification_settings_stamp();

-- RLS: قراءة لكل معتمد (is_approved) → technician/viewer يقرؤون التفضيلات لعرض التنبيهات؛
--  pending/rejected يُرجع NULL؛ anon محجوب. الكتابة/التعديل: admin/it_manager فقط. لا DELETE.
alter table public.notification_settings enable row level security;

drop policy if exists sel_auth on public.notification_settings;
create policy sel_auth on public.notification_settings
  for select to authenticated using (public.is_approved());

drop policy if exists ins_mgr on public.notification_settings;
create policy ins_mgr on public.notification_settings
  for insert to authenticated
  with check (public.app_user_role() = any (array['admin','it_manager']));

drop policy if exists upd_mgr on public.notification_settings;
create policy upd_mgr on public.notification_settings
  for update to authenticated
  using (public.app_user_role() = any (array['admin','it_manager']))
  with check (public.app_user_role() = any (array['admin','it_manager']));

-- تحصين امتيازات مستوى الجدول (defense-in-depth) — نفس نمط بقية الجداول: revoke anon + grant authenticated.
revoke all on public.notification_settings from anon;
grant select, insert, update on public.notification_settings to authenticated;

comment on table public.notification_settings is
  'تفضيلات التنبيهات داخل النظام (In-App). صف واحد id=main. RLS: قراءة لكل معتمد، تعديل admin/it_manager. لا إيميل، لا Jobs.';
