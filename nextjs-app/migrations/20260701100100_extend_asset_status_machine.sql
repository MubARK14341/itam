-- ============================================================================
--  المرحلة: نظام طلبات العملاء — توسيع آلة حالات الأصل لتشمل rented/sold
--  إضافي وآمن: نعيد تعريف asset_status_allowed بإبقاء كل الانتقالات القائمة
--  وإضافة مسارات التأجير/البيع فقط. لا حذف · لا تغيير بيانات.
--   • available/reserved/assigned → rented (تسليم تأجير) · → sold (تسليم بيع)
--   • rented → available (إرجاع) · in_maintenance/damaged/lost/retired · sold · reserved
--   • sold → available (إلغاء/عكس بيع خاطئ فقط)
-- ============================================================================

create or replace function public.asset_status_allowed(p_old asset_status, p_new asset_status)
returns boolean
language plpgsql
immutable
as $function$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'available'      then p_new in ('assigned','reserved','in_maintenance','damaged','lost','retired','rented','sold')
    when 'assigned'       then p_new in ('available','in_maintenance','damaged','lost','retired','rented','sold')
    when 'reserved'       then p_new in ('available','assigned','in_maintenance','retired','rented','sold')
    when 'in_maintenance' then p_new in ('available','assigned','damaged','retired')
    when 'damaged'        then p_new in ('in_maintenance','lost','retired','disposed')
    when 'lost'           then p_new in ('available','retired')
    when 'retired'        then p_new in ('disposed')
    when 'rented'         then p_new in ('available','reserved','in_maintenance','damaged','lost','retired','sold')
    when 'sold'           then p_new in ('available')
    when 'disposed'       then false
    else false
  end;
end $function$;
