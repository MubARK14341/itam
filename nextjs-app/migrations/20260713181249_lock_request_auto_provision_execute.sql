-- Purpose: prevent direct API execution of the internal auto-provision helper.
-- Risk: low; the authorized SECURITY DEFINER wrapper remains executable and
--       invokes this helper as the postgres function owner.
-- Rollback:
--   grant execute on function public._request_auto_provision(uuid)
--   to anon, authenticated;

revoke execute on function public._request_auto_provision(uuid)
from public, anon, authenticated;
