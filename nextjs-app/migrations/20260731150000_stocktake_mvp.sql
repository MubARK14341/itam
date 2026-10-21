-- Purpose: provide an RPC-only stocktake workflow with an immutable expected
-- snapshot, blind scan-first counting, recount/reason/review gates, atomic
-- location adjustments, append-only evidence, and read-only auditor access.
-- Risk: medium/additive. Existing draft stocktakes remain readable but cannot be
-- completed through the new workflow without a snapshot.
-- Rollback: forward-fix only. Revoke the RPCs to contain; do not drop evidence
-- tables or columns after a session has started.

begin;

alter table public.stocktakes
  add column if not exists snapshot_at timestamptz,
  add column if not exists expected_count integer not null default 0,
  add column if not exists observed_count integer not null default 0,
  add column if not exists variance_count integer not null default 0,
  add column if not exists blind_count boolean not null default true,
  add column if not exists review_state text not null default 'counting',
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.app_users(id),
  add column if not exists locked_at timestamptz,
  add column if not exists correction_of uuid references public.stocktakes(id),
  add column if not exists create_operation_id uuid;

alter table public.stocktakes
  drop constraint if exists stocktakes_review_state_check;
alter table public.stocktakes
  add constraint stocktakes_review_state_check check (
    review_state in ('counting', 'recount', 'submitted', 'approved', 'rejected')
  );
create unique index if not exists ux_stocktakes_create_operation
  on public.stocktakes(create_operation_id)
  where create_operation_id is not null;
create index if not exists ix_stocktakes_location_status
  on public.stocktakes(location_id, status, created_at desc);

alter table public.stocktake_items
  add column if not exists item_kind text not null default 'asset',
  add column if not exists is_expected boolean not null default true,
  add column if not exists expected_location_id uuid references public.locations(id),
  add column if not exists snapshot_asset_tag text,
  add column if not exists snapshot_asset_name text,
  add column if not exists snapshot_serial_number text,
  add column if not exists snapshot_rfid_tag text,
  add column if not exists observation_status text,
  add column if not exists observed_location_id uuid references public.locations(id),
  add column if not exists observed_identifier text,
  add column if not exists count_round integer not null default 1,
  add column if not exists recount_required boolean not null default false,
  add column if not exists variance_reason text,
  add column if not exists adjustment_applied boolean not null default false;

alter table public.stocktake_items
  drop constraint if exists stocktake_items_item_kind_check;
alter table public.stocktake_items
  add constraint stocktake_items_item_kind_check
  check (item_kind = 'asset');
alter table public.stocktake_items
  drop constraint if exists stocktake_items_observation_status_check;
alter table public.stocktake_items
  add constraint stocktake_items_observation_status_check check (
    observation_status is null
    or observation_status in ('found', 'missing', 'unexpected', 'wrong_location')
  );
create index if not exists ix_stocktake_items_progress
  on public.stocktake_items(stocktake_id, observation_status, scanned);

create table if not exists public.stocktake_operations (
  operation_id uuid primary key,
  stocktake_id uuid not null references public.stocktakes(id) on delete cascade,
  action text not null,
  result jsonb not null,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.stocktake_events (
  id bigint generated always as identity primary key,
  stocktake_id uuid not null references public.stocktakes(id) on delete cascade,
  event_type text not null,
  actor_type text not null default 'user',
  actor_id uuid,
  operation_id uuid,
  item_id uuid references public.stocktake_items(id) on delete set null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  source text not null default 'stocktake_rpc',
  created_at timestamptz not null default now()
);

alter table public.stocktake_operations enable row level security;
alter table public.stocktake_events enable row level security;
revoke all on public.stocktakes, public.stocktake_items,
  public.stocktake_operations, public.stocktake_events
from public, anon, authenticated;

drop policy if exists sel_auth on public.stocktakes;
drop policy if exists sel_stocktake_roles on public.stocktakes;
create policy sel_stocktake_roles on public.stocktakes
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor')
);

drop policy if exists sel_auth on public.stocktake_items;
drop policy if exists sel_stocktake_roles on public.stocktake_items;
create policy sel_stocktake_roles on public.stocktake_items
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor')
);

drop policy if exists sel_stocktake_events_roles on public.stocktake_events;
create policy sel_stocktake_events_roles on public.stocktake_events
for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor')
);

