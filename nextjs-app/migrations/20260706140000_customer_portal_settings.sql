-- ============================================================================
--  Client Portal — Phase 5 (1/2): إعدادات بوابة العميل + قوائم السماح (شركات/تصنيفات)
--                                  + أعمدة اعتماد مدير المشروع على requests.
--  إضافي وآمن بالكامل. لا DROP/DELETE بيانات · لا anon · لا لمس منطق المخزون.
--
--  المبدأ الأمني:
--   • الجداول الجديدة لا يقرأها/يكتبها العميل مباشرةً (RLS = مدير فقط للقراءة، ولا سياسات
--     كتابة إطلاقًا — كل الكتابة عبر RPCs إدارية SECURITY DEFINER في الجزء 2/2).
--   • البوابة تقرأ الإعدادات/القوائم حصراً عبر portal_* RPCs (SECURITY DEFINER) — لا SELECT مباشر.
--   • «لا صف إعدادات» = السلوك السابق (كل شيء مسموح، بلا اعتماد مدير مشروع) عبر _portal_settings().
--   • أعمدة requests الجديدة على جدول requests (SELECT على مستوى الجدول ممنوح للموظفين أصلاً)،
--     والعميل لا يصل requests مباشرةً (RLS: is_approved/app_user_role يفشلان لمستخدم البوابة).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) إعدادات بوابة كل عميل (صف واحد لكل عميل — قد لا يوجد ⇒ الافتراضات في _portal_settings)
-- ---------------------------------------------------------------------------
create table if not exists public.customer_portal_settings (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  portal_enabled                    boolean not null default true,
  allow_rental_requests             boolean not null default true,
  allow_purchase_requests           boolean not null default true,
  allow_maintenance_requests        boolean not null default true,
  allow_custom_requests             boolean not null default true,
  allow_custom_item_requests        boolean not null default true,
  allow_attachments                 boolean not null default true,
  require_project_manager_approval  boolean not null default false,
  updated_by uuid null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

drop trigger if exists trg_portal_settings_updated on public.customer_portal_settings;
create trigger trg_portal_settings_updated before update on public.customer_portal_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) الشركات المسموح ظهورها في بوابة العميل (allowlist). فارغ ⇒ لا اختيار شركة (نص فقط).
-- ---------------------------------------------------------------------------
create table if not exists public.customer_allowed_companies (
  customer_id uuid not null references public.customers(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  created_by  uuid null,
  created_at  timestamptz not null default now(),
  primary key (customer_id, company_id)
);
create index if not exists idx_cust_allowed_companies_customer on public.customer_allowed_companies(customer_id);

-- ---------------------------------------------------------------------------
-- 3) التصنيفات المسموحة (الخيار B: مفتاح نصي — لا يوجد جدول categories في المخطط الحالي).
--    category_key = نفس مفاتيح الواجهة (camera/printer/laptop/pos/scanner/consumable/other).
--    label_ar/en = لقطة نصية للعرض الإداري. فارغ ⇒ لا قيد على التصنيف (القائمة العامة).
-- ---------------------------------------------------------------------------
create table if not exists public.customer_allowed_categories (
  customer_id      uuid not null references public.customers(id) on delete cascade,
  category_key     text not null,
  category_label_ar text null,
  category_label_en text null,
  created_by       uuid null,
  created_at       timestamptz not null default now(),
  primary key (customer_id, category_key)
);
create index if not exists idx_cust_allowed_categories_customer on public.customer_allowed_categories(customer_id);

-- ---------------------------------------------------------------------------
-- 4) أعمدة اعتماد مدير المشروع على requests (كلها إضافية، defaults تحافظ على الطلبات القديمة)
-- ---------------------------------------------------------------------------
alter table public.requests add column if not exists portal_approval_status text not null default 'not_required';
alter table public.requests add column if not exists portal_approval_requested_by uuid null;
alter table public.requests add column if not exists portal_approval_requested_at timestamptz null;
alter table public.requests add column if not exists portal_approved_by uuid null;
alter table public.requests add column if not exists portal_approved_at timestamptz null;
alter table public.requests add column if not exists portal_rejected_by uuid null;
alter table public.requests add column if not exists portal_rejected_at timestamptz null;
alter table public.requests add column if not exists portal_rejection_reason text null;

