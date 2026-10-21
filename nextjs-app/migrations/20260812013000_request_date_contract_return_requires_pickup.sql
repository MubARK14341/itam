-- Purpose: require a delivery date whenever an expected return date is supplied.
-- Risk: new or date-edited requests with a return date but no delivery date are rejected.
-- Rollback: replace public.request_dates_application_guard() with the preceding migration definition.

begin;

create or replace function public.request_dates_application_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_max date := ((now() at time zone 'Asia/Riyadh')::date + interval '10 years')::date;
begin
  if new.pickup_date is not null and (new.pickup_date < v_today or new.pickup_date > v_max) then
    raise exception 'request_date_out_of_range' using errcode = '22007';
  end if;
  if new.return_date is not null and (new.return_date < v_today or new.return_date > v_max) then
    raise exception 'request_date_out_of_range' using errcode = '22007';
  end if;
  if new.return_date is not null and new.pickup_date is null then
    raise exception 'return_date_invalid' using errcode = '22007';
  end if;
  if new.pickup_date is not null and new.return_date is not null and new.return_date <= new.pickup_date then
    raise exception 'return_date_invalid' using errcode = '22007';
  end if;
  return new;
end;
$function$;

commit;