grant select on public.stocktakes, public.stocktake_items, public.stocktake_events
to authenticated;

create or replace function public._stocktake_can_manage()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.is_approved()
    and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager')
    and public.current_user_has_capability('stocktake.manage');
$function$;

create or replace function public._stocktake_can_read()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.is_approved()
    and public.app_user_role() in ('admin', 'it_manager', 'warehouse_manager', 'auditor');
$function$;

create or replace function public._stocktake_event(
  p_stocktake_id uuid,
  p_event_type text,
  p_operation_id uuid,
  p_item_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
) returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.stocktake_events (
    stocktake_id, event_type, actor_type, actor_id, operation_id,
    item_id, before_data, after_data, reason
  ) values (
    p_stocktake_id, p_event_type, 'user', auth.uid(), p_operation_id,
    p_item_id, p_before, p_after, nullif(btrim(p_reason), '')
  );
$function$;

create or replace function public._stocktake_existing_operation(
  p_operation_id uuid,
  p_action text
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select o.result
  from public.stocktake_operations o
  where o.operation_id = p_operation_id
    and o.action = p_action;
$function$;

create or replace function public._stocktake_record_operation(
  p_operation_id uuid,
  p_stocktake_id uuid,
  p_action text,
  p_result jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.stocktake_operations (
    operation_id, stocktake_id, action, result, actor_id
  ) values (
    p_operation_id, p_stocktake_id, p_action, p_result, auth.uid()
  )
  on conflict (operation_id) do nothing;
  return p_result;
end;
$function$;

create or replace function public._stocktake_refresh_counts(p_stocktake_id uuid)
returns void
language sql
security definer
set search_path = ''
as $function$
  update public.stocktakes s
  set observed_count = q.observed_count,
      variance_count = q.variance_count
  from (
    select
      count(*) filter (where i.scanned) as observed_count,
      count(*) filter (
        where i.observation_status in ('missing', 'unexpected', 'wrong_location')
      ) as variance_count
    from public.stocktake_items i
    where i.stocktake_id = p_stocktake_id
  ) q
  where s.id = p_stocktake_id;
$function$;

create or replace function public.stocktake_create(
  p_title text,
  p_location_id uuid,
  p_operation_id uuid,
  p_correction_of uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_id uuid;
  v_code text;
  v_expected integer;
  v_prior public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'create');
  if v_existing is not null then return v_existing; end if;
  if coalesce(length(btrim(p_title)), 0) < 3 or length(p_title) > 160 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.locations l
    where l.id = p_location_id and l.is_active
  ) then
    raise exception 'location_not_found' using errcode = '22023';
  end if;
  if p_correction_of is not null then
    select * into v_prior from public.stocktakes where id = p_correction_of;
    if not found or v_prior.status <> 'completed' then
      raise exception 'completed_session_required' using errcode = '22023';
    end if;
    if v_prior.location_id is distinct from p_location_id then
      raise exception 'correction_location_mismatch' using errcode = '22023';
    end if;
  end if;

  v_id := gen_random_uuid();
  v_code := 'STK-' || upper(substr(replace(v_id::text, '-', ''), 1, 10));
  insert into public.stocktakes (
    id, code, title, location_id, status, created_by, snapshot_at,
    blind_count, review_state, correction_of, create_operation_id
  ) values (
    v_id, v_code, btrim(p_title), p_location_id, 'draft', auth.uid(), now(),
    true, 'counting', p_correction_of, p_operation_id
  );

  insert into public.stocktake_items (
    stocktake_id, asset_id, item_kind, is_expected, expected_status,
    expected_location_id, snapshot_asset_tag, snapshot_asset_name,
    snapshot_serial_number, snapshot_rfid_tag
  )
  select
    v_id, a.id, 'asset', true, a.status, a.location_id,
    a.asset_tag, a.name, a.serial_number, a.rfid_tag
  from public.assets a
  where a.is_active and a.location_id = p_location_id
  order by a.id;

  get diagnostics v_expected = row_count;
  update public.stocktakes set expected_count = v_expected where id = v_id;
  perform public._stocktake_event(
    v_id, case when p_correction_of is null then 'created' else 'correction_created' end,
    p_operation_id, null, null,
    jsonb_build_object(
      'location_id', p_location_id,
      'expected_count', v_expected,
      'correction_of', p_correction_of
    ),
    null
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', v_id, 'code', v_code, 'expected_count', v_expected
  );
  return public._stocktake_record_operation(
    p_operation_id, v_id, 'create', v_result
  );
end;
$function$;

create or replace function public.stocktake_start(
  p_stocktake_id uuid,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_row public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'start');
  if v_existing is not null then return v_existing; end if;
  select * into v_row
  from public.stocktakes where id = p_stocktake_id for update;
  if not found then raise exception 'stocktake_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'draft' or v_row.snapshot_at is null then
    raise exception 'stocktake_not_startable' using errcode = '22023';
  end if;
  update public.stocktakes
  set status = 'in_progress', started_at = now(), review_state = 'counting'
  where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'started', p_operation_id, null,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'in_progress'), null
  );
  v_result := jsonb_build_object('ok', true, 'id', p_stocktake_id);
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'start', v_result
  );
