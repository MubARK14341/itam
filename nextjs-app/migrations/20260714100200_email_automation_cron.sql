-- ADR-004 / exactly three Cron Jobs.
-- IMPORTANT: local deployment artifact only. Do not execute before REMOTE TEST-MODE APPROVAL.
-- Preconditions: pg_cron, pg_net, Vault, SUPABASE_URL named Vault secret,
-- and ITAM_AUTOMATION_SECRET named Vault secret.
-- No raw secret value is stored in cron.job.

begin;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

do $preflight$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception 'remote_preflight_missing_vault';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'SUPABASE_URL') then
    raise exception 'remote_preflight_missing_vault_supabase_url';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'ITAM_AUTOMATION_SECRET') then
    raise exception 'remote_preflight_missing_vault_automation_secret';
  end if;
end;
$preflight$;

select cron.schedule(
  'itam-automation-scanner',
  '0 * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'SUPABASE_URL'
        limit 1
      ) || '/functions/v1/itam-automation-worker/scan',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-itam-automation-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'ITAM_AUTOMATION_SECRET'
          limit 1
        )
      ),
      body := jsonb_build_object('mode', 'scan'),
      timeout_milliseconds := 140000
    );
  $job$
);

select cron.schedule(
  'itam-automation-sender',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'SUPABASE_URL'
        limit 1
      ) || '/functions/v1/itam-automation-worker/send',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-itam-automation-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'ITAM_AUTOMATION_SECRET'
          limit 1
        )
      ),
      body := jsonb_build_object('mode', 'send'),
      timeout_milliseconds := 140000
    );
  $job$
);

select cron.schedule(
  'itam-automation-health',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'SUPABASE_URL'
        limit 1
      ) || '/functions/v1/itam-automation-worker/health',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-itam-automation-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'ITAM_AUTOMATION_SECRET'
          limit 1
        )
      ),
      body := jsonb_build_object('mode', 'health'),
      timeout_milliseconds := 140000
    );
  $job$
);

commit;
