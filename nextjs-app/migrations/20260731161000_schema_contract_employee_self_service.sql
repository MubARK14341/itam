-- P1-04 compatibility gate: employee UI must never open against a database
-- that still has the legacy broad employee-request function.
begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073104,
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
    'public.stocktake_apply_adjustments(uuid,uuid)',
    'public.employee_my_requests()',
    'public.employee_my_request(uuid)',
    'public.employee_my_assets()',
    'public.employee_reply_request_clarification(uuid,text,uuid)',
    'public.employee_report_asset_issue(uuid,text,uuid)',
    'public.employee_request_asset_return(uuid,text,uuid)'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;
