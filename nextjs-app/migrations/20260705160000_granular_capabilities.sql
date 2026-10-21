-- ============================================================================
--  Batch 2C — granular capabilities (scoped, seed-to-match, zero day-1 change)
--  (version 20260705160000). Mirror of the live migration.
--
--  الجداول permissions/role_permissions/user_permissions موجودة مسبقًا (13 صلاحية،
--  40 ربطًا) لكنها غير مستخدمة للتحقق. هذه الدفعة تُفعّلها بأسلوب آمن:
--    • تضيف 4 مفاتيح ناقصة (asset.delete / asset.import / request.approve / report.export)
--      وتزرع روابط الأدوار **لتطابق السلوك الحالي تمامًا** ⇒ صفر تغيير يوم الإطلاق.
--    • has_capability(): admin كامل دائمًا؛ تجاوز المستخدم (allow/deny) ثم افتراضي الدور؛
--      غير المعتمد = لا صلاحيات.
--    • تطبيق فعلي في DB على بوابتين واضحتين فقط:
--        - حذف الأصول (سياسة del_admin) → asset.delete (الافتراضي admin فقط = مطابق).
--        - RPC import_inventory → asset.import (الافتراضي admin/it_manager/technician = مطابق).
--      report.export و request.approve تُدار من المصفوفة وتُطبَّق في الواجهة هذه الدفعة
--      (approve يبقى محكومًا بالدور في RPC/trigger كخط دفاع).
--    • إدارة الصلاحيات عبر RPCs admin-only فقط (لا تعديل ذاتي، لا لمس هدف admin).
--  إضافي/غير مدمّر: لا حذف بيانات، لا DROP جداول. Rollback: حذف الصفوف المزروعة + الدوال
--  وإعادة سياسة del_admin إلى app_user_role()='admin'.
-- ============================================================================

-- 1) المفاتيح الأربعة الناقصة (idempotent عبر UNIQUE(key)).
insert into public.permissions (key, grp, description) values
  ('asset.delete',    'assets',   'حذف أصل'),
  ('asset.import',    'assets',   'استيراد من CSV'),
  ('request.approve', 'requests', 'اعتماد الطلبات'),
  ('report.export',   'reports',  'تصدير التقارير')
on conflict (key) do nothing;

-- 2) زرع روابط الأدوار لتطابق السلوك الحالي تمامًا.
--    asset.delete = admin فقط (del_admin).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where p.key='asset.delete' and r.key in ('admin')
on conflict do nothing;
--    asset.import = admin/it_manager/technician (بوابة RPC).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where p.key='asset.import' and r.key in ('admin','it_manager','technician')
on conflict do nothing;
--    request.approve = admin/it_manager (بوابة RPC/trigger).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where p.key='request.approve' and r.key in ('admin','it_manager')
on conflict do nothing;
--    report.export = كل الأدوار (اليوم: من يرى التقارير يُصدّر CSV غير المالي).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where p.key='report.export' and r.key in ('admin','it_manager','technician','viewer','auditor')
on conflict do nothing;

-- 3) مُحلِّل الصلاحية: admin كامل؛ تجاوز المستخدم؛ افتراضي الدور؛ غير المعتمد = false.
create or replace function public.has_capability(p_user uuid, p_key text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_role text; v_override boolean;
begin
  select r.key into v_role
  from public.app_users u join public.roles r on r.id = u.role_id
  where u.id = p_user and coalesce(u.approval_status,'approved') = 'approved';

  if v_role is null then return false; end if;   -- غير معتمد/بلا دور
  if v_role = 'admin' then return true; end if;   -- admin كامل دائمًا

  select up.allow into v_override
  from public.user_permissions up join public.permissions p on p.id = up.permission_id
  where up.user_id = p_user and p.key = p_key;
  if found then return v_override; end if;        -- تجاوز صريح لكل مستخدم

  return exists (                                  -- افتراضي الدور
    select 1 from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = (select role_id from public.app_users where id = p_user)
      and p.key = p_key);
end $$;

create or replace function public.current_user_has_capability(p_key text)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.has_capability(auth.uid(), p_key); $$;

-- مفاتيح المستخدم الحالي (للواجهة والمصفوفة). admin يحصل على الكل.
create or replace function public.my_capabilities()
returns setof text
language sql stable security definer set search_path = public
as $$ select p.key from public.permissions p where public.has_capability(auth.uid(), p.key); $$;

-- 4) إدارة الصلاحيات — admin فقط. (users.manage/financial تبقى admin-only ضمنًا لأن المتصل admin.)
create or replace function public.set_role_capability(p_role_key text, p_key text, p_allowed boolean)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_caller text := public.app_user_role(); v_role uuid; v_perm uuid;
begin
  if v_caller is null or v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id into v_role from public.roles where key = p_role_key;
  select id into v_perm from public.permissions where key = p_key;
  if v_role is null or v_perm is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  delete from public.role_permissions where role_id = v_role and permission_id = v_perm;
  if p_allowed then
    insert into public.role_permissions(role_id, permission_id) values (v_role, v_perm);
  end if;
  return json_build_object('ok', true);
end $$;

