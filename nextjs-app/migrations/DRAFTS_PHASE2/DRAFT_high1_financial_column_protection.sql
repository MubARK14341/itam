-- ============================================================================
-- HIGH-1 — Financial API Protection (Strict) — FINAL DRAFT (بعد فحص المخطط الحيّ)
-- بانتظار الموافقة الثانية الصريحة. لا يُطبَّق قبلها.
-- ============================================================================
--
-- الهدف: حجب الأعمدة المالية (المبالغ/النسب) عن القراءة عبر الـ API لغير admin/it_manager،
--        على مستوى العمود في قاعدة البيانات (وليس الواجهة فقط)، مع مسار مدراء عبر RPCs.
--
-- سياسة Strict: القراءة المالية لـ admin/it_manager فقط. maintenance cost = مالية بالكامل،
--               وtechnician لا يقرأ ولا يُدخل التكلفة (حاجز DB على الكتابة أيضًا).
--
-- قرارات نطاق (قابلة للتعديل قبل التطبيق):
--   • REVOKE يشمل المبالغ/النسب فقط. تُبقى قابلة للقراءة (غير مبالغ، تشغيلية):
--       assets.purchase_date (يقود الضمان/الإهلاك/العمر، ويُعرض للجميع)،
--       maintenance/consumable invoice_number + invoice_date (بيانات تسليم/مرجع، لا مبالغ؛
--       ملفات الفواتير نفسها محميّة مسبقًا على مستوى Storage/RLS).
--   • assets.salvage_rate يُحجب لكنه غير معروض في أي شاشة (يكفي إزالته من الـ selects).
--
-- ----------------------------------------------------------------------------
-- (1) دالة تحقّق الدور المالي (= canSeeFinancial: admin/it_manager)
-- ----------------------------------------------------------------------------
create or replace function public.is_financial_viewer()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_user_role() in ('admin','it_manager') and public.is_approved();
$$;
revoke all on function public.is_financial_viewer() from public, anon;
grant execute on function public.is_financial_viewer() to authenticated;

-- ----------------------------------------------------------------------------
-- (2) REVOKE قراءة الأعمدة المالية (المبالغ/النسب) من الدور المشترك authenticated
--     SELECT فقط — INSERT/UPDATE غير متأثرة (تُحكَم عبر الواجهة/trigger الصيانة).
--     المالك (postgres) يبقى قادرًا على القراءة ⇒ الـ RPCs (SECURITY DEFINER) تعمل.
-- ----------------------------------------------------------------------------
revoke select (purchase_cost, salvage_rate)   on public.assets                  from authenticated;
revoke select (unit_cost)                     on public.consumables             from authenticated;
revoke select (unit_cost, total_cost)         on public.consumable_transactions from authenticated;
revoke select (cost)                          on public.maintenance_records     from authenticated;
revoke select (unit_price, total_price)       on public.request_items           from authenticated;
revoke select (annual_rate, salvage_rate)     on public.depreciation_rules      from authenticated;

-- ----------------------------------------------------------------------------
-- (3) RPCs مالية — تُرجع الأرقام للمخوّلين فقط (is_financial_viewer)، وإلا 0 صفوف.
-- ----------------------------------------------------------------------------
create or replace function public.assets_financial(p_ids uuid[])
returns table (id uuid, purchase_cost numeric)
language sql stable security definer set search_path = public as $$
  select a.id, a.purchase_cost from public.assets a
  where public.is_financial_viewer() and a.id = any(p_ids);
$$;

create or replace function public.consumables_financial(p_ids uuid[])
returns table (id uuid, unit_cost numeric)
language sql stable security definer set search_path = public as $$
  select c.id, c.unit_cost from public.consumables c
  where public.is_financial_viewer() and c.id = any(p_ids);
$$;

create or replace function public.consumable_txn_financial(p_ids uuid[])
returns table (id uuid, unit_cost numeric, total_cost numeric)
language sql stable security definer set search_path = public as $$
  select t.id, t.unit_cost, t.total_cost from public.consumable_transactions t
  where public.is_financial_viewer() and t.id = any(p_ids);
$$;

create or replace function public.maintenance_financial(p_ids uuid[])
returns table (id uuid, cost numeric)
language sql stable security definer set search_path = public as $$
  select m.id, m.cost from public.maintenance_records m
  where public.is_financial_viewer() and m.id = any(p_ids);
$$;

create or replace function public.request_items_financial(p_request_ids uuid[])
returns table (id uuid, request_id uuid, unit_price numeric, total_price numeric)
language sql stable security definer set search_path = public as $$
  select ri.id, ri.request_id, ri.unit_price, ri.total_price from public.request_items ri
  where public.is_financial_viewer() and ri.request_id = any(p_request_ids);
$$;

create or replace function public.depreciation_financial()
returns table (id uuid, annual_rate numeric, salvage_rate numeric)
language sql stable security definer set search_path = public as $$
  select d.id, d.annual_rate, d.salvage_rate from public.depreciation_rules d
  where public.is_financial_viewer();
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.assets_financial(uuid[])','public.consumables_financial(uuid[])',
    'public.consumable_txn_financial(uuid[])','public.maintenance_financial(uuid[])',
    'public.request_items_financial(uuid[])','public.depreciation_financial()'
  ] loop
    execute format('revoke all on function %s from public, anon;', fn);
    execute format('grant execute on function %s to authenticated;', fn);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- (4) حارس كتابة تكلفة الصيانة: technician لا يُدخل/يعدّل cost (ويمنع مسحها بالخطأ).
--     المدراء فقط يكتبون cost. لا يمسّ invoice_number/invoice_date (تشغيلية).
-- ----------------------------------------------------------------------------
create or replace function public.maintenance_guard_financial()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_financial_viewer() then
    if tg_op = 'INSERT' then
      new.cost := null;
    else
      new.cost := old.cost;  -- UPDATE: نحفظ القيمة القديمة (لا مسح ولا تعديل)
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_maintenance_guard_financial on public.maintenance_records;
create trigger trg_maintenance_guard_financial
  before insert or update on public.maintenance_records
  for each row execute function public.maintenance_guard_financial();

-- ============================================================================
-- Rollback (عكسي بالكامل، بلا فقد بيانات):
--   grant select (purchase_cost, salvage_rate)  on public.assets                  to authenticated;
--   grant select (unit_cost)                    on public.consumables             to authenticated;
--   grant select (unit_cost, total_cost)        on public.consumable_transactions to authenticated;
--   grant select (cost)                         on public.maintenance_records     to authenticated;
--   grant select (unit_price, total_price)      on public.request_items           to authenticated;
--   grant select (annual_rate, salvage_rate)    on public.depreciation_rules      to authenticated;
--   drop trigger if exists trg_maintenance_guard_financial on public.maintenance_records;
--   drop function if exists public.maintenance_guard_financial();
--   drop function if exists public.assets_financial(uuid[]);
--   drop function if exists public.consumables_financial(uuid[]);
--   drop function if exists public.consumable_txn_financial(uuid[]);
--   drop function if exists public.maintenance_financial(uuid[]);
--   drop function if exists public.request_items_financial(uuid[]);
--   drop function if exists public.depreciation_financial();
--   drop function if exists public.is_financial_viewer();
--   ثم استرجاع كود الواجهة (selects القديمة + canSeeMaintenanceCost القديمة).
-- ============================================================================
