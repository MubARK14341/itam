-- إصلاح (HIGH): عمليات العهدة كانت ثلاث كتابات منفصلة من طبقة التطبيق
-- (إدراج عهدة ← تحديث حالة الأصل ← إدراج حركة) بدون معاملة واحدة:
--   • فشل جزئي أو تعارض متزامن ⇒ صفوف عهدة يتيمة/مكررة وحالة أصل غير متسقة.
--   • خطأ إدراج سجل الحركة كان يُتجاهل ⇒ سجل تدقيق ناقص بصمت.
--
-- الحل: RPCs ذرية على نمط request_deliver (20260701100500):
--   قفل صف الأصل بـ for update ← تحقق كامل ← كل الكتابات في معاملة واحدة،
--   مع ختم performed_by من الخادم (auth.uid()) بدل الاعتماد على العميل.
-- آلة الحالات (trigger asset_status_allowed) تبقى حارسًا احتياطيًا داخل المعاملة.

-- ----------------------------------------------------------------------------
-- تسليم عهدة
-- ----------------------------------------------------------------------------
create or replace function public.asset_assign(
  p_asset_id uuid,
  p_employee_id uuid,
  p_due_date date default null
)
returns json
language plpgsql security definer set search_path = public
as $func$
declare
  v_caller text := public.app_user_role();
  v_from asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select status into v_from from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  if exists (
    select 1 from public.asset_assignments
    where asset_id = p_asset_id and status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'already_assigned');
  end if;

  if not public.asset_status_allowed(v_from, 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_transition',
                             'from', v_from, 'to', 'assigned');
  end if;

  insert into public.asset_assignments (asset_id, employee_id, due_return_date, status)
  values (p_asset_id, p_employee_id, p_due_date, 'active');

  update public.assets
  set status = 'assigned', assigned_to_employee_id = p_employee_id
  where id = p_asset_id;

  insert into public.asset_movements
    (asset_id, movement_type, from_status, to_status, to_employee_id, performed_by, note)
  values
    (p_asset_id, 'assign', v_from, 'assigned', p_employee_id, auth.uid(), 'تسليم عهدة');

  return json_build_object('ok', true);
end $func$;

-- ----------------------------------------------------------------------------
-- إرجاع عهدة
-- ----------------------------------------------------------------------------
create or replace function public.asset_return(
  p_asset_id uuid,
  p_condition text default null
)
returns json
language plpgsql security definer set search_path = public
as $func$
declare
  v_caller text := public.app_user_role();
  v_from asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select status into v_from from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  if not public.asset_status_allowed(v_from, 'available') then
    return json_build_object('ok', false, 'error', 'invalid_transition',
                             'from', v_from, 'to', 'available');
  end if;

  -- إغلاق كل العهد النشطة (إن وُجدت أكثر من واحدة تاريخيًا تُغلق جميعها)
  update public.asset_assignments
  set status = 'returned', returned_at = now(), return_condition = nullif(p_condition, '')
  where asset_id = p_asset_id and status = 'active';

  update public.assets
  set status = 'available', assigned_to_employee_id = null
  where id = p_asset_id;

  insert into public.asset_movements
    (asset_id, movement_type, from_status, to_status, performed_by, note)
  values
    (p_asset_id, 'return', v_from, 'available', auth.uid(), 'إرجاع عهدة');

  return json_build_object('ok', true);
end $func$;

-- ----------------------------------------------------------------------------
-- تغيير حالة عام (من صفحة الأصل)
-- ----------------------------------------------------------------------------
create or replace function public.asset_change_status(
  p_asset_id uuid,
  p_to_status asset_status,
  p_note text default null
)
returns json
language plpgsql security definer set search_path = public
as $func$
declare
  v_caller text := public.app_user_role();
  v_from asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select status into v_from from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  if not public.asset_status_allowed(v_from, p_to_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition',
                             'from', v_from, 'to', p_to_status);
  end if;

  if p_to_status in ('available','retired','disposed','lost') then
    -- الحالات التي تُنهي المسؤولية: نُفرغ المسؤول ونُغلق أي عهدة نشطة
    -- حتى لا يظهر الأصل «متاحًا» وبعهدة موظف في آنٍ واحد
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = p_asset_id and status = 'active';

    update public.assets
    set status = p_to_status, assigned_to_employee_id = null
    where id = p_asset_id;
  else
    update public.assets set status = p_to_status where id = p_asset_id;
  end if;

  insert into public.asset_movements
    (asset_id, movement_type, from_status, to_status, performed_by, note)
  values
    (p_asset_id, 'status_change', v_from, p_to_status, auth.uid(),
     coalesce(nullif(p_note, ''), 'تغيير حالة'));

  return json_build_object('ok', true);
end $func$;

-- ----------------------------------------------------------------------------
-- الصلاحيات: البوابة داخل الدوال؛ ونسحب anon/public صراحةً
-- (إعادة التعريف تُعيد المنح الافتراضي من Supabase)
-- ----------------------------------------------------------------------------
revoke execute on function public.asset_assign(uuid, uuid, date) from public, anon;
revoke execute on function public.asset_return(uuid, text) from public, anon;
revoke execute on function public.asset_change_status(uuid, asset_status, text) from public, anon;
grant execute on function public.asset_assign(uuid, uuid, date) to authenticated;
grant execute on function public.asset_return(uuid, text) to authenticated;
grant execute on function public.asset_change_status(uuid, asset_status, text) to authenticated;
