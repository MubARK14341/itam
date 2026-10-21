-- Purpose: seed the 13 owner-approved high-confidence catalog models.
-- Scope: INSERT into public.models only; public.assets is not read or written.
-- Risk: low; exact active category/company matches are required and the insert
--       is idempotent through the existing unique indexes.
-- Rollback: intentionally manual. Business master-data DELETE/UPDATE is outside
--           this migration's authorized scope; deactivate reviewed rows through
--           the catalog UI if the owner later rejects one.

with wanted(category_name_ar, company_name, model_name) as (
  values
    ('قارئ باركود','Honeywell','EDA51-1-B623SQGR'),
    ('طابعة','Matica','XL-8300'),
    ('طابعة','Epson','TM-C3500'),
    ('طابعة','Epson','TM-T20II (M267D)'),
    ('طابعة','Epson','TM-T20III (M267D)'),
    ('لابتوب','HP','15-bs151nx'),
    ('لابتوب','HP','255 G9'),
    ('طابعة','Epson','TM-T20II (M267E)'),
    ('طابعة','Epson','TM-T88VI (M338A)'),
    ('لابتوب','Dell','Latitude 5480'),
    ('طابعة','Epson','L805 (B412C)'),
    ('مودم','TP-LINK','TL-MR100'),
    ('طابعة','HITI','CS-200e')
)
insert into public.models (category_id, company_id, model_name, is_active)
select c.id, co.id, w.model_name, true
from wanted w
join public.categories c
  on c.name_ar = w.category_name_ar
 and c.is_active = true
join public.companies co
  on lower(btrim(co.name)) = lower(btrim(w.company_name))
 and co.is_active = true
on conflict do nothing;
