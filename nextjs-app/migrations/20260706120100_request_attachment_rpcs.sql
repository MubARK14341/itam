-- ============================================================================
--  Phase 3 (2/2) — دوال تسجيل/سرد/توقيع مرفقات الطلبات
--  كل الدوال: SECURITY DEFINER + set search_path=public + منح authenticated فقط.
--  التدفق: العميل/الموظف (1) يرفع الملف إلى bucket request-attachments (سياسات
--  storage تحرس المسار)، ثم (2) يستدعي register RPC الذي يتحقق من ملكية الكائن
--  ويقرأ mime/size من metadata السيرفر (لا من العميل) ويسجّل الصف + حدثًا.
--  عزل العملاء مفروض ثلاثيًا: register RPC (قفل + ملكية) · سياسة INSERT (مسار
--  مربوط بطلب العميل) · سياسة SELECT عند التوقيع (helper). لا storage_path للبوابة.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) تسجيل مرفق بوابة (بعد الرفع) — visible_to_customer=true دائمًا (مرفق العميل)
-- ---------------------------------------------------------------------------
create or replace function public.portal_register_request_attachment(
  p_request_id uuid, p_file_name text, p_storage_path text
) returns json language plpgsql security definer set search_path = public as $func$
declare
  v_cid  uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_req  public.requests%rowtype;
  v_mime text; v_size bigint; v_id uuid;
  v_allowed text[] := array[
    'application/pdf','image/png','image/jpeg','image/webp','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','needs_clarification') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  if p_storage_path !~ ('^requests/' || p_request_id::text || '/portal/[A-Za-z0-9._-]{1,150}$') then
    return json_build_object('ok', false, 'error', 'invalid_path'); end if;
  if coalesce(length(trim(p_file_name)),0) = 0 or length(p_file_name) > 200 then
    return json_build_object('ok', false, 'error', 'invalid_name'); end if;

  -- ملكية الكائن + mime/size من metadata السيرفر (يقتل انتحال المسار والصفوف الوهمية)
  select nullif(o.metadata->>'mimetype',''), coalesce((o.metadata->>'size')::bigint, 0)
    into v_mime, v_size
    from storage.objects o
    where o.bucket_id = 'request-attachments' and o.name = p_storage_path and o.owner_id = auth.uid()::text;
  if not found then return json_build_object('ok', false, 'error', 'object_not_found'); end if;
  if v_mime is not null and v_mime <> all(v_allowed) then return json_build_object('ok', false, 'error', 'bad_type'); end if;
  if v_size > 10485760 then return json_build_object('ok', false, 'error', 'too_large'); end if;

  insert into public.request_attachments (
    request_id, uploaded_by_kind, uploaded_by, visible_to_customer,
    file_name, storage_path, mime_type, size_bytes
  ) values (
    p_request_id, 'portal', auth.uid(), true,
    p_file_name, p_storage_path, coalesce(v_mime,'application/octet-stream'), v_size
  )
  on conflict (storage_path) do nothing
  returning id into v_id;
  if v_id is null then return json_build_object('ok', false, 'error', 'already_registered'); end if;

  perform public._request_add_event(p_request_id, 'attachment_added', 'portal', p_file_name,
    jsonb_build_object('attachment_id', v_id));
  return json_build_object('ok', true, 'id', v_id);
end $func$;

-- ---------------------------------------------------------------------------
-- 2) سرد مرفقات طلب للبوابة — بلا storage_path · فقط المرئي للعميل
-- ---------------------------------------------------------------------------
create or replace function public.portal_list_request_attachments(p_request_id uuid)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true, 'attachments', coalesce((
    select json_agg(json_build_object(
      'id', ra.id, 'file_name', ra.file_name, 'mime_type', ra.mime_type,
      'size_bytes', ra.size_bytes, 'created_at', ra.created_at, 'uploaded_by_kind', ra.uploaded_by_kind
    ) order by ra.created_at)
    from public.request_attachments ra
    where ra.request_id = p_request_id and (ra.uploaded_by_kind = 'portal' or ra.visible_to_customer)
  ), '[]'::json));
end $func$;

