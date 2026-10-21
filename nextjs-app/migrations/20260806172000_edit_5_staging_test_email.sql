-- EDIT 5 — Manager-initiated Staging test email.
-- Purpose: provide the required Manager-only QA action without exposing a
--          provider secret or placing the configured test recipient in SQL.
-- Risk: additive SECURITY DEFINER RPC only; it inserts one durable outbox row.
-- Rollback: revoke execute on the RPC. Existing immutable audit evidence remains.

begin;

create or replace function public.automation_email_enqueue_staging_test()
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user public.app_users%rowtype;
  v_notification_id uuid;
begin
  if not public.automation_edit5_is_manager() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Test-mode is a server-side guard. The worker redirects this intended
  -- recipient to ITAM_TEST_RECIPIENT only after it has claimed the row.
  if not exists (
    select 1 from public.email_automation_settings
    where id = 'main' and test_mode and email_enabled
  ) then
    raise exception 'staging_test_mode_required' using errcode = '22023';
  end if;

  select * into v_user
  from public.app_users
  where id = auth.uid() and is_active and approval_status = 'approved';
  if not found or nullif(btrim(v_user.email), '') is null then
    raise exception 'test_email_recipient_unavailable' using errcode = 'P0002';
  end if;

  v_notification_id := public.automation_edit5_enqueue(
    'staging-test/' || extensions.gen_random_uuid()::text,
    'staging_test_email',
    v_user.id,
    v_user.email,
    'manager',
    'email_automation',
    null,
    'email_staging_test',
    jsonb_build_object(
      'recipient_name', coalesce(v_user.full_name, v_user.email),
      'summary', 'Manager-initiated Staging Test Mode verification.',
      'link', '/settings'
    ),
    30
  );

  perform public.automation_edit5_audit(
    'staging_test_email_enqueued',
    'success',
    jsonb_build_object('notification_id', v_notification_id)
  );
  return v_notification_id;
end
$function$;

revoke all on function public.automation_email_enqueue_staging_test() from public, anon, authenticated;
grant execute on function public.automation_email_enqueue_staging_test() to authenticated;

commit;
