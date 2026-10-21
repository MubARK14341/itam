-- Purpose: allow warehouse_manager to use the scan workflow that is core to
-- warehouse preparation/delivery tasks. No other table permission is widened.
-- Rollback: drop policies scan_logs_warehouse_select and scan_logs_warehouse_insert.

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='scan_logs' and policyname='scan_logs_warehouse_select') then
    create policy scan_logs_warehouse_select on public.scan_logs for select to authenticated
      using (public.app_user_role() = 'warehouse_manager');
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='scan_logs' and policyname='scan_logs_warehouse_insert') then
    create policy scan_logs_warehouse_insert on public.scan_logs for insert to authenticated
      with check (public.app_user_role() = 'warehouse_manager');
  end if;
end
$$;
