-- Purpose: keep the location inventory maintenance count within its selected
-- location and return expected stocktake identifier failures as logical errors.
-- Risk: no row rewrite, RLS, role, grant, financial or custody changes. The scan
-- transaction retains its existing authorization, locking, counters and events.
-- Rollback: restore the two reviewed function definitions from
-- 20260816162807_stocktake_inventory_report_status_counts.sql and the final
-- stocktake_scan definition in 20260809170000_production_reconciliation_non_email.sql.

begin;

-- Fail closed if a different implementation is installed. Only the missing
-- location predicate changes; global delivered/dataIssues metrics stay intact.
do $migration$
declare
  v_definition text := pg_get_functiondef('public.stocktake_system_inventory_report(uuid)'::regprocedure);
  v_anchor text := '''inMaintenance'', count(*) filter (where i.status = ''in_maintenance'')';
  v_replacement text := '''inMaintenance'', count(*) filter (where i.location_id = p_location_id and i.status = ''in_maintenance'')';
begin
  if position(v_replacement in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0 then
      raise exception 'stocktake inventory report differs from the reviewed definition';
    end if;
    execute replace(v_definition, v_anchor, v_replacement);
  end if;
end;
$migration$;

-- Unknown and ambiguous identifiers are user-correctable lookup outcomes.
-- Preserve every other error and the original successful transaction body.
do $migration$
declare
  v_definition text := pg_get_functiondef('public.stocktake_scan(uuid,text,uuid)'::regprocedure);
  v_anchor text := 'if v_count=0 then raise exception ''asset_not_found'' using errcode=''P0002''; elsif v_count>1 then raise exception ''identifier_ambiguous'' using errcode=''21000''; end if;';
  v_replacement text := 'if v_count=0 then return jsonb_build_object(''ok'',false,''error'',''asset_not_found''); elsif v_count>1 then return jsonb_build_object(''ok'',false,''error'',''identifier_ambiguous''); end if;';
begin
  if position(v_replacement in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0 then
      raise exception 'stocktake scan differs from the reviewed definition';
    end if;
    execute replace(v_definition, v_anchor, v_replacement);
  end if;
end;
$migration$;

-- Function references remain schema-qualified; pin the project search path.
alter function public.stocktake_scan(uuid,text,uuid) set search_path to 'public';

commit;
