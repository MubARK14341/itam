-- ============================================================================
--  Purchase Requests — طلبات شراء بسيطة للمستهلكات (تجهيز/متابعة، ليست ERP).
--  إضافي وآمن: جدولان + ترقيم PR- (نفس نمط REQ-). لا يلمس أي بيانات حقيقية.
--  قواعد صلبة:
--   • المخزون لا يرتفع من هنا أبدًا — التوريد الحقيقي يبقى عبر consumable_stock_move
--     حصريًا؛ «الاستلام» هنا مجرد متابعة (received_quantity) عبر RPC.
--   • unit_cost مالي: مستثنى من grant القراءة (نمط HIGH-1) ويُقرأ عبر RPC مالي
--     للمدراء فقط + trigger يصفّر ما يكتبه غير المصرح.
--   • تغيير الحالة عبر RPC فقط (state machine) — grant UPDATE محدود بالأعمدة الوصفية.
-- ============================================================================

-- ترقيم PR-YYYY-#### — نفس نمط request_sequences/next_request_number
create table if not exists public.purchase_request_sequences (
  year int primary key,
  last_seq int not null default 0
);
revoke all on public.purchase_request_sequences from anon, authenticated;

create or replace function public.next_purchase_request_number()
returns text language plpgsql security definer set search_path = public as $func$
declare
  v_year int := extract(year from now())::int;
  v_seq int;
