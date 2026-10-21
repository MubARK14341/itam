-- Keep middleware/login routing aligned with the database authorization gate.
-- An inactive approved account must never be described to the application as
-- an approved, role-bearing staff session.

begin;

create or replace function public.auth_security_state()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid;
  v_role text;
  v_status text;
  v_active boolean := false;
  v_portal boolean := public.is_portal_user();
  v_policy public.auth_security_policy%rowtype;
  v_aal text := public._auth_current_aal();
begin
  select u.id, r.key, u.approval_status, u.is_active
  into v_user_id, v_role, v_status, v_active
  from public.app_users u
  left join public.roles r on r.id = u.role_id
  where u.id = auth.uid();

  select * into v_policy
  from public.auth_security_policy
  where singleton;

  return jsonb_build_object(
    'authenticated', auth.uid() is not null,
    'subject_kind', case when v_user_id is not null then 'staff'
                         when v_portal then 'portal'
                         else 'unknown' end,
    'approval_status', case
      when v_user_id is not null and not coalesce(v_active, false) then 'rejected'
      else coalesce(v_status, case when v_portal then 'approved' else 'pending' end)
    end,
    'is_active', case
      when v_user_id is not null then coalesce(v_active, false)
      when v_portal then true
      else false
    end,
    'role', case
      when coalesce(v_active, false) and v_status = 'approved' then v_role
      else null
    end,
    'aal', v_aal,
    'admin_mfa_required', v_policy.admin_mfa_required,
    'needs_mfa', coalesce(v_active, false)
      and v_status = 'approved'
      and v_policy.admin_mfa_required
      and coalesce(v_role, '') in ('admin', 'it_manager')
      and v_aal <> 'aal2',
    'sensitive_reauth_required', v_policy.sensitive_reauth_required,
    'reauth_recent', public.auth_recent_reauthentication(v_policy.reauth_max_age_seconds),
    'reauth_max_age_seconds', v_policy.reauth_max_age_seconds,
    'session_idle_seconds', v_policy.session_idle_seconds,
    'session_absolute_seconds', v_policy.session_absolute_seconds
  );
end
$function$;

revoke all on function public.auth_security_state() from public, anon;
grant execute on function public.auth_security_state() to authenticated, service_role;

commit;
