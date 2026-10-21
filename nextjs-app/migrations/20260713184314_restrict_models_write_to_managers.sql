-- Purpose: prevent technician writes to catalog models while preserving reads.
-- Additive command-specific RESTRICTIVE policies; existing policies stay intact.
-- Rollback: drop the three models_*_managers_restrictive policies.

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='models' and policyname='models_insert_managers_restrictive') then
    create policy models_insert_managers_restrictive on public.models as restrictive for insert to authenticated
      with check (public.app_user_role() in ('admin','it_manager'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='models' and policyname='models_update_managers_restrictive') then
    create policy models_update_managers_restrictive on public.models as restrictive for update to authenticated
      using (public.app_user_role() in ('admin','it_manager'))
      with check (public.app_user_role() in ('admin','it_manager'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='models' and policyname='models_delete_managers_restrictive') then
    create policy models_delete_managers_restrictive on public.models as restrictive for delete to authenticated
      using (public.app_user_role() in ('admin','it_manager'));
  end if;
end
$$;
