-- =====================================================================
-- Purpose: الإرجاع والفحص المنظّم لكل جهاز + عدّادات تتبّع على الأصل.
--   • عدّادات إضافية على assets: عدد مرات الخروج، آخر طلب، آخر حالة/تاريخ إرجاع/خروج،
--     عدد مرات الرجوع غير السليم. غير مالية — تُمنح select صراحةً (HIGH-1) وتُضاف لقائمة NOFIN.
--   • request_deliver: يزيد عداد الخروج ويختم آخر طلب/خروج عند تسليم كل أصل.
--   • asset_return: يختم آخر حالة/تاريخ إرجاع (لعهدة الموظف).
--   • request_inspect_return(uuid, jsonb): فحص كل جهاز راجع (سليم/غير سليم/مفقود/يحتاج صيانة):
--       سليم→available، غير سليم/يحتاج صيانة→in_maintenance + فتح سجل صيانة + عداد+1،
--       مفقود→lost. كل الأجهزة سليمة ⇒ الطلب completed؛ فيه غير سليم ⇒ returned (بانتظار المعالجة)؛
--       بقي أجهزة ⇒ partially_returned.
-- Risk:    متوسط — أعمدة إضافية + دالة جديدة + حقن عدّادات في دالتين قائمتين (لا تغيير سلوك).
--          كل التحديثات عبر SECURITY DEFINER (تتجاوز RLS)، بلا أي حقل مالي.
-- Rollback: drop function request_inspect_return; حذف الأعمدة؛ إعادة request_deliver/asset_return لتعريفهما.
-- =====================================================================

-- 1) أعمدة العدّادات + منح select (HIGH-1: assets محجوب على مستوى العمود) ----
alter table public.assets
  add column if not exists times_checked_out    integer not null default 0,
  add column if not exists unsound_return_count integer not null default 0,
  add column if not exists last_request_id      uuid references public.requests(id) on delete set null,
  add column if not exists last_return_condition text,
  add column if not exists last_out_at          timestamptz,
  add column if not exists last_return_at        timestamptz;

grant select (times_checked_out, unsound_return_count, last_request_id,
              last_return_condition, last_out_at, last_return_at)
  on public.assets to authenticated;

-- 2) request_deliver: عدّاد الخروج + آخر طلب/خروج (حقن دقيق في جملتَي تحديث الأصل) --
do $mig$
declare def text;
begin
  select pg_get_functiondef('public.request_deliver(uuid)'::regprocedure) into def;
  if position('times_checked_out' in def) = 0 then
    def := replace(def,
      $q$set status = 'assigned', assigned_to_employee_id = v_req.beneficiary_employee_id where id = r.asset_id;$q$,
      $q$set status = 'assigned', assigned_to_employee_id = v_req.beneficiary_employee_id, times_checked_out = coalesce(times_checked_out,0) + 1, last_out_at = now(), last_request_id = p_id where id = r.asset_id;$q$);
    def := replace(def,
      $q$set status = v_target, assigned_to_employee_id = null where id = r.asset_id;$q$,
      $q$set status = v_target, assigned_to_employee_id = null, times_checked_out = coalesce(times_checked_out,0) + 1, last_out_at = now(), last_request_id = p_id where id = r.asset_id;$q$);
    execute def;
  end if;
end $mig$;

-- 3) asset_return: ختم آخر حالة/تاريخ إرجاع (عهدة الموظف) -------------------
do $mig$
declare def text;
begin
  select pg_get_functiondef('public.asset_return(uuid, text)'::regprocedure) into def;
  if position('last_return_at' in def) = 0 then
    def := replace(def,
      $q$set status = 'available', assigned_to_employee_id = null
  where id = p_asset_id;$q$,
      $q$set status = 'available', assigned_to_employee_id = null,
      last_return_condition = nullif(p_condition, ''), last_return_at = now()
  where id = p_asset_id;$q$);
    execute def;
  end if;
end $mig$;