begin
  insert into public.purchase_request_sequences (year, last_seq) values (v_year, 1)
  on conflict (year) do update set last_seq = purchase_request_sequences.last_seq + 1
  returning last_seq into v_seq;
  return format('PR-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
end $func$;
revoke all on function public.next_purchase_request_number() from public, anon;
grant execute on function public.next_purchase_request_number() to authenticated;

create table if not exists public.purchase_requests (
  id              uuid primary key default gen_random_uuid(),
  request_number  text unique not null default '',
  supplier_id     uuid references public.suppliers(id),
  status          text not null default 'draft',
  requested_by    uuid references public.app_users(id),
  submitted_at    timestamptz,
  approved_by     uuid references public.app_users(id),
  approved_at     timestamptz,
  cancelled_by    uuid references public.app_users(id),
  cancelled_at    timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint purchase_request_status_valid check (status in
    ('draft','submitted','approved','ordered','partially_received','received','cancelled'))
);

create table if not exists public.purchase_request_items (
  id                   uuid primary key default gen_random_uuid(),
  purchase_request_id  uuid not null references public.purchase_requests(id) on delete cascade,
  consumable_id        uuid not null references public.consumables(id),
  requested_quantity   numeric not null check (requested_quantity > 0),
  received_quantity    numeric not null default 0 check (received_quantity >= 0),
  suggested_quantity   numeric,
  notes                text,
  unit_cost            numeric, -- مالي: يُقرأ عبر RPC المدراء فقط
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_pr_items_pr on public.purchase_request_items(purchase_request_id);
create index if not exists idx_pr_status on public.purchase_requests(status);

-- ختم الرقم + الطالب + updated_at بالخادم (يتجاهل قيم العميل)
create or replace function public.purchase_requests_stamp()
returns trigger language plpgsql set search_path = public as $func$
begin
  if tg_op = 'INSERT' then
    if new.request_number is null or btrim(new.request_number) = '' then
      new.request_number := public.next_purchase_request_number();
    end if;
    new.requested_by := auth.uid();
    new.status := 'draft'; -- الإنشاء مسودة دائمًا؛ التحولات عبر RPC فقط
  end if;
  new.updated_at := now();
  return new;
end $func$;

drop trigger if exists trg_purchase_requests_stamp on public.purchase_requests;
create trigger trg_purchase_requests_stamp
  before insert or update on public.purchase_requests
  for each row execute function public.purchase_requests_stamp();

-- حارس مالية البنود: غير المصرح ماليًا لا يكتب unit_cost (نفس نمط حارس تكلفة الصيانة)
create or replace function public.pr_items_guard_financial()
returns trigger language plpgsql set search_path = public as $func$
begin
  if not public.is_financial_viewer() then
    if tg_op = 'INSERT' then
      new.unit_cost := null;
    elsif new.unit_cost is distinct from old.unit_cost then
      new.unit_cost := old.unit_cost;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $func$;

drop trigger if exists trg_pr_items_guard_financial on public.purchase_request_items;
create trigger trg_pr_items_guard_financial
  before insert or update on public.purchase_request_items
  for each row execute function public.pr_items_guard_financial();

-- RLS
alter table public.purchase_requests enable row level security;
alter table public.purchase_request_items enable row level security;

drop policy if exists sel_auth on public.purchase_requests;
create policy sel_auth on public.purchase_requests
  for select to authenticated using (public.is_approved());

drop policy if exists ins_ops on public.purchase_requests;
create policy ins_ops on public.purchase_requests
  for insert to authenticated
  with check (public.app_user_role() = any (array['admin','it_manager','technician']));

drop policy if exists upd_ops on public.purchase_requests;
create policy upd_ops on public.purchase_requests
  for update to authenticated
  using (public.app_user_role() = any (array['admin','it_manager','technician']))
  with check (public.app_user_role() = any (array['admin','it_manager','technician']));

drop policy if exists sel_auth on public.purchase_request_items;
create policy sel_auth on public.purchase_request_items
  for select to authenticated using (public.is_approved());

-- بنود الطلب تُعدَّل فقط والطلب مسودة (بعد الإرسال تتجمد؛ الاستلام عبر RPC)
drop policy if exists ins_ops_draft on public.purchase_request_items;
create policy ins_ops_draft on public.purchase_request_items
  for insert to authenticated
  with check (
    public.app_user_role() = any (array['admin','it_manager','technician'])
    and exists (select 1 from public.purchase_requests pr
                where pr.id = purchase_request_id and pr.status = 'draft')
  );

drop policy if exists upd_ops_draft on public.purchase_request_items;
create policy upd_ops_draft on public.purchase_request_items
  for update to authenticated
  using (
    public.app_user_role() = any (array['admin','it_manager','technician'])
    and exists (select 1 from public.purchase_requests pr
                where pr.id = purchase_request_id and pr.status = 'draft')
  )
  with check (
    public.app_user_role() = any (array['admin','it_manager','technician'])
  );

drop policy if exists del_ops_draft on public.purchase_request_items;
create policy del_ops_draft on public.purchase_request_items
  for delete to authenticated
  using (
    public.app_user_role() = any (array['admin','it_manager','technician'])
    and exists (select 1 from public.purchase_requests pr
                where pr.id = purchase_request_id and pr.status = 'draft')
  );

-- Grants — نمط HIGH-1: القراءة بأعمدة صريحة (بلا unit_cost في البنود)؛
-- التحديث المباشر للرأس مقصور على الأعمدة الوصفية (الحالة عبر RPC فقط).
revoke all on public.purchase_requests from anon, authenticated;
grant select on public.purchase_requests to authenticated;
grant insert (id, supplier_id, notes) on public.purchase_requests to authenticated;
grant update (supplier_id, notes) on public.purchase_requests to authenticated;

revoke all on public.purchase_request_items from anon, authenticated;
grant select (id, purchase_request_id, consumable_id, requested_quantity, received_quantity,
              suggested_quantity, notes, created_at, updated_at)
  on public.purchase_request_items to authenticated;
grant insert (id, purchase_request_id, consumable_id, requested_quantity, suggested_quantity, notes, unit_cost)
  on public.purchase_request_items to authenticated;
grant update (requested_quantity, notes, unit_cost) on public.purchase_request_items to authenticated;
grant delete on public.purchase_request_items to authenticated;

-- RPC مالي: unit_cost للبنود — للمصرح ماليًا فقط (نفس نمط assets_financial)
create or replace function public.purchase_request_items_financial(p_pr_ids uuid[])
returns table (id uuid, unit_cost numeric)
language sql security definer stable set search_path = public as $func$
  select i.id, i.unit_cost
  from public.purchase_request_items i
  where i.purchase_request_id = any (p_pr_ids) and public.is_financial_viewer();
$func$;
revoke all on function public.purchase_request_items_financial(uuid[]) from public, anon;
grant execute on function public.purchase_request_items_financial(uuid[]) to authenticated;

-- RPC حالة الطلب — آلة حالات صريحة + صلاحيات لكل انتقال
create or replace function public.purchase_request_set_status(p_id uuid, p_to text)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role text := public.app_user_role();
  v_cur text;
  v_requested_by uuid;
  v_ok boolean := false;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;

  select status, requested_by into v_cur, v_requested_by
  from public.purchase_requests where id = p_id for update;
  if v_cur is null then return json_build_object('ok', false, 'error', 'not_found'); end if;

  -- الانتقالات المسموحة:
  --   draft→submitted (ops) | submitted→approved (مدراء) | approved→ordered (ops)
  --   ordered→partially_received/received (ops) | partially_received→received (ops)
  --   إلغاء: المدراء من أي حالة غير نهائية؛ الفنيّ يلغي مسودته هو فقط.
  if p_to = 'submitted' and v_cur = 'draft' then
    v_ok := true;
    update public.purchase_requests set status = 'submitted', submitted_at = now() where id = p_id;
  elsif p_to = 'approved' and v_cur = 'submitted' and v_role in ('admin','it_manager') then
    v_ok := true;
    update public.purchase_requests set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_id;
  elsif p_to = 'ordered' and v_cur = 'approved' then
    v_ok := true;
    update public.purchase_requests set status = 'ordered' where id = p_id;
  elsif p_to in ('partially_received','received') and v_cur in ('ordered','partially_received') then
    v_ok := true;
    update public.purchase_requests set status = p_to where id = p_id;
  elsif p_to = 'cancelled' and v_cur in ('draft','submitted','approved','ordered') then
    if v_role in ('admin','it_manager') or (v_cur = 'draft' and v_requested_by = auth.uid()) then
      v_ok := true;
      update public.purchase_requests set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now() where id = p_id;
    end if;
  end if;

  if not v_ok then return json_build_object('ok', false, 'error', 'bad_transition'); end if;
  return json_build_object('ok', true);
end $func$;
revoke all on function public.purchase_request_set_status(uuid, text) from public, anon;
grant execute on function public.purchase_request_set_status(uuid, text) to authenticated;

-- RPC استلام بند — متابعة فقط: لا يلمس المخزون أبدًا (التوريد عبر consumable_stock_move)
create or replace function public.purchase_request_item_receive(p_item_id uuid, p_qty numeric)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role text := public.app_user_role();
  v_pr uuid;
  v_status text;
  v_all_received boolean;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_qty is null or p_qty <= 0 then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;

  select i.purchase_request_id, pr.status into v_pr, v_status
  from public.purchase_request_items i
  join public.purchase_requests pr on pr.id = i.purchase_request_id
  where i.id = p_item_id for update of pr;
  if v_pr is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_status not in ('ordered','partially_received') then
    return json_build_object('ok', false, 'error', 'bad_status');
  end if;

  update public.purchase_request_items
  set received_quantity = received_quantity + p_qty, updated_at = now()
  where id = p_item_id;

  select bool_and(received_quantity >= requested_quantity) into v_all_received
  from public.purchase_request_items where purchase_request_id = v_pr;

  update public.purchase_requests
  set status = case when v_all_received then 'received' else 'partially_received' end
  where id = v_pr;

  return json_build_object('ok', true);
end $func$;
revoke all on function public.purchase_request_item_receive(uuid, numeric) from public, anon;
grant execute on function public.purchase_request_item_receive(uuid, numeric) to authenticated;

comment on table public.purchase_requests is
  'طلبات شراء المستهلكات (تجهيز/متابعة فقط — المخزون يتحدّث حصريًا عبر consumable_stock_move). الحالة عبر RPC. unit_cost مالي محمي بنمط HIGH-1.';
