-- ============================================================================
--  Action Center — تتبّع ومتابعة التنبيهات (إسناد/بدء معالجة/ملاحظات) بلا أن يصبح
--  مصدر الحقيقة: الرقم الأساسي يبقى محسوبًا من البيانات الأصلية (المصدر الموحد).
--  إضافي وآمن: جدولان جديدان فقط. لا حذف/تعديل لأي بيانات حقيقية.
--  قواعد صلبة:
--   • لا يوجد إخفاء يدوي: auto_resolved لا يضبطه إلا sync عندما يختفي السبب من البيانات.
--   • لا كتابة مباشرة من العميل إطلاقًا (لا سياسات insert/update/delete) — كل الكتابة
--     عبر RPCs أدناه (SECURITY DEFINER) بفحوص أدوار داخلية.
--   • metadata بيضاء بالقائمة (label/url فقط) — يستحيل تسريب ماليات حتى لو أخطأ العميل.
--   • pending/rejected/unapproved: لا قراءة (is_approved) ولا تنفيذ (app_user_role تعيد NULL).
-- ============================================================================

create table if not exists public.action_alert_instances (
  id                uuid primary key default gen_random_uuid(),
  stable_key        text unique not null,
  alert_type        text not null,
  entity_type       text not null,
  entity_id         uuid,
  severity          text not null default 'medium',
  status            text not null default 'open',
  assigned_to       uuid references public.app_users(id),
  assigned_by       uuid references public.app_users(id),
  assigned_at       timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  auto_resolved_at  timestamptz,
  reopened_at       timestamptz,
  occurrence_count  integer not null default 1,
  last_action_at    timestamptz,
  metadata          jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint action_alert_status_valid   check (status in ('open','in_progress','auto_resolved','reopened')),
  constraint action_alert_severity_valid check (severity in ('critical','high','medium','low'))
);

create index if not exists idx_action_alerts_status   on public.action_alert_instances(status);
create index if not exists idx_action_alerts_type     on public.action_alert_instances(alert_type);
create index if not exists idx_action_alerts_assigned on public.action_alert_instances(assigned_to);

create table if not exists public.action_alert_events (
  id                 uuid primary key default gen_random_uuid(),
  alert_instance_id  uuid not null references public.action_alert_instances(id) on delete cascade,
  event_type         text not null,
  actor_id           uuid,
  note               text,
  metadata           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  constraint action_alert_event_type_valid check (event_type in
    ('created','seen_again','assigned','unassigned','in_progress','note_added','auto_resolved','reopened'))
);

create index if not exists idx_action_alert_events_instance on public.action_alert_events(alert_instance_id);

-- RLS: قراءة للمعتمدين فقط؛ لا كتابة مباشرة من العميل (كل الكتابة عبر RPC).
alter table public.action_alert_instances enable row level security;
alter table public.action_alert_events    enable row level security;

drop policy if exists sel_auth on public.action_alert_instances;
create policy sel_auth on public.action_alert_instances
  for select to authenticated using (public.is_approved());

drop policy if exists sel_auth on public.action_alert_events;
create policy sel_auth on public.action_alert_events
  for select to authenticated using (public.is_approved());

revoke all on public.action_alert_instances from anon, authenticated;
revoke all on public.action_alert_events    from anon, authenticated;
grant select on public.action_alert_instances to authenticated;
grant select on public.action_alert_events    to authenticated;

-- ---------------------------------------------------------------------------
-- RPC 1: مزامنة المرشّحين (يبنيهم العميل من المصدر الموحد alert-predicates.ts).
--  • upsert حسب stable_key + تحديث آخر ظهور.
--  • عاد بعد auto_resolved ⇒ reopened + عدّاد تكرار.
--  • اختفى من المرشّحين ⇒ auto_resolved (الطريقة الوحيدة للوصول لهذه الحالة).
--  • metadata بقائمة بيضاء (label فقط) — لا ماليات إطلاقًا.
-- ---------------------------------------------------------------------------
create or replace function public.action_alerts_sync(p_candidates jsonb)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role text := public.app_user_role();
  v_keys text[];
  c jsonb;
  v_id uuid;
  v_status text;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then
    return json_build_object('ok', false, 'error', 'bad_input');
  end if;

  select coalesce(array_agg(x->>'stable_key'), '{}') into v_keys
  from jsonb_array_elements(p_candidates) x;

  for c in select * from jsonb_array_elements(p_candidates) loop
    if coalesce(c->>'stable_key','') = '' or coalesce(c->>'alert_type','') = '' then
      continue;
    end if;

    select id, status into v_id, v_status
    from public.action_alert_instances where stable_key = c->>'stable_key';

    if v_id is null then
      insert into public.action_alert_instances
        (stable_key, alert_type, entity_type, entity_id, severity, metadata)
      values (
        c->>'stable_key', c->>'alert_type', coalesce(c->>'entity_type','general'),
        nullif(c->>'entity_id','')::uuid,
        case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else 'medium' end,
        jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int))
      )
      returning id into v_id;
      insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
      values (v_id, 'created', auth.uid());
    else
      update public.action_alert_instances set
        last_seen_at = now(),
        updated_at = now(),
        severity = case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else severity end,
        metadata = jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int)),
        status = case when status = 'auto_resolved' then 'reopened' else status end,
        reopened_at = case when status = 'auto_resolved' then now() else reopened_at end,
        auto_resolved_at = case when status = 'auto_resolved' then null else auto_resolved_at end,
        occurrence_count = case when status = 'auto_resolved' then occurrence_count + 1 else occurrence_count end
      where id = v_id;
      if v_status = 'auto_resolved' then
        insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
        values (v_id, 'reopened', auth.uid());
      end if;
    end if;
  end loop;

  -- الحل التلقائي: المرشّح اختفى من البيانات الأصلية ⇒ المشكلة انحلّت فعلًا.
  insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
  select i.id, 'auto_resolved', auth.uid()
  from public.action_alert_instances i
  where i.status in ('open','in_progress','reopened') and not (i.stable_key = any(v_keys));

  update public.action_alert_instances set
    status = 'auto_resolved', auto_resolved_at = now(), updated_at = now()
  where status in ('open','in_progress','reopened') and not (stable_key = any(v_keys));

  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- RPC 2: الإسناد — admin/it_manager لأي مستخدم (أو null لإلغاء الإسناد)؛
