-- EDIT 4: portal-safe availability and required request facts.
-- This migration is additive and transactional.  Availability is calculated
-- only in SECURITY DEFINER functions; the portal never receives asset-level
-- data, identifiers, locations, reservations, or financial information.
begin;

alter table public.request_items
  add column if not exists portal_model_id uuid references public.models(id),
  add column if not exists available_quantity_at_submission integer,
  add column if not exists shortage_quantity integer not null default 0,
  add column if not exists additional_quantity_requested boolean not null default false,
  add column if not exists availability_snapshot_at timestamptz;

alter table public.request_items
  drop constraint if exists request_items_shortage_quantity_check;
alter table public.request_items
  add constraint request_items_shortage_quantity_check check (shortage_quantity >= 0);
create index if not exists request_items_portal_model_id_idx on public.request_items(portal_model_id)
  where portal_model_id is not null;
create index if not exists request_items_consumable_open_reservation_idx
  on public.request_items(consumable_id, request_id) where consumable_id is not null;

-- The sole portal projection for a selected item.  It deliberately returns
-- just a type and aggregate ATP value after checking the authenticated
-- customer's existing catalog/category/company policy.
create or replace function public.portal_item_availability(
  p_item_type text,
  p_category_id uuid default null,
  p_model_id uuid default null,
  p_consumable_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_cid uuid := public.portal_customer_id();
  v_available integer := 0;
begin
  if v_cid is null or not (public._portal_settings(v_cid)).portal_enabled then
    return jsonb_build_object('ok', false, 'error', 'not_portal');
  end if;
  if p_item_type = 'durable' then
    if p_category_id is null or p_model_id is null or not exists (
      select 1 from public.portal_list_catalog() c
      where c.category_id = p_category_id and c.model_id = p_model_id
    ) then
      return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed');
    end if;
    select count(*)::int into v_available
    from public.assets a
    where a.category_id = p_category_id
      and a.model_id = p_model_id
      and a.is_active and a.archived_at is null
      and a.status = 'available'
      and a.assigned_to_employee_id is null
      and not exists (select 1 from public.asset_assignments aa where aa.asset_id = a.id and aa.status = 'active')
      and not exists (
        select 1 from public.request_asset_allocations ra
        where ra.asset_id = a.id and ra.state in ('selected', 'prepared', 'delivered')
      );
  elsif p_item_type = 'consumable' then
    if p_consumable_id is null or not exists (
      select 1 from public.portal_list_consumables() c where c.consumable_id = p_consumable_id
    ) then
      return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed');
    end if;
    select greatest(c.quantity_on_hand - coalesce((
      select sum(greatest(ri.quantity - coalesce(ri.delivered_quantity, 0), 0))::int
      from public.request_items ri
      join public.requests r on r.id = ri.request_id
      where ri.consumable_id = c.id
        and r.status in ('under_review', 'approved', 'auto_provisioning', 'provisioned', 'stock_shortage', 'preparing', 'ready_for_pickup')
        and r.portal_approval_status <> 'rejected_by_project_manager'
    ), 0), 0) into v_available
    from public.consumables c where c.id = p_consumable_id and c.is_active;
    if not found then return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed'); end if;
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_item_type');
  end if;
  return jsonb_build_object('ok', true, 'item_type', p_item_type, 'available_quantity', coalesce(v_available, 0));
end $function$;

-- The previous function is intentionally replaced (not overloaded) so every
-- portal client invokes the same validated submission path.
drop function if exists public.portal_add_item(uuid, text, text, text, numeric, text, boolean, boolean, uuid, text);
drop function if exists public.portal_add_item(uuid, text, text, text, numeric, text, boolean, boolean, uuid, text, uuid, uuid, boolean);
create function public.portal_add_item(
  p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text,
  p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean,
  p_preferred_company_id uuid default null, p_category_key text default null,
  p_model_id uuid default null, p_consumable_id uuid default null,
  p_additional_quantity_requested boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_req public.requests%rowtype; v_result jsonb; v_available integer; v_category text; v_category_id uuid;
begin
  if v_cid is null or v_role = 'viewer' then return jsonb_build_object('ok', false, 'error', 'not_authorized'); end if;
  if p_quantity is null or p_quantity < 1 or p_quantity <> floor(p_quantity) then return jsonb_build_object('ok', false, 'error', 'invalid_quantity'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid or v_req.status <> 'draft' then return jsonb_build_object('ok', false, 'error', 'invalid_state'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_requested_kind = 'consumable' then
    select public.portal_item_availability('consumable', null, null, p_consumable_id) into v_result;
    if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
    select cat.name_ar into v_category from public.consumables c join public.categories cat on cat.id=c.category_id where c.id=p_consumable_id;
    v_available := (v_result->>'available_quantity')::int;
    if p_quantity > v_available and not coalesce(p_additional_quantity_requested, false) then return jsonb_build_object('ok', false, 'error', 'additional_quantity_acknowledgement_required'); end if;
    insert into public.request_items(request_id,item_kind,requested_kind,requested_description,requested_category,consumable_id,quantity,preferred_model,accept_alternative,needs_purchase,additional_quantity_requested)
    values(p_request_id,'consumable','consumable',nullif(btrim(p_requested_description),''),coalesce(v_category,nullif(btrim(p_requested_category),'')),p_consumable_id,p_quantity,null,false,false,coalesce(p_additional_quantity_requested,false));
  elsif p_requested_kind = 'existing_asset' then
    -- Resolve the selected model's category server-side; no client category or
    -- company value participates in the availability decision.
    if p_model_id is null then return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed'); end if;
    select m.category_id into strict v_category_id from public.models m where m.id = p_model_id;
    select public.portal_item_availability('durable', v_category_id, p_model_id, null) into v_result;
    if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
    v_available := (v_result->>'available_quantity')::int;
    if p_quantity > v_available and not coalesce(p_additional_quantity_requested, false) then return jsonb_build_object('ok', false, 'error', 'additional_quantity_acknowledgement_required'); end if;
    insert into public.request_items(request_id,item_kind,requested_kind,requested_description,requested_category,quantity,preferred_model,portal_model_id,accept_alternative,needs_purchase,additional_quantity_requested)
    values(p_request_id,'custom','existing_asset',nullif(btrim(p_requested_description),''),nullif(btrim(p_requested_category),''),p_quantity,nullif(btrim(p_preferred_model),''),p_model_id,coalesce(p_accept_alternative,true),false,coalesce(p_additional_quantity_requested,false));
  elsif p_requested_kind = 'custom' then
    if nullif(btrim(p_requested_description),'') is null then return jsonb_build_object('ok', false, 'error', 'description_required'); end if;
    insert into public.request_items(request_id,item_kind,requested_kind,requested_description,requested_category,quantity,accept_alternative,needs_purchase)
    values(p_request_id,'custom','custom',nullif(btrim(p_requested_description),''),nullif(btrim(p_requested_category),''),p_quantity,coalesce(p_accept_alternative,false),coalesce(p_needs_purchase,false));
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_kind');
  end if;
  return jsonb_build_object('ok', true);
exception when no_data_found then return jsonb_build_object('ok', false, 'error', 'catalog_item_not_allowed');
end $function$;

create or replace function public.portal_create_request(
  p_project_name text, p_project_city text, p_contact_phone text, p_contact_email text,
  p_request_type text, p_pickup_date date, p_return_date date, p_notes text
) returns json language plpgsql security definer set search_path = public, pg_temp
as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_id uuid; v_phone text; v_email text; v_name text;
begin
  if v_cid is null or v_role = 'viewer' or not (public._portal_settings(v_cid)).portal_enabled then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  if nullif(btrim(p_project_name),'') is null or length(btrim(p_project_name)) > 160 then return jsonb_build_object('ok',false,'error','project_name_required'); end if;
  if nullif(btrim(p_project_city),'') is null or length(btrim(p_project_city)) > 120 then return jsonb_build_object('ok',false,'error','city_required'); end if;
  if p_pickup_date is null then return jsonb_build_object('ok',false,'error','delivery_date_required'); end if;
  if p_pickup_date < (now() at time zone 'Asia/Riyadh')::date then return jsonb_build_object('ok',false,'error','delivery_date_in_past'); end if;
  select phone into v_phone from public.customer_portal_users where id=auth.uid() and is_active;
  select email into v_email from auth.users where id=auth.uid(); select name into v_name from public.customers where id=v_cid;
  if nullif(btrim(v_phone),'') is null then return jsonb_build_object('ok',false,'error','phone_required'); end if;
  insert into public.requests(customer_id,customer_name_snapshot,contact_phone_snapshot,contact_email_snapshot,project_name,project_city,request_type,status,request_source,submitted_by,pickup_date,return_date,notes,created_by)
  values(v_cid,v_name,v_phone,v_email,btrim(p_project_name),btrim(p_project_city),'rental','draft','client_portal',auth.uid(),p_pickup_date,p_return_date,nullif(btrim(p_notes),''),auth.uid()) returning id into v_id;
  return jsonb_build_object('ok',true,'id',v_id);
end $function$;

create or replace function public.portal_submit_request(p_request_id uuid)
returns json language plpgsql security definer set search_path = public, pg_temp
as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype; v_s public.customer_portal_settings; v_line record; v_available jsonb; v_qty int; v_shortage int := 0; v_requires_return boolean;
begin
  if v_cid is null or v_role = 'viewer' then return jsonb_build_object('ok',false,'error','not_authorized'); end if;
  v_s := public._portal_settings(v_cid); if not v_s.portal_enabled then return jsonb_build_object('ok',false,'error','portal_disabled'); end if;
  select * into v_req from public.requests where id=p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid or v_req.status <> 'draft' or v_req.portal_approval_status <> 'not_required' then return jsonb_build_object('ok',false,'error','invalid_state'); end if;
  if nullif(btrim(v_req.project_name),'') is null then return jsonb_build_object('ok',false,'error','project_name_required'); end if;
  if nullif(btrim(v_req.project_city),'') is null then return jsonb_build_object('ok',false,'error','city_required'); end if;
  if v_req.pickup_date is null then return jsonb_build_object('ok',false,'error','delivery_date_required'); end if;
  if v_req.pickup_date < (now() at time zone 'Asia/Riyadh')::date then return jsonb_build_object('ok',false,'error','delivery_date_in_past'); end if;
  if not exists(select 1 from public.request_items where request_id=p_request_id) then return jsonb_build_object('ok',false,'error','no_items'); end if;
  select exists(select 1 from public.request_items where request_id=p_request_id and portal_model_id is not null) into v_requires_return;
  if v_requires_return and v_req.return_date is null then return jsonb_build_object('ok',false,'error','return_date_required'); end if;
  if v_requires_return and v_req.return_date <= v_req.pickup_date then return jsonb_build_object('ok',false,'error','return_date_invalid'); end if;
  for v_line in select * from public.request_items where request_id=p_request_id for update loop
    if v_line.portal_model_id is not null then select public.portal_item_availability('durable', (select category_id from public.models where id=v_line.portal_model_id), v_line.portal_model_id, null) into v_available;
    elsif v_line.consumable_id is not null then select public.portal_item_availability('consumable',null,null,v_line.consumable_id) into v_available;
    else continue; end if;
    if not coalesce((v_available->>'ok')::boolean,false) then return jsonb_build_object('ok',false,'error','availability_unavailable'); end if;
    v_qty:=coalesce(v_line.quantity,0)::int; v_shortage:=greatest(v_qty-coalesce((v_available->>'available_quantity')::int,0),0);
    if v_shortage>0 and not v_line.additional_quantity_requested then return jsonb_build_object('ok',false,'error','additional_quantity_acknowledgement_required'); end if;
    update public.request_items set available_quantity_at_submission=coalesce((v_available->>'available_quantity')::int,0),shortage_quantity=v_shortage,availability_snapshot_at=now(),needs_purchase=case when v_shortage>0 then true else needs_purchase end where id=v_line.id;
  end loop;
  if v_role='authorized_requester' and v_s.require_project_manager_approval then
    update public.requests set portal_approval_status='pending_project_manager',portal_approval_requested_by=auth.uid(),portal_approval_requested_at=now() where id=p_request_id;
    perform public._request_add_event(p_request_id,'portal_pm_approval_requested','portal',null,jsonb_build_object('availability_snapshot',true));
    return jsonb_build_object('ok',true,'pending_pm',true);
  end if;
  update public.requests set status='under_review',portal_approval_status=case when v_role='project_manager' and v_s.require_project_manager_approval then 'approved_by_project_manager' else portal_approval_status end,portal_approved_by=case when v_role='project_manager' and v_s.require_project_manager_approval then auth.uid() else portal_approved_by end,portal_approved_at=case when v_role='project_manager' and v_s.require_project_manager_approval then now() else portal_approved_at end where id=p_request_id;
  perform public._request_add_event(p_request_id,'submitted','portal',null,jsonb_build_object('availability_snapshot',true));
  return jsonb_build_object('ok',true,'pending_pm',false);
end $function$;

revoke all on function public.portal_item_availability(text,uuid,uuid,uuid), public.portal_add_item(uuid,text,text,text,numeric,text,boolean,boolean,uuid,text,uuid,uuid,boolean), public.portal_create_request(text,text,text,text,text,date,date,text), public.portal_submit_request(uuid) from public, anon;
grant execute on function public.portal_item_availability(text,uuid,uuid,uuid), public.portal_add_item(uuid,text,text,text,numeric,text,boolean,boolean,uuid,text,uuid,uuid,boolean), public.portal_create_request(text,text,text,text,text,date,date,text), public.portal_submit_request(uuid) to authenticated;
commit;
