-- EDIT 5 — Staging-only scheduler for the existing secure automation worker.
-- Purpose: hourly scanner (which produces 09:00 Asia/Riyadh digests) and a
--          five-minute dispatcher fallback; no secret values are stored here.
-- Preconditions: Staging Vault names SUPABASE_URL and ITAM_AUTOMATION_SECRET.
-- Risk: additive pg_cron jobs only. Rollback: cron.unschedule by the two names.

begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $block$
begin
  if not exists (select 1 from pg_extension where extname='supabase_vault') then raise exception 'edit5_missing_supabase_vault'; end if;
  if not exists (select 1 from vault.decrypted_secrets where name='SUPABASE_URL') then raise exception 'edit5_missing_vault_supabase_url'; end if;
  if not exists (select 1 from vault.decrypted_secrets where name='ITAM_AUTOMATION_SECRET') then raise exception 'edit5_missing_vault_automation_secret'; end if;
end $block$;
select cron.unschedule(jobid) from cron.job where jobname in ('itam-edit5-email-scan','itam-edit5-email-dispatch');
select cron.schedule('itam-edit5-email-scan','0 * * * *',$job$
  select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name='SUPABASE_URL' limit 1) || '/functions/v1/itam-automation-worker/scan', headers := jsonb_build_object('Content-Type','application/json','x-itam-automation-secret',(select decrypted_secret from vault.decrypted_secrets where name='ITAM_AUTOMATION_SECRET' limit 1)), body := '{}'::jsonb, timeout_milliseconds := 140000);
$job$);
select cron.schedule('itam-edit5-email-dispatch','*/5 * * * *',$job$
  select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name='SUPABASE_URL' limit 1) || '/functions/v1/itam-automation-worker/send', headers := jsonb_build_object('Content-Type','application/json','x-itam-automation-secret',(select decrypted_secret from vault.decrypted_secrets where name='ITAM_AUTOMATION_SECRET' limit 1)), body := '{}'::jsonb, timeout_milliseconds := 140000);
$job$);
commit;
