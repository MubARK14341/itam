-- Purpose: keep the request-date trigger implementation non-callable by application roles.
-- Risk: no application RPC calls this trigger function directly; the requests trigger continues to invoke it.
-- Rollback: grant execute on function public.request_dates_application_guard() only if a verified trigger runtime requires it.

begin;

revoke all on function public.request_dates_application_guard() from public;
revoke all on function public.request_dates_application_guard() from anon;
revoke all on function public.request_dates_application_guard() from authenticated;

commit;
