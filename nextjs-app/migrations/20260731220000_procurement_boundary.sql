begin;

-- This is an integration boundary, not an ERP sub-ledger. The existing
-- purchase_requests aggregate remains the requisition. External PO, goods
-- receipt, invoice, and stock receipt references are separate documents.
create table public.procurement_document_refs (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  purchase_request_item_id uuid null references public.purchase_request_items(id),
  document_type text not null check (
    document_type in ('purchase_order', 'goods_receipt', 'invoice', 'stock_receipt')
  ),
  source_system text not null default 'external'
    check (length(btrim(source_system)) between 1 and 100),
  external_reference text not null
    check (length(btrim(external_reference)) between 1 and 200),
  document_status text not null default 'recorded'
    check (document_status in ('recorded', 'confirmed', 'cancelled')),
  stock_transaction_id uuid null references public.consumable_transactions(id),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  recorded_by uuid not null references auth.users(id),
  recorded_at timestamptz not null default now(),
  unique (source_system, document_type, external_reference),
  check (
    (document_type = 'stock_receipt' and stock_transaction_id is not null)
    or (document_type <> 'stock_receipt' and stock_transaction_id is null)
  )
);
create unique index uq_procurement_stock_receipt_transaction
  on public.procurement_document_refs(stock_transaction_id)
  where stock_transaction_id is not null;
create index idx_procurement_document_pr
  on public.procurement_document_refs(purchase_request_id, recorded_at desc);

create table public.procurement_integration_events (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id),
  purchase_request_item_id uuid null references public.purchase_request_items(id),
  document_ref_id uuid null references public.procurement_document_refs(id),
  event_type text not null check (event_type in (
    'purchase_order_recorded',
    'goods_receipt_recorded',
    'goods_receipt_quantity_tracked',
    'invoice_recorded',
    'stock_receipt_posted'
  )),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  recorded_by uuid null references auth.users(id),
  occurred_at timestamptz not null default now()
);
create index idx_procurement_events_pr
  on public.procurement_integration_events(purchase_request_id, occurred_at desc);

create table public.procurement_operation_results (
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, operation_id)
);

alter table public.procurement_document_refs enable row level security;
alter table public.procurement_integration_events enable row level security;
alter table public.procurement_operation_results enable row level security;
revoke all on public.procurement_document_refs from public, anon, authenticated;
revoke all on public.procurement_integration_events from public, anon, authenticated;
revoke all on public.procurement_operation_results from public, anon, authenticated;
grant select on public.procurement_document_refs to authenticated;
grant select on public.procurement_integration_events to authenticated;
grant select on public.procurement_operation_results to authenticated;

create policy procurement_documents_read
on public.procurement_document_refs for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() <> 'employee'
  and (document_type <> 'invoice' or public.is_financial_viewer())
);
create policy procurement_events_read
on public.procurement_integration_events for select to authenticated
using (
  public.is_approved()
  and public.app_user_role() <> 'employee'
  and (
    event_type <> 'invoice_recorded'
    or public.is_financial_viewer()
  )
);
create policy procurement_operation_self
on public.procurement_operation_results for select to authenticated
using (
  actor_id = auth.uid()
  and public.is_approved()
  and public.app_user_role() <> 'employee'
);

