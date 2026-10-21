-- ============================================================================
--  Serial Exemption — إعفاء موثَّق للأصول التي لا تملك رقمًا تسلسليًا فعليًا.
--  إضافي وآمن: أعمدة جديدة nullable/default على assets فقط. لا يلمس أي بيانات.
--  الأصل يخرج من تنبيه «بدون رقم تسلسلي» إذا امتلأ serial_number أو أُعفي بقرار
--  موثَّق (سبب إجباري + من/متى، يختمها الخادم).
--  ⚠ جداول HIGH-1 تستخدم grants أعمدة للقراءة — الأعمدة الجديدة تحتاج grant صريحًا.
--  الكتابة: منح الجدول القائم يسمح بها، لكن trigger حارس يقصر تعديل حقول الإعفاء
--  على admin/it_manager حصرًا (نفس فلسفة حارس تكلفة الصيانة).
-- ============================================================================

alter table public.assets
  add column if not exists serial_exempt boolean not null default false,
  add column if not exists serial_exempt_reason text,
  add column if not exists serial_exempted_by uuid references public.app_users(id),
  add column if not exists serial_exempted_at timestamptz;

comment on column public.assets.serial_exempt is
  'إعفاء موثق من الرقم التسلسلي (لا يملك serial فعليًا). يعدّله admin/it_manager فقط عبر trigger حارس.';

-- HIGH-1: القراءة column-level — الأعمدة الجديدة غير مالية فتُمنح للقراءة صراحة.
grant select (serial_exempt, serial_exempt_reason, serial_exempted_by, serial_exempted_at)
  on public.assets to authenticated;

-- حارس حقول الإعفاء: تعديلها للمدراء فقط + سبب إجباري عند الإعفاء + ختم من/متى بالخادم.
create or replace function public.assets_guard_serial_exempt()
returns trigger language plpgsql set search_path = public as $func$
declare
  v_changed boolean;
begin
  if tg_op = 'UPDATE' then
    v_changed := new.serial_exempt is distinct from old.serial_exempt
      or new.serial_exempt_reason is distinct from old.serial_exempt_reason
      or new.serial_exempted_by is distinct from old.serial_exempted_by
      or new.serial_exempted_at is distinct from old.serial_exempted_at;
    if not v_changed then return new; end if;
  elsif tg_op = 'INSERT' then
    if not new.serial_exempt then return new; end if;
  end if;

  if coalesce(public.app_user_role(), '') not in ('admin','it_manager') then
    raise exception 'serial_exempt_forbidden';
  end if;

  if new.serial_exempt then
    if coalesce(btrim(new.serial_exempt_reason), '') = '' then
      raise exception 'serial_exempt_reason_required';
    end if;
    new.serial_exempted_by := auth.uid();
    new.serial_exempted_at := now();
  else
    -- إلغاء الإعفاء: تُنظَّف حقول التوثيق.
    new.serial_exempt_reason := null;
    new.serial_exempted_by := null;
    new.serial_exempted_at := null;
  end if;
  return new;
end $func$;

drop trigger if exists trg_assets_guard_serial_exempt on public.assets;
create trigger trg_assets_guard_serial_exempt
  before insert or update on public.assets
  for each row execute function public.assets_guard_serial_exempt();
