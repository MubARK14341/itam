-- M5 (RC1 hygiene, 2026-07-07): enable RLS on purchase_request_sequences.
-- Its sibling counter tables (request_sequences, tag_sequences) already have RLS
-- enabled; this one did not, which the Supabase advisor flags as "critical". The
-- table has ZERO anon/authenticated table grants and is only ever touched by the
-- SECURITY DEFINER purchase-request RPCs (definer bypasses RLS), so enabling RLS
-- with NO policy is a safe deny-all for client roles and silences the advisor.
-- No behavioural change. Matches request_sequences' RLS-enabled-no-policy posture.
alter table public.purchase_request_sequences enable row level security;
