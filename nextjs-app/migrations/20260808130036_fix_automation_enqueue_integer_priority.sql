-- Purpose: restore Staging Auth sign-up and notification triggers whose priority
-- literals are typed as integer while the internal helper accepts smallint.
-- Risk: low; adds a service-role-only compatibility overload and delegates to
-- the existing bounded smallint implementation.
-- Rollback: DROP FUNCTION public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,integer);

begin;

create or replace function public.automation_edit5_enqueue(
  p_event_key text,
  p_event_type text,
  p_recipient_id uuid,
  p_recipient_email text,
  p_recipient_role text,
  p_reference_type text,
  p_reference_id uuid,
  p_template_key text,
  p_payload jsonb,
  p_priority integer
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_priority not between -32768 and 32767 then
    raise exception 'invalid_automation_priority' using errcode = '22023';
  end if;

  return public.automation_edit5_enqueue(
    p_event_key,
    p_event_type,
    p_recipient_id,
    p_recipient_email,
    p_recipient_role,
    p_reference_type,
    p_reference_id,
    p_template_key,
    p_payload,
    p_priority::smallint
  );
end;
$function$;

revoke all on function public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,integer)
  from public, anon, authenticated;
grant execute on function public.automation_edit5_enqueue(text,text,uuid,text,text,text,uuid,text,jsonb,integer)
  to service_role;

commit;
