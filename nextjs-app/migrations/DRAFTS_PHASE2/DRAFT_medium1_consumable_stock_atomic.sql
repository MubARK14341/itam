-- ============================================================================
-- MEDIUM-1 — ذرّية مخزون المستهلكات (RPC ذرّي)
-- FINAL (بعد فحص المخطط والبيانات الحيّة 2026-07-01) — بانتظار تأكيد التطبيق النهائي.
-- ============================================================================
--
-- الهدف:
--   جعل صرف/توريد/تسوية المستهلكات عملية ذرّية على مستوى قاعدة البيانات:
--     • يُحسب الرصيد من القاعدة تحت قفل صف (FOR UPDATE) لا من قيمة `current` القادمة من العميل.
--     • تُكتب حركة المخزون + تحديث الكمية في معاملة واحدة (لا تحديث ضائع بين طلبين متزامنين).
--   يعيد استخدام نمط request_deliver المثبت.
--
-- نتائج الفحص القرائي (حاسمة):
--   • قيد CHECK (quantity_on_hand >= 0) *موجود مسبقًا* (consumables_quantity_on_hand_check)
--     ⇒ لا نُضيف قيدًا؛ منع السالب على مستوى DB قائم بالفعل. المتبقّي = الذرّية فقط.
--   • enum consumable_txn_type = {in, out, adjust} ⇒ يُسجَّل adjust بأمان.
--   • consumable_transactions.quantity له CHECK (> 0) ⇒ نتجاوز تسجيل حركة عند تسوية بلا تغيير.
--   • quantity/balance_after/previous_quantity أعداد صحيحة (integer).
--   • لا trigger على consumable_transactions ⇒ الدالة تضبط balance_after/previous_quantity/performed_by صراحةً.
--   • الحالة الحيّة: 18 مستهلكًا · 0 حركة · 0 رصيد سالب ⇒ لا بيانات قديمة متعارضة.
--
-- ماذا يغيّر:
--   • يضيف RPC واحدًا: public.consumable_stock_move(...) يغطّي in/out/adjust ذرّيًا.
--   • (كود مقترن — يُطبَّق بعد نجاح الـ SQL) توجيه issue/replenish/adjust/stockTxn في
--     src/lib/queries.ts لاستدعاء الـ RPC. الحُرّاس الحالية في العميل تبقى كطبقة أولى (UX).
--   • يحافظ على سلوك التوريد الحالي حرفيًا (تسجيل تكلفة الشراء في السجل + تحديث آخر unit_cost) —
--     ليس تغييرًا في حماية الأعمدة المالية (ذلك من اختصاص HIGH-1)، بل نقل سلوك قائم إلى دالة ذرّية.
--
-- Destructive؟  ❌ لا. لا حذف بيانات ولا backfill. إضافة دالة فقط.
--
-- ----------------------------------------------------------------------------
-- RPC ذرّي لحركة المخزون (in = توريد · out = صرف · adjust = تعيين مطلق)
-- SECURITY DEFINER + search_path ثابت. يفحص دور المستدعي (كتابة) بنفسه.
-- ----------------------------------------------------------------------------
create or replace function public.consumable_stock_move(
  p_consumable_id  uuid,
  p_type           text,                       -- 'in' | 'out' | 'adjust'
  p_quantity       integer,                     -- in/out: المقدار (>0) · adjust: القيمة المطلقة (>=0)
  p_reason         text    default null,
  p_unit_cost      numeric default null,        -- توريد فقط
  p_supplier_id    uuid    default null,        -- توريد فقط
  p_invoice_number text    default null,        -- توريد فقط
  p_invoice_date   date    default null,        -- توريد فقط
  p_employee_id    uuid    default null,        -- صرف فقط
  p_department_id  uuid    default null          -- صرف فقط
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text := public.app_user_role();
  v_current integer;
  v_next    integer;
  v_qty     integer;
begin
  -- 1) بوابة الدور: الكتابة للأدوار الكاتبة فقط (مطابق ins_ops/upd_ops في RLS)
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_type not in ('in','out','adjust') then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;
  if p_type in ('in','out') and p_quantity = 0 then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  -- 2) قفل صف المستهلك وقراءة الرصيد الفعلي من القاعدة (لا من العميل)
  select quantity_on_hand into v_current
  from public.consumables
  where id = p_consumable_id
  for update;
  if not found then
    raise exception 'consumable_not_found' using errcode = 'P0002';
  end if;

  -- 3) حساب الرصيد الجديد
  if p_type = 'in' then
    v_next := v_current + p_quantity;  v_qty := p_quantity;
  elsif p_type = 'out' then
    v_next := v_current - p_quantity;  v_qty := p_quantity;
  else  -- adjust = تعيين مطلق
    v_next := p_quantity;              v_qty := abs(p_quantity - v_current);
  end if;

  -- 4) منع الرصيد السالب (القيد الموجود يحرسه أيضًا؛ رسالة أوضح هنا)
  if v_next < 0 then
    raise exception 'insufficient_stock' using errcode = '23514';
  end if;

  -- 5) تسجيل الحركة (نتجاوزها عند تسوية بلا تغيير فعلي بسبب قيد quantity > 0)
  if v_qty > 0 then
    insert into public.consumable_transactions(
      consumable_id, txn_type, quantity, previous_quantity, balance_after,
      unit_cost, total_cost, supplier_id, invoice_number, invoice_date,
      related_employee_id, department_id, reason, performed_by
    ) values (
      p_consumable_id, p_type::consumable_txn_type, v_qty, v_current, v_next,
      case when p_type='in' then p_unit_cost else null end,
      case when p_type='in' and p_unit_cost is not null then p_unit_cost * p_quantity else null end,
      case when p_type='in' then p_supplier_id else null end,
      case when p_type='in' then p_invoice_number else null end,
      case when p_type='in' then p_invoice_date else null end,
      case when p_type='out' then p_employee_id else null end,
      case when p_type='out' then p_department_id else null end,
      p_reason, auth.uid()
    );
  end if;

  -- 6) تحديث الكمية (+ آخر سعر شراء عند التوريد — سلوك قائم، لا تغيير في حماية الماليات)
  update public.consumables
     set quantity_on_hand = v_next,
         unit_cost = case when p_type='in' and p_unit_cost is not null then p_unit_cost else unit_cost end
   where id = p_consumable_id;

  return v_next;