--        technician لنفسه فقط. viewer/auditor/غير المعتمد: ممنوع.
-- ---------------------------------------------------------------------------
create or replace function public.action_alert_assign(p_id uuid, p_user uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if v_role = 'technician' and (p_user is distinct from auth.uid()) then
    return json_build_object('ok', false, 'error', 'self_only');
  end if;
  if p_user is not null and not exists (
    select 1 from public.app_users u where u.id = p_user and coalesce(u.approval_status,'approved') = 'approved'
  ) then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  update public.action_alert_instances set
    assigned_to = p_user,
    assigned_by = case when p_user is null then null else auth.uid() end,
    assigned_at = case when p_user is null then null else now() end,
    last_action_at = now(), updated_at = now()
  where id = p_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  insert into public.action_alert_events (alert_instance_id, event_type, actor_id, metadata)
  values (p_id, case when p_user is null then 'unassigned' else 'assigned' end, auth.uid(),
          jsonb_strip_nulls(jsonb_build_object('assigned_to', p_user)));
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- RPC 3: بدء المعالجة — لا يخفي التنبيه ولا ينقص الرقم؛ حالة متابعة فقط.
-- ---------------------------------------------------------------------------
create or replace function public.action_alert_start(p_id uuid)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  update public.action_alert_instances set
    status = 'in_progress', last_action_at = now(), updated_at = now()
  where id = p_id and status in ('open','reopened');
  if not found then return json_build_object('ok', false, 'error', 'bad_status'); end if;
  insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
  values (p_id, 'in_progress', auth.uid());
  return json_build_object('ok', true);
end $func$;

-- ---------------------------------------------------------------------------
-- RPC 4: ملاحظة متابعة — لا تحل المشكلة ولا تخفي التنبيه.
-- ---------------------------------------------------------------------------
create or replace function public.action_alert_note(p_id uuid, p_note text)
returns json language plpgsql security definer set search_path = public as $func$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if coalesce(btrim(p_note), '') = '' then
    return json_build_object('ok', false, 'error', 'empty_note');
  end if;
  if not exists (select 1 from public.action_alert_instances where id = p_id) then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into public.action_alert_events (alert_instance_id, event_type, actor_id, note)
  values (p_id, 'note_added', auth.uid(), btrim(p_note));
  update public.action_alert_instances set last_action_at = now(), updated_at = now() where id = p_id;
  return json_build_object('ok', true);
end $func$;

-- تحصين التنفيذ: revoke ثم grant للمصادَقين فقط (الفحص الداخلي يحكم الأدوار).
revoke all on function public.action_alerts_sync(jsonb) from public, anon;
revoke all on function public.action_alert_assign(uuid, uuid) from public, anon;
revoke all on function public.action_alert_start(uuid) from public, anon;
revoke all on function public.action_alert_note(uuid, text) from public, anon;
grant execute on function public.action_alerts_sync(jsonb) to authenticated;
grant execute on function public.action_alert_assign(uuid, uuid) to authenticated;
grant execute on function public.action_alert_start(uuid) to authenticated;
grant execute on function public.action_alert_note(uuid, text) to authenticated;

comment on table public.action_alert_instances is
  'مركز الإجراءات: تتبّع التنبيهات المشتقة (إسناد/متابعة). ليس مصدر الحقيقة — الرقم من البيانات الأصلية. auto_resolved عبر sync فقط. metadata بقائمة بيضاء بلا ماليات.';
