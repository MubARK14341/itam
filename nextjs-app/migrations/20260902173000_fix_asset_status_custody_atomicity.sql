begin;

-- The three-state status simplification retained the custody precondition but
-- accidentally dropped the active-assignment closure from asset_change_status.
-- Restore the original atomic invariant without changing roles, grants, or RLS.
create or replace function public.asset_change_status(
  p_asset_id uuid,
  p_to_status public.asset_status,
  p_note text default null
) returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_from public.asset_status;
begin
  if not public.current_user_has_capability('asset.update') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_to_status not in ('available', 'in_maintenance') then
    return json_build_object('ok', false, 'error', 'invalid_primary_status');
  end if;

  select status into v_from
  from public.assets
  where id = p_asset_id
  for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;
  if not public.custody_asset_is_consistent(p_asset_id)
     or not public.asset_status_allowed(v_from, p_to_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.assets
  set status = p_to_status,
      assigned_to_employee_id = null
  where id = p_asset_id;

  update public.asset_assignments
  set status = 'returned',
      returned_at = statement_timestamp()
  where asset_id = p_asset_id
    and status = 'active';

  insert into public.asset_movements (
    asset_id, movement_type, from_status, to_status, performed_by, note
  ) values (
    p_asset_id, 'status_change', v_from, p_to_status, auth.uid(),
    coalesce(nullif(p_note, ''), 'تغيير حالة')
  );
  return json_build_object('ok', true);
end
$function$;

revoke all on function public.asset_change_status(uuid, public.asset_status, text)
from public, anon;
grant execute on function public.asset_change_status(uuid, public.asset_status, text)
to authenticated, service_role;

-- Delivery with proof is the only authenticated delivery path. A later
-- reconciliation replay restored this legacy function's grant, bypassing the
-- evidence and segregation-of-duties boundary.
revoke all on function public.request_deliver(uuid)
from public, anon, authenticated;
grant execute on function public.request_deliver(uuid)
to service_role;

commit;
