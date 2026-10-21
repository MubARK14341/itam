-- Purpose: move financial depreciation-policy mutations behind validated,
-- self-authorizing RPCs and add redacted audit coverage.
-- Risk: callers must send the complete rule payload; direct Data API writes are
-- intentionally denied. Existing rows and read projections are unchanged.
-- Rollback: restore the former manager write policies/grants, remove the two
-- RPCs and audit trigger, and restore the previous audit sanitizer definition.

begin;

create or replace function public.depreciation_rule_save_atomic(
  p_rule_id uuid,
  p_input jsonb
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
  v_category_id uuid;
  v_company_id uuid;
  v_asset_type text;
  v_annual_rate numeric;
  v_salvage_rate numeric;
  v_useful_life numeric;
  v_alert_days integer;
  v_priority integer;
  v_is_active boolean;
  v_rate_pattern constant text := '^(0|[1-9][0-9]*)(\.[0-9]+)?$';
begin
  if not public.current_user_has_capability('settings.manage')
     or not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or p_input->>'method' is distinct from 'straight_line'
     or jsonb_typeof(p_input->'is_active') is distinct from 'boolean' then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  v_asset_type := nullif(btrim(p_input->>'asset_type'), '');
  if length(v_asset_type) > 100 then
    return json_build_object('ok', false, 'error', 'invalid_asset_type');
  end if;
  if coalesce(p_input->>'salvage_rate', '') !~ v_rate_pattern
     or coalesce(p_input->>'alert_before_days', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_input->>'priority', '') !~ '^(0|[1-9][0-9]*)$' then
    return json_build_object('ok', false, 'error', 'invalid_numeric_value');
  end if;
  if nullif(p_input->>'useful_life_years', '') is null
     and coalesce(p_input->>'annual_rate', '') !~ v_rate_pattern then
    return json_build_object('ok', false, 'error', 'annual_rate_or_life_required');
  end if;
  if nullif(p_input->>'useful_life_years', '') is not null
     and (p_input->>'useful_life_years') !~ v_rate_pattern then
    return json_build_object('ok', false, 'error', 'invalid_useful_life');
  end if;

  begin
    v_category_id := nullif(p_input->>'category_id', '')::uuid;
    v_company_id := nullif(p_input->>'company_id', '')::uuid;
    v_salvage_rate := (p_input->>'salvage_rate')::numeric;
    v_useful_life := nullif(p_input->>'useful_life_years', '')::numeric;
    v_alert_days := (p_input->>'alert_before_days')::integer;
    v_priority := (p_input->>'priority')::integer;
    v_is_active := (p_input->>'is_active')::boolean;
    if v_useful_life is null then
      v_annual_rate := (p_input->>'annual_rate')::numeric;
    else
      v_annual_rate := round((100 - v_salvage_rate) / v_useful_life, 6);
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range or division_by_zero then
    return json_build_object('ok', false, 'error', 'invalid_numeric_or_reference');
  end;

  if v_salvage_rate < 0 or v_salvage_rate > 100
     or v_annual_rate < 0 or v_annual_rate > 100
     or (v_useful_life is not null and (v_useful_life <= 0 or v_useful_life > 1000))
     or v_alert_days > 36500
     or v_priority > 1000000 then
    return json_build_object('ok', false, 'error', 'numeric_value_out_of_range');
  end if;

  if p_rule_id is null then
    insert into public.depreciation_rules (
      category_id, asset_type, method, annual_rate, salvage_rate, is_active,
      company_id, useful_life_years, alert_before_days, priority
    ) values (
      v_category_id, v_asset_type, 'straight_line', v_annual_rate,
      v_salvage_rate, v_is_active, v_company_id, v_useful_life,
      v_alert_days, v_priority
    )
    returning id into v_id;
  else
    perform 1
    from public.depreciation_rules
    where id = p_rule_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'rule_not_found');
    end if;

    update public.depreciation_rules
    set category_id = v_category_id,
        asset_type = v_asset_type,
        method = 'straight_line',
        annual_rate = v_annual_rate,
        salvage_rate = v_salvage_rate,
        is_active = v_is_active,
        company_id = v_company_id,
        useful_life_years = v_useful_life,
        alert_before_days = v_alert_days,
        priority = v_priority,
        updated_at = now()
    where id = p_rule_id;
    v_id := p_rule_id;
  end if;

  return json_build_object('ok', true, 'id', v_id);
end
$function$;

create or replace function public.depreciation_rule_set_active(
  p_rule_id uuid,
  p_is_active boolean
)
returns json
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.current_user_has_capability('settings.manage')
     or not public.is_financial_viewer() then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_rule_id is null or p_is_active is null then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  update public.depreciation_rules
  set is_active = p_is_active,
      updated_at = now()
  where id = p_rule_id;
  if not found then
    return json_build_object('ok', false, 'error', 'rule_not_found');
  end if;
  return json_build_object('ok', true, 'id', p_rule_id);
end
$function$;

revoke all on function public.depreciation_rule_save_atomic(uuid, jsonb)
from public, anon;
revoke all on function public.depreciation_rule_set_active(uuid, boolean)
from public, anon;
grant execute on function public.depreciation_rule_save_atomic(uuid, jsonb)
to authenticated, service_role;
grant execute on function public.depreciation_rule_set_active(uuid, boolean)
to authenticated, service_role;

revoke insert, update, delete on public.depreciation_rules
from anon, authenticated;
drop policy if exists ins_mgr on public.depreciation_rules;
drop policy if exists upd_mgr on public.depreciation_rules;
drop policy if exists del_mgr on public.depreciation_rules;

-- Depreciation percentages are financial data. Audit the fact of each change
-- while preserving the existing non-financial auditor boundary.
create or replace function public._audit_sanitize(p_value jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value) = 'object' then
    select coalesce(jsonb_object_agg(
      key,
      case
        when key ~* '(secret|token|password|authorization|api[_-]?key|cookie|signature|private[_-]?key|purchase[_-]?cost|unit[_-]?cost|unit[_-]?price|total[_-]?price|annual[_-]?rate|salvage[_-]?rate|invoice|email|phone|contact|customer[_-]?name|storage[_-]?path|notes?|message|description)'
          then '"[REDACTED]"'::jsonb
        else public._audit_sanitize(value)
      end
    ), '{}'::jsonb)
    into v_result
    from jsonb_each(p_value);
    return v_result;
  elsif jsonb_typeof(p_value) = 'array' then
    select coalesce(jsonb_agg(public._audit_sanitize(value)), '[]'::jsonb)
    into v_result
    from jsonb_array_elements(p_value);
    return v_result;
  elsif jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~* '(bearer[[:space:]]+|eyj[a-z0-9_-]{12,}\.|sk-[a-z0-9_-]{12,}|service[_-]?role|api[_-]?key[[:space:]]*[=:]|password[[:space:]]*[=:]|token[[:space:]]*[=:])' then
    return '"[REDACTED]"'::jsonb;
  end if;
  return p_value;
end
$function$;

drop trigger if exists trg_unified_audit on public.depreciation_rules;
create trigger trg_unified_audit
after insert or update or delete on public.depreciation_rules
for each row execute function public._audit_row_change();

commit;
