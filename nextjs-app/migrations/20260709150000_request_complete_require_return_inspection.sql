-- =====================================================================
-- Purpose: F-A (High) — منع تجاوز فحص الإرجاع في request_complete.
--   قبل هذا الترحيل كانت request_complete تقبل الحالة 'delivered' وتُعيد كل أصل
--   rented→available في حلقة صامتة، متجاوزةً request_inspect_return: جهاز تالف
--   يعود للمخزون بوصفه سليمًا بلا فحص ولا سجل صيانة ولا عدّاد رجوع غير سليم.
--   الإصلاح: حارس خادمي قبل حلقة rented→available — إن وُجد أي بند أصل مُسلَّم
--   ولم يُرجَع بعد (item_kind='asset' و delivered_quantity > returned_quantity)
--   في طلب إيجار، تُرفَض العملية بخطأ 'inspection_required' ويُوجَّه المستخدم
--   لمسار «فحص وإرجاع». البيع (request_type='sale') لا يُرجَع فيُستثنى ليبقى إكماله
--   صحيحًا، والطلبات بلا أصول مُعلَّقة (مستهلكات/احتياج) تمرّ كما كانت.
-- Notes:  أُعيد بناء الدالة حرفيًا من التعريف الحيّ (production) مع إبقاء قائمة
--   الأدوار الأربعة كما هي (admin/it_manager/technician/warehouse_manager)،
--   وإبقاء حلقة rented→available كخط دفاع خلفي بعد الحارس.
-- Risk:   منخفض — دالة SECURITY DEFINER واحدة، تشديد فقط (لا توسيع صلاحية)،
--   لا تغيير على المخطط/الأعمدة/الأدوار. idempotent عبر create or replace.
-- Rollback: إعادة إنشاء request_complete بنسختها السابقة (بلا فقرة الحارس).
-- =====================================================================

create or replace function public.request_complete(p_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered','partially_returned','returned') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;

  -- F-A: أي جهاز مُسلَّم لم يُرجَع بعد في طلب إيجار يجب أن يمرّ عبر فحص الإرجاع أولًا.
  -- (البيع لا يُرجَع فيُستثنى؛ الطلبات بلا أصول مُعلَّقة تمرّ لأن exists = false.)
  if v_req.request_type <> 'sale' and exists (
    select 1 from public.request_items ri
    where ri.request_id = p_id
      and ri.item_kind = 'asset'
      and coalesce(ri.delivered_quantity, 0) > coalesce(ri.returned_quantity, 0)
  ) then
    return json_build_object('ok', false, 'error', 'inspection_required');
  end if;

  for r in select ri.id, ri.asset_id, ri.delivered_quantity, a.status
           from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'rented' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'rented', 'available', v_uid, 'إكمال طلب '||v_req.request_number);
    update public.request_items set returned_quantity = delivered_quantity where id = r.id;
  end loop;
  update public.requests set status = 'completed' where id = p_id;
  return json_build_object('ok', true);
end $function$;

-- الحفاظ على نفس مصفوفة الصلاحيات الحيّة (authenticated فقط عبر PUBLIC؛ anon محجوب).
revoke all on function public.request_complete(uuid) from public;
grant execute on function public.request_complete(uuid) to authenticated;
