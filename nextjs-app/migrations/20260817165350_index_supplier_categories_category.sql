-- Purpose: cover the supplier_categories category foreign key and category-first lookups.
-- Risk: additive btree index only; no rows or access policies change.
-- Rollback: drop index if exists public.supplier_categories_category_id_idx;

create index if not exists supplier_categories_category_id_idx
  on public.supplier_categories (category_id, supplier_id);
