-- Production scheduler for the verified Brevo delivery worker. The hourly
-- scanner evaluates the 09:00 Asia/Riyadh digest rule in application code;
-- the dispatcher and health probe use the same authenticated worker path.
-- No raw credential is stored in pg_cron.

begin;

do $block$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'production_email_missing_pg_cron';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'production_email_missing_pg_net';
  end if;
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception 'production_email_missing_supabase_vault';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'SUPABASE_URL') then
    raise exception 'production_email_missing_vault_supabase_url';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'ITAM_AUTOMATION_SECRET') then
    raise exception 'production_email_missing_vault_automation_secret';
  end if;
end;
$block$;

select cron.unschedule(jobid)
from cron.job
where jobname in ('itam-production-email-scan', 'itam-production-email-dispatch', 'itam-production-email-health');

select cron.schedule('itam-production-email-scan', '0 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL' limit 1) || '/functions/v1/itam-automation-worker/scan',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-itam-automation-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ITAM_AUTOMATION_SECRET' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000
  );
$job$);

select cron.schedule('itam-production-email-dispatch', '*/5 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL' limit 1) || '/functions/v1/itam-automation-worker/send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-itam-automation-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ITAM_AUTOMATION_SECRET' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000
  );
$job$);

select cron.schedule('itam-production-email-health', '*/15 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL' limit 1) || '/functions/v1/itam-automation-worker/health',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-itam-automation-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ITAM_AUTOMATION_SECRET' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000
  );
$job$);

commit;
