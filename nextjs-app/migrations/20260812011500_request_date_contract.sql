-- Purpose: enforce the application-supported request delivery/return date range.
-- Risk: new or date-edited requests outside today through today+10 years are rejected.
-- Rollback: drop trigger request_dates_application_guard on public.requests; drop function public.request_dates_application_guard().

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
  if new.pickup_date is not null and new.return_date is not null and new.return_date <= new.pickup_date then
    raise exception 'return_date_invalid' using errcode = '22007';
  end if;
  return new;
end;
$function$;

drop trigger if exists request_dates_application_guard on public.requests;
create trigger request_dates_application_guard
before insert or update of pickup_date, return_date on public.requests
for each row execute function public.request_dates_application_guard();

commit;
