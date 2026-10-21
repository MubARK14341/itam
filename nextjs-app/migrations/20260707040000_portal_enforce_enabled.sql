-- 20260707040000_portal_enforce_enabled.sql
-- PRODUCTION COMPLETION FIXES — RC1 TO REAL USE / STEP 4
-- Enforce customer_portal_settings.portal_enabled FAIL-CLOSED across ALL portal RPCs.
--
-- Before this migration: the shared helper _portal_settings() synthesized portal_enabled=TRUE
-- when a customer had no settings row (fail-OPEN), and most READ RPCs never consulted
-- portal_enabled at all (only portal_get_request_dashboard + the write RPCs did).
--
-- After this migration:
--   1. No settings row  => portal DISABLED (fail-closed) — durable guarantee for every future customer.
--   2. All 7 previously-ungated read RPCs return 'portal_disabled' (or, for get_context, a well-formed
--      disabled context so the portal shell renders its banner instead of bouncing to /dashboard).
--   3. Both storage guard functions (upload/read) honor portal_enabled.
--   4. An explicit settings row (portal_enabled=false) is persisted for every existing customer,
--      recording the "off until an admin enables it" decision.
--
-- Safety: every statement is CREATE OR REPLACE FUNCTION or INSERT ... ON CONFLICT DO NOTHING.
-- No DROP, no DELETE, no ALTER ... DEFAULT, no signature changes (grants preserved by CREATE OR REPLACE).
-- Idempotent / re-runnable. Does not touch write RPCs (already gated) or Public QR.

begin;

-- ---------------------------------------------------------------------------
-- 1) Shared helper: flip the no-row synthesis to fail-closed (portal_enabled=false).
--    Only the synthesized-default block changes; allow_* stay true (moot — every gate
--    checks portal_enabled first and short-circuits with 'portal_disabled').
-- ---------------------------------------------------------------------------
create or replace function public._portal_settings(p_customer_id uuid)
returns public.customer_portal_settings
language plpgsql stable security definer set search_path = public as $function$
declare v public.customer_portal_settings;
begin
  select * into v from public.customer_portal_settings where customer_id = p_customer_id;
  if not found then
    v.customer_id                      := p_customer_id;
    v.portal_enabled                   := false;   -- CHANGED: fail-closed (no row = portal OFF)
    v.allow_rental_requests            := true;
    v.allow_purchase_requests          := true;
    v.allow_maintenance_requests       := true;
    v.allow_custom_requests            := true;
    v.allow_custom_item_requests       := true;
    v.allow_attachments                := true;
    v.require_project_manager_approval := false;
  end if;
  return v;
end $function$;
-- Preserve the original hardening: this helper is callable only from other DEFINER RPCs.
revoke all on function public._portal_settings(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) portal_get_context: MUST keep ok:true when disabled so getPortalContext() returns a
--    non-null context and the layout renders the "portal disabled" banner (client-portal/
--    layout.tsx:65-70) instead of redirecting to /dashboard (layout.tsx:22). Withhold the
--    allow_* capability flags + counts so the request form cannot be driven while disabled.
-- ---------------------------------------------------------------------------
create or replace function public.portal_get_context()
returns json language plpgsql stable security definer set search_path = public as $function$
declare
  v_cid uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_name text; v_contact text;
  v_s public.customer_portal_settings;
  v_companies int; v_categories int;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  select c.name, pu.contact_name into v_name, v_contact
    from public.customer_portal_users pu join public.customers c on c.id = pu.customer_id
    where pu.id = auth.uid() and pu.is_active = true;
  v_s := public._portal_settings(v_cid);

  if not v_s.portal_enabled then
    return json_build_object('ok', true,
      'customer_name', v_name, 'contact_name', v_contact, 'portal_role', v_role,
      'portal_enabled', false, 'disabled', true,
      'allow_rental_requests', false, 'allow_purchase_requests', false,
      'allow_maintenance_requests', false, 'allow_custom_requests', false,
      'allow_custom_item_requests', false, 'allow_attachments', false,
      'require_project_manager_approval', false,
      'allowed_companies_count', 0, 'allowed_categories_count', 0
    );
  end if;

  select count(*) into v_companies  from public.customer_allowed_companies  where customer_id = v_cid;
  select count(*) into v_categories from public.customer_allowed_categories where customer_id = v_cid;
  return json_build_object('ok', true,
    'customer_name', v_name, 'contact_name', v_contact, 'portal_role', v_role,
    'portal_enabled', true, 'disabled', false,
    'allow_rental_requests', v_s.allow_rental_requests,
    'allow_purchase_requests', v_s.allow_purchase_requests,
    'allow_maintenance_requests', v_s.allow_maintenance_requests,
    'allow_custom_requests', v_s.allow_custom_requests,
    'allow_custom_item_requests', v_s.allow_custom_item_requests,
    'allow_attachments', v_s.allow_attachments,
    'require_project_manager_approval', v_s.require_project_manager_approval,
    'allowed_companies_count', v_companies,
    'allowed_categories_count', v_categories
  );
