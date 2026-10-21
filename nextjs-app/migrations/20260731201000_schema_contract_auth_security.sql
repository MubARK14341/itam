begin;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
select
  contract_key,
  2026073108,
  required_signatures || array[
    'public.auth_security_state()',
    'public.auth_recent_reauthentication(integer)',
    'public.record_auth_security_event(text,jsonb)'
  ]::text[],
  now()
from public.app_schema_versions
where contract_key = 'itam_app'
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

commit;
