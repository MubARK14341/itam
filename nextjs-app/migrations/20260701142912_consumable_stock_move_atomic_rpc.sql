-- ============================================================================
--  MEDIUM-1 (Phase 2) — Atomic consumable stock movement RPC
--  APPLIED 2026-07-01 (version 20260701142912). Mirror of the live migration.
--
--  دالة ذرّية لتحريك مخزون المستهلكات (in=توريد · out=صرف · adjust=تعيين مطلق):
--    • تقرأ الرصيد من القاعدة تحت قفل صف (FOR UPDATE) — لا تثق بقيمة العميل.
--    • تسجّل الحركة + تحدّث الكمية في معاملة واحدة (تمنع التحديث الضائع بين طلبين متزامنين).
--    • تمنع الرصيد السالب (insufficient_stock) — بالإضافة للقيد الموجود quantity_on_hand>=0.
--    • بوابة دور داخلية (admin/it_manager/technician) مطابقة لسياسات RLS.
--  إضافي/غير مدمّر: إنشاء دالة فقط — لا حذف بيانات، لا backfill، لا قيد جديد
--  (القيد consumables_quantity_on_hand_check كان موجودًا مسبقًا).
-- ============================================================================

create or replace function public.consumable_stock_move(
  p_consumable_id  uuid,
  p_type           text,
  p_quantity       integer,
  p_reason         text    default null,
  p_unit_cost      numeric default null,
  p_supplier_id    uuid    default null,
  p_invoice_number text    default null,
  p_invoice_date   date    default null,
  p_employee_id    uuid    default null,
  p_department_id  uuid    default null
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

  select quantity_on_hand into v_current
  from public.consumables
  where id = p_consumable_id
  for update;
  if not found then
    raise exception 'consumable_not_found' using errcode = 'P0002';
  end if;

  if p_type = 'in' then
    v_next := v_current + p_quantity;  v_qty := p_quantity;
  elsif p_type = 'out' then
    v_next := v_current - p_quantity;  v_qty := p_quantity;
  else
    v_next := p_quantity;              v_qty := abs(p_quantity - v_current);
  end if;

  if v_next < 0 then
    raise exception 'insufficient_stock' using errcode = '23514';
  end if;

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

  update public.consumables
     set quantity_on_hand = v_next,
         unit_cost = case when p_type='in' and p_unit_cost is not null then p_unit_cost else unit_cost end
   where id = p_consumable_id;

  return v_next;
end $$;

revoke all on function public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid) from public, anon;
grant execute on function public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid) to authenticated;
