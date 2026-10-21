-- Attribute each provider attempt so inbound delivery webhooks can match the
-- durable outbox row. Existing callers remain compatible through the default.
-- Apply to Staging before Brevo validation and to Production only during the
-- separately approved email activation window.

begin;

create or replace function public.automation_complete_attempt(
  p_outbox_id uuid,
  p_lock_token uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_error text default null,
  p_next_attempt_at timestamptz default null,
  p_provider text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.automation_outbox;
  v_status text;
begin
  if p_provider is not null and p_provider not in ('resend', 'sendgrid', 'brevo') then
    raise exception 'invalid_email_provider' using errcode = '22023';
  end if;

  select * into v_row
  from public.automation_outbox
  where id = p_outbox_id and status = 'processing' and lock_token = p_lock_token
  for update;
  if not found then
    raise exception 'automation_lock_mismatch' using errcode = '55000';
  end if;

  if p_outcome = 'sent' then
    v_status := 'sent';
  elsif p_outcome = 'retry' and v_row.attempt_count < v_row.max_attempts then
    v_status := 'pending';
  elsif p_outcome = 'delivery_unknown' then
    v_status := 'delivery_unknown';
  elsif p_outcome = 'failed' or p_outcome = 'retry' then
    v_status := 'failed';
  elsif p_outcome = 'release' then
    v_status := 'pending';
  else
    raise exception 'invalid_automation_outcome' using errcode = '22023';
  end if;

  update public.automation_outbox
  set status = v_status,
      provider = coalesce(nullif(p_provider, ''), provider),
      provider_message_id = coalesce(nullif(p_provider_message_id, ''), provider_message_id),
      error_code = nullif(left(coalesce(p_error_code, ''), 100), ''),
      sanitized_error = nullif(public.automation_sanitize_error(p_error), ''),
      next_attempt_at = case
        when v_status = 'pending' then greatest(coalesce(p_next_attempt_at, now()), now())
        else next_attempt_at
      end,
      attempt_count = case when p_outcome = 'release' then greatest(attempt_count - 1, 0) else attempt_count end,
      sent_at = case when v_status = 'sent' then now() else sent_at end,
      locked_at = null,
      lock_token = null
  where id = p_outbox_id;
  return v_status;
end;
$function$;

revoke all on function public.automation_complete_attempt(uuid,uuid,text,text,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.automation_complete_attempt(uuid,uuid,text,text,text,text,timestamptz,text) to service_role;

commit;
