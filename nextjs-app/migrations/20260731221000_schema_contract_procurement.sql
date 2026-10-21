begin;

insert into public.app_schema_versions (
  contract_key, compatibility_version, required_signatures, applied_at
)
select
  contract_key,
  2026073110,
  required_signatures || array[
    'public.procurement_record_external_document(uuid,uuid,text,text,text,text,uuid,jsonb,uuid)',
    'public.purchase_request_procurement_state(uuid)'
  ]::text[],
  now()
from public.app_schema_versions where contract_key = 'itam_app'
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;
