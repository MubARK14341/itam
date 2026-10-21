-- Purpose: advance the application/schema compatibility ledger after all P0
-- contracts are present, so an older or partially migrated database fails closed.
-- Risk: low/additive. Existing clients receive the same JSON shape with a newer
-- version and a stricter required-signature set.
-- Rollback: forward-fix only. Do not lower the compatibility version while this
-- application build may be deployed.

begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073102,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;
