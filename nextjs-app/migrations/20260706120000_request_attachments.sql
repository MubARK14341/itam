-- ============================================================================
--  Phase 3 (1/2) — مرفقات الطلبات: bucket خاص جديد + جدول + سياسات تخزين
--  ✅ إضافي بالكامل: bucket جديد request-attachments منفصل تمامًا عن bucket
--     attachments المُقسّى (لا نلمس أيًّا من سياسات attachments_* القديمة).
--  الرؤية: مرفق portal يراه العميل صاحبه + الموظفون. مرفق staff داخلي افتراضيًا
--     (visible_to_customer=false) لا يراه العميل إلا إذا فعّله الموظف.
--  عزل العملاء: مفروض عبر دوال SECURITY DEFINER (لأن سياسات storage تُقيَّم بهوية
--     المستدعي وRLS على requests/request_attachments يجعل أي subquery مباشر يفشل
--     للعميل — لهذا كل الفحوص المركّبة داخل helper functions بنمط المشروع).
--  الكتابة metadata عبر RPCs (الملف التالي) فقط — لا insert/update/delete مباشر.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) bucket خاص — private + فرض سيرفري للحجم (10MB) والأنواع المسموحة
--    (bucket attachments القديم لا يملك هذا الفرض؛ الجديد أكثر تقسية)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'request-attachments', 'request-attachments', false, 10485760,
  array[
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2) جدول تسجيل المرفقات (metadata) — الكتابة عبر RPCs فقط
-- ---------------------------------------------------------------------------
create table if not exists public.request_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  uploaded_by_kind text not null check (uploaded_by_kind in ('staff','portal')),
  uploaded_by uuid not null,
  visible_to_customer boolean not null default false,
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_request_attachments_request
  on public.request_attachments(request_id, created_at);

alter table public.request_attachments enable row level security;

-- لا anon، ولا كتابة مباشرة من authenticated (الكتابة عبر SECURITY DEFINER RPCs).
-- القراءة المباشرة للموظفين المعتمدين فقط (viewer/auditor يقرؤون؛ لا يرفعون).
revoke all on public.request_attachments from anon, authenticated;
grant select on public.request_attachments to authenticated;

drop policy if exists sel_staff on public.request_attachments;
create policy sel_staff on public.request_attachments for select to authenticated
  using (public.is_approved());
-- ملاحظة: العميل لا يقرأ الجدول مباشرة إطلاقًا (is_approved=false له) — يقرأ عبر RPC.

-- ---------------------------------------------------------------------------
-- 3) دوال helper للسياسات (SECURITY DEFINER, fail-closed) — تُستدعى من سياسات
--    storage.objects بدل أي subquery مباشر (نمط المشروع الإلزامي).
-- ---------------------------------------------------------------------------

-- (أ) هل يجوز لمستخدم البوابة الحالي الرفع إلى هذا المسار؟
create or replace function public.portal_can_upload_request_attachment(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_cid  uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_rid  uuid;
  v_req  public.requests%rowtype;
begin
  if v_cid is null then return false; end if;          -- ليس مستخدم بوابة نشطًا
  if v_role = 'viewer' then return false; end if;       -- viewer لا يرفع
  -- مسار مُرسّى: uuid حروف صغيرة + مقطع اسم واحد ASCII بلا '/'
  if p_name !~ '^requests/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/portal/[A-Za-z0-9._-]{1,150}$' then
    return false;
  end if;
  begin
    v_rid := split_part(p_name, '/', 2)::uuid;
  exception when others then
    return false;
  end;
  select * into v_req from public.requests where id = v_rid;
  if not found then return false; end if;
  if v_req.customer_id is distinct from v_cid then return false; end if;
  if v_req.status not in ('draft','under_review','needs_clarification') then return false; end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return false;
  end if;
  return true;
end $$;

-- (ب) هل يجوز لمستخدم البوابة الحالي قراءة (توقيع) هذا المرفق؟
create or replace function public.portal_can_read_request_attachment(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.request_attachments ra
    join public.requests r on r.id = ra.request_id
    where ra.storage_path = p_name
      and public.portal_customer_id() is not null
      and r.customer_id = public.portal_customer_id()
      and (public.portal_user_role() <> 'authorized_requester'
           or r.submitted_by is not distinct from auth.uid())
      and (ra.uploaded_by_kind = 'portal' or ra.visible_to_customer)
  );
$$;

-- (ج) هل هذا المسار مُسجَّل في request_attachments؟ (لمنع حذف المرفقات المسجلة)
create or replace function public.request_attachment_registered(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.request_attachments where storage_path = p_name);
$$;

revoke all on function public.portal_can_upload_request_attachment(text) from public, anon;
revoke all on function public.portal_can_read_request_attachment(text) from public, anon;
revoke all on function public.request_attachment_registered(text) from public, anon;
grant execute on function public.portal_can_upload_request_attachment(text) to authenticated;
grant execute on function public.portal_can_read_request_attachment(text) to authenticated;
grant execute on function public.request_attachment_registered(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) سياسات storage.objects — bucket request-attachments فقط (بادئة req_att_)
--    لا نضيف UPDATE (يمنع overwrite/upsert/move/rename → المرفق ثابت).
-- ---------------------------------------------------------------------------

-- قراءة الموظف المعتمد (شامل viewer/auditor) لكل مرفقات الـ bucket
drop policy if exists req_att_staff_read on storage.objects;
create policy req_att_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'request-attachments' and public.is_approved());

-- قراءة المالك لكائنه (توقيع الكائن المرفوع للتو + مسار الـ rollback)
drop policy if exists req_att_own_read on storage.objects;
create policy req_att_own_read on storage.objects for select to authenticated
  using (bucket_id = 'request-attachments' and owner_id = auth.uid()::text);

-- قراءة البوابة (حسب ملكية العميل + نطاق الطالب + الرؤية) عبر helper
drop policy if exists req_att_portal_read on storage.objects;
create policy req_att_portal_read on storage.objects for select to authenticated
  using (
    bucket_id = 'request-attachments'
    and public.is_portal_user()
    and public.portal_can_read_request_attachment(name)
  );

-- رفع الموظف: أدوار الكتابة فقط + مسار /staff/ مربوط بشكل uuid صحيح
drop policy if exists req_att_staff_insert on storage.objects;
create policy req_att_staff_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'request-attachments'
    and public.app_user_role() in ('admin','it_manager','technician')
    and name ~ '^requests/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/staff/[A-Za-z0-9._-]{1,150}$'
  );

-- رفع البوابة: عبر helper (يفرض العميل/الحالة/الطالب/شكل المسار)
drop policy if exists req_att_portal_insert on storage.objects;
create policy req_att_portal_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'request-attachments'
    and public.portal_can_upload_request_attachment(name)
  );

-- حذف كائن غير مُسجَّل يملكه المستخدم فقط (rollback للتسجيل الفاشل) — المسجّل ثابت
drop policy if exists req_att_delete_own_unregistered on storage.objects;
create policy req_att_delete_own_unregistered on storage.objects for delete to authenticated
  using (
    bucket_id = 'request-attachments'
    and owner_id = auth.uid()::text
    and not public.request_attachment_registered(name)
  );