-- p_state: allow | deny | inherit (inherit يمسح التجاوز فيعود لافتراضي الدور).
create or replace function public.set_user_capability(p_user uuid, p_key text, p_state text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_caller text := public.app_user_role(); v_perm uuid; v_target_role text;
begin
  if v_caller is null or v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user = auth.uid() then
    return json_build_object('ok', false, 'error', 'cannot_modify_self');
  end if;
  select r.key into v_target_role
  from public.app_users u join public.roles r on r.id = u.role_id where u.id = p_user;
  if v_target_role = 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_modify_admin');
  end if;
  select id into v_perm from public.permissions where key = p_key;
  if v_perm is null then return json_build_object('ok', false, 'error', 'not_found'); end if;

  delete from public.user_permissions where user_id = p_user and permission_id = v_perm;
  if p_state = 'allow' then
    insert into public.user_permissions(user_id, permission_id, allow) values (p_user, v_perm, true);
  elsif p_state = 'deny' then
    insert into public.user_permissions(user_id, permission_id, allow) values (p_user, v_perm, false);
  end if; -- inherit ⇒ الحذف أعلاه يكفي
  return json_build_object('ok', true);
end $$;

revoke all on function public.has_capability(uuid, text) from public, anon;
revoke all on function public.current_user_has_capability(text) from public, anon;
revoke all on function public.my_capabilities() from public, anon;
revoke all on function public.set_role_capability(text, text, boolean) from public, anon;
revoke all on function public.set_user_capability(uuid, text, text) from public, anon;
grant execute on function public.has_capability(uuid, text) to authenticated;
grant execute on function public.current_user_has_capability(text) to authenticated;
grant execute on function public.my_capabilities() to authenticated;
grant execute on function public.set_role_capability(text, text, boolean) to authenticated;
grant execute on function public.set_user_capability(uuid, text, text) to authenticated;

-- 5) تطبيق فعلي — حذف الأصول عبر القدرة (الافتراضي admin فقط = مطابق تمامًا لليوم).
drop policy if exists del_admin on public.assets;
create policy del_admin on public.assets for delete
  using (public.current_user_has_capability('asset.delete'));

-- 6) تطبيق فعلي — بوابة import_inventory عبر القدرة asset.import (الافتراضي = نفس أدوار اليوم).
--    نُعيد تعريف الدالة كما هي مع تبديل سطر البوابة فقط.
create or replace function public.import_inventory(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fin         boolean := public.is_financial_viewer();
  v_item        jsonb;
  v_type        text;
  v_id          uuid;
  v_status      asset_status;
  v_loc         uuid;
  v_qty         integer;
  v_cost        numeric;
  v_assets      integer := 0;
  v_consumables integer := 0;
  v_idx         integer := 0;
begin
  if not public.has_capability(auth.uid(), 'asset.import') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_idx  := v_idx + 1;
    v_type := v_item->>'item_type';

    if v_type = 'asset' then
      insert into public.assets (
        category_id, name, serial_number, status, location_id, company_id, supplier_id,
        purchase_date, purchase_cost, warranty_end, condition_grade, rfid_tag, notes
      ) values (
        (v_item->>'category_id')::uuid,
        nullif(v_item->>'name',''),
        nullif(v_item->>'serial_number',''),
        coalesce(nullif(v_item->>'status',''),'available')::asset_status,
        nullif(v_item->>'location_id','')::uuid,
        nullif(v_item->>'company_id','')::uuid,
        nullif(v_item->>'supplier_id','')::uuid,
        nullif(v_item->>'purchase_date','')::date,
        case when v_fin then nullif(v_item->>'purchase_cost','')::numeric else null end,
        nullif(v_item->>'warranty_end','')::date,
        nullif(v_item->>'condition_grade',''),
        nullif(v_item->>'rfid_tag',''),
        nullif(v_item->>'notes','')
      )
      returning id, status, location_id into v_id, v_status, v_loc;

      insert into public.asset_movements (asset_id, movement_type, to_status, to_location_id, performed_by, note)
      values (v_id, 'create'::movement_type, v_status, v_loc, auth.uid(), 'استيراد CSV');

      v_assets := v_assets + 1;

    elsif v_type = 'consumable' then
      v_qty  := coalesce(floor(nullif(v_item->>'quantity','')::numeric), 0)::integer;
      v_cost := case when v_fin then nullif(v_item->>'unit_cost','')::numeric else null end;

      insert into public.consumables (
        category_id, name, sku, unit, quantity_on_hand, reorder_level,
        company_id, supplier_id, location_id, unit_cost, rfid_tag, notes
      ) values (
        (v_item->>'category_id')::uuid,
        nullif(v_item->>'name',''),
        nullif(v_item->>'sku',''),
        coalesce(nullif(v_item->>'unit',''),'each'),
        v_qty,
        coalesce(floor(nullif(v_item->>'reorder_level','')::numeric), 0)::integer,
        nullif(v_item->>'company_id','')::uuid,
        nullif(v_item->>'supplier_id','')::uuid,
        nullif(v_item->>'location_id','')::uuid,
        v_cost,
        nullif(v_item->>'rfid_tag',''),
        nullif(v_item->>'notes','')
      )
      returning id into v_id;

      if v_qty > 0 then
        insert into public.consumable_transactions (
          consumable_id, txn_type, quantity, previous_quantity, balance_after,
          unit_cost, total_cost, supplier_id, reason, performed_by
        ) values (
          v_id, 'in'::consumable_txn_type, v_qty, 0, v_qty,
          v_cost, case when v_cost is not null then v_cost * v_qty else null end,
          nullif(v_item->>'supplier_id','')::uuid, 'رصيد افتتاحي (استيراد)', auth.uid()
        );
      end if;

      v_consumables := v_consumables + 1;

    else
      raise exception 'invalid_item_type at row %', v_idx using errcode = '22023';
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'assets', v_assets, 'consumables', v_consumables);
end $$;