-- 4) request_inspect_return: فحص كل جهاز راجع -------------------------------
create or replace function public.request_inspect_return(p_id uuid, p_lines jsonb)
returns json language plpgsql security definer set search_path to 'public' as $func$
declare
  v_role text := public.app_user_role();
  v_req  public.requests%rowtype;
  v_line jsonb;
  v_asset uuid;
  v_cond text;
  v_notes text;
  v_cur asset_status;
  v_new asset_status;
  v_processed int := 0;
  v_unsound int := 0;
  v_remaining int;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician','warehouse_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered','partially_returned','overdue') then
    return json_build_object('ok', false, 'error', 'state_not_returnable');
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_asset := nullif(v_line->>'asset_id','')::uuid;
    v_cond  := coalesce(nullif(v_line->>'condition',''), 'sound');
    v_notes := nullif(btrim(v_line->>'notes'), '');
    if v_asset is null then continue; end if;
    if v_cond not in ('sound','unsound','missing','needs_maintenance') then v_cond := 'sound'; end if;

    -- الأصل ضمن بنود الطلب المسلَّمة وغير المُرجَعة
    if not exists (select 1 from public.request_items ri
                   where ri.request_id = p_id and ri.item_kind = 'asset' and ri.asset_id = v_asset
                     and coalesce(ri.delivered_quantity,0) > coalesce(ri.returned_quantity,0)) then
      continue;
    end if;
    select status into v_cur from public.assets where id = v_asset for update;
    if v_cur not in ('rented','assigned') then continue; end if;

    v_new := case when v_cond = 'sound' then 'available'::asset_status
                  when v_cond = 'missing' then 'lost'::asset_status
                  else 'in_maintenance'::asset_status end;

    update public.assets
      set status = v_new,
          assigned_to_employee_id = null,
          last_return_condition = v_cond,
          last_return_at = now(),
          last_request_id = p_id,
          unsound_return_count = coalesce(unsound_return_count,0)
            + case when v_cond in ('unsound','needs_maintenance') then 1 else 0 end
      where id = v_asset;

    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (v_asset, 'status_change', v_cur, v_new, auth.uid(),
              'إرجاع وفحص طلب '||v_req.request_number||' — '||v_cond||coalesce(' · '||v_notes,''));

    update public.asset_assignments
      set status = 'returned', returned_at = now(), return_condition = v_cond
      where asset_id = v_asset and status = 'active';

    if v_cond in ('unsound','needs_maintenance') then
      insert into public.maintenance_records (asset_id, reported_by, problem_description)
        values (v_asset, auth.uid(),
                'جهاز راجع غير سليم من الطلب '||v_req.request_number||coalesce(' · '||v_notes,''));
      v_unsound := v_unsound + 1;
    end if;

    update public.request_items set returned_quantity = quantity
      where request_id = p_id and item_kind = 'asset' and asset_id = v_asset;

    v_processed := v_processed + 1;
  end loop;

  select count(*) into v_remaining from public.request_items ri
    where ri.request_id = p_id and ri.item_kind = 'asset'
      and coalesce(ri.delivered_quantity,0) > coalesce(ri.returned_quantity,0);

  if v_remaining > 0 then
    update public.requests set status = 'partially_returned' where id = p_id;
  elsif v_unsound > 0 then
    update public.requests set status = 'returned', returned_at = now() where id = p_id;
  else
    update public.requests set status = 'completed', returned_at = now() where id = p_id;
  end if;

  perform public._request_add_event(p_id, 'inspected_return', 'staff', null,
    jsonb_build_object('processed', v_processed, 'unsound', v_unsound, 'remaining', v_remaining));

  return json_build_object('ok', true, 'processed', v_processed, 'unsound', v_unsound, 'remaining', v_remaining);
end $func$;

revoke all on function public.request_inspect_return(uuid, jsonb) from public;
grant execute on function public.request_inspect_return(uuid, jsonb) to authenticated;