do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'requests_portal_approval_status_check'
                   and conrelid = 'public.requests'::regclass) then
    alter table public.requests add constraint requests_portal_approval_status_check
      check (portal_approval_status in
        ('not_required','pending_project_manager','approved_by_project_manager','rejected_by_project_manager'));
  end if;
end $$;

-- فهرس جزئي: فقط الطلبات ذات حالة اعتماد غير الافتراضية (خفيف، لفلترة الفريق الداخلي).
create index if not exists idx_requests_portal_approval
  on public.requests(portal_approval_status)
  where portal_approval_status <> 'not_required';

-- ---------------------------------------------------------------------------
-- 5) RLS — قراءة للمدراء فقط (للواجهة الإدارية)، ولا سياسات كتابة (كلها عبر RPCs الآمنة).
--    مستخدم البوابة ليس app_user ⇒ app_user_role() = null ⇒ لا قراءة/كتابة مباشرة إطلاقًا.
-- ---------------------------------------------------------------------------
alter table public.customer_portal_settings   enable row level security;
alter table public.customer_allowed_companies enable row level security;
alter table public.customer_allowed_categories enable row level security;

revoke all on public.customer_portal_settings   from anon;
revoke all on public.customer_allowed_companies from anon;
revoke all on public.customer_allowed_categories from anon;
grant select on public.customer_portal_settings   to authenticated;
grant select on public.customer_allowed_companies to authenticated;
grant select on public.customer_allowed_categories to authenticated;

drop policy if exists sel_mgr on public.customer_portal_settings;
create policy sel_mgr on public.customer_portal_settings for select to authenticated
  using (public.app_user_role() in ('admin','it_manager'));
drop policy if exists sel_mgr on public.customer_allowed_companies;
create policy sel_mgr on public.customer_allowed_companies for select to authenticated
  using (public.app_user_role() in ('admin','it_manager'));
drop policy if exists sel_mgr on public.customer_allowed_categories;
create policy sel_mgr on public.customer_allowed_categories for select to authenticated
  using (public.app_user_role() in ('admin','it_manager'));

-- ---------------------------------------------------------------------------
-- 6) الإعدادات الفعّالة لعميل — صفّه إن وُجد، وإلا الافتراضات (كل شيء مسموح، بلا اعتماد PM).
--    دالة داخلية: تُستدعى حصراً من portal_* / admin RPCs (SECURITY DEFINER). revoke عن الجميع.
-- ---------------------------------------------------------------------------
create or replace function public._portal_settings(p_customer_id uuid)
returns public.customer_portal_settings
language plpgsql stable security definer set search_path = public as $func$
declare v public.customer_portal_settings;
begin
  select * into v from public.customer_portal_settings where customer_id = p_customer_id;
  if not found then
    v.customer_id                      := p_customer_id;
    v.portal_enabled                   := true;
    v.allow_rental_requests            := true;
    v.allow_purchase_requests          := true;
    v.allow_maintenance_requests       := true;
    v.allow_custom_requests            := true;
    v.allow_custom_item_requests       := true;
    v.allow_attachments                := true;
    v.require_project_manager_approval := false;
  end if;
  return v;
end $func$;
revoke all on function public._portal_settings(uuid) from public, anon, authenticated;

comment on table public.customer_portal_settings is
  'إعدادات بوابة كل عميل (Phase 5). غياب الصف = كل شيء مسموح بلا اعتماد مدير مشروع. الكتابة عبر RPCs إدارية فقط.';
comment on table public.customer_allowed_companies is
  'قائمة الشركات المسموح ظهورها في بوابة العميل. فارغة = لا اختيار شركة (إدخال نصي فقط).';
comment on table public.customer_allowed_categories is
  'قائمة التصنيفات المسموحة (مفتاح نصي — الخيار B). فارغة = لا قيد على التصنيف.';
