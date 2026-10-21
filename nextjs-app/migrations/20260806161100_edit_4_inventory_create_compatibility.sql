begin;
create function public.stocktake_create(p_title text,p_location_id uuid,p_operation_id uuid,p_correction_of uuid)
returns jsonb language sql security definer set search_path = '' as $function$
  select public.stocktake_create(p_title,p_location_id,p_operation_id,p_correction_of,'full',null);
$function$;
revoke all on function public.stocktake_create(text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.stocktake_create(text,uuid,uuid,uuid) to authenticated;
commit;
