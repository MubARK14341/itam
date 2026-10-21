-- =====================================================================
-- Purpose: دور RBAC جديد «مدير المستودع» (warehouse_manager) — نظير technician
--          تشغيليًا (تجهيز/تسليم/إرجاع/فحص + صيانة)، بلا صلاحية مالية ولا إعدادات
--          ولا اعتماد الطلبات (يبقى request.approve = admin/it_manager).
-- What:
--   1) صف roles جديد.
--   2) نسخ صلاحيات technician (permissions) إليه — لا request.approve/settings.manage.
--   3) توسيع حرّاس الأدوار في دوال العمليات (SECURITY DEFINER) لتشمل warehouse_manager.
--   4) RLS: السماح لمدير المستودع بإنشاء/تعديل الطلبات وبنودها (نفس technician).
-- Risk:    منخفض/متوسط — إضافي فقط؛ يوسّع قوائم أدوار قائمة (منح لا تقييد).
--          الدوال تُعاد بنفس تعريفها + الدور الجديد (grants/owner محفوظة). لا مالي، لا انتقال حالة جديد.
-- Rollback: يتطلب حذف صف الدور + إعادة الدوال/السياسات لقوائمها القديمة (يدوي).
-- =====================================================================

-- 1) الدور الجديد ----------------------------------------------------------
insert into public.roles (key, name, name_ar, is_system)
values ('warehouse_manager', 'Warehouse Manager', 'مدير المستودع', true)
on conflict (key) do nothing;

-- 2) صلاحيات technician نفسها (بلا request.approve/settings.manage — technician لا يملكهما أصلًا)
insert into public.role_permissions (role_id, permission_id)
select wr.id, rp.permission_id
from public.role_permissions rp
join public.roles r on r.id = rp.role_id
cross join (select id from public.roles where key = 'warehouse_manager') wr
where r.key = 'technician'
  and not exists (
    select 1 from public.role_permissions x
    where x.role_id = wr.id and x.permission_id = rp.permission_id
  );

-- 3) توسيع حرّاس الأدوار في دوال العمليات (تتجاوز RLS داخليًا بحكم SECURITY DEFINER) --
--    استبدال دقيق للقائمة الحرفية 'admin','it_manager','technician' → +warehouse_manager
do $mig$
declare
  r   record;
  def text;
  targets text[] := array[
    'request_start_preparing', 'request_mark_ready', 'request_deliver', 'request_return',
    'request_complete', 'request_cancel', 'request_item_fulfill', 'request_item_unfulfill',
    'asset_assign', 'asset_return', 'asset_change_status'
  ];
begin
  for r in
    select p.oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname = any(targets)
  loop
    def := pg_get_functiondef(r.oid);
    if position('warehouse_manager' in def) = 0
       and position($q$'admin','it_manager','technician')$q$ in def) > 0 then
      def := replace(def,
        $q$'admin','it_manager','technician')$q$,
        $q$'admin','it_manager','technician','warehouse_manager')$q$);
      execute def;
    end if;
  end loop;
end $mig$;

-- 4) RLS: إنشاء/تعديل الطلبات وبنودها (نفس صلاحية technician) ---------------
alter policy ins_ops on public.requests
  with check (public.app_user_role() = any (array['admin','it_manager','technician','warehouse_manager']));
alter policy upd_ops on public.requests
  using (public.app_user_role() = any (array['admin','it_manager','technician','warehouse_manager']))
  with check (public.app_user_role() = any (array['admin','it_manager','technician','warehouse_manager']));

alter policy ins_ops on public.request_items
  with check (
    (public.app_user_role() = any (array['admin','it_manager','technician','warehouse_manager']))
    and exists (select 1 from public.requests r where r.id = request_items.request_id and r.status = any (array['draft','under_review']))
  );
alter policy del_ops on public.request_items
  using (
    (public.app_user_role() = any (array['admin','it_manager','technician','warehouse_manager']))
    and exists (select 1 from public.requests r where r.id = request_items.request_id and r.status = any (array['draft','under_review']))
  );
alter policy upd_ops on public.request_items
  using (public.app_user_role() = any (array['admin','it_manager','technician','warehouse_manager']))
  with check (public.app_user_role() = any (array['admin','it_manager','technician','warehouse_manager']));

-- 5) إضافة warehouse_manager إلى قائمة الأدوار المسموح إسنادها في approve_user -----
do $mig2$
declare def text;
begin
  select pg_get_functiondef('public.approve_user(uuid, text)'::regprocedure) into def;
  if position('warehouse_manager' in def) = 0 then
    def := replace(def,
      $q$p_role_key not in ('admin','it_manager','technician','auditor','viewer')$q$,
      $q$p_role_key not in ('admin','it_manager','technician','warehouse_manager','auditor','viewer')$q$);
    execute def;
  end if;
end $mig2$;
