-- =====================================================================
-- Purpose: السماح بربط بند بالمخزون (request_item_fulfill) وتحويله إلى طلب شراء
--          (request_item_convert_to_pr) أثناء حالتَي provisioned/stock_shortage —
--          لتمكين قرارات النقص (تحويل الناقص لشراء / ربط يدوي) بعد التجهيز التلقائي.
-- Risk:    منخفض — يوسّع حارس الحالة في دالتين قائمتين (منح لا تقييد)، بلا تغيير آخر.
-- Rollback: إعادة الحارسَين لقائمتهما السابقة.
-- =====================================================================
do $mig$
declare def text; fn text;
  fns text[] := array['public.request_item_fulfill(uuid,uuid,uuid)','public.request_item_convert_to_pr(uuid,uuid)'];
begin
  foreach fn in array fns loop
    select pg_get_functiondef(fn::regprocedure) into def;
    if position($q$'under_review','needs_clarification','approved','preparing','provisioned','stock_shortage'$q$ in def) = 0 then
      def := replace(def,
        $q$'under_review','needs_clarification','approved','preparing'$q$,
        $q$'under_review','needs_clarification','approved','preparing','provisioned','stock_shortage'$q$);
      execute def;
    end if;
  end loop;
end $mig$;