-- ---------------------------------------------------------------------------
-- 3) مسار مرفق للبوابة (عند الضغط فقط) — العميل يوقّعه بـ createSignedUrl(path,120)
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_request_attachment_path(p_attachment_id uuid)
returns json language plpgsql stable security definer set search_path = public as $func$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_ra public.request_attachments%rowtype; v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  select * into v_ra from public.request_attachments where id = p_attachment_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  select * into v_req from public.requests where id = v_ra.request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  if not (v_ra.uploaded_by_kind = 'portal' or v_ra.visible_to_customer) then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true, 'path', v_ra.storage_path);
end $func$;

-- ---------------------------------------------------------------------------
-- 4) تسجيل مرفق موظف (بعد الرفع) — visible_to_customer اختياري (افتراضي داخلي)
-- ---------------------------------------------------------------------------
create or replace function public.staff_register_request_attachment(
  p_request_id uuid, p_file_name text, p_storage_path text, p_visible_to_customer boolean default false
) returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role text := public.app_user_role();
  v_req  public.requests%rowtype;
  v_mime text; v_size bigint; v_id uuid;
  v_allowed text[] := array[
    'application/pdf','image/png','image/jpeg','image/webp','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if p_storage_path !~ ('^requests/' || p_request_id::text || '/staff/[A-Za-z0-9._-]{1,150}$') then
    return json_build_object('ok', false, 'error', 'invalid_path'); end if;
  if coalesce(length(trim(p_file_name)),0) = 0 or length(p_file_name) > 200 then
    return json_build_object('ok', false, 'error', 'invalid_name'); end if;

  select nullif(o.metadata->>'mimetype',''), coalesce((o.metadata->>'size')::bigint, 0)
    into v_mime, v_size
    from storage.objects o
    where o.bucket_id = 'request-attachments' and o.name = p_storage_path and o.owner_id = auth.uid()::text;
  if not found then return json_build_object('ok', false, 'error', 'object_not_found'); end if;
  if v_mime is not null and v_mime <> all(v_allowed) then return json_build_object('ok', false, 'error', 'bad_type'); end if;
  if v_size > 10485760 then return json_build_object('ok', false, 'error', 'too_large'); end if;

  insert into public.request_attachments (
    request_id, uploaded_by_kind, uploaded_by, visible_to_customer,
    file_name, storage_path, mime_type, size_bytes
  ) values (
    p_request_id, 'staff', auth.uid(), coalesce(p_visible_to_customer, false),
    p_file_name, p_storage_path, coalesce(v_mime,'application/octet-stream'), v_size
  )
  on conflict (storage_path) do nothing
  returning id into v_id;
  if v_id is null then return json_build_object('ok', false, 'error', 'already_registered'); end if;

  perform public._request_add_event(p_request_id, 'attachment_added', 'staff', p_file_name,
    jsonb_build_object('attachment_id', v_id, 'visible_to_customer', coalesce(p_visible_to_customer, false)));
  return json_build_object('ok', true, 'id', v_id);
end $func$;

-- ---------------------------------------------------------------------------
-- 5) تبديل رؤية مرفق موظف للعميل (مرفقات staff فقط)
-- ---------------------------------------------------------------------------
create or replace function public.staff_set_request_attachment_visibility(p_attachment_id uuid, p_visible boolean)
returns json language plpgsql security definer set search_path = public as $func$
declare v_role text := public.app_user_role(); v_ra public.request_attachments%rowtype;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_ra from public.request_attachments where id = p_attachment_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_ra.uploaded_by_kind <> 'staff' then return json_build_object('ok', false, 'error', 'not_allowed'); end if;
  update public.request_attachments set visible_to_customer = coalesce(p_visible, false) where id = p_attachment_id;
  perform public._request_add_event(v_ra.request_id, 'attachment_visibility_changed', 'staff', v_ra.file_name,
    jsonb_build_object('attachment_id', v_ra.id, 'visible_to_customer', coalesce(p_visible, false)));
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- 6) الصلاحيات: authenticated فقط (الحُرّاس داخل الدوال) — لا anon.
-- ---------------------------------------------------------------------------
do $do$
declare fn text;
begin
  foreach fn in array array[
    'portal_register_request_attachment(uuid, text, text)',
    'portal_list_request_attachments(uuid)',
    'portal_get_request_attachment_path(uuid)',
    'staff_register_request_attachment(uuid, text, text, boolean)',
    'staff_set_request_attachment_visibility(uuid, boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $do$;
