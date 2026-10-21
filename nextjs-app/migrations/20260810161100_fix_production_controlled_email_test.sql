-- Correct the exact UUID and priority argument types used by the controlled
-- Production activation test helper. The prior definition was never able to
-- enqueue a message, so this remains a fail-closed repair.

begin;

create or replace function public.automation_enqueue_production_email_test(p_recipient_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_recipient_email text := lower(nullif(btrim(p_recipient_email), ''));
  v_outbox_id uuid;
  v_key text;
begin
  if not exists (
    select 1 from public.email_automation_settings
    where id = 'main' and email_go_live_at is not null
  ) then
    raise exception 'email_go_live_cutoff_required' using errcode = '22023';
  end if;
  if v_recipient_email is null
     or v_recipient_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_test_recipient' using errcode = '22023';
  end if;
  if exists (select 1 from public.email_suppressions where normalized_email = v_recipient_email) then
    raise exception 'test_recipient_suppressed' using errcode = '22023';
  end if;

  v_key := 'production-email-activation/' || gen_random_uuid()::text;
  v_outbox_id := public.automation_enqueue(
    v_key,
    v_key,
    'production_email_activation_test',
    'system_test',
    null::uuid,
    v_recipient_email,
    'email_automation',
    null::uuid,
    'email_production_test',
    'en',
    jsonb_build_object(
      'summary', 'Controlled Production email activation verification.',
      'link', '/settings'
    ),
    100::smallint,
    now()
  );
  if v_outbox_id is null then
    raise exception 'production_test_enqueue_failed' using errcode = 'P0001';
  end if;

  perform public.automation_edit5_audit(
    'production_email_activation_test_enqueued',
    'success',
    jsonb_build_object('notification_id', v_outbox_id, 'created_after_cutoff', true)
  );
  return v_outbox_id;
end;
$function$;

revoke all on function public.automation_enqueue_production_email_test(text) from public, anon, authenticated;
grant execute on function public.automation_enqueue_production_email_test(text) to service_role;

commit;
