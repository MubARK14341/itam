-- Batch 7 — Production Readiness RC1: anon hardening (defense-in-depth)
--
-- Context: Supabase security advisor flagged 4 pure TRIGGER functions as
-- executable by `anon`, and two reference tables carried stray table
-- privileges for `anon`. None is remotely exploitable today (trigger EXECUTE
-- is irrelevant to trigger firing, and RLS already denies the anon table
-- access), but we remove the latent surface so `anon` holds nothing it does
-- not need. No behavioural change for authenticated users or triggers.

begin;

-- 1) Trigger functions must never be callable directly via the REST RPC API.
--    They fire as the table owner regardless of EXECUTE grants, so revoking
--    EXECUTE from public/anon/authenticated is safe and closes the surface.
revoke execute on function public.audit_trigger()               from public, anon, authenticated;
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
revoke execute on function public.maintenance_guard_financial() from public, anon, authenticated;
revoke execute on function public.requests_log_status_event()   from public, anon, authenticated;

-- 2) Remove stray table privileges held by `anon` on reference tables.
--    RLS already denies anon here (no anon policy exists); this drops the
--    dormant grant so anon has zero privileges on these tables.
revoke all on table public.depreciation_rules from anon;
revoke all on table public.supplier_categories from anon;

commit;