end;
$function$;

create or replace function public.stocktake_scan(
  p_stocktake_id uuid,
  p_identifier text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_asset public.assets%rowtype;
  v_asset_id uuid;
  v_item public.stocktake_items%rowtype;
  v_match_count integer;
  v_classification text;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'scan');
  if v_existing is not null then return v_existing; end if;
  if coalesce(length(btrim(p_identifier)), 0) = 0 or length(p_identifier) > 255 then
    raise exception 'invalid_identifier' using errcode = '22023';
  end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found then raise exception 'stocktake_not_found' using errcode = 'P0002'; end if;
  if v_take.status <> 'in_progress'
     or v_take.review_state not in ('counting', 'recount') then
    raise exception 'stocktake_not_countable' using errcode = '22023';
  end if;

  select count(*), min(a.id::text)::uuid
  into v_match_count, v_asset_id
  from public.assets a
  where a.is_active and (
    lower(a.asset_tag) = lower(btrim(p_identifier))
    or lower(coalesce(a.serial_number, '')) = lower(btrim(p_identifier))
    or lower(coalesce(a.rfid_tag, '')) = lower(btrim(p_identifier))
    or lower(a.qr_token) = lower(btrim(p_identifier))
  );
  if v_match_count = 0 then
    raise exception 'asset_not_found' using errcode = 'P0002';
  elsif v_match_count > 1 then
    raise exception 'identifier_ambiguous' using errcode = '21000';
  end if;
  select * into v_asset from public.assets where id = v_asset_id for update;

  select * into v_item
  from public.stocktake_items
  where stocktake_id = p_stocktake_id and asset_id = v_asset.id
  for update;

  if found then
    v_classification := case
      when v_asset.location_id is not distinct from v_take.location_id then 'found'
      else 'wrong_location'
    end;
    update public.stocktake_items
    set scanned = true,
        found = true,
        scanned_at = now(),
        scanned_by = auth.uid(),
        observed_location_id = v_take.location_id,
        observed_identifier = btrim(p_identifier),
        observation_status = v_classification,
        recount_required = false
    where id = v_item.id
    returning * into v_item;
  else
    v_classification := 'unexpected';
    insert into public.stocktake_items (
      stocktake_id, asset_id, item_kind, is_expected, expected_status,
      expected_location_id, snapshot_asset_tag, snapshot_asset_name,
      snapshot_serial_number, snapshot_rfid_tag, scanned, found,
      scanned_at, scanned_by, observed_location_id, observed_identifier,
      observation_status
    ) values (
      p_stocktake_id, v_asset.id, 'asset', false, v_asset.status,
      v_asset.location_id, v_asset.asset_tag, v_asset.name,
      v_asset.serial_number, v_asset.rfid_tag, true, true,
      now(), auth.uid(), v_take.location_id, btrim(p_identifier),
      v_classification
    )
    returning * into v_item;
  end if;

  perform public._stocktake_refresh_counts(p_stocktake_id);
  perform public._stocktake_event(
    p_stocktake_id, 'scanned', p_operation_id, v_item.id, null,
    jsonb_build_object(
      'asset_id', v_asset.id,
      'classification', v_classification,
      'count_round', v_item.count_round
    ), null
  );
  v_result := jsonb_build_object(
    'ok', true,
    'item_id', v_item.id,
    'asset_id', v_asset.id,
    'asset_tag', v_asset.asset_tag,
    'asset_name', v_asset.name,
    'classification', v_classification,
    'count_round', v_item.count_round
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'scan', v_result
  );
