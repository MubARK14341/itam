-- Keep discrepancy review authoritative when two managers have the same item open.
-- Replays with the same operation ID remain idempotent; distinct stale decisions fail.
create or replace function public.stocktake_decide_item(
  p_stocktake_id uuid,
  p_item_id uuid,
  p_decision text,
  p_note text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_item public.stocktake_items%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_review() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null
    or p_decision not in ('approve_correction', 'keep_current', 'request_recheck')
    or coalesce(length(btrim(p_note)), 0) < 3
    or length(p_note) > 1000 then
    raise exception 'invalid_discrepancy_decision' using errcode = '22023';
  end if;

  v_existing := public._stocktake_existing_operation(p_operation_id, 'decide_item');
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_take
  from public.stocktakes
  where id = p_stocktake_id
  for update;
  if not found or v_take.status <> 'in_progress' or v_take.review_state <> 'submitted' then
    raise exception 'stocktake_not_reviewable' using errcode = '22023';
  end if;

  select * into v_item
  from public.stocktake_items
  where id = p_item_id and stocktake_id = p_stocktake_id
  for update;
  if not found or v_item.observation_status not in ('missing', 'unexpected', 'wrong_location') then
    raise exception 'variance_item_required' using errcode = '22023';
  end if;
  if v_item.review_decision is not null then
    raise exception 'discrepancy_already_decided' using errcode = '22023';
  end if;

  update public.stocktake_items
  set review_decision = p_decision,
      review_note = btrim(p_note),
      decided_by = auth.uid(),
      decided_at = now()
  where id = p_item_id;

  if p_decision = 'request_recheck' then
    update public.stocktake_items
    set scanned = false,
        found = false,
        scanned_at = null,
        scanned_by = null,
        observed_location_id = null,
        observed_identifier = null,
        observation_status = null,
        count_round = count_round + 1,
        recount_required = true
    where id = p_item_id;
    update public.stocktakes set review_state = 'recount' where id = p_stocktake_id;
  end if;

  perform public._stocktake_event(
    p_stocktake_id,
    'discrepancy_decided',
    p_operation_id,
    p_item_id,
    null,
    jsonb_build_object('decision', p_decision),
    p_note
  );
  v_result := jsonb_build_object('ok', true, 'item_id', p_item_id, 'decision', p_decision);
  return public._stocktake_record_operation(p_operation_id, p_stocktake_id, 'decide_item', v_result);
end;
$function$;
