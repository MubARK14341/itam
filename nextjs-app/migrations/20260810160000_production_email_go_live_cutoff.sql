-- Production email go-live guard.
-- Preserves historical outbox/audit evidence while preventing any notification
-- created before the recorded launch instant from being claimed without a
-- separate, auditable approval.

begin;

alter table public.email_automation_settings
  add column if not exists email_go_live_at timestamptz;

alter table public.automation_outbox
  add column if not exists dispatch_approved_at timestamptz,
  add column if not exists dispatch_approved_by uuid references public.app_users(id);

alter table public.automation_outbox
  drop constraint if exists automation_outbox_status_check;
alter table public.automation_outbox
  add constraint automation_outbox_status_check check (
    status in ('pending','processing','sent','delivered','failed','cancelled','suppressed','delivery_unknown','review_required')
  );

create index if not exists automation_outbox_pre_go_live_review_idx
  on public.automation_outbox (created_at, id)
  where status = 'review_required';

-- The dispatcher is fail-closed when a go-live cutoff exists: historical rows
-- need an explicit approved timestamp before they may be claimed.
create or replace function public.automation_claim_outbox(p_limit integer,p_lock_token uuid)
returns setof public.automation_outbox
language sql
security definer
set search_path = public
as $function$
  with candidates as (
    select o.id
    from public.automation_outbox o
    where o.status = 'pending'
      and o.scheduled_for <= now()
      and o.next_attempt_at <= now()
      and exists (
        select 1
        from public.email_automation_settings s
        where s.id = 'main'
          and (
            s.email_go_live_at is null
            or o.created_at >= s.email_go_live_at
            or o.dispatch_approved_at is not null
          )
      )
    order by o.priority desc,o.next_attempt_at,o.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit,1),1),100)
  )
  update public.automation_outbox o
  set status='processing',locked_at=now(),lease_expires_at=now()+interval '15 minutes',lock_token=p_lock_token,
      attempt_count=o.attempt_count+1,error_code=null,sanitized_error=null
  from candidates c
  where o.id=c.id
  returning o.*;
$function$;

-- Service-only, idempotent pre-go-live review. Active maintenance and SLA
-- items are retained for a later manager decision; closed/missing/superseded
-- historical notifications are cancelled without deleting their evidence.
create or replace function public.automation_reconcile_pre_go_live_outbox(p_cutoff timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_existing timestamptz;
  v_review_required integer := 0;
  v_cancelled integer := 0;
begin
  if p_cutoff is null or p_cutoff > now() + interval '5 minutes' then
    raise exception 'invalid_email_go_live_cutoff' using errcode = '22023';
  end if;

  select email_go_live_at into v_existing
  from public.email_automation_settings
  where id = 'main'
  for update;
  if not found then
    raise exception 'email_automation_settings_missing' using errcode = 'P0002';
  end if;
  if v_existing is not null and v_existing <> p_cutoff then
    raise exception 'email_go_live_cutoff_already_set' using errcode = '22023';
  end if;

  update public.email_automation_settings
  set email_go_live_at = p_cutoff,
      updated_at = now()
  where id = 'main';

  with classified as (
    select o.id,
      case
        when o.reference_type = 'maintenance_record' and m.status in ('open','in_progress') then 'review_required'
        when o.reference_type = 'request' and r.status in ('under_review','approved','returned') then 'review_required'
        else 'cancelled'
      end as next_status
    from public.automation_outbox o
    left join public.maintenance_records m
      on o.reference_type = 'maintenance_record' and o.reference_id = m.id
    left join public.requests r
      on o.reference_type = 'request' and o.reference_id = r.id
    where o.status in ('pending','processing')
      and o.created_at < p_cutoff
  ), changed as (
    update public.automation_outbox o
    set status = c.next_status,
        error_code = case when c.next_status = 'review_required' then 'pre_go_live_review_required' else 'pre_go_live_historical_suppressed' end,
        sanitized_error = case when c.next_status = 'review_required' then 'Pre-go-live notification requires explicit approval' else 'Pre-go-live historical notification suppressed' end,
        locked_at = null,
        lock_token = null
    from classified c
    where o.id = c.id
    returning o.status
  )
  select count(*) filter (where status = 'review_required'), count(*) filter (where status = 'cancelled')
  into v_review_required, v_cancelled
  from changed;

  perform public.automation_edit5_audit(
    'production_pre_go_live_outbox_reconciled',
    'success',
    jsonb_build_object(
      'cutoff', p_cutoff,
      'review_required', v_review_required,
      'cancelled', v_cancelled,
      'reason', 'pre-go-live historical notification suppressed'
    )
  );
  return jsonb_build_object(
    'cutoff', p_cutoff,
    'review_required', v_review_required,
    'cancelled', v_cancelled
  );
end;
$function$;

revoke all on function public.automation_reconcile_pre_go_live_outbox(timestamptz) from public, anon, authenticated;
grant execute on function public.automation_reconcile_pre_go_live_outbox(timestamptz) to service_role;

commit;