end;
$function$;

create or replace function public.stocktake_submit(
  p_stocktake_id uuid,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'submit');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state not in ('counting', 'recount') then
    raise exception 'stocktake_not_submittable' using errcode = '22023';
  end if;
  update public.stocktake_items
  set observation_status = 'missing',
      found = false,
      recount_required = true
  where stocktake_id = p_stocktake_id
    and is_expected and not scanned;
  perform public._stocktake_refresh_counts(p_stocktake_id);
  update public.stocktakes
  set review_state = 'submitted', submitted_at = now()
  where id = p_stocktake_id;
  select * into v_take from public.stocktakes where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'submitted', p_operation_id, null, null,
    jsonb_build_object(
      'observed_count', v_take.observed_count,
      'variance_count', v_take.variance_count
    ), null
  );
  v_result := jsonb_build_object(
    'ok', true,
    'id', p_stocktake_id,
    'observed_count', v_take.observed_count,
    'variance_count', v_take.variance_count
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'submit', v_result
  );
end;
$function$;

create or replace function public.stocktake_recount_item(
  p_stocktake_id uuid,
  p_item_id uuid,
  p_reason text,
  p_operation_id uuid
) returns jsonb
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
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null or coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'operation_and_reason_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'recount');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state not in ('submitted', 'recount') then
    raise exception 'stocktake_not_recountable' using errcode = '22023';
  end if;
  select * into v_item
  from public.stocktake_items
  where id = p_item_id and stocktake_id = p_stocktake_id
  for update;
  if not found or v_item.observation_status not in (
    'missing', 'unexpected', 'wrong_location'
  ) then
    raise exception 'variance_item_required' using errcode = '22023';
  end if;
  update public.stocktake_items
  set scanned = false,
      found = null,
      scanned_at = null,
      scanned_by = null,
      observed_location_id = null,
      observed_identifier = null,
      observation_status = null,
      count_round = count_round + 1,
      recount_required = true,
      variance_reason = btrim(p_reason)
  where id = p_item_id
  returning * into v_item;
  update public.stocktakes set review_state = 'recount' where id = p_stocktake_id;
  perform public._stocktake_refresh_counts(p_stocktake_id);
  perform public._stocktake_event(
    p_stocktake_id, 'recount_requested', p_operation_id, p_item_id, null,
    jsonb_build_object('count_round', v_item.count_round), p_reason
  );
  v_result := jsonb_build_object(
    'ok', true, 'item_id', p_item_id, 'count_round', v_item.count_round
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'recount', v_result
  );
end;
$function$;

create or replace function public.stocktake_set_variance_reason(
  p_stocktake_id uuid,
  p_item_id uuid,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_item public.stocktake_items%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null or coalesce(length(btrim(p_reason)), 0) < 3
     or length(p_reason) > 1000 then
    raise exception 'operation_and_reason_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'reason');
  if v_existing is not null then return v_existing; end if;
  if not exists (
    select 1 from public.stocktakes s
    where s.id = p_stocktake_id
      and s.status = 'in_progress'
      and s.review_state in ('submitted', 'recount')
  ) then
    raise exception 'stocktake_not_reviewable' using errcode = '22023';
  end if;
  update public.stocktake_items
  set variance_reason = btrim(p_reason)
  where id = p_item_id
    and stocktake_id = p_stocktake_id
    and observation_status in ('missing', 'unexpected', 'wrong_location')
  returning * into v_item;
  if not found then
    raise exception 'variance_item_required' using errcode = '22023';
  end if;
  perform public._stocktake_event(
    p_stocktake_id, 'variance_reasoned', p_operation_id, p_item_id,
    null, jsonb_build_object('classification', v_item.observation_status), p_reason
  );
  v_result := jsonb_build_object('ok', true, 'item_id', p_item_id);
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'reason', v_result
  );
end;
$function$;

