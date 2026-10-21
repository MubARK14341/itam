-- ============================================================================
--  Client Portal — Phase 1 (1/3): سجل أحداث الطلب (request_events)
--  Append-only. الكتابة عبر دوال SECURITY DEFINER فقط (لا إدراج/تعديل/حذف مباشر من العميل).
--  القراءة: الموظفون المعتمدون (is_approved). العميل يقرأ لاحقًا عبر portal_* RPC حصراً.
--  ✅ إضافي وآمن: لا DROP/DELETE على بيانات · لا anon · لا لمس منطق المخزون.
-- ============================================================================

create table if not exists public.request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  event_type text not null,
  actor_kind text not null check (actor_kind in ('staff','portal','system')),
  actor_id uuid null,
  message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_request_events_request on public.request_events(request_id, created_at);

alter table public.request_events enable row level security;

-- لا anon. قراءة فقط للموظفين المعتمدين؛ لا إدراج/تعديل/حذف مباشر (الكتابة عبر الدوال الخادمية).
revoke all on public.request_events from anon;
grant select on public.request_events to authenticated;

drop policy if exists sel_auth on public.request_events;
create policy sel_auth on public.request_events for select to authenticated using (public.is_approved());

-- محدِّد نوع الفاعل (staff/system الآن؛ يُوسَّع لـ portal في المرحلة 2 دون لمس المحفّز).
create or replace function public._request_actor_kind()
returns text language sql stable security definer set search_path = public as $$
  select case when public.app_user_role() is not null then 'staff' else 'system' end;
$$;

-- مُسجِّل حدث داخلي — يُستدعى حصراً من دوال SECURITY DEFINER أخرى (revoke عن الجميع).
create or replace function public._request_add_event(
  p_request_id uuid, p_event_type text, p_actor_kind text,
  p_message text default null, p_metadata jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.request_events(request_id, event_type, actor_kind, actor_id, message, metadata)
  values (p_request_id, p_event_type, p_actor_kind, auth.uid(), nullif(p_message,''), coalesce(p_metadata,'{}'::jsonb));
$$;

-- تسجيل تلقائي لكل تغيّر حالة (يغطي كل RPCs التسليم/الإرجاع/الإلغاء دون لمسها).
create or replace function public.requests_log_status_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into public.request_events(request_id, event_type, actor_kind, actor_id, metadata)
    values (new.id, 'status_changed', public._request_actor_kind(), auth.uid(),
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end $$;

drop trigger if exists trg_requests_log_status_event on public.requests;
create trigger trg_requests_log_status_event after update on public.requests
  for each row execute function public.requests_log_status_event();

revoke all on function public._request_actor_kind() from public, anon, authenticated;
revoke all on function public._request_add_event(uuid, text, text, text, jsonb) from public, anon, authenticated;
