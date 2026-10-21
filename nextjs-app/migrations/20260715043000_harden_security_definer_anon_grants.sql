-- ADR-004 RC2: retain public entry points only where anonymous access is intentional.
-- Security review: all functions below are SECURITY DEFINER with a fixed search_path.
-- Their caller authorization is either auth.uid()-based or enforced by app_user_role(),
-- so anonymous EXECUTE is unnecessary and creates an avoidable attack surface.
--
-- Rollback (review before use; this deliberately restores the previous broad access):
--   GRANT EXECUTE ON FUNCTION public.app_user_role() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.approve_customer(uuid, boolean) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.request_auto_provision(p_id uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.request_create_employee_self(p_status text, p_project_name text, p_pickup_date date, p_return_date date, p_notes text, p_items jsonb) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.request_inspect_return(p_id uuid, p_lines jsonb) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.request_shortage_fulfill_available(p_id uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.user_label(uid uuid) TO PUBLIC;

BEGIN;

REVOKE ALL ON FUNCTION public.app_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_user_role() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.approve_customer(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_customer(uuid, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_auto_provision(p_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_auto_provision(p_id uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_create_employee_self(p_status text, p_project_name text, p_pickup_date date, p_return_date date, p_notes text, p_items jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_create_employee_self(p_status text, p_project_name text, p_pickup_date date, p_return_date date, p_notes text, p_items jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_inspect_return(p_id uuid, p_lines jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_inspect_return(p_id uuid, p_lines jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_shortage_fulfill_available(p_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_shortage_fulfill_available(p_id uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.user_label(uid uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_label(uid uuid) TO authenticated, service_role;

COMMIT;
