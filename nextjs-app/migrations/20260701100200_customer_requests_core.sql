-- ============================================================================
--  المرحلة: نظام طلبات العملاء الخارجيين (Customer Requests) — النواة
--  إضافي وآمن بالكامل: جداول + دوال + سياسات RLS مغلقة فقط.
--  ✅ لا DROP TABLE · ✅ لا حذف بيانات · ✅ لا anon · ✅ لا service_role في الواجهة
--  العميل (customer) كيان خارجي ≠ مستخدم النظام (app_users). الطلب يطلب من مخزوننا
--  أصولًا/مستهلكات. الترقيم REQ-2026-0001 تلقائي. التسليم يؤثر على المخزون من طبقة
--  التطبيق (مثل assign/issue الحاليّين)، والاعتماد/الرفض عبر RPC للمدير فقط.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) العملاء الخارجيون (لا حذف — is_active=false للتعطيل)
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_person text null,
  phone text null,
  email text null,
  city text null,
  address text null,
  notes text null,
  is_active boolean not null default true,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2) تسلسل أرقام الطلبات حسب السنة (مثل tag_sequences) — يُدار حصراً عبر دالة آمنة
-- ---------------------------------------------------------------------------
create table if not exists public.request_sequences (
  year int primary key,
  last_seq int not null default 0
);

create or replace function public.next_request_number()
returns text language plpgsql security definer set search_path = public as $func$
declare v_year int := extract(year from now())::int; v_seq int;
begin
  insert into public.request_sequences (year, last_seq) values (v_year, 1)
  on conflict (year) do update set last_seq = request_sequences.last_seq + 1
  returning last_seq into v_seq;
  return format('REQ-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
end $func$;
revoke all on function public.next_request_number() from public;
grant execute on function public.next_request_number() to authenticated;

-- ---------------------------------------------------------------------------
-- 3) الطلبات
-- ---------------------------------------------------------------------------
create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  request_number text unique not null,
  customer_id uuid null references public.customers(id),
  customer_name_snapshot text null,
  contact_phone_snapshot text null,
  project_name text null,
  project_city text null,
  request_type text not null default 'rental'
    check (request_type in ('rental','sale','service','mixed')),
  status text not null default 'draft'
    check (status in ('draft','under_review','approved','rejected','preparing',
                      'ready_for_pickup','delivered','partially_returned','returned',
                      'completed','cancelled','overdue')),
  pickup_date date null,
  return_date date null,
  delivered_at timestamptz null,
  returned_at timestamptz null,
  approved_by uuid null,
  approved_at timestamptz null,
  rejected_by uuid null,
  rejected_at timestamptz null,
  rejection_reason text null,
  notes text null,
  internal_notes text null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_requests_status on public.requests(status);
create index if not exists idx_requests_customer on public.requests(customer_id);
create index if not exists idx_requests_created_at on public.requests(created_at desc);

-- ترقيم تلقائي (مثل assets_assign_tag) إن لم يُمرَّر رقم
create or replace function public.requests_assign_number()
returns trigger language plpgsql as $func$
begin
  if new.request_number is null or new.request_number = '' then
    new.request_number := public.next_request_number();
  end if;
  return new;
end $func$;
drop trigger if exists trg_requests_assign_number on public.requests;
create trigger trg_requests_assign_number before insert on public.requests
  for each row execute function public.requests_assign_number();

-- ---------------------------------------------------------------------------
-- 4) عناصر الطلب (أصل محدد أو مستهلك بكمية)
-- ---------------------------------------------------------------------------
create table if not exists public.request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  item_kind text not null check (item_kind in ('asset','consumable')),
  asset_id uuid null references public.assets(id),
  consumable_id uuid null references public.consumables(id),
  quantity numeric not null default 1 check (quantity > 0),
  approved_quantity numeric null,
  delivered_quantity numeric not null default 0,
  returned_quantity numeric not null default 0,
  unit_price numeric null,
  total_price numeric null,
  notes text null,
  created_at timestamptz not null default now(),
  constraint request_items_kind_ref check (
    (item_kind = 'asset' and asset_id is not null and consumable_id is null) or
    (item_kind = 'consumable' and consumable_id is not null and asset_id is null)
  )
);
create index if not exists idx_request_items_request on public.request_items(request_id);
create index if not exists idx_request_items_asset on public.request_items(asset_id);
create index if not exists idx_request_items_consumable on public.request_items(consumable_id);

-- ---------------------------------------------------------------------------
-- 5) محفّزات updated_at + التدقيق (إعادة استخدام الدوال القائمة)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_customers_updated on public.customers;
create trigger trg_customers_updated before update on public.customers
  for each row execute function public.set_updated_at();
