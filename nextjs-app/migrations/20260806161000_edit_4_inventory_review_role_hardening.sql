-- EDIT 4 follow-up: only Managers may close a submitted physical inventory.
begin;
create or replace function public.stocktake_review(p_stocktake_id uuid,p_decision text,p_reason text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_existing jsonb; v_take public.stocktakes%rowtype; v_result jsonb;
begin
  if not public._stocktake_can_review() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_operation_id is null or p_decision <> 'rejected' or coalesce(length(btrim(p_reason)),0)<3 then raise exception 'invalid_review' using errcode='22023'; end if;
  v_existing:=public._stocktake_existing_operation(p_operation_id,'review'); if v_existing is not null then return v_existing; end if;
  select * into v_take from public.stocktakes where id=p_stocktake_id for update; if not found or v_take.status<>'in_progress' or v_take.review_state<>'submitted' then raise exception 'stocktake_not_reviewable' using errcode='22023'; end if;
  update public.stocktakes set review_state='rejected',reviewed_at=now(),reviewed_by=auth.uid() where id=p_stocktake_id;
  perform public._stocktake_event(p_stocktake_id,'reviewed',p_operation_id,null,jsonb_build_object('review_state',v_take.review_state),jsonb_build_object('review_state','rejected'),p_reason);
  v_result:=jsonb_build_object('ok',true,'id',p_stocktake_id,'decision','rejected'); return public._stocktake_record_operation(p_operation_id,p_stocktake_id,'review',v_result);
end $function$;
revoke all on function public.stocktake_review(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.stocktake_review(uuid,text,text,uuid) to authenticated;
commit;
