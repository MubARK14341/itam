begin;

-- P1-05: unified append-only evidence for events created after this migration.
-- Historical tables are not rewritten or attributed retroactively.

create table if not exists public.audit_events_v2 (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  actor_type text not null
    check (actor_type in ('staff', 'employee', 'portal', 'system', 'service', 'anonymous')),
  actor_id uuid null,
  system_principal text null,
  event_type text not null,
  outcome text not null default 'success'
    check (outcome in ('success', 'denied', 'failure')),
  entity_type text not null,
  entity_id text null,
  request_id uuid null references public.requests(id) on delete set null,
  before_state jsonb null,
  after_state jsonb null,
  reason text null,
  source text not null,
  correlation_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  attribution_status text not null default 'attributed'
    check (attribution_status in ('attributed', 'system_attributed', 'legacy_unattributed')),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint audit_events_v2_actor_identity check (
    (actor_type in ('staff', 'employee', 'portal') and actor_id is not null and system_principal is null)
    or
    (actor_type in ('system', 'service') and actor_id is null and system_principal is not null)
    or
    (actor_type = 'anonymous' and actor_id is null and system_principal is null)
  ),
  constraint audit_events_v2_state_shape check (
    before_state is null or jsonb_typeof(before_state) = 'object'
  ),
  constraint audit_events_v2_after_shape check (
    after_state is null or jsonb_typeof(after_state) = 'object'
  ),
  constraint audit_events_v2_metadata_shape check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index if not exists idx_audit_events_v2_entity
  on public.audit_events_v2(entity_type, entity_id, id desc);
create index if not exists idx_audit_events_v2_request
  on public.audit_events_v2(request_id, id desc)
  where request_id is not null;
create index if not exists idx_audit_events_v2_actor
  on public.audit_events_v2(actor_id, id desc)
  where actor_id is not null;
create index if not exists idx_audit_events_v2_outcome
  on public.audit_events_v2(outcome, id desc)
  where outcome <> 'success';

alter table public.audit_events_v2 enable row level security;
revoke all on public.audit_events_v2 from public, anon, authenticated;
grant select on public.audit_events_v2 to authenticated;
grant select, insert on public.audit_events_v2 to service_role;

drop policy if exists sel_audit_roles on public.audit_events_v2;
create policy sel_audit_roles on public.audit_events_v2
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'auditor')
);

create or replace function public._audit_reject_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  raise exception 'audit_events_append_only' using errcode = '42501';
end
$function$;

drop trigger if exists trg_audit_events_v2_append_only on public.audit_events_v2;
create trigger trg_audit_events_v2_append_only
before update or delete on public.audit_events_v2
for each row execute function public._audit_reject_mutation();

create or replace function public._audit_sanitize(p_value jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = public
as $function$
declare
  v_result jsonb;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value) = 'object' then
    select coalesce(jsonb_object_agg(
      key,
      case
        when key ~* '(secret|token|password|authorization|api[_-]?key|cookie|signature|private[_-]?key|purchase[_-]?cost|unit[_-]?cost|unit[_-]?price|total[_-]?price|invoice|email|phone|contact|customer[_-]?name|storage[_-]?path|notes?|message|description)'
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

create or replace function public._audit_actor_context(
  p_row jsonb default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public.app_user_role();
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), '')
  );
  v_row_actor_kind text := nullif(p_row->>'actor_kind', '');
  v_row_actor_id uuid;