end $function$;

-- ---------------------------------------------------------------------------
-- 3) The 6 remaining read RPCs: return {ok:false, error:'portal_disabled'} when disabled
--    (matches the precedent of portal_get_request_dashboard + the frontend's !ok handler).
-- ---------------------------------------------------------------------------
create or replace function public.portal_list_requests()
returns json language plpgsql stable security definer set search_path = public as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
        v_s public.customer_portal_settings;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  return json_build_object('ok', true, 'requests', coalesce((
    select json_agg(json_build_object(
      'id', r.id, 'request_number', r.request_number, 'status', r.status,
      'portal_approval_status', r.portal_approval_status,
      'request_type', r.request_type, 'project_name', r.project_name, 'project_city', r.project_city,
      'pickup_date', r.pickup_date, 'return_date', r.return_date, 'created_at', r.created_at,
      'item_count', (select count(*) from public.request_items ri where ri.request_id = r.id)
    ) order by r.created_at desc)
    from public.requests r
    where r.customer_id = v_cid
      and (v_role in ('project_manager','viewer') or r.submitted_by = auth.uid())
  ), '[]'::json));
end $function$;

create or replace function public.portal_get_request(p_request_id uuid)
returns json language plpgsql stable security definer set search_path = public as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
        v_req public.requests%rowtype; v_s public.customer_portal_settings;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;

  return json_build_object('ok', true,
    'request', json_build_object(
      'id', v_req.id, 'request_number', v_req.request_number, 'status', v_req.status,
      'portal_approval_status', v_req.portal_approval_status,
      'portal_rejection_reason', v_req.portal_rejection_reason,
      'can_pm_approve', (v_role = 'project_manager'
                         and v_req.status = 'draft'
                         and v_req.portal_approval_status = 'pending_project_manager'),
      'request_type', v_req.request_type, 'project_name', v_req.project_name, 'project_city', v_req.project_city,
      'contact_phone', v_req.contact_phone_snapshot, 'contact_email', v_req.contact_email_snapshot,
      'pickup_date', v_req.pickup_date, 'return_date', v_req.return_date,
      'notes', v_req.notes, 'created_at', v_req.created_at, 'rejection_reason', v_req.rejection_reason
    ),
    'items', coalesce((
      select json_agg(json_build_object(
        'id', ri.id, 'requested_kind', ri.requested_kind, 'requested_description', ri.requested_description,
        'requested_category', ri.requested_category, 'preferred_model', ri.preferred_model,
        'accept_alternative', ri.accept_alternative, 'needs_purchase', ri.needs_purchase, 'quantity', ri.quantity,
        'fulfillment', case
          when ri.delivered_quantity > 0 then 'delivered'
          when ri.item_kind in ('asset','consumable') then 'preparing'
          when ri.needs_purchase then 'procuring'
          else 'reviewing' end
      ) order by ri.created_at)
      from public.request_items ri where ri.request_id = p_request_id
    ), '[]'::json),
    'events', coalesce((
      select json_agg(json_build_object(
        'event_type', e.event_type,
        'to_status', case when e.event_type = 'status_changed' then e.metadata->>'to' else null end,
        'message', case when e.event_type in ('clarification_requested','clarification_reply','portal_pm_rejected') then e.message else null end,
        'created_at', e.created_at
      ) order by e.created_at)
      from public.request_events e
      where e.request_id = p_request_id
        and e.event_type in ('status_changed','clarification_requested','clarification_reply','submitted',
                             'portal_pm_approval_requested','portal_pm_approved','portal_pm_rejected')
    ), '[]'::json)
  );
end $function$;

create or replace function public.portal_list_request_attachments(p_request_id uuid)
returns json language plpgsql stable security definer set search_path = public as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
        v_req public.requests%rowtype; v_s public.customer_portal_settings;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true, 'attachments', coalesce((
    select json_agg(json_build_object(
      'id', ra.id, 'file_name', ra.file_name, 'mime_type', ra.mime_type,
      'size_bytes', ra.size_bytes, 'created_at', ra.created_at, 'uploaded_by_kind', ra.uploaded_by_kind
    ) order by ra.created_at)
    from public.request_attachments ra
    where ra.request_id = p_request_id and (ra.uploaded_by_kind = 'portal' or ra.visible_to_customer)
  ), '[]'::json));
