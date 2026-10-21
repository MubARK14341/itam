-- Rollback for 20260716000000_rc2_restrict_invoice_metadata_and_direct_mutations.sql.
-- Do not run automatically. This restores the immediately preceding local
-- definitions and policies, including their less restrictive behavior.

BEGIN;

DROP TRIGGER IF EXISTS trg_consumable_transactions_guard_financial ON public.consumable_transactions;
DROP FUNCTION IF EXISTS public.consumable_transactions_guard_financial();
DROP FUNCTION IF EXISTS public.consumable_txn_financial_detail(uuid[]);
DROP FUNCTION IF EXISTS public.maintenance_financial_detail(uuid[]);

GRANT SELECT (invoice_number, invoice_date) ON public.consumable_transactions TO authenticated;
GRANT SELECT (invoice_number, invoice_date) ON public.maintenance_records TO authenticated;

CREATE OR REPLACE FUNCTION public.maintenance_guard_financial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
BEGIN
  IF NOT public.is_financial_viewer() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.cost := 0;
    ELSE
      NEW.cost := OLD.cost;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE EXECUTE ON FUNCTION public.maintenance_guard_financial() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consumable_stock_move(
  p_consumable_id uuid,
  p_type text,
  p_quantity integer,
  p_reason text DEFAULT NULL,
  p_unit_cost numeric DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_invoice_date date DEFAULT NULL,
  p_employee_id uuid DEFAULT NULL,
  p_department_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_role text := public.app_user_role();
  v_current integer;
  v_next integer;
  v_qty integer;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin','it_manager','technician') THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_type NOT IN ('in','out','adjust') THEN
    RAISE EXCEPTION 'invalid_type' USING ERRCODE = '22023';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 0 OR (p_type IN ('in','out') AND p_quantity = 0) THEN
    RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = '22023';
  END IF;

  SELECT quantity_on_hand INTO v_current
  FROM public.consumables
  WHERE id = p_consumable_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consumable_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_type = 'in' THEN
    v_next := v_current + p_quantity; v_qty := p_quantity;
  ELSIF p_type = 'out' THEN
    v_next := v_current - p_quantity; v_qty := p_quantity;
  ELSE
    v_next := p_quantity; v_qty := abs(p_quantity - v_current);
  END IF;
  IF v_next < 0 THEN
    RAISE EXCEPTION 'insufficient_stock' USING ERRCODE = '23514';
  END IF;

  IF v_qty > 0 THEN
    INSERT INTO public.consumable_transactions(
      consumable_id, txn_type, quantity, previous_quantity, balance_after,
      unit_cost, total_cost, supplier_id, invoice_number, invoice_date,
      related_employee_id, department_id, reason, performed_by
    ) VALUES (
      p_consumable_id, p_type::consumable_txn_type, v_qty, v_current, v_next,
      CASE WHEN p_type = 'in' THEN p_unit_cost ELSE NULL END,
      CASE WHEN p_type = 'in' AND p_unit_cost IS NOT NULL THEN p_unit_cost * p_quantity ELSE NULL END,
      CASE WHEN p_type = 'in' THEN p_supplier_id ELSE NULL END,
      CASE WHEN p_type = 'in' THEN p_invoice_number ELSE NULL END,
      CASE WHEN p_type = 'in' THEN p_invoice_date ELSE NULL END,
      CASE WHEN p_type = 'out' THEN p_employee_id ELSE NULL END,
      CASE WHEN p_type = 'out' THEN p_department_id ELSE NULL END,
      p_reason, auth.uid()
    );
  END IF;

  UPDATE public.consumables
  SET quantity_on_hand = v_next,
      unit_cost = CASE WHEN p_type = 'in' AND p_unit_cost IS NOT NULL THEN p_unit_cost ELSE unit_cost END
  WHERE id = p_consumable_id;
  RETURN v_next;
END
$function$;
REVOKE ALL ON FUNCTION public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consumable_stock_move(uuid,text,integer,text,numeric,uuid,text,date,uuid,uuid) TO authenticated;

DROP POLICY IF EXISTS ins_managers ON public.assets;
DROP POLICY IF EXISTS upd_managers ON public.assets;
CREATE POLICY assets_insert_managers_restrictive ON public.assets AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.app_user_role() IN ('admin','it_manager'));
CREATE POLICY ins_ops ON public.assets FOR INSERT TO authenticated
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));
CREATE POLICY upd_ops ON public.assets FOR UPDATE TO authenticated
  USING (public.app_user_role() IN ('admin','it_manager','technician'))
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));

DROP POLICY IF EXISTS ins_managers ON public.consumables;
DROP POLICY IF EXISTS upd_managers ON public.consumables;
CREATE POLICY ins_ops ON public.consumables FOR INSERT TO authenticated
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));
CREATE POLICY upd_ops ON public.consumables FOR UPDATE TO authenticated
  USING (public.app_user_role() IN ('admin','it_manager','technician'))
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));

DROP POLICY IF EXISTS ins_managers ON public.consumable_transactions;
DROP POLICY IF EXISTS upd_managers ON public.consumable_transactions;
CREATE POLICY ins_ops ON public.consumable_transactions FOR INSERT TO authenticated
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));
CREATE POLICY upd_ops ON public.consumable_transactions FOR UPDATE TO authenticated
  USING (public.app_user_role() IN ('admin','it_manager','technician'))
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));

DROP POLICY IF EXISTS ins_managers ON public.asset_assignments;
DROP POLICY IF EXISTS upd_managers ON public.asset_assignments;
CREATE POLICY ins_ops ON public.asset_assignments FOR INSERT TO authenticated
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));
CREATE POLICY upd_ops ON public.asset_assignments FOR UPDATE TO authenticated
  USING (public.app_user_role() IN ('admin','it_manager','technician'))
  WITH CHECK (public.app_user_role() IN ('admin','it_manager','technician'));

COMMIT;
