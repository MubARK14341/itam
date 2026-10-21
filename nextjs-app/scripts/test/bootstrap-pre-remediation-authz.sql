-- TEST ONLY — never apply to production.
--
-- Purpose: recreate the non-personal authorization reference rows that the
-- generated baseline deliberately omits. This is the read-only production
-- snapshot from 2026-07-28, before M1–M8. Apply it only to a proven disposable
-- local stack or data-less Supabase development branch, after the production
-- schema/migrations and before M1–M8.

begin;

insert into public.roles (key, name, name_ar, description, is_system)
values
  ('admin', 'Administrator', 'مدير النظام', 'صلاحيات كاملة', true),
  ('it_manager', 'IT Manager', 'مدير تقنية المعلومات', 'إدارة الأصول والتقارير', true),
  ('technician', 'Technician', 'فني', 'الصيانة وتحديث الأصول', true),
  ('warehouse_manager', 'Warehouse Manager', 'مدير المستودع', null, true),
  ('viewer', 'Viewer', 'مشاهد', 'عرض فقط', true),
  ('auditor', 'Auditor', 'مدقّق/جرد', 'عرض + جلسات الجرد', true)
on conflict (key) do update
set name = excluded.name,
    name_ar = excluded.name_ar,
    description = excluded.description,
    is_system = true;

insert into public.permissions (key, grp, description)
values
  ('asset.assign', 'assets', 'تسليم/إرجاع'),
  ('asset.create', 'assets', 'إضافة أصل'),
  ('asset.delete', 'assets', 'حذف أصل'),
  ('asset.import', 'assets', 'استيراد من CSV'),
  ('asset.retire', 'assets', 'إخراج من الخدمة'),
  ('asset.update', 'assets', 'تعديل أصل'),
  ('asset.view', 'assets', 'عرض الأصول'),
  ('consumable.manage', 'consumables', 'إدارة المستهلكات'),
  ('consumable.view', 'consumables', 'عرض المستهلكات'),
  ('maintenance.manage', 'maintenance', 'إدارة الصيانة'),
  ('maintenance.view', 'maintenance', 'عرض الصيانة'),
  ('report.customer_requests', 'reports', 'عرض تقارير طلبات العملاء'),
  ('report.export', 'reports', 'تصدير التقارير'),
  ('report.view', 'reports', 'عرض التقارير'),
  ('request.approve', 'requests', 'اعتماد الطلبات'),
  ('settings.manage', 'admin', 'إدارة الإعدادات'),
  ('stocktake.manage', 'stocktake', 'إدارة الجرد'),
  ('user.manage', 'admin', 'إدارة المستخدمين')
on conflict (key) do update
set grp = excluded.grp,
    description = excluded.description;

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.key in ('admin', 'it_manager', 'technician', 'warehouse_manager', 'viewer', 'auditor')
  and p.key in (
    'asset.assign', 'asset.create', 'asset.delete', 'asset.import',
    'asset.retire', 'asset.update', 'asset.view', 'consumable.manage',
    'consumable.view', 'maintenance.manage', 'maintenance.view',
    'report.customer_requests', 'report.export', 'report.view',
    'request.approve', 'settings.manage', 'stocktake.manage', 'user.manage'
  );

with expected(role_key, permission_key) as (
  values
    ('admin', 'asset.assign'),
    ('admin', 'asset.create'),
    ('admin', 'asset.delete'),
    ('admin', 'asset.import'),
    ('admin', 'asset.retire'),
    ('admin', 'asset.update'),
    ('admin', 'asset.view'),
    ('admin', 'consumable.manage'),
    ('admin', 'consumable.view'),
    ('admin', 'maintenance.manage'),
    ('admin', 'maintenance.view'),
    ('admin', 'report.customer_requests'),
    ('admin', 'report.export'),
    ('admin', 'report.view'),
    ('admin', 'request.approve'),
    ('admin', 'settings.manage'),
    ('admin', 'stocktake.manage'),
    ('admin', 'user.manage'),
    ('it_manager', 'asset.assign'),
    ('it_manager', 'asset.create'),
    ('it_manager', 'asset.import'),
    ('it_manager', 'asset.retire'),
    ('it_manager', 'asset.update'),
    ('it_manager', 'asset.view'),
    ('it_manager', 'consumable.manage'),
    ('it_manager', 'consumable.view'),
    ('it_manager', 'maintenance.manage'),
    ('it_manager', 'maintenance.view'),
    ('it_manager', 'report.customer_requests'),
    ('it_manager', 'report.export'),
    ('it_manager', 'report.view'),
    ('it_manager', 'request.approve'),
    ('it_manager', 'settings.manage'),
    ('it_manager', 'stocktake.manage'),
    ('technician', 'asset.import'),
    ('technician', 'asset.update'),
    ('technician', 'asset.view'),
    ('technician', 'consumable.view'),
    ('technician', 'maintenance.manage'),
    ('technician', 'maintenance.view'),
    ('technician', 'report.export'),
    ('technician', 'report.view'),
    ('warehouse_manager', 'asset.import'),
    ('warehouse_manager', 'asset.update'),
    ('warehouse_manager', 'asset.view'),
    ('warehouse_manager', 'consumable.view'),
    ('warehouse_manager', 'maintenance.manage'),
    ('warehouse_manager', 'maintenance.view'),
    ('warehouse_manager', 'report.export'),
    ('warehouse_manager', 'report.view'),
    ('viewer', 'asset.view'),
    ('viewer', 'consumable.view'),
    ('viewer', 'maintenance.view'),
    ('viewer', 'report.customer_requests'),
    ('viewer', 'report.export'),
    ('viewer', 'report.view'),
    ('auditor', 'asset.view'),
    ('auditor', 'consumable.view'),
    ('auditor', 'maintenance.view'),
    ('auditor', 'report.customer_requests'),
    ('auditor', 'report.export'),
    ('auditor', 'report.view'),
    ('auditor', 'stocktake.manage')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from expected e
join public.roles r on r.key = e.role_key
join public.permissions p on p.key = e.permission_key
on conflict do nothing;

do $assert$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id
  where r.key in ('admin', 'it_manager', 'technician', 'warehouse_manager', 'viewer', 'auditor')
    and p.key in (
      'asset.assign', 'asset.create', 'asset.delete', 'asset.import',
      'asset.retire', 'asset.update', 'asset.view', 'consumable.manage',
      'consumable.view', 'maintenance.manage', 'maintenance.view',
      'report.customer_requests', 'report.export', 'report.view',
      'request.approve', 'settings.manage', 'stocktake.manage', 'user.manage'
    );
  if v_count <> 63 then
    raise exception 'unexpected pre-remediation role mapping count: %', v_count;
  end if;
end
$assert$;

commit;