end $$;

revoke all on function public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid) from public, anon;
grant execute on function public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid) to authenticated;

-- ============================================================================
-- Rollback Plan:
--   drop function if exists public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid);
--   -- الكود يعود لاستدعاء المسار القديم (سنُبقيه كـ fallback حتى تثبت الدفعة).
--   -- القيد consumables_quantity_on_hand_check لم نُنشئه (كان موجودًا) فلا نحذفه.
--
-- Test Plan (Smoke):
--   [technician] صرف كمية < المتاح ⇒ ينجح، الرصيد ينقص، حركة out بـ performed_by.
--   [technician] صرف كمية = المتاح ⇒ ينجح، الرصيد يصبح 0.
--   [technician] صرف كمية > المتاح ⇒ insufficient_stock (لا سالب).
--   [it_manager] توريد بكمية+سعر+مورّد+فاتورة ⇒ الرصيد يزيد، unit_cost يُحدَّث، total_cost محسوب.
--   [admin]      تسوية (adjust) لقيمة مطلقة ⇒ balance_after صحيح، quantity = |الفرق|؛ تسوية بلا تغيير = لا حركة.
--   [viewer]     أي استدعاء ⇒ not_authorized.
--   تزوير `current`: الـ RPC يتجاهله (يقرأ من القاعدة).
--   low/out stock alerts + consumable profile + reports: تعمل (تقرأ quantity_on_hand كما هي).
--
-- مخاطر التطبيق:
--   • SECURITY DEFINER: search_path مثبّت = public.
--   • لا تعارض مع الـ triggers (audit على consumables يسجّل التحديث كالمعتاد).
--   • أسماء الأعمدة/الأنواع مؤكَّدة من الفحص الحيّ أعلاه.
-- ============================================================================
