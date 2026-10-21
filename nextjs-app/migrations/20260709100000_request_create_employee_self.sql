-- =====================================================================
-- Purpose: طلب موظف داخلي (عهدة) يُسجَّل تلقائيًا باسم الحساب الحالي.
--          المستفيد (beneficiary_employee_id) يُشتق خادميًا من
--          app_users.employee_id لـauth.uid() — لا يُقبل معرّف موظف من العميل،
--          فيستحيل إنشاء طلب باسم موظف آخر. بلا أي حقول مالية (unit_price/total_price).
--          تحقيق ذاتي للرابط: إن لم يكن الحساب مربوطًا بموظف، يُربط بموظف مطابق
--          بالبريد أو يُنشأ سجل موظف من بيانات الحساب ثم يُربط (يجعل الميزة تعمل فورًا).
-- Risk:    منخفض — دالة إضافية جديدة فقط؛ لا DDL على جداول قائمة، لا تغيير RLS.
--          SECURITY DEFINER + SET search_path=public؛ ممنوحة لـauthenticated فقط.
--          تنشئ/تربط صف employees عند الحاجة (full_name فقط إلزامي) وتحدّث app_users.employee_id.
-- Rollback: drop function public.request_create_employee_self(text,text,date,date,text,jsonb);
-- =====================================================================

create or replace function public.request_create_employee_self(
  p_status       text,
  p_project_name text,
  p_pickup_date  date,
  p_return_date  date,
  p_notes        text,
  p_items        jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $func$
declare
  v_uid    uuid := auth.uid();
  v_emp    uuid;
  v_email  text;
  v_name   text;
  v_req    uuid;
  v_status text := coalesce(nullif(btrim(p_status), ''), 'under_review');
  v_item   jsonb;
  v_kind   text;
  v_qty    numeric;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_approved() then
    return jsonb_build_object('ok', false, 'error', 'not_approved');
  end if;
  if v_status not in ('draft', 'under_review') then
    v_status := 'under_review';
  end if;

  -- المستفيد = الموظف المرتبط بحساب المتصل (لا يُقبل من العميل)
  select employee_id, email, full_name into v_emp, v_email, v_name
  from public.app_users where id = v_uid;

  -- تحقيق ذاتي للرابط: ربط بموظف مطابق بالبريد، أو إنشاء سجل من بيانات الحساب
  if v_emp is null then
    if v_email is not null then
      select e.id into v_emp from public.employees e
      where lower(e.email) = lower(v_email) and e.is_active
      order by e.created_at limit 1;
    end if;
    if v_emp is null then
      insert into public.employees (full_name, email)
      values (coalesce(nullif(btrim(v_name), ''), nullif(split_part(coalesce(v_email, ''), '@', 1), ''), 'موظف'), v_email)
      returning id into v_emp;
    end if;
    update public.app_users set employee_id = v_emp where id = v_uid;
  end if;

  insert into public.requests (
    status, request_type, beneficiary_type, beneficiary_employee_id,
    customer_id, submitted_by, created_by, request_source,
    project_name, pickup_date, return_date, notes
  ) values (
    v_status, 'internal', 'employee', v_emp,
    null, v_uid, v_uid, 'internal',
    nullif(btrim(p_project_name), ''), p_pickup_date, p_return_date, nullif(btrim(p_notes), '')
  ) returning id into v_req;

  if p_items is not null and jsonb_typeof(p_items) = 'array' then
    for v_item in select * from jsonb_array_elements(p_items) loop
      v_kind := coalesce(v_item->>'item_kind', 'custom');
      v_qty  := greatest(1, coalesce((v_item->>'quantity')::numeric, 1));
      if v_kind = 'consumable' then
        insert into public.request_items (
          request_id, item_kind, consumable_id, quantity, notes,
          requested_kind, requested_description, requested_category
        ) values (
          v_req, 'consumable', nullif(v_item->>'consumable_id', '')::uuid, v_qty, nullif(v_item->>'notes', ''),
          'consumable', nullif(v_item->>'requested_description', ''), nullif(v_item->>'requested_category', '')
        );
      else
        -- احتياج أصل: يُخزَّن custom ويُربط بالمخزون لاحقًا أثناء التجهيز
        insert into public.request_items (
          request_id, item_kind, quantity, notes,
          requested_kind, requested_description, requested_category,
          preferred_company_id, preferred_model
        ) values (
          v_req, 'custom', v_qty, nullif(v_item->>'notes', ''),
          coalesce(nullif(v_item->>'requested_kind', ''), 'existing_asset'),
          nullif(v_item->>'requested_description', ''), nullif(v_item->>'requested_category', ''),
          nullif(v_item->>'preferred_company_id', '')::uuid, nullif(v_item->>'preferred_model', '')
        );
      end if;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'id', v_req);
end $func$;

revoke all on function public.request_create_employee_self(text,text,date,date,text,jsonb) from public;
grant execute on function public.request_create_employee_self(text,text,date,date,text,jsonb) to authenticated;
