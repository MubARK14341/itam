-- Purpose: prevent this application build from opening the Stocktake surface
-- against a database that lacks the complete RPC workflow.
-- Risk: low/additive compatibility-ledger update only.
-- Rollback: forward-fix only; do not lower the version while this app is deployed.

begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073103,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()',
    'public.complete_attachment_scan(text,text,text,text,text,text)',
    'public.custody_reconciliation_list()',
    'public.maintenance_financial_truth(uuid[])',
    'public.financial_data_quality_summary()',
    'public.stocktake_create(text,uuid,uuid,uuid)',
    'public.stocktake_scan(uuid,text,uuid)',
    'public.stocktake_submit(uuid,uuid)',
    'public.stocktake_review(uuid,text,text,uuid)',
    'public.stocktake_apply_adjustments(uuid,uuid)'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;
