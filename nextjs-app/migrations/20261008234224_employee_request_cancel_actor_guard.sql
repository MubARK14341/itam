-- Purpose: allow the existing employee-owned, unprepared cancellation path to
-- write valid staff actor evidence and fail closed for a missing employee role.
-- Risk: narrow function-body changes only. Manager denial, ownership, state,
-- preparation, reservation release, RLS and event constraints stay intact.
-- Rollback: any replacement must retain an equivalent approved/active employee
-- gate and the valid staff actor kind with the real actor identity. Do not restore
-- the nullable role guard or invalid requester actor from the prior definition.
-- No rows or request_events actor constraints are rewritten.

begin;

do $migration$
declare
  v_definition text := pg_get_functiondef('public.request_cancel(uuid)'::regprocedure);
  v_role_anchor text := 'if public.app_user_role() <> ''employee'' then return json_build_object(''ok'',false,''error'',''not_authorized''); end if;';
  v_role_replacement text := 'if public.is_approved() is distinct from true or public.app_user_role() is distinct from ''employee'' then return json_build_object(''ok'',false,''error'',''not_authorized''); end if;';
  v_actor_anchor text := 'perform public._request_add_event(p_id,''requester_cancelled'',''requester'',null,jsonb_build_object(''released'',v_released));';
  v_actor_replacement text := 'perform public._request_add_event(p_id,''requester_cancelled'',''staff'',null,jsonb_build_object(''released'',v_released));';
begin
  if position(v_role_replacement in v_definition) = 0 then
    if position(v_role_anchor in v_definition) = 0 then
      raise exception 'request_cancel role guard differs from the reviewed definition';
    end if;
    v_definition := replace(v_definition, v_role_anchor, v_role_replacement);
  end if;
  if position(v_actor_replacement in v_definition) = 0 then
    if position(v_actor_anchor in v_definition) = 0 then
      raise exception 'request_cancel actor event differs from the reviewed definition';
    end if;
    v_definition := replace(v_definition, v_actor_anchor, v_actor_replacement);
  end if;
  execute v_definition;
end;
$migration$;

commit;