begin
  begin
    v_row_actor_id := nullif(p_row->>'actor_id', '')::uuid;
  exception when invalid_text_representation then
    v_row_actor_id := null;
  end;

  if v_row_actor_kind = 'system' then
    return jsonb_build_object(
      'actor_type', 'system',
      'actor_id', null,
      'system_principal', 'request_workflow',
      'attribution_status', 'system_attributed'
    );
  elsif v_row_actor_kind = 'portal' and coalesce(v_row_actor_id, v_uid) is not null then
    return jsonb_build_object(
      'actor_type', 'portal',
      'actor_id', coalesce(v_row_actor_id, v_uid),
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_role = 'employee' and v_uid is not null then
    return jsonb_build_object(
      'actor_type', 'employee',
      'actor_id', v_uid,
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_role is not null and v_uid is not null then
    return jsonb_build_object(
      'actor_type', 'staff',
      'actor_id', v_uid,
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_uid is not null then
    return jsonb_build_object(
      'actor_type', 'portal',
      'actor_id', v_uid,
      'system_principal', null,
      'attribution_status', 'attributed'
    );
  elsif v_jwt_role = 'service_role' or current_user = 'service_role' then
    return jsonb_build_object(
      'actor_type', 'service',
      'actor_id', null,
      'system_principal', 'supabase_service_role',
      'attribution_status', 'system_attributed'
    );
  end if;
  return jsonb_build_object(
    'actor_type', 'system',
    'actor_id', null,
    'system_principal', 'database_internal',
    'attribution_status', 'system_attributed'
  );
end
$function$;

-- Internal writer. It is inaccessible over the Data API.
create or replace function public._audit_write(
  p_event_type text,
  p_outcome text,
  p_entity_type text,
  p_entity_id text,
  p_request_id uuid,
  p_before_state jsonb,
  p_after_state jsonb,
  p_reason text,
  p_source text,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_row jsonb default null,
  p_system_principal text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor jsonb := public._audit_actor_context(p_actor_row);
  v_event_id uuid;
begin
  if p_event_type is null or btrim(p_event_type) = ''
     or p_entity_type is null or btrim(p_entity_type) = ''
     or p_source is null or btrim(p_source) = '' then
    raise exception 'invalid_audit_event';
  end if;
  if p_outcome not in ('success', 'denied', 'failure') then
    raise exception 'invalid_audit_outcome';
  end if;

  if p_system_principal is not null then
    v_actor := jsonb_build_object(
      'actor_type', 'system',
      'actor_id', null,
      'system_principal', p_system_principal,
      'attribution_status', 'system_attributed'
    );
  end if;

  insert into public.audit_events_v2 (
    actor_type,
    actor_id,
    system_principal,
    event_type,
    outcome,
    entity_type,
    entity_id,
    request_id,
    before_state,
    after_state,
    reason,
    source,
    correlation_id,
    metadata,
    attribution_status
  ) values (
    v_actor->>'actor_type',
    nullif(v_actor->>'actor_id', '')::uuid,
    nullif(v_actor->>'system_principal', ''),
    btrim(p_event_type),
    p_outcome,
    btrim(p_entity_type),
    nullif(btrim(p_entity_id), ''),
    p_request_id,
    public._audit_sanitize(p_before_state),
    public._audit_sanitize(p_after_state),
    case
      when nullif(btrim(p_reason), '') is null then null
      else public._audit_sanitize(to_jsonb(p_reason)) #>> '{}'
    end,
    btrim(p_source),
    case
      when nullif(coalesce(p_metadata, '{}'::jsonb)->>'correlation_id', '') is null then null
      when (p_metadata->>'correlation_id') ~* '^[0-9a-f-]{36}$'
        then (p_metadata->>'correlation_id')::uuid
      else null
    end,
    public._audit_sanitize(coalesce(p_metadata, '{}'::jsonb) - 'correlation_id'),
    v_actor->>'attribution_status'
  )
  returning event_id into v_event_id;
  return v_event_id;
end
$function$;

create or replace function public._audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_row jsonb := coalesce(v_new, v_old);
  v_entity_id text := coalesce(v_row->>'id', v_row->>'event_id');
  v_request_id uuid;
  v_reason text := coalesce(
    nullif(v_row->>'reason', ''),
    nullif(v_row->>'rejection_reason', ''),
    nullif(v_row->>'resolution_note', '')
  );
begin
  begin
    if tg_table_name = 'requests' then
      v_request_id := nullif(v_row->>'id', '')::uuid;
    elsif v_row ? 'request_id' then
      v_request_id := nullif(v_row->>'request_id', '')::uuid;
    end if;
  exception when invalid_text_representation then
    v_request_id := null;
  end;

  perform public._audit_write(
    lower(tg_op),
    'success',
    tg_table_name,
    v_entity_id,
    v_request_id,
    v_old,
    v_new,
    v_reason,
    'database_trigger:' || tg_table_name,
    jsonb_build_object('schema', tg_table_schema),
    v_row,
    null
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

do $triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'requests',
    'request_items',
    'request_events',
    'request_attachments',
    'assets',
    'asset_assignments',
    'asset_movements',
    'maintenance_records',
    'attachments',
    'consumable_transactions',
    'purchase_requests',
    'purchase_request_items',
    'stocktakes',
    'stocktake_items',
    'stocktake_events',
    'custody_reconciliation_cases',
    'employee_asset_return_requests',
    'role_permissions',
    'user_permissions'
  ]
  loop
    if to_regclass('public.' || v_table) is not null then
      execute format('drop trigger if exists trg_unified_audit on public.%I', v_table);
      execute format(
        'create trigger trg_unified_audit after insert or update or delete on public.%I for each row execute function public._audit_row_change()',
        v_table
      );
    end if;
  end loop;
end
$triggers$;

-- Explicit denied-event writer used by high-risk authorization administration.
create or replace function public._audit_capability_denial(
  p_event_type text,
  p_entity_type text,
  p_entity_id text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  perform public._audit_write(
    p_event_type,
    'denied',
    p_entity_type,
    p_entity_id,
    null,
    null,
    null,
    p_reason,
    'rpc:authorization_admin',
    '{}'::jsonb,
    null,
    null
  );
end
$function$;

create or replace function public.set_role_capability(
  p_role_key text,
  p_key text,
  p_allowed boolean
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_caller text := public.app_user_role();
  v_role uuid;
  v_perm uuid;
begin
  if v_caller is null or v_caller <> 'admin' then
    perform public._audit_capability_denial(
      'role_capability_change_attempt',
      'role',
      p_role_key,
      'not_authorized'
    );
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id into v_role from public.roles where key = p_role_key;
  select id into v_perm from public.permissions where key = p_key;
  if v_role is null or v_perm is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  delete from public.role_permissions
  where role_id = v_role and permission_id = v_perm;
  if p_allowed then
    insert into public.role_permissions(role_id, permission_id)
    values (v_role, v_perm);
  end if;
  return json_build_object('ok', true);
end
$function$;

create or replace function public.set_user_capability(
  p_user uuid,
  p_key text,
  p_state text
) returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_caller text := public.app_user_role();
  v_perm uuid;
  v_target_role text;
begin
  if v_caller is null or v_caller <> 'admin' then
    perform public._audit_capability_denial(
      'user_capability_change_attempt',
      'app_user',
      p_user::text,
      'not_authorized'
    );
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user = auth.uid() then
    perform public._audit_capability_denial(
      'user_capability_change_attempt',
      'app_user',
      p_user::text,
      'cannot_modify_self'
    );
    return json_build_object('ok', false, 'error', 'cannot_modify_self');
  end if;
  if p_state not in ('allow', 'deny', 'inherit') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  select r.key into v_target_role
  from public.app_users u
  join public.roles r on r.id = u.role_id
  where u.id = p_user;
  if v_target_role = 'admin' then
    perform public._audit_capability_denial(
      'user_capability_change_attempt',
      'app_user',
      p_user::text,
      'cannot_modify_admin'
    );
    return json_build_object('ok', false, 'error', 'cannot_modify_admin');
  end if;
  select id into v_perm from public.permissions where key = p_key;
  if v_perm is null then return json_build_object('ok', false, 'error', 'not_found'); end if;

  delete from public.user_permissions
  where user_id = p_user and permission_id = v_perm;
  if p_state = 'allow' then
    insert into public.user_permissions(user_id, permission_id, allow)
    values (p_user, v_perm, true);
  elsif p_state = 'deny' then
    insert into public.user_permissions(user_id, permission_id, allow)
    values (p_user, v_perm, false);
  end if;
  return json_build_object('ok', true);
end
$function$;

-- Read-only request evidence. Financial values, storage paths, customer PII,
-- secrets, and tokens are deliberately absent.
create or replace function public.audit_request_evidence(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_role text := public.app_user_role();
  v_result jsonb;
begin
  if v_role not in ('admin', 'it_manager', 'auditor') then
    return jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select jsonb_build_object(
    'ok', true,
    'request', jsonb_build_object(
      'id', r.id,
      'request_number', r.request_number,
      'request_type', r.request_type,
      'beneficiary_type', r.beneficiary_type,
      'beneficiary_employee_id', r.beneficiary_employee_id,
      'status', r.status,
      'pickup_date', r.pickup_date,
      'return_date', r.return_date,
      'created_at', r.created_at,
      'updated_at', r.updated_at
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id,
        'item_kind', ri.item_kind,
        'asset_id', ri.asset_id,
        'consumable_id', ri.consumable_id,
        'quantity', ri.quantity,
        'approved_quantity', ri.approved_quantity,
        'delivered_quantity', ri.delivered_quantity,
        'returned_quantity', ri.returned_quantity,
        'requested_description', ri.requested_description,
        'needs_purchase', ri.needs_purchase,
        'created_at', ri.created_at
      ) order by ri.created_at, ri.id)
      from public.request_items ri where ri.request_id = r.id
    ), '[]'::jsonb),
    'approvals', jsonb_build_object(
      'approved_by', r.approved_by,
      'approved_at', r.approved_at,
      'rejected_by', r.rejected_by,
      'rejected_at', r.rejected_at,
      'rejection_reason', public._audit_sanitize(to_jsonb(r.rejection_reason)) #>> '{}',
      'portal_approval_status', r.portal_approval_status,
      'portal_approved_by', r.portal_approved_by,
      'portal_approved_at', r.portal_approved_at,
      'portal_rejected_by', r.portal_rejected_by,
      'portal_rejected_at', r.portal_rejected_at,
      'portal_rejection_reason', public._audit_sanitize(to_jsonb(r.portal_rejection_reason)) #>> '{}'
    ),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', am.id,
        'asset_id', am.asset_id,
        'movement_type', am.movement_type,
        'from_status', am.from_status,
        'to_status', am.to_status,
        'from_location_id', am.from_location_id,
        'to_location_id', am.to_location_id,
        'from_employee_id', am.from_employee_id,
        'to_employee_id', am.to_employee_id,
        'performed_by', am.performed_by,
        'created_at', am.created_at
      ) order by am.created_at, am.id)
      from public.asset_movements am
      where am.asset_id in (
        select ri.asset_id from public.request_items ri
        where ri.request_id = r.id and ri.asset_id is not null
      )
    ), '[]'::jsonb),
    'custody', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', aa.id,
        'asset_id', aa.asset_id,
        'employee_id', aa.employee_id,
        'assigned_by', aa.assigned_by,
        'assigned_at', aa.assigned_at,
        'due_return_date', aa.due_return_date,
        'returned_at', aa.returned_at,
        'return_condition', aa.return_condition,
        'status', aa.status
      ) order by aa.assigned_at, aa.id)
      from public.asset_assignments aa
      where aa.asset_id in (
        select ri.asset_id from public.request_items ri
        where ri.request_id = r.id and ri.asset_id is not null
      )
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ra.id,
        'uploaded_by_kind', ra.uploaded_by_kind,
        'uploaded_by', ra.uploaded_by,
        'visible_to_customer', ra.visible_to_customer,
        'file_name', ra.file_name,
        'mime_type', ra.mime_type,
        'size_bytes', ra.size_bytes,
        'created_at', ra.created_at
      ) order by ra.created_at, ra.id)
      from public.request_attachments ra where ra.request_id = r.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', re.id,
        'event_type', re.event_type,
        'actor_type', re.actor_kind,
        'actor_id', re.actor_id,
        'message', public._audit_sanitize(to_jsonb(re.message)) #>> '{}',
        'metadata', public._audit_sanitize(re.metadata),
        'timestamp', re.created_at,
        'attribution_status', case
          when re.actor_id is null and re.actor_kind <> 'system'
            then 'legacy_unattributed'
          when re.actor_kind = 'system' then 'system_attributed'
          else 'attributed'
        end,
        'source', 'legacy:request_events'
      ) order by re.created_at, re.id)
      from public.request_events re where re.request_id = r.id
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_id', ae.event_id,
        'actor_type', ae.actor_type,
        'actor_id', ae.actor_id,
        'system_principal', ae.system_principal,
        'event_type', ae.event_type,
        'outcome', ae.outcome,
        'entity_type', ae.entity_type,
        'entity_id', ae.entity_id,
        'before', ae.before_state,
        'after', ae.after_state,
        'reason', ae.reason,
        'source', ae.source,
        'timestamp', ae.occurred_at,
        'attribution_status', ae.attribution_status
      ) order by ae.id)
      from public.audit_events_v2 ae
      where ae.request_id = r.id
         or (ae.entity_type = 'requests' and ae.entity_id = r.id::text)
    ), '[]'::jsonb)
  )
  into v_result
  from public.requests r
  where r.id = p_request_id;

  return coalesce(v_result, jsonb_build_object('ok', false, 'error', 'not_found'));