drop trigger if exists trg_requests_updated on public.requests;
create trigger trg_requests_updated before update on public.requests
  for each row execute function public.set_updated_at();

drop trigger if exists trg_audit_customers on public.customers;
create trigger trg_audit_customers after insert or update or delete on public.customers
  for each row execute function public.audit_trigger();
drop trigger if exists trg_audit_requests on public.requests;
create trigger trg_audit_requests after insert or update or delete on public.requests
  for each row execute function public.audit_trigger();
drop trigger if exists trg_audit_request_items on public.request_items;
create trigger trg_audit_request_items after insert or update or delete on public.request_items
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- 6) الصلاحيات: authenticated فقط (RLS الحارس) — لا anon. تسلسل الأرقام مغلق.
-- ---------------------------------------------------------------------------
revoke all on public.customers from anon;
revoke all on public.requests from anon;
revoke all on public.request_items from anon;
revoke all on public.request_sequences from anon;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.requests to authenticated;
grant select, insert, update, delete on public.request_items to authenticated;

alter table public.customers enable row level security;
alter table public.requests enable row level security;
alter table public.request_items enable row level security;
alter table public.request_sequences enable row level security; -- بلا سياسات = منع مباشر (يُدار عبر الدالة الآمنة)

-- 6-أ) customers: قراءة لكل معتمد · كتابة admin/it_manager · حذف admin
drop policy if exists sel_auth on public.customers;
drop policy if exists ins_mgr on public.customers;
drop policy if exists upd_mgr on public.customers;
drop policy if exists del_admin on public.customers;
create policy sel_auth on public.customers for select to authenticated using (public.is_approved());
create policy ins_mgr on public.customers for insert to authenticated
  with check (public.app_user_role() in ('admin','it_manager'));
create policy upd_mgr on public.customers for update to authenticated
  using (public.app_user_role() in ('admin','it_manager'))
  with check (public.app_user_role() in ('admin','it_manager'));
create policy del_admin on public.customers for delete to authenticated
  using (public.app_user_role() = 'admin');

-- 6-ب) requests: قراءة لكل معتمد · إنشاء/تحديث admin/it_manager/technician · حذف admin
--      (الاعتماد/الرفض محصوران بالمدير عبر RPC أدناه — لا يكفي UI)
drop policy if exists sel_auth on public.requests;
drop policy if exists ins_ops on public.requests;
drop policy if exists upd_ops on public.requests;
drop policy if exists del_admin on public.requests;
create policy sel_auth on public.requests for select to authenticated using (public.is_approved());
create policy ins_ops on public.requests for insert to authenticated
  with check (public.app_user_role() in ('admin','it_manager','technician'));
create policy upd_ops on public.requests for update to authenticated
  using (public.app_user_role() in ('admin','it_manager','technician'))
  with check (public.app_user_role() in ('admin','it_manager','technician'));
create policy del_admin on public.requests for delete to authenticated
  using (public.app_user_role() = 'admin');

-- 6-ج) request_items: قراءة لكل معتمد · كتابة/حذف ops (بنود مسودّة)
drop policy if exists sel_auth on public.request_items;
drop policy if exists ins_ops on public.request_items;
drop policy if exists upd_ops on public.request_items;
drop policy if exists del_ops on public.request_items;
create policy sel_auth on public.request_items for select to authenticated using (public.is_approved());
create policy ins_ops on public.request_items for insert to authenticated
  with check (public.app_user_role() in ('admin','it_manager','technician'));
create policy upd_ops on public.request_items for update to authenticated
  using (public.app_user_role() in ('admin','it_manager','technician'))
  with check (public.app_user_role() in ('admin','it_manager','technician'));
create policy del_ops on public.request_items for delete to authenticated
  using (public.app_user_role() in ('admin','it_manager','technician'));

-- ---------------------------------------------------------------------------
-- 7) اعتماد/رفض الطلب — مدير فقط (admin/it_manager) عبر RPC آمن (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
create or replace function public.request_approve(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'approved', approved_by = auth.uid(), approved_at = now(),
      rejected_by = null, rejected_at = null, rejection_reason = null, updated_at = now()
  where id = p_id and status in ('draft','under_review');
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  return json_build_object('ok', true);
end $func$;
revoke all on function public.request_approve(uuid) from public;
grant execute on function public.request_approve(uuid) to authenticated;

create or replace function public.request_reject(p_id uuid, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $func$
declare v_caller text := public.app_user_role();
begin
  if v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(),
      rejection_reason = nullif(p_reason, ''), updated_at = now()
  where id = p_id and status in ('draft','under_review','approved','preparing','ready_for_pickup');
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  return json_build_object('ok', true);
end $func$;
revoke all on function public.request_reject(uuid, text) from public;
grant execute on function public.request_reject(uuid, text) to authenticated;