create or replace function public.stocktake_review(
  p_stocktake_id uuid,
  p_decision text,
  p_reason text,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_result jsonb;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null
     or p_decision not in ('approved', 'rejected')
     or coalesce(length(btrim(p_reason)), 0) < 3 then
    raise exception 'invalid_review' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'review');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state <> 'submitted' then
    raise exception 'stocktake_not_reviewable' using errcode = '22023';
  end if;
  if v_take.created_by = auth.uid() then
    raise exception 'independent_reviewer_required' using errcode = '42501';
  end if;
  if p_decision = 'approved' and exists (
    select 1 from public.stocktake_items i
    where i.stocktake_id = p_stocktake_id
      and i.observation_status in ('missing', 'unexpected', 'wrong_location')
      and (
        i.count_round < 2
        or coalesce(length(btrim(i.variance_reason)), 0) < 3
      )
  ) then
    raise exception 'recount_and_reason_required' using errcode = '22023';
  end if;
  update public.stocktakes
  set review_state = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'reviewed', p_operation_id, null,
    jsonb_build_object('review_state', v_take.review_state),
    jsonb_build_object('review_state', p_decision), p_reason
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', p_stocktake_id, 'decision', p_decision
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'review', v_result
  );
end;
$function$;

create or replace function public.stocktake_apply_adjustments(
  p_stocktake_id uuid,
  p_operation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing jsonb;
  v_take public.stocktakes%rowtype;
  v_asset public.assets%rowtype;
  v_applied integer := 0;
  v_result jsonb;
  r record;
begin
  if not public._stocktake_can_manage() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required' using errcode = '22023';
  end if;
  v_existing := public._stocktake_existing_operation(p_operation_id, 'apply');
  if v_existing is not null then return v_existing; end if;
  select * into v_take
  from public.stocktakes where id = p_stocktake_id for update;
  if not found or v_take.status <> 'in_progress'
     or v_take.review_state <> 'approved' then
    raise exception 'approved_stocktake_required' using errcode = '22023';
  end if;
  if v_take.created_by = auth.uid() then
    raise exception 'independent_adjuster_required' using errcode = '42501';
  end if;

  for r in
    select i.*
    from public.stocktake_items i
    where i.stocktake_id = p_stocktake_id
      and i.observation_status in ('unexpected', 'wrong_location')
      and not i.adjustment_applied
    order by i.asset_id
  loop
    select * into v_asset from public.assets where id = r.asset_id for update;
    if v_asset.location_id is distinct from v_take.location_id then
      update public.assets
      set location_id = v_take.location_id
      where id = r.asset_id;
      insert into public.asset_movements (
        asset_id, movement_type, from_status, to_status,
        from_location_id, to_location_id, performed_by, note
      ) values (
        r.asset_id, 'transfer', v_asset.status, v_asset.status,
        v_asset.location_id, v_take.location_id, auth.uid(),
        'Stocktake ' || v_take.code || ': ' || r.variance_reason
      );
      v_applied := v_applied + 1;
    end if;
    update public.stocktake_items
    set adjustment_applied = true
    where id = r.id;
  end loop;

  update public.stocktakes
  set status = 'completed', completed_at = now(), locked_at = now()
  where id = p_stocktake_id;
  perform public._stocktake_event(
    p_stocktake_id, 'completed', p_operation_id, null, null,
    jsonb_build_object(
      'adjustments_applied', v_applied,
      'missing_not_adjusted', (
        select count(*) from public.stocktake_items i
        where i.stocktake_id = p_stocktake_id
          and i.observation_status = 'missing'
      )
    ), 'Approved observed-location adjustments only'
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', p_stocktake_id, 'adjustments_applied', v_applied
  );
  return public._stocktake_record_operation(
    p_operation_id, p_stocktake_id, 'apply', v_result
  );
end;
$function$;

create or replace function public.stocktake_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public._stocktake_can_read() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id,
      'code', s.code,
      'title', s.title,
      'location_id', s.location_id,
      'location_name', l.name,
      'status', s.status,
      'review_state', s.review_state,
      'snapshot_at', s.snapshot_at,
      'started_at', s.started_at,
      'submitted_at', s.submitted_at,
      'completed_at', s.completed_at,
      'expected_count', s.expected_count,
      'observed_count', s.observed_count,
      'variance_count', s.variance_count,
      'correction_of', s.correction_of,
      'created_by', s.created_by
    ) order by s.created_at desc)
    from public.stocktakes s
    left join public.locations l on l.id = s.location_id
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.stocktake_detail(p_stocktake_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_take public.stocktakes%rowtype;
  v_hide_expected boolean;
begin
  if not public._stocktake_can_read() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_take from public.stocktakes where id = p_stocktake_id;
  if not found then raise exception 'stocktake_not_found' using errcode = 'P0002'; end if;
  v_hide_expected := v_take.blind_count
    and v_take.review_state in ('counting', 'recount');
  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_take.id,
      'code', v_take.code,
      'title', v_take.title,
      'location_id', v_take.location_id,
      'status', v_take.status,
      'review_state', v_take.review_state,
      'snapshot_at', v_take.snapshot_at,
      'expected_count', v_take.expected_count,
      'observed_count', v_take.observed_count,
      'variance_count', v_take.variance_count,
      'blind_count', v_take.blind_count,
      'correction_of', v_take.correction_of,
      'created_by', v_take.created_by,
      'reviewed_by', v_take.reviewed_by
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'asset_id', i.asset_id,
        'asset_tag', i.snapshot_asset_tag,
        'asset_name', i.snapshot_asset_name,
        'is_expected', i.is_expected,
        'scanned', i.scanned,
        'classification', i.observation_status,
        'count_round', i.count_round,
        'recount_required', i.recount_required,
        'variance_reason', i.variance_reason,
        'adjustment_applied', i.adjustment_applied,
        'observed_at', i.scanned_at
      ) order by i.scanned_at nulls last, i.snapshot_asset_tag)
      from public.stocktake_items i
      where i.stocktake_id = p_stocktake_id
        and (not v_hide_expected or i.scanned)
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_type', e.event_type,
        'actor_id', e.actor_id,
        'item_id', e.item_id,
        'reason', e.reason,
        'created_at', e.created_at
      ) order by e.created_at, e.id)
      from public.stocktake_events e
      where e.stocktake_id = p_stocktake_id
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public._stocktake_can_manage() from public, anon, authenticated;
revoke all on function public._stocktake_can_read() from public, anon, authenticated;
revoke all on function public._stocktake_event(uuid,text,uuid,uuid,jsonb,jsonb,text)
from public, anon, authenticated;
revoke all on function public._stocktake_existing_operation(uuid,text)
from public, anon, authenticated;
revoke all on function public._stocktake_record_operation(uuid,uuid,text,jsonb)
from public, anon, authenticated;
revoke all on function public._stocktake_refresh_counts(uuid)
from public, anon, authenticated;

