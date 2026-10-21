-- Purpose: Restore the non-financial archived_at projection required by the
-- RLS-authorized asset-availability queries introduced with exact allocation.
-- Risk: authenticated can read only this operational archive marker; existing
-- RLS policies remain the row-level boundary and financial columns stay denied.
-- Rollback: REVOKE SELECT (archived_at) ON TABLE public.assets FROM authenticated;

begin;

grant select (archived_at) on table public.assets to authenticated;

commit;
