-- Purpose: expose a minimal, non-sensitive schema compatibility contract so the
-- application and deployment checks fail before users reach a mutation button.
-- Risk: low/additive. One deny-by-default table and one explicitly granted RPC.
-- Rollback: forward-fix only. A later migration may revoke EXECUTE or advance the
-- version; do not drop the table/function while an older app may call it.

begin;

create table if not exists public.app_schema_versions (
  contract_key text primary key,
  compatibility_version bigint not null check (compatibility_version > 0),
  required_signatures text[] not null default '{}'::text[],
  applied_at timestamptz not null default now()
);

alter table public.app_schema_versions enable row level security;
revoke all on table public.app_schema_versions from public, anon, authenticated;

insert into public.app_schema_versions (
  contract_key,
  compatibility_version,
  required_signatures,
  applied_at
)
values (
  'itam_app',
  2026073101,
  array[
    'public.asset_create_atomic(jsonb)',
    'public.consumable_create_with_opening_stock(jsonb)',
    'public.maintenance_create_atomic(jsonb)',
    'public.request_create_staff(text,uuid,text,text,text,text,text,date,date,text,text,jsonb)',
    'public.dashboard_operational_summary()'
  ]::text[],
  now()
)
on conflict (contract_key) do update
set compatibility_version = excluded.compatibility_version,
    required_signatures = excluded.required_signatures,
    applied_at = excluded.applied_at;

create or replace function public.app_schema_compatibility()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_version bigint;
  v_required text[];
  v_missing text[];
begin
  select compatibility_version, required_signatures
    into v_version, v_required
  from public.app_schema_versions
  where contract_key = 'itam_app';

  if v_version is null then
    return pg_catalog.jsonb_build_object(
      'contract', 'itam_app',
      'version', 0,
      'compatible', false,
      'missing', pg_catalog.to_jsonb(array['schema_version_ledger']::text[])
    );
  end if;

  select coalesce(pg_catalog.array_agg(signature order by signature), '{}'::text[])
    into v_missing
  from pg_catalog.unnest(v_required) as required(signature)
  where pg_catalog.to_regprocedure(signature) is null;

  return pg_catalog.jsonb_build_object(
    'contract', 'itam_app',
    'version', v_version,
    'compatible', pg_catalog.cardinality(v_missing) = 0,
    'missing', pg_catalog.to_jsonb(v_missing)
  );
end;
$function$;

comment on table public.app_schema_versions is
  'Application/schema compatibility ledger. Direct client access is denied.';
comment on function public.app_schema_compatibility() is
  'Returns only the current compatibility version and missing required RPC signatures.';

revoke all on function public.app_schema_compatibility() from public, anon, authenticated;
grant execute on function public.app_schema_compatibility() to anon, authenticated;

commit;