revoke all on function public.stocktake_create(text,uuid,uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_start(uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_scan(uuid,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_submit(uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_recount_item(uuid,uuid,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_set_variance_reason(uuid,uuid,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_review(uuid,text,text,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_apply_adjustments(uuid,uuid)
from public, anon, authenticated;
revoke all on function public.stocktake_list()
from public, anon, authenticated;
revoke all on function public.stocktake_detail(uuid)
from public, anon, authenticated;

grant execute on function public.stocktake_create(text,uuid,uuid,uuid)
to authenticated;
grant execute on function public.stocktake_start(uuid,uuid)
to authenticated;
grant execute on function public.stocktake_scan(uuid,text,uuid)
to authenticated;
grant execute on function public.stocktake_submit(uuid,uuid)
to authenticated;
grant execute on function public.stocktake_recount_item(uuid,uuid,text,uuid)
to authenticated;
grant execute on function public.stocktake_set_variance_reason(uuid,uuid,text,uuid)
to authenticated;
grant execute on function public.stocktake_review(uuid,text,text,uuid)
to authenticated;
grant execute on function public.stocktake_apply_adjustments(uuid,uuid)
to authenticated;
grant execute on function public.stocktake_list()
to authenticated;
grant execute on function public.stocktake_detail(uuid)
to authenticated;

comment on function public.stocktake_detail(uuid) is
  'Non-financial stocktake projection. Blind sessions omit unobserved expected rows until submission.';
comment on function public.stocktake_apply_adjustments(uuid,uuid) is
  'Atomically moves only positively observed wrong-location/unexpected assets; missing assets are never guessed.';

commit;
