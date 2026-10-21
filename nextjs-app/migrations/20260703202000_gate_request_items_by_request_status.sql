-- إصلاح (MEDIUM): سياسات request_items كانت تسمح بالإدراج/الحذف حسب الدور فقط
-- دون النظر لحالة الطلب الأب:
--   • حذف بند من طلب مُسلَّم يقطع الرابط الوحيد بين الطلب والأصل، فيبقى الأصل
--     عالقًا في rented/sold للأبد (request_return/request_complete تمشي على البنود).
--   • إدراج بنود بعد الاعتماد يعدّل نطاق طلب معتمد خارج سير العمل.
--
-- الإصلاح: الإدراج/الحذف مسموحان فقط والطلب في draft/under_review.
-- (تحديث delivered_quantity يتم عبر request_deliver الخادمي — لا يتأثر لأن
--  SECURITY DEFINER يتجاوز RLS، وتحديث العميل المباشر مسحوب أصلًا في 20260701100500.)

drop policy if exists ins_ops on public.request_items;
drop policy if exists del_ops on public.request_items;

create policy ins_ops on public.request_items for insert to authenticated
  with check (
    public.app_user_role() in ('admin','it_manager','technician')
    and exists (
      select 1 from public.requests r
      where r.id = request_id
        and r.status in ('draft','under_review')
    )
  );

create policy del_ops on public.request_items for delete to authenticated
  using (
    public.app_user_role() in ('admin','it_manager','technician')
    and exists (
      select 1 from public.requests r
      where r.id = request_id
        and r.status in ('draft','under_review')
    )
  );
