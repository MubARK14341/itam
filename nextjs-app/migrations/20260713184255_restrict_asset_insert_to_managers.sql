-- Purpose: align asset creation enforcement with the admin/it_manager UI rule.
-- Additive RESTRICTIVE policy; the existing ins_ops policy is preserved.
-- Rollback: drop policy assets_insert_managers_restrictive on public.assets;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='assets'
      and policyname='assets_insert_managers_restrictive'
  ) then
    create policy assets_insert_managers_restrictive
      on public.assets
      as restrictive
      for insert
      to authenticated
      with check (public.app_user_role() in ('admin','it_manager'));
  end if;
end
$$;