end $function$;

create or replace function public.portal_get_request_attachment_path(p_attachment_id uuid)
returns json language plpgsql stable security definer set search_path = public as $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
        v_ra public.request_attachments%rowtype; v_req public.requests%rowtype;
        v_s public.customer_portal_settings;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_ra from public.request_attachments where id = p_attachment_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  select * into v_req from public.requests where id = v_ra.request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  if not (v_ra.uploaded_by_kind = 'portal' or v_ra.visible_to_customer) then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true, 'path', v_ra.storage_path);
end $function$;

create or replace function public.portal_list_allowed_companies()
returns json language plpgsql stable security definer set search_path = public as $function$
declare v_cid uuid := public.portal_customer_id(); v_s public.customer_portal_settings;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  return json_build_object('ok', true, 'companies', coalesce((
    select json_agg(json_build_object('id', c.id, 'name', c.name) order by c.name)
    from public.customer_allowed_companies ac join public.companies c on c.id = ac.company_id
    where ac.customer_id = v_cid and c.is_active = true
  ), '[]'::json));
end $function$;

create or replace function public.portal_list_allowed_categories()
returns json language plpgsql stable security definer set search_path = public as $function$
declare v_cid uuid := public.portal_customer_id(); v_s public.customer_portal_settings;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  return json_build_object('ok', true, 'categories', coalesce((
    select json_agg(json_build_object('key', category_key,
      'label_ar', category_label_ar, 'label_en', category_label_en) order by category_key)
    from public.customer_allowed_categories where customer_id = v_cid
  ), '[]'::json));
end $function$;

-- ---------------------------------------------------------------------------
-- 4) Storage guard functions (portal-identity-only; staff/owner policies untouched).
--    Upload: block when disabled AND when attachments disabled (matches register RPC).
--    Read:   block the portal read path when disabled (master kill-switch = portal_enabled).
-- ---------------------------------------------------------------------------
create or replace function public.portal_can_upload_request_attachment(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $function$
declare
  v_cid  uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_s    public.customer_portal_settings;
  v_rid  uuid;
  v_req  public.requests%rowtype;
begin
  if v_cid is null then return false; end if;
  if v_role = 'viewer' then return false; end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return false; end if;        -- ADDED: fail-closed
  if not v_s.allow_attachments then return false; end if;      -- ADDED: consistent with register RPC
  if p_name !~ '^requests/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/portal/[A-Za-z0-9._-]{1,150}$' then
    return false;
  end if;
  begin
    v_rid := split_part(p_name, '/', 2)::uuid;
  exception when others then
    return false;
  end;
  select * into v_req from public.requests where id = v_rid;
  if not found then return false; end if;
  if v_req.customer_id is distinct from v_cid then return false; end if;
  if v_req.status not in ('draft','under_review','needs_clarification') then return false; end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return false;
  end if;
  return true;
end $function$;

create or replace function public.portal_can_read_request_attachment(p_name text)
returns boolean language sql stable security definer set search_path = public as $function$
  select exists (
    select 1
    from public.request_attachments ra
    join public.requests r on r.id = ra.request_id
    where ra.storage_path = p_name
      and public.portal_customer_id() is not null
      and r.customer_id = public.portal_customer_id()
      and (public._portal_settings(public.portal_customer_id())).portal_enabled   -- ADDED: fail-closed
      and (public.portal_user_role() <> 'authorized_requester'
           or r.submitted_by is not distinct from auth.uid())
      and (ra.uploaded_by_kind = 'portal' or ra.visible_to_customer)
  );
$function$;

-- ---------------------------------------------------------------------------
-- 5) Persist "portal off until an admin enables it" for every existing customer.
--    ON CONFLICT DO NOTHING => never overwrites an admin's later choice; re-runnable.
--    Other columns take table defaults (allow_* = true, require_pm = false).
-- ---------------------------------------------------------------------------
insert into public.customer_portal_settings (customer_id, portal_enabled)
select id, false from public.customers
on conflict (customer_id) do nothing;

commit;