create or replace function public.procurement_record_external_document(
  p_purchase_request_id uuid,
  p_purchase_request_item_id uuid,
  p_document_type text,
  p_source_system text,
  p_external_reference text,
  p_document_status text,
  p_stock_transaction_id uuid,
  p_metadata jsonb,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_pr_status text;
  v_item_consumable_id uuid;
  v_txn_consumable_id uuid;
  v_txn_type text;
  v_id uuid;
  v_result jsonb;
  v_event_type text;
begin
  if (
       not public.current_user_has_capability('purchase.manage')
       and public.app_user_role() <> 'warehouse_manager'
     )
     or p_operation_id is null
     or p_document_type not in (
       'purchase_order', 'goods_receipt', 'invoice', 'stock_receipt'
     )
     or coalesce(nullif(btrim(p_source_system), ''), '') = ''
     or coalesce(nullif(btrim(p_external_reference), ''), '') = ''
     or coalesce(p_document_status, 'recorded') not in (
       'recorded', 'confirmed', 'cancelled'
     )
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_document_type = 'invoice' and not public.is_financial_viewer() then
    return jsonb_build_object('ok', false, 'error', 'financial_not_authorized');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text || ':' || p_operation_id::text, 0)
  );
  select result into v_result
  from public.procurement_operation_results
  where actor_id = v_uid and operation_id = p_operation_id;
  if found then return v_result; end if;

  select status into v_pr_status
  from public.purchase_requests
  where id = p_purchase_request_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'purchase_request_not_found');
  end if;
  if v_pr_status in ('draft', 'submitted', 'cancelled') then
    return jsonb_build_object('ok', false, 'error', 'invalid_purchase_request_state');
  end if;

  if p_purchase_request_item_id is not null then
    select consumable_id into v_item_consumable_id
    from public.purchase_request_items
    where id = p_purchase_request_item_id
      and purchase_request_id = p_purchase_request_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'purchase_request_item_mismatch');
    end if;
  end if;

  if p_document_type = 'stock_receipt' then
    if p_purchase_request_item_id is null or p_stock_transaction_id is null then
      return jsonb_build_object('ok', false, 'error', 'stock_receipt_links_required');
    end if;
    select consumable_id, txn_type::text
    into v_txn_consumable_id, v_txn_type
    from public.consumable_transactions
    where id = p_stock_transaction_id;
    if not found or v_txn_type <> 'in'
       or v_txn_consumable_id is distinct from v_item_consumable_id then
      return jsonb_build_object('ok', false, 'error', 'invalid_stock_transaction');
    end if;
    if not exists (
      select 1 from public.procurement_document_refs d
      where d.purchase_request_id = p_purchase_request_id
        and d.purchase_request_item_id = p_purchase_request_item_id
        and d.document_type = 'goods_receipt'
        and d.document_status <> 'cancelled'
    ) then
      return jsonb_build_object('ok', false, 'error', 'goods_receipt_required');
    end if;
  elsif p_stock_transaction_id is not null then
    return jsonb_build_object('ok', false, 'error', 'unexpected_stock_transaction');
  end if;

  insert into public.procurement_document_refs(
    purchase_request_id, purchase_request_item_id, document_type,
    source_system, external_reference, document_status,
    stock_transaction_id, metadata, recorded_by
  ) values (
    p_purchase_request_id, p_purchase_request_item_id, p_document_type,
    btrim(p_source_system), btrim(p_external_reference),
    coalesce(p_document_status, 'recorded'), p_stock_transaction_id,
    coalesce(p_metadata, '{}'::jsonb), v_uid
  ) returning id into v_id;

  v_event_type := case p_document_type
    when 'purchase_order' then 'purchase_order_recorded'
    when 'goods_receipt' then 'goods_receipt_recorded'
    when 'invoice' then 'invoice_recorded'
    when 'stock_receipt' then 'stock_receipt_posted'
  end;
  insert into public.procurement_integration_events(
    purchase_request_id, purchase_request_item_id, document_ref_id,
    event_type, payload, recorded_by
  ) values (
    p_purchase_request_id, p_purchase_request_item_id, v_id,
    v_event_type,
    jsonb_build_object(
      'source_system', btrim(p_source_system),
      'external_reference', btrim(p_external_reference),
      'document_status', coalesce(p_document_status, 'recorded'),
      'stock_effect', p_document_type = 'stock_receipt'
    ),
    v_uid
  );
  v_result := jsonb_build_object(
    'ok', true, 'id', v_id, 'document_type', p_document_type,
    'stock_effect', p_document_type = 'stock_receipt'
  );
  insert into public.procurement_operation_results(actor_id, operation_id, result)
  values (v_uid, p_operation_id, v_result);
  return v_result;
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'duplicate_document_reference');
end
$function$;

-- Legacy received_quantity is only a goods-receipt tracking fact. Emit an
-- explicit no-stock event so downstream integrations cannot interpret it as a
-- stock ledger posting.
create or replace function public._procurement_legacy_receipt_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.received_quantity > old.received_quantity then
    insert into public.procurement_integration_events(
      purchase_request_id, purchase_request_item_id, event_type, payload, recorded_by
    ) values (
      new.purchase_request_id,
      new.id,
      'goods_receipt_quantity_tracked',
      jsonb_build_object(
        'quantity_delta', new.received_quantity - old.received_quantity,
        'tracked_total', new.received_quantity,
        'stock_effect', false,
        'semantic', 'goods_receipt_tracking_only'
      ),
      auth.uid()
    );
  end if;
  return new;
end
$function$;

drop trigger if exists trg_procurement_legacy_receipt_event
  on public.purchase_request_items;
create trigger trg_procurement_legacy_receipt_event
after update of received_quantity on public.purchase_request_items
for each row execute function public._procurement_legacy_receipt_event();

create or replace function public.purchase_request_procurement_state(
  p_purchase_request_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select case
    when not public.is_approved()
      or public.app_user_role() = 'employee' then
      jsonb_build_object('ok', false, 'error', 'not_authorized')
    when not exists (
      select 1 from public.purchase_requests where id = p_purchase_request_id
    ) then
      jsonb_build_object('ok', false, 'error', 'not_found')
    else jsonb_build_object(
      'ok', true,
      'purchase_request_id', p_purchase_request_id,
      'legacy_received_semantic', 'goods_receipt_tracking_only',
      'legacy_received_has_stock_effect', false,
      'purchase_orders', (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'purchase_order' and document_status <> 'cancelled'
      ),
      'goods_receipts', (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'goods_receipt' and document_status <> 'cancelled'
      ),
      'invoices', case when public.is_financial_viewer() then (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'invoice' and document_status <> 'cancelled'
      ) else null end,
      'stock_receipts', (
        select count(*) from public.procurement_document_refs
        where purchase_request_id = p_purchase_request_id
          and document_type = 'stock_receipt' and document_status <> 'cancelled'
      )
    )
  end
$function$;

comment on column public.purchase_request_items.received_quantity is
  'Legacy goods-receipt quantity tracking only; it never posts stock. Stock changes require consumable_stock_move plus a separate stock_receipt document reference.';
comment on column public.purchase_requests.status is
  'Legacy received/partially_received statuses mean goods-receipt tracking only, never stock ledger posting.';
comment on table public.procurement_document_refs is
  'External procurement document boundary. References only; not an AP, GL, or ERP sub-ledger.';

revoke all on function public.procurement_record_external_document(
  uuid,uuid,text,text,text,text,uuid,jsonb,uuid
) from public, anon;
revoke all on function public._procurement_legacy_receipt_event()
  from public, anon, authenticated;
revoke all on function public.purchase_request_procurement_state(uuid)
  from public, anon;
grant execute on function public.procurement_record_external_document(
  uuid,uuid,text,text,text,text,uuid,jsonb,uuid
) to authenticated;
grant execute on function public.purchase_request_procurement_state(uuid)
  to authenticated;

commit;