end
$function$;

create or replace function public.audit_legacy_events(
  p_limit integer default 100,
  p_before_id bigint default null
) returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select case
    when public.app_user_role() not in ('admin', 'it_manager', 'auditor')
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(row_data order by sort_time desc, sort_id desc)
      from (
        select
          al.created_at as sort_time,
          al.id as sort_id,
          jsonb_build_object(
            'legacy_id', al.id,
            'actor_type', case when al.changed_by is null then 'anonymous' else 'staff' end,
            'actor_id', al.changed_by,
            'event_type', al.action,
            'entity_type', al.table_name,
            'entity_id', al.record_id,
            'before', public._audit_sanitize(al.old_data),
            'after', public._audit_sanitize(al.new_data),
            'source', 'legacy:audit_logs',
            'timestamp', al.created_at,
            'attribution_status', case
              when al.changed_by is null then 'legacy_unattributed'
              else 'attributed'
            end
          ) as row_data
        from public.audit_logs al
        where p_before_id is null or al.id < p_before_id
        order by al.id desc
        limit least(greatest(coalesce(p_limit, 100), 1), 500)
      ) legacy
    ), '[]'::jsonb)
  end
$function$;

revoke all on function public._audit_reject_mutation() from public, anon, authenticated;
revoke all on function public._audit_sanitize(jsonb) from public, anon, authenticated;
revoke all on function public._audit_actor_context(jsonb) from public, anon, authenticated;
revoke all on function public._audit_write(
  text, text, text, text, uuid, jsonb, jsonb, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all on function public._audit_row_change() from public, anon, authenticated;
revoke all on function public._audit_capability_denial(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.audit_request_evidence(uuid) from public, anon;
revoke all on function public.audit_legacy_events(integer, bigint) from public, anon;
grant execute on function public.audit_request_evidence(uuid) to authenticated;
grant execute on function public.audit_legacy_events(integer, bigint) to authenticated;

revoke all on function public.set_role_capability(text, text, boolean) from public, anon;
revoke all on function public.set_user_capability(uuid, text, text) from public, anon;
grant execute on function public.set_role_capability(text, text, boolean) to authenticated;
grant execute on function public.set_user_capability(uuid, text, text) to authenticated;

comment on table public.audit_events_v2 is
  'Append-only audit ledger for post-P1-05 events. Historical records remain in their original tables.';
comment on function public.audit_request_evidence(uuid) is
  'Non-financial request evidence bundle for admin, IT manager, and read-only auditor.';

commit;
