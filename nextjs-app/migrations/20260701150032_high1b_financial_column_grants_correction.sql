-- ============================================================================
--  HIGH-1b (Phase 2) — column-level SELECT correction — APPLIED 2026-07-01
--  (version 20260701150032). Mirror of the live migration.
--
--  السبب: authenticated يملك GRANT SELECT على مستوى الجدول (يتجاوز REVOKE العمودي).
--  الحل: سحب SELECT الجدول ثم منح SELECT على الأعمدة غير المالية فقط (المبالغ/النسب محجوبة).
--  أثر مقصود: select لعمود مالي أو `select *` من authenticated ⇒ permission denied.
--  ملاحظة صيانة: أي عمود جديد يُضاف لهذه الجداول يحتاج grant صريح لـ authenticated.
--  غير مدمّر: صلاحيات فقط. Rollback: grant select on <table> to authenticated;
-- ============================================================================

revoke select on public.assets from authenticated;
grant select (
  id, asset_tag, qr_token, category_id, model_id, serial_number, name, status,
  condition_grade, supplier_id, location_id, department_id, assigned_to_employee_id,
  purchase_date, currency, warranty_end, lifespan_months, notes, special_attributes,
  is_active, created_by, created_at, updated_at, company_id, rfid_tag, pool_id
) on public.assets to authenticated;

revoke select on public.consumables from authenticated;
grant select (
  id, category_id, name, sku, brand, unit, quantity_on_hand, reorder_level,
  location_id, supplier_id, currency, notes, is_active, created_at, updated_at,
  company_id, rfid_tag
) on public.consumables to authenticated;

revoke select on public.consumable_transactions from authenticated;
grant select (
  id, consumable_id, txn_type, quantity, balance_after, related_employee_id,
  related_asset_id, reason, performed_by, created_at, supplier_id, invoice_number,
  invoice_date, previous_quantity, department_id, location_id
) on public.consumable_transactions to authenticated;

revoke select on public.maintenance_records from authenticated;
grant select (
  id, asset_id, type, status, reported_at, started_at, completed_at, reported_by,
  technician_id, vendor_supplier_id, problem_description, action_taken, currency,
  outcome, downtime_hours, next_due_date, created_at, updated_at, priority,
  problem_type, workflow_stage, invoice_number, reported_by_employee_id, final_summary,
  vendor_name, vendor_phone, vendor_location, vendor_map_link, invoice_date,
  handoff_notes, receiver_name
) on public.maintenance_records to authenticated;

revoke select on public.request_items from authenticated;
grant select (
  id, request_id, item_kind, asset_id, consumable_id, quantity, approved_quantity,
  delivered_quantity, returned_quantity, notes, created_at
) on public.request_items to authenticated;

revoke select on public.depreciation_rules from authenticated;
revoke select on public.depreciation_rules from anon;
grant select (
  id, category_id, asset_type, method, is_active, created_at, updated_at
) on public.depreciation_rules to authenticated;
