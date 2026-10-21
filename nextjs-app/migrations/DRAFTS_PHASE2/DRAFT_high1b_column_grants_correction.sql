-- ============================================================================
-- HIGH-1b — تصحيح آلية حجب الأعمدة (column-level SELECT)
-- سبب: authenticated يملك GRANT SELECT على مستوى الجدول (من secure_rls)، وهذا
-- يتجاوز REVOKE على مستوى العمود. الحل الصحيح: سحب SELECT الجدول ثم منح SELECT
-- على الأعمدة غير المالية فقط. (اكتُشف عبر اختبار سلبي بدور authenticated.)
--
-- Destructive؟ ❌ لا. صلاحيات فقط (لا حذف بيانات). عكسي عبر إعادة منح SELECT الجدول.
-- أثر مقصود: أي select يذكر عمودًا ماليًا أو `select *` من authenticated ⇒ permission denied.
-- ملاحظة صيانة: أي عمود جديد يُضاف مستقبلًا لهذه الجداول يحتاج grant صريح لـ authenticated.
-- ----------------------------------------------------------------------------

-- assets — استبعاد: purchase_cost, salvage_rate
revoke select on public.assets from authenticated;
grant select (
  id, asset_tag, qr_token, category_id, model_id, serial_number, name, status,
  condition_grade, supplier_id, location_id, department_id, assigned_to_employee_id,
  purchase_date, currency, warranty_end, lifespan_months, notes, special_attributes,
  is_active, created_by, created_at, updated_at, company_id, rfid_tag, pool_id
) on public.assets to authenticated;

-- consumables — استبعاد: unit_cost
revoke select on public.consumables from authenticated;
grant select (
  id, category_id, name, sku, brand, unit, quantity_on_hand, reorder_level,
  location_id, supplier_id, currency, notes, is_active, created_at, updated_at,
  company_id, rfid_tag
) on public.consumables to authenticated;

-- consumable_transactions — استبعاد: unit_cost, total_cost
revoke select on public.consumable_transactions from authenticated;
grant select (
  id, consumable_id, txn_type, quantity, balance_after, related_employee_id,
  related_asset_id, reason, performed_by, created_at, supplier_id, invoice_number,
  invoice_date, previous_quantity, department_id, location_id
) on public.consumable_transactions to authenticated;

-- maintenance_records — استبعاد: cost
revoke select on public.maintenance_records from authenticated;
grant select (
  id, asset_id, type, status, reported_at, started_at, completed_at, reported_by,
  technician_id, vendor_supplier_id, problem_description, action_taken, currency,
  outcome, downtime_hours, next_due_date, created_at, updated_at, priority,
  problem_type, workflow_stage, invoice_number, reported_by_employee_id, final_summary,
  vendor_name, vendor_phone, vendor_location, vendor_map_link, invoice_date,
  handoff_notes, receiver_name
) on public.maintenance_records to authenticated;

-- request_items — استبعاد: unit_price, total_price
revoke select on public.request_items from authenticated;
grant select (
  id, request_id, item_kind, asset_id, consumable_id, quantity, approved_quantity,
  delivered_quantity, returned_quantity, notes, created_at
) on public.request_items to authenticated;

-- depreciation_rules — استبعاد: annual_rate, salvage_rate ; وإزالة تسرّب anon
revoke select on public.depreciation_rules from authenticated;
revoke select on public.depreciation_rules from anon;
grant select (
  id, category_id, asset_type, method, is_active, created_at, updated_at
) on public.depreciation_rules to authenticated;

-- ============================================================================
-- Rollback: أعِد منح SELECT الجدول الكامل (يُعيد الوضع قبل HIGH-1b):
--   grant select on public.assets to authenticated;
--   grant select on public.consumables to authenticated;
--   grant select on public.consumable_transactions to authenticated;
--   grant select on public.maintenance_records to authenticated;
--   grant select on public.request_items to authenticated;
--   grant select on public.depreciation_rules to authenticated;
--   -- (اختياري) grant select on public.depreciation_rules to anon;  -- غير موصى به
-- ============================================================================
