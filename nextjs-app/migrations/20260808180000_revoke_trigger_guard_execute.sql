-- Purpose: remove public RPC execution from an internal request-status trigger guard.
-- Risk: the guard is invoked only by its table trigger; no application caller should execute it directly.
-- Rollback: grant execute only to an explicitly justified role after reviewing the trigger contract.

begin;

revoke all on function public.request_exact_assets_ready_guard() from public, anon, authenticated;

commit;
