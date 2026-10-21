begin;

insert into public.app_schema_versions (
  contract_key, compatibility_version, required_signatures, applied_at
)
select
  contract_key,
  2026073109,
  required_signatures || array[
    'public.request_create_amendment(uuid,jsonb,text,uuid)',
    'public.request_review_amendment(uuid,text,text,uuid)',
    'public.request_execute_idempotent(uuid,text,uuid,jsonb)',
    'public.request_create_idempotent(uuid,jsonb)',
    'public.request_operation_result_lookup(uuid)',
    'public.maintenance_update_safe(uuid,jsonb,uuid)',
    'public.maintenance_add_time_entry(uuid,timestamp with time zone,timestamp with time zone,text,uuid)',
    'public.maintenance_plan_part(uuid,uuid,text,numeric,uuid)',
    'public.maintenance_confirm_handoff(uuid,uuid)',
    'public.maintenance_escalate_overdue()'
  ]::text[],
  now()
from public.app_schema_versions where contract_key = 'itam_app'
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;
