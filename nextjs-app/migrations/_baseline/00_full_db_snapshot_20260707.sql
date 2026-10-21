-- =====================================================================
-- ITAM — FULL DATABASE SCHEMA SNAPSHOT (generated 2026-07-07, RC1 audit)
-- Source: private historical schema snapshot; hosted project identity omitted.
--
-- WHY THIS FILE EXISTS
--   The incremental migrations/ folder begins at 20260630201216. The DB was
--   bootstrapped with ~12 earlier foundational migrations (itam_core_schema,
--   itam_seed_reference_data, itam_storage_and_rls, ...) whose files were
--   never committed, so migrations/ alone cannot rebuild the database. This
--   snapshot captures the CURRENT structural + logic state so the schema can
--   be recreated from an empty database.
--
-- WHAT IS INCLUDED
--   enum types, sequences, tables, PK/UNIQUE/CHECK constraints, foreign keys,
--   indexes, functions (SECURITY DEFINER RPCs + helpers), triggers,
--   ROW-LEVEL security enable + policies.
--
-- WHAT IS **NOT** INCLUDED (IMPORTANT — do not treat as a full backup)
--   * column-level GRANT/REVOKE (the financial-column protection) — these
--     live in the committed migrations (e.g.
--     20260701150032_high1b_financial_column_grants_correction.sql). Apply the
--     committed grant migrations AFTER this snapshot, or use pg_dump.
--   * storage buckets / storage.objects policies (attachments, request-attachments)
--   * ROW DATA (assets, users, etc.)
--   For a byte-perfect, authoritative backup incl. data + grants, use the
--   procedure in itam-app/DB_BACKUP_AND_DR_RUNBOOK_AR.md (supabase db dump).
--
-- STATUS: reference / structure-rebuild aid. VERIFY on a scratch database
--   before relying on it for disaster recovery.
-- =====================================================================

-- This generated snapshot contains SQL functions whose dependencies appear
-- later in the file. PostgreSQL otherwise validates those bodies eagerly and
-- rejects a clean restore before the referenced functions exist.
set check_function_bodies = false;

create type public.asset_status as enum ('available', 'assigned', 'reserved', 'in_maintenance', 'damaged', 'lost', 'retired', 'disposed', 'rented', 'sold');
create type public.assignment_status as enum ('active', 'returned');
create type public.attachment_entity as enum ('asset', 'consumable', 'maintenance', 'employee', 'stocktake');
create type public.consumable_txn_type as enum ('in', 'out', 'adjust');
create type public.maintenance_outcome as enum ('repaired', 'replaced', 'retired', 'no_fault');
create type public.maintenance_status as enum ('open', 'in_progress', 'completed', 'cancelled');
create type public.maintenance_type as enum ('preventive', 'corrective', 'inspection');
create type public.management_type as enum ('TRACKED', 'BULK', 'HYBRID');
create type public.movement_type as enum ('create', 'assign', 'return', 'transfer', 'status_change', 'dispose');
create type public.stocktake_status as enum ('draft', 'in_progress', 'completed', 'cancelled');

create sequence if not exists public.audit_logs_id_seq;

create table if not exists public.action_alert_events (
  id uuid not null default gen_random_uuid(),
  alert_instance_id uuid not null,
  event_type text not null,
  actor_id uuid,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.action_alert_instances (
  id uuid not null default gen_random_uuid(),
  stable_key text not null,
  alert_type text not null,
  entity_type text not null,
  entity_id uuid,
  severity text not null default 'medium'::text,
  status text not null default 'open'::text,
  assigned_to uuid,
  assigned_by uuid,
  assigned_at timestamp with time zone,
  first_seen_at timestamp with time zone not null default now(),
  last_seen_at timestamp with time zone not null default now(),
  auto_resolved_at timestamp with time zone,
  reopened_at timestamp with time zone,
  occurrence_count integer not null default 1,
  last_action_at timestamp with time zone,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.app_users (
  id uuid not null,
  email text not null,
  full_name text,
  employee_id uuid,
  role_id uuid,
  is_active boolean not null default true,
  last_login_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  approval_status text default 'pending'::text,
  approved_at timestamp with time zone,
  approved_by uuid,
  rejected_at timestamp with time zone,
  rejected_by uuid,
  rejection_reason text,
  phone text,
  department_id uuid,
  registration_note text,
  requested_role text,
  last_approval_action_at timestamp with time zone
);

create table if not exists public.asset_assignments (
  id uuid not null default gen_random_uuid(),
  asset_id uuid not null,
  employee_id uuid not null,
  assigned_by uuid,
  assigned_at timestamp with time zone not null default now(),
  due_return_date date,
  returned_at timestamp with time zone,
  return_condition text,
  status assignment_status not null default 'active'::assignment_status,
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.asset_movements (
  id uuid not null default gen_random_uuid(),
  asset_id uuid not null,
  movement_type movement_type not null,
  from_location_id uuid,
  to_location_id uuid,
  from_employee_id uuid,
  to_employee_id uuid,
  from_status asset_status,
  to_status asset_status,
  performed_by uuid,
  note text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.asset_pools (
  id uuid not null default gen_random_uuid(),
  name text not null,
  name_ar text,
  category_id uuid,
  company_id uuid,
  description text,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.assets (
  id uuid not null default gen_random_uuid(),
  asset_tag text,
  qr_token text not null default replace((gen_random_uuid())::text, '-'::text, ''::text),
  category_id uuid not null,
  model_id uuid,
  serial_number text,
  name text,
  status asset_status not null default 'available'::asset_status,
  condition_grade text,
  supplier_id uuid,
  location_id uuid,
  department_id uuid,
  assigned_to_employee_id uuid,
  purchase_date date,
  purchase_cost numeric(12,2),
  currency text not null default 'SAR'::text,
  warranty_end date,
  lifespan_months integer,
  salvage_rate numeric(4,3) not null default 0.10,
  notes text,
  special_attributes jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  company_id uuid,
  rfid_tag text,
  pool_id uuid,
  serial_exempt boolean not null default false,
  serial_exempt_reason text,
  serial_exempted_by uuid,
  serial_exempted_at timestamp with time zone
);

create table if not exists public.attachments (
  id uuid not null default gen_random_uuid(),
  entity_type attachment_entity not null,
  entity_id uuid not null,
  file_name text not null,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid,
  created_at timestamp with time zone not null default now(),
  kind text
);

create table if not exists public.audit_logs (
  id bigint not null default nextval('audit_logs_id_seq'::regclass),
  table_name text not null,
  record_id text,
  action text not null,
  changed_by uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.categories (
  id uuid not null default gen_random_uuid(),
  name text not null,
  name_ar text,
  prefix text not null,
  management_type management_type not null default 'TRACKED'::management_type,
  kind text not null default 'asset'::text,
  default_lifespan_months integer,
  description text,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.companies (
  id uuid not null default gen_random_uuid(),
  name text not null,
  normalized_name text,
  notes text,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.consumable_transactions (
  id uuid not null default gen_random_uuid(),
  consumable_id uuid not null,
  txn_type consumable_txn_type not null,
  quantity integer not null,
  balance_after integer,
  related_employee_id uuid,
  related_asset_id uuid,
  reason text,
  performed_by uuid,
  created_at timestamp with time zone not null default now(),
  unit_cost numeric,
  total_cost numeric,
  supplier_id uuid,
  invoice_number text,
  invoice_date date,
  previous_quantity integer,
  department_id uuid,
  location_id uuid
);

create table if not exists public.consumables (
  id uuid not null default gen_random_uuid(),
  category_id uuid not null,
  name text not null,
  sku text,
  brand text,
  unit text not null default 'piece'::text,
  quantity_on_hand integer not null default 0,
  reorder_level integer not null default 0,
  location_id uuid,
  supplier_id uuid,
  unit_cost numeric(12,2),
  currency text not null default 'SAR'::text,
  notes text,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  company_id uuid,
  rfid_tag text
);

create table if not exists public.customer_allowed_categories (
  customer_id uuid not null,
  category_key text not null,
  category_label_ar text,
  category_label_en text,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.customer_allowed_companies (
  customer_id uuid not null,
  company_id uuid not null,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.customer_portal_invites (
  id uuid not null default gen_random_uuid(),
  code text not null,
  customer_id uuid not null,
  portal_role text not null default 'authorized_requester'::text,
  expires_at timestamp with time zone not null,
  max_uses integer not null default 1,
  used_count integer not null default 0,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.customer_portal_settings (
  customer_id uuid not null,
  portal_enabled boolean not null default true,
  allow_rental_requests boolean not null default true,
  allow_purchase_requests boolean not null default true,
  allow_maintenance_requests boolean not null default true,
  allow_custom_requests boolean not null default true,
  allow_custom_item_requests boolean not null default true,
  allow_attachments boolean not null default true,
  require_project_manager_approval boolean not null default false,
  updated_by uuid,
  updated_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now()
);

create table if not exists public.customer_portal_users (
  id uuid not null,
  customer_id uuid not null,
  contact_name text not null,
  phone text,
  portal_role text not null default 'authorized_requester'::text,
  is_active boolean not null default true,
  invited_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.customers (
  id uuid not null default gen_random_uuid(),
  name text not null,
  contact_person text,
  phone text,
  email text,
  city text,
  address text,
  notes text,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.departments (
  id uuid not null default gen_random_uuid(),
  name text not null,
  name_ar text,
  code text,
  manager_employee_id uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.depreciation_rules (
  id uuid not null default gen_random_uuid(),
  category_id uuid,
  asset_type text,
  method text not null default 'straight_line'::text,
  annual_rate numeric not null default 0,
  salvage_rate numeric not null default 0,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  company_id uuid,
  useful_life_years numeric,
  alert_before_days integer not null default 30,
  priority integer not null default 100
);

create table if not exists public.employees (
  id uuid not null default gen_random_uuid(),
  employee_no text,
  full_name text not null,
  full_name_ar text,
  email text,
  phone text,
  department_id uuid,
  job_title text,
  location_id uuid,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.feature_exposure_settings (
  id text not null default 'main'::text,
  enabled boolean not null default true,
  level integer,
  updated_by uuid,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.locations (
  id uuid not null default gen_random_uuid(),
  name text not null,
  name_ar text,
  code text,
  building text,
  floor text,
  room text,
  parent_id uuid,
  notes text,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.maintenance_records (
  id uuid not null default gen_random_uuid(),
  asset_id uuid not null,
  type maintenance_type not null default 'corrective'::maintenance_type,
  status maintenance_status not null default 'open'::maintenance_status,
  reported_at timestamp with time zone not null default now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  reported_by uuid,
  technician_id uuid,
  vendor_supplier_id uuid,
  problem_description text,
  action_taken text,
  cost numeric(12,2) not null default 0,
  currency text not null default 'SAR'::text,
  outcome maintenance_outcome,
  downtime_hours numeric(8,2),
  next_due_date date,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  priority text,
  problem_type text,
  workflow_stage text,
  invoice_number text,
  reported_by_employee_id uuid,
  final_summary text,
  vendor_name text,
  vendor_phone text,
  vendor_location text,
  vendor_map_link text,
  invoice_date date,
  handoff_notes text,
  receiver_name text
);

create table if not exists public.models (
  id uuid not null default gen_random_uuid(),
  category_id uuid not null,
  brand text not null,
  model_name text not null,
  default_warranty_months integer,
  description text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.notification_settings (
  id text not null default 'main'::text,
  low_stock_enabled boolean not null default true,
  out_of_stock_enabled boolean not null default true,
  overdue_requests_enabled boolean not null default true,
  pending_approval_enabled boolean not null default true,
  maintenance_due_enabled boolean not null default true,
  overdue_grace_days integer not null default 0,
  maintenance_due_window_days integer not null default 14,
  in_app_enabled boolean not null default true,
  email_enabled boolean not null default false,
  updated_by uuid,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.permissions (
  id uuid not null default gen_random_uuid(),
  key text not null,
  grp text,
  description text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.purchase_request_items (
  id uuid not null default gen_random_uuid(),
  purchase_request_id uuid not null,
  consumable_id uuid,
  requested_quantity numeric not null,
  received_quantity numeric not null default 0,
  suggested_quantity numeric,
  notes text,
  unit_cost numeric,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  description text,
  source_request_item_id uuid
);

create table if not exists public.purchase_request_sequences (
  year integer not null,
  last_seq integer not null default 0
);

create table if not exists public.purchase_requests (
  id uuid not null default gen_random_uuid(),
  request_number text not null default ''::text,
  supplier_id uuid,
  status text not null default 'draft'::text,
  requested_by uuid,
  submitted_at timestamp with time zone,
  approved_by uuid,
  approved_at timestamp with time zone,
  cancelled_by uuid,
  cancelled_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.registration_invite_uses (
  id uuid not null default gen_random_uuid(),
  invite_id uuid,
  user_id uuid,
  email text not null,
  used_at timestamp with time zone not null default now()
);

create table if not exists public.registration_invites (
  id uuid not null default gen_random_uuid(),
  code text not null,
  label text,
  default_role text not null default 'viewer'::text,
  max_uses integer,
  used_count integer not null default 0,
  expires_at timestamp with time zone,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.registration_settings (
  id text not null default 'main'::text,
  mode text not null default 'closed'::text,
  require_email_verification boolean not null default true,
  remaining_slots integer not null default 0,
  allowed_domains text[],
  default_requested_role text not null default 'viewer'::text,
  message_ar text,
  message_en text,
  updated_at timestamp with time zone not null default now(),
  updated_by uuid
);

create table if not exists public.request_attachments (
  id uuid not null default gen_random_uuid(),
  request_id uuid not null,
  uploaded_by_kind text not null,
  uploaded_by uuid not null,
  visible_to_customer boolean not null default false,
  file_name text not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.request_events (
  id uuid not null default gen_random_uuid(),
  request_id uuid not null,
  event_type text not null,
  actor_kind text not null,
  actor_id uuid,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.request_items (
  id uuid not null default gen_random_uuid(),
  request_id uuid not null,
  item_kind text not null,
  asset_id uuid,
  consumable_id uuid,
  quantity numeric not null default 1,
  approved_quantity numeric,
  delivered_quantity numeric not null default 0,
  returned_quantity numeric not null default 0,
  unit_price numeric,
  total_price numeric,
  notes text,
  created_at timestamp with time zone not null default now(),
  requested_kind text not null default 'existing_asset'::text,
  requested_description text,
  requested_category text,
  preferred_company_id uuid,
  preferred_model text,
  accept_alternative boolean not null default true,
  needs_purchase boolean not null default false
);

create table if not exists public.request_sequences (
  year integer not null,
  last_seq integer not null default 0
);

create table if not exists public.requests (
  id uuid not null default gen_random_uuid(),
  request_number text not null,
  customer_id uuid,
  customer_name_snapshot text,
  contact_phone_snapshot text,
  project_name text,
  project_city text,
  request_type text not null default 'rental'::text,
  status text not null default 'draft'::text,
  pickup_date date,
  return_date date,
  delivered_at timestamp with time zone,
  returned_at timestamp with time zone,
  approved_by uuid,
  approved_at timestamp with time zone,
  rejected_by uuid,
  rejected_at timestamp with time zone,
  rejection_reason text,
  notes text,
  internal_notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  request_source text not null default 'internal'::text,
  submitted_by uuid,
  responsible_employee_id uuid,
  contact_email_snapshot text,
  portal_approval_status text not null default 'not_required'::text,
  portal_approval_requested_by uuid,
  portal_approval_requested_at timestamp with time zone,
  portal_approved_by uuid,
  portal_approved_at timestamp with time zone,
  portal_rejected_by uuid,
  portal_rejected_at timestamp with time zone,
  portal_rejection_reason text
);

create table if not exists public.role_permissions (
  role_id uuid not null,
  permission_id uuid not null
);

create table if not exists public.roles (
  id uuid not null default gen_random_uuid(),
  key text not null,
  name text not null,
  name_ar text,
  description text,
  is_system boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.scan_logs (
  id uuid not null default gen_random_uuid(),
  scan_mode text not null,
  result text not null,
  item_kind text,
  asset_id uuid,
  consumable_id uuid,
  scanned_value text not null,
  matched_by text,
  location_id uuid,
  notes text,
  error_code text,
  performed_by uuid,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.stocktake_items (
  id uuid not null default gen_random_uuid(),
  stocktake_id uuid not null,
  asset_id uuid,
  consumable_id uuid,
  expected_status asset_status,
  scanned boolean not null default false,
  found boolean,
  scanned_at timestamp with time zone,
  scanned_by uuid,
  note text
);

create table if not exists public.stocktakes (
  id uuid not null default gen_random_uuid(),
  code text,
  title text not null,
  location_id uuid,
  status stocktake_status not null default 'draft'::stocktake_status,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_by uuid,
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.supplier_categories (
  id uuid not null default gen_random_uuid(),
  supplier_id uuid not null,
  category_id uuid not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.suppliers (
  id uuid not null default gen_random_uuid(),
  name text not null,
  name_ar text,
  contact_person text,
  email text,
  phone text,
  address text,
  notes text,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.tag_sequences (
  category_id uuid not null,
  year integer not null,
  last_seq integer not null default 0
);

create table if not exists public.user_permissions (
  user_id uuid not null,
  permission_id uuid not null,
  allow boolean not null default true
);

alter table only action_alert_events add constraint action_alert_event_type_valid CHECK ((event_type = ANY (ARRAY['created'::text, 'seen_again'::text, 'assigned'::text, 'unassigned'::text, 'in_progress'::text, 'note_added'::text, 'auto_resolved'::text, 'reopened'::text])));
alter table only action_alert_events add constraint action_alert_events_pkey PRIMARY KEY (id);
alter table only action_alert_instances add constraint action_alert_instances_pkey PRIMARY KEY (id);
alter table only action_alert_instances add constraint action_alert_instances_stable_key_key UNIQUE (stable_key);
alter table only action_alert_instances add constraint action_alert_severity_valid CHECK ((severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text])));
alter table only action_alert_instances add constraint action_alert_status_valid CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'auto_resolved'::text, 'reopened'::text])));
alter table only app_users add constraint app_users_approval_status_chk CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
alter table only app_users add constraint app_users_email_key UNIQUE (email);
alter table only app_users add constraint app_users_pkey PRIMARY KEY (id);
alter table only asset_assignments add constraint asset_assignments_pkey PRIMARY KEY (id);
alter table only asset_assignments add constraint asset_assignments_return_condition_check CHECK ((return_condition = ANY (ARRAY['new'::text, 'good'::text, 'fair'::text, 'poor'::text])));
alter table only asset_movements add constraint asset_movements_pkey PRIMARY KEY (id);
alter table only asset_pools add constraint asset_pools_pkey PRIMARY KEY (id);
alter table only assets add constraint assets_asset_tag_key UNIQUE (asset_tag);
alter table only assets add constraint assets_condition_grade_check CHECK ((condition_grade = ANY (ARRAY['new'::text, 'good'::text, 'fair'::text, 'poor'::text])));
alter table only assets add constraint assets_pkey PRIMARY KEY (id);
alter table only assets add constraint assets_qr_token_key UNIQUE (qr_token);
alter table only attachments add constraint attachments_pkey PRIMARY KEY (id);
alter table only audit_logs add constraint audit_logs_pkey PRIMARY KEY (id);
alter table only categories add constraint categories_kind_check CHECK ((kind = ANY (ARRAY['asset'::text, 'consumable'::text, 'accessory'::text, 'special'::text])));
alter table only categories add constraint categories_name_key UNIQUE (name);
alter table only categories add constraint categories_pkey PRIMARY KEY (id);
alter table only categories add constraint categories_prefix_key UNIQUE (prefix);
alter table only categories add constraint prefix_format CHECK ((prefix ~ '^[A-Z]{2,5}$'::text));
alter table only companies add constraint companies_name_key UNIQUE (name);
alter table only companies add constraint companies_normalized_name_key UNIQUE (normalized_name);
alter table only companies add constraint companies_pkey PRIMARY KEY (id);
alter table only consumable_transactions add constraint consumable_transactions_pkey PRIMARY KEY (id);
alter table only consumable_transactions add constraint consumable_transactions_quantity_check CHECK ((quantity > 0));
alter table only consumables add constraint consumables_pkey PRIMARY KEY (id);
alter table only consumables add constraint consumables_quantity_on_hand_check CHECK ((quantity_on_hand >= 0));
alter table only consumables add constraint consumables_reorder_level_check CHECK ((reorder_level >= 0));
alter table only consumables add constraint consumables_sku_key UNIQUE (sku);
alter table only customer_allowed_categories add constraint customer_allowed_categories_pkey PRIMARY KEY (customer_id, category_key);
alter table only customer_allowed_companies add constraint customer_allowed_companies_pkey PRIMARY KEY (customer_id, company_id);
alter table only customer_portal_invites add constraint customer_portal_invites_code_key UNIQUE (code);
alter table only customer_portal_invites add constraint customer_portal_invites_pkey PRIMARY KEY (id);
alter table only customer_portal_invites add constraint customer_portal_invites_portal_role_check CHECK ((portal_role = ANY (ARRAY['project_manager'::text, 'authorized_requester'::text, 'viewer'::text])));
alter table only customer_portal_settings add constraint customer_portal_settings_pkey PRIMARY KEY (customer_id);
alter table only customer_portal_users add constraint customer_portal_users_pkey PRIMARY KEY (id);
alter table only customer_portal_users add constraint customer_portal_users_portal_role_check CHECK ((portal_role = ANY (ARRAY['project_manager'::text, 'authorized_requester'::text, 'viewer'::text])));
alter table only customers add constraint customers_pkey PRIMARY KEY (id);
alter table only departments add constraint departments_code_key UNIQUE (code);
alter table only departments add constraint departments_pkey PRIMARY KEY (id);
alter table only depreciation_rules add constraint depreciation_rules_annual_rate_check CHECK (((annual_rate >= (0)::numeric) AND (annual_rate <= (100)::numeric)));
alter table only depreciation_rules add constraint depreciation_rules_pkey PRIMARY KEY (id);
alter table only depreciation_rules add constraint depreciation_rules_salvage_rate_check CHECK (((salvage_rate >= (0)::numeric) AND (salvage_rate <= (100)::numeric)));
alter table only employees add constraint employees_employee_no_key UNIQUE (employee_no);
alter table only employees add constraint employees_pkey PRIMARY KEY (id);
alter table only feature_exposure_settings add constraint feature_exposure_settings_level_valid CHECK (((level IS NULL) OR (((level >= 10) AND (level <= 100)) AND ((level % 10) = 0))));
alter table only feature_exposure_settings add constraint feature_exposure_settings_pkey PRIMARY KEY (id);
alter table only feature_exposure_settings add constraint feature_exposure_settings_singleton CHECK ((id = 'main'::text));
alter table only locations add constraint locations_code_key UNIQUE (code);
alter table only locations add constraint locations_pkey PRIMARY KEY (id);
alter table only maintenance_records add constraint maintenance_records_pkey PRIMARY KEY (id);
alter table only models add constraint models_brand_model_name_key UNIQUE (brand, model_name);
alter table only models add constraint models_pkey PRIMARY KEY (id);
alter table only notification_settings add constraint notification_settings_grace_nonneg CHECK ((overdue_grace_days >= 0));
alter table only notification_settings add constraint notification_settings_pkey PRIMARY KEY (id);
alter table only notification_settings add constraint notification_settings_singleton CHECK ((id = 'main'::text));
alter table only notification_settings add constraint notification_settings_window_nonneg CHECK ((maintenance_due_window_days >= 0));
alter table only permissions add constraint permissions_key_key UNIQUE (key);
alter table only permissions add constraint permissions_pkey PRIMARY KEY (id);
alter table only purchase_request_items add constraint pr_items_consumable_or_description CHECK (((consumable_id IS NOT NULL) OR ((description IS NOT NULL) AND (btrim(description) <> ''::text))));
alter table only purchase_request_items add constraint purchase_request_items_pkey PRIMARY KEY (id);
alter table only purchase_request_items add constraint purchase_request_items_received_quantity_check CHECK ((received_quantity >= (0)::numeric));
alter table only purchase_request_items add constraint purchase_request_items_requested_quantity_check CHECK ((requested_quantity > (0)::numeric));
alter table only purchase_request_sequences add constraint purchase_request_sequences_pkey PRIMARY KEY (year);
alter table only purchase_requests add constraint purchase_request_status_valid CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'ordered'::text, 'partially_received'::text, 'received'::text, 'cancelled'::text])));
alter table only purchase_requests add constraint purchase_requests_pkey PRIMARY KEY (id);
alter table only purchase_requests add constraint purchase_requests_request_number_key UNIQUE (request_number);
alter table only registration_invite_uses add constraint registration_invite_uses_pkey PRIMARY KEY (id);
alter table only registration_invites add constraint registration_invites_code_key UNIQUE (code);
alter table only registration_invites add constraint registration_invites_pkey PRIMARY KEY (id);
alter table only registration_settings add constraint registration_settings_mode_check CHECK ((mode = ANY (ARRAY['closed'::text, 'open_with_approval'::text, 'gradual'::text, 'invite_only'::text])));
alter table only registration_settings add constraint registration_settings_pkey PRIMARY KEY (id);
alter table only request_attachments add constraint request_attachments_pkey PRIMARY KEY (id);
alter table only request_attachments add constraint request_attachments_storage_path_key UNIQUE (storage_path);
alter table only request_attachments add constraint request_attachments_uploaded_by_kind_check CHECK ((uploaded_by_kind = ANY (ARRAY['staff'::text, 'portal'::text])));
alter table only request_events add constraint request_events_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['staff'::text, 'portal'::text, 'system'::text])));
alter table only request_events add constraint request_events_pkey PRIMARY KEY (id);
alter table only request_items add constraint request_items_item_kind_check CHECK ((item_kind = ANY (ARRAY['asset'::text, 'consumable'::text, 'custom'::text])));
alter table only request_items add constraint request_items_kind_ref CHECK ((((item_kind = 'asset'::text) AND (asset_id IS NOT NULL) AND (consumable_id IS NULL)) OR ((item_kind = 'consumable'::text) AND (consumable_id IS NOT NULL) AND (asset_id IS NULL)) OR ((item_kind = 'custom'::text) AND (asset_id IS NULL) AND (consumable_id IS NULL))));
alter table only request_items add constraint request_items_pkey PRIMARY KEY (id);
alter table only request_items add constraint request_items_quantity_check CHECK ((quantity > (0)::numeric));
alter table only request_items add constraint request_items_requested_kind_check CHECK ((requested_kind = ANY (ARRAY['existing_asset'::text, 'consumable'::text, 'custom'::text])));
alter table only request_sequences add constraint request_sequences_pkey PRIMARY KEY (year);
alter table only requests add constraint requests_pkey PRIMARY KEY (id);
alter table only requests add constraint requests_portal_approval_status_check CHECK ((portal_approval_status = ANY (ARRAY['not_required'::text, 'pending_project_manager'::text, 'approved_by_project_manager'::text, 'rejected_by_project_manager'::text])));
alter table only requests add constraint requests_request_number_key UNIQUE (request_number);
alter table only requests add constraint requests_request_source_check CHECK ((request_source = ANY (ARRAY['internal'::text, 'client_portal'::text])));
alter table only requests add constraint requests_request_type_check CHECK ((request_type = ANY (ARRAY['rental'::text, 'sale'::text, 'service'::text, 'mixed'::text])));
alter table only requests add constraint requests_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'under_review'::text, 'approved'::text, 'rejected'::text, 'preparing'::text, 'ready_for_pickup'::text, 'delivered'::text, 'partially_returned'::text, 'returned'::text, 'completed'::text, 'cancelled'::text, 'overdue'::text, 'needs_clarification'::text])));
alter table only role_permissions add constraint role_permissions_pkey PRIMARY KEY (role_id, permission_id);
alter table only roles add constraint roles_key_key UNIQUE (key);
alter table only roles add constraint roles_pkey PRIMARY KEY (id);
alter table only scan_logs add constraint scan_logs_item_kind_check CHECK (((item_kind IS NULL) OR (item_kind = ANY (ARRAY['asset'::text, 'consumable'::text, 'unknown'::text]))));
alter table only scan_logs add constraint scan_logs_matched_by_check CHECK (((matched_by IS NULL) OR (matched_by = ANY (ARRAY['qr_token'::text, 'asset_tag'::text, 'serial_number'::text, 'rfid_tag'::text, 'barcode'::text, 'sku'::text, 'name'::text, 'manual'::text]))));
alter table only scan_logs add constraint scan_logs_pkey PRIMARY KEY (id);
alter table only scan_logs add constraint scan_logs_result_check CHECK ((result = ANY (ARRAY['found'::text, 'not_found'::text, 'error'::text, 'blocked'::text])));
alter table only scan_logs add constraint scan_logs_scan_mode_check CHECK ((scan_mode = ANY (ARRAY['search'::text, 'entry'::text, 'exit'::text])));
alter table only stocktake_items add constraint stocktake_items_pkey PRIMARY KEY (id);
alter table only stocktake_items add constraint stocktake_items_stocktake_id_asset_id_key UNIQUE (stocktake_id, asset_id);
alter table only stocktakes add constraint stocktakes_code_key UNIQUE (code);
alter table only stocktakes add constraint stocktakes_pkey PRIMARY KEY (id);
alter table only supplier_categories add constraint supplier_categories_pkey PRIMARY KEY (id);
alter table only supplier_categories add constraint supplier_categories_supplier_id_category_id_key UNIQUE (supplier_id, category_id);
alter table only suppliers add constraint suppliers_pkey PRIMARY KEY (id);
alter table only tag_sequences add constraint tag_sequences_pkey PRIMARY KEY (category_id, year);
alter table only user_permissions add constraint user_permissions_pkey PRIMARY KEY (user_id, permission_id);

alter table only action_alert_events add constraint action_alert_events_alert_instance_id_fkey FOREIGN KEY (alert_instance_id) REFERENCES action_alert_instances(id) ON DELETE CASCADE;
alter table only action_alert_instances add constraint action_alert_instances_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES app_users(id);
alter table only action_alert_instances add constraint action_alert_instances_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES app_users(id);
alter table only app_users add constraint app_users_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
alter table only app_users add constraint app_users_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;
alter table only app_users add constraint app_users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table only app_users add constraint app_users_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;
alter table only asset_assignments add constraint asset_assignments_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT;
alter table only asset_assignments add constraint asset_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only asset_assignments add constraint asset_assignments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT;
alter table only asset_movements add constraint asset_movements_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
alter table only asset_movements add constraint asset_movements_from_employee_id_fkey FOREIGN KEY (from_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
alter table only asset_movements add constraint asset_movements_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only asset_movements add constraint asset_movements_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only asset_movements add constraint asset_movements_to_employee_id_fkey FOREIGN KEY (to_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
alter table only asset_movements add constraint asset_movements_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only asset_pools add constraint asset_pools_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id);
alter table only asset_pools add constraint asset_pools_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
alter table only assets add constraint assets_assigned_to_employee_id_fkey FOREIGN KEY (assigned_to_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
alter table only assets add constraint assets_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT;
alter table only assets add constraint assets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
alter table only assets add constraint assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only assets add constraint assets_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
alter table only assets add constraint assets_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only assets add constraint assets_model_id_fkey FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL;
alter table only assets add constraint assets_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES asset_pools(id) ON DELETE SET NULL;
alter table only assets add constraint assets_serial_exempted_by_fkey FOREIGN KEY (serial_exempted_by) REFERENCES app_users(id);
alter table only assets add constraint assets_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
alter table only attachments add constraint attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only consumable_transactions add constraint consumable_transactions_consumable_id_fkey FOREIGN KEY (consumable_id) REFERENCES consumables(id) ON DELETE RESTRICT;
alter table only consumable_transactions add constraint consumable_transactions_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only consumable_transactions add constraint consumable_transactions_related_asset_id_fkey FOREIGN KEY (related_asset_id) REFERENCES assets(id) ON DELETE SET NULL;
alter table only consumable_transactions add constraint consumable_transactions_related_employee_id_fkey FOREIGN KEY (related_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
alter table only consumable_transactions add constraint consumable_txn_department_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
alter table only consumable_transactions add constraint consumable_txn_location_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only consumable_transactions add constraint consumable_txn_supplier_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
alter table only consumables add constraint consumables_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT;
alter table only consumables add constraint consumables_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
alter table only consumables add constraint consumables_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only consumables add constraint consumables_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
alter table only customer_allowed_categories add constraint customer_allowed_categories_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
alter table only customer_allowed_companies add constraint customer_allowed_companies_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
alter table only customer_allowed_companies add constraint customer_allowed_companies_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
alter table only customer_portal_invites add constraint customer_portal_invites_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
alter table only customer_portal_settings add constraint customer_portal_settings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
alter table only customer_portal_users add constraint customer_portal_users_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
alter table only customer_portal_users add constraint customer_portal_users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table only departments add constraint fk_dept_manager FOREIGN KEY (manager_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
alter table only depreciation_rules add constraint depreciation_rules_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
alter table only depreciation_rules add constraint depreciation_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
alter table only employees add constraint employees_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
alter table only employees add constraint employees_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only locations add constraint locations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only maintenance_records add constraint maintenance_records_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT;
alter table only maintenance_records add constraint maintenance_records_reported_by_employee_id_fkey FOREIGN KEY (reported_by_employee_id) REFERENCES employees(id);
alter table only maintenance_records add constraint maintenance_records_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only maintenance_records add constraint maintenance_records_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only maintenance_records add constraint maintenance_records_vendor_supplier_id_fkey FOREIGN KEY (vendor_supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
alter table only models add constraint models_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT;
alter table only purchase_request_items add constraint purchase_request_items_consumable_id_fkey FOREIGN KEY (consumable_id) REFERENCES consumables(id);
alter table only purchase_request_items add constraint purchase_request_items_purchase_request_id_fkey FOREIGN KEY (purchase_request_id) REFERENCES purchase_requests(id) ON DELETE CASCADE;
alter table only purchase_request_items add constraint purchase_request_items_source_request_item_id_fkey FOREIGN KEY (source_request_item_id) REFERENCES request_items(id);
alter table only purchase_requests add constraint purchase_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES app_users(id);
alter table only purchase_requests add constraint purchase_requests_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES app_users(id);
alter table only purchase_requests add constraint purchase_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES app_users(id);
alter table only purchase_requests add constraint purchase_requests_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
alter table only registration_invite_uses add constraint registration_invite_uses_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES registration_invites(id);
alter table only request_attachments add constraint request_attachments_request_id_fkey FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE;
alter table only request_events add constraint request_events_request_id_fkey FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE;
alter table only request_items add constraint request_items_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id);
alter table only request_items add constraint request_items_consumable_id_fkey FOREIGN KEY (consumable_id) REFERENCES consumables(id);
alter table only request_items add constraint request_items_preferred_company_id_fkey FOREIGN KEY (preferred_company_id) REFERENCES companies(id);
alter table only request_items add constraint request_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE;
alter table only requests add constraint requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
alter table only requests add constraint requests_responsible_employee_id_fkey FOREIGN KEY (responsible_employee_id) REFERENCES app_users(id);
alter table only role_permissions add constraint role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE;
alter table only role_permissions add constraint role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;
alter table only scan_logs add constraint scan_logs_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL;
alter table only scan_logs add constraint scan_logs_consumable_id_fkey FOREIGN KEY (consumable_id) REFERENCES consumables(id) ON DELETE SET NULL;
alter table only scan_logs add constraint scan_logs_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only stocktake_items add constraint stocktake_items_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
alter table only stocktake_items add constraint stocktake_items_consumable_id_fkey FOREIGN KEY (consumable_id) REFERENCES consumables(id) ON DELETE CASCADE;
alter table only stocktake_items add constraint stocktake_items_scanned_by_fkey FOREIGN KEY (scanned_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only stocktake_items add constraint stocktake_items_stocktake_id_fkey FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE;
alter table only stocktakes add constraint stocktakes_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_users(id) ON DELETE SET NULL;
alter table only stocktakes add constraint stocktakes_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
alter table only supplier_categories add constraint supplier_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
alter table only supplier_categories add constraint supplier_categories_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE;
alter table only tag_sequences add constraint tag_sequences_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
alter table only user_permissions add constraint user_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE;
alter table only user_permissions add constraint user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE;

CREATE INDEX assets_rfid_tag_idx ON public.assets USING btree (rfid_tag);
CREATE UNIQUE INDEX assets_rfid_tag_uniq ON public.assets USING btree (lower(rfid_tag)) WHERE ((rfid_tag IS NOT NULL) AND (rfid_tag <> ''::text));
CREATE INDEX consumable_txn_consumable_idx ON public.consumable_transactions USING btree (consumable_id, created_at DESC);
CREATE INDEX consumables_rfid_tag_idx ON public.consumables USING btree (rfid_tag);
CREATE UNIQUE INDEX consumables_rfid_tag_uniq ON public.consumables USING btree (lower(rfid_tag)) WHERE ((rfid_tag IS NOT NULL) AND (rfid_tag <> ''::text));
CREATE UNIQUE INDEX depreciation_rules_category_default_uq ON public.depreciation_rules USING btree (category_id) WHERE ((asset_type IS NULL) AND (category_id IS NOT NULL));
CREATE INDEX idx_action_alert_events_instance ON public.action_alert_events USING btree (alert_instance_id);
CREATE INDEX idx_action_alerts_assigned ON public.action_alert_instances USING btree (assigned_to);
CREATE INDEX idx_action_alerts_status ON public.action_alert_instances USING btree (status);
CREATE INDEX idx_action_alerts_type ON public.action_alert_instances USING btree (alert_type);
CREATE INDEX idx_asset_pools_active ON public.asset_pools USING btree (is_active);
CREATE INDEX idx_assets_pool ON public.assets USING btree (pool_id) WHERE (pool_id IS NOT NULL);
CREATE INDEX idx_cust_allowed_categories_customer ON public.customer_allowed_categories USING btree (customer_id);
CREATE INDEX idx_cust_allowed_companies_customer ON public.customer_allowed_companies USING btree (customer_id);
CREATE INDEX idx_portal_invites_customer ON public.customer_portal_invites USING btree (customer_id);
CREATE INDEX idx_portal_users_customer ON public.customer_portal_users USING btree (customer_id);
CREATE INDEX idx_pr_items_pr ON public.purchase_request_items USING btree (purchase_request_id);
CREATE INDEX idx_pr_items_source_request_item ON public.purchase_request_items USING btree (source_request_item_id);
CREATE INDEX idx_pr_status ON public.purchase_requests USING btree (status);
CREATE INDEX idx_request_attachments_request ON public.request_attachments USING btree (request_id, created_at);
CREATE INDEX idx_request_events_request ON public.request_events USING btree (request_id, created_at);
CREATE INDEX idx_request_events_request_type_created ON public.request_events USING btree (request_id, event_type, created_at);
CREATE INDEX idx_request_items_asset ON public.request_items USING btree (asset_id);
CREATE INDEX idx_request_items_consumable ON public.request_items USING btree (consumable_id);
CREATE INDEX idx_request_items_request ON public.request_items USING btree (request_id);
CREATE INDEX idx_request_items_request_kind_purchase ON public.request_items USING btree (request_id, item_kind, needs_purchase);
CREATE INDEX idx_requests_created_at ON public.requests USING btree (created_at DESC);
CREATE INDEX idx_requests_customer ON public.requests USING btree (customer_id);
CREATE INDEX idx_requests_customer_pmstatus_created ON public.requests USING btree (customer_id, portal_approval_status, created_at);
CREATE INDEX idx_requests_portal_approval ON public.requests USING btree (portal_approval_status) WHERE (portal_approval_status <> 'not_required'::text);
CREATE INDEX idx_requests_responsible ON public.requests USING btree (responsible_employee_id);
CREATE INDEX idx_requests_responsible_created ON public.requests USING btree (responsible_employee_id, created_at);
CREATE INDEX idx_requests_source ON public.requests USING btree (request_source);
CREATE INDEX idx_requests_source_customer_status_created ON public.requests USING btree (request_source, customer_id, status, created_at);
CREATE INDEX idx_requests_status ON public.requests USING btree (status);
CREATE INDEX idx_requests_submitted_by ON public.requests USING btree (submitted_by);
CREATE INDEX idx_scan_logs_asset ON public.scan_logs USING btree (asset_id) WHERE (asset_id IS NOT NULL);
CREATE INDEX idx_scan_logs_consumable ON public.scan_logs USING btree (consumable_id) WHERE (consumable_id IS NOT NULL);
CREATE INDEX idx_scan_logs_created_at ON public.scan_logs USING btree (created_at DESC);
CREATE INDEX idx_scan_logs_mode_result ON public.scan_logs USING btree (scan_mode, result);
CREATE INDEX ix_assets_assignee ON public.assets USING btree (assigned_to_employee_id);
CREATE INDEX ix_assets_category ON public.assets USING btree (category_id);
CREATE INDEX ix_assets_location ON public.assets USING btree (location_id);
CREATE INDEX ix_assets_model ON public.assets USING btree (model_id);
CREATE INDEX ix_assets_qr_token ON public.assets USING btree (qr_token);
CREATE INDEX ix_assets_status ON public.assets USING btree (status);
CREATE INDEX ix_assign_asset ON public.asset_assignments USING btree (asset_id);
CREATE INDEX ix_assign_employee ON public.asset_assignments USING btree (employee_id);
CREATE INDEX ix_attachments_entity ON public.attachments USING btree (entity_type, entity_id);
CREATE INDEX ix_audit_table ON public.audit_logs USING btree (table_name, created_at DESC);
CREATE INDEX ix_consumables_cat ON public.consumables USING btree (category_id);
CREATE INDEX ix_ctxn_consumable ON public.consumable_transactions USING btree (consumable_id, created_at DESC);
CREATE INDEX ix_maint_asset ON public.maintenance_records USING btree (asset_id, status);
CREATE INDEX ix_movements_asset ON public.asset_movements USING btree (asset_id, created_at DESC);
CREATE INDEX ix_stitems_take ON public.stocktake_items USING btree (stocktake_id);
CREATE UNIQUE INDEX uq_active_assignment ON public.asset_assignments USING btree (asset_id) WHERE (status = 'active'::assignment_status);
CREATE UNIQUE INDEX uq_asset_pools_name_active ON public.asset_pools USING btree (lower(name)) WHERE is_active;
CREATE UNIQUE INDEX uq_assets_serial ON public.assets USING btree (serial_number) WHERE (serial_number IS NOT NULL);
CREATE UNIQUE INDEX uq_pr_items_source_request_item ON public.purchase_request_items USING btree (source_request_item_id) WHERE (source_request_item_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public._crq_filter(p_filters jsonb)
 RETURNS SETOF requests
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_date_from date; v_date_to date; v_customer uuid; v_responsible uuid;
  v_type text; v_status text; v_source text; v_pm text; v_city text;
begin
  begin
    v_date_from   := nullif(p_filters->>'date_from','')::date;
    v_date_to     := nullif(p_filters->>'date_to','')::date;
    v_customer    := nullif(p_filters->>'customer_id','')::uuid;
    v_responsible := nullif(p_filters->>'responsible_employee_id','')::uuid;
  exception when others then
    raise exception 'invalid_filters' using errcode = '22023';
  end;
  v_type   := nullif(p_filters->>'request_type','');
  v_status := nullif(p_filters->>'status','');
  v_source := nullif(p_filters->>'source','');
  v_pm     := nullif(p_filters->>'portal_approval_status','');
  v_city   := nullif(p_filters->>'city','');
  if v_type is not null and v_type not in ('rental','sale','service','mixed') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;
  if v_source is not null and v_source not in ('internal','client_portal') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;
  if v_pm is not null and v_pm not in ('not_required','pending_project_manager','approved_by_project_manager','rejected_by_project_manager') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;
  if v_status is not null and v_status not in
     ('draft','under_review','approved','rejected','preparing','ready_for_pickup',
      'delivered','partially_returned','returned','completed','cancelled','overdue','needs_clarification') then
    raise exception 'invalid_filters' using errcode = '22023'; end if;

  return query
  select r.* from public.requests r
  where (v_date_from   is null or r.created_at >= v_date_from)
    and (v_date_to     is null or r.created_at < (v_date_to + 1))
    and (v_customer    is null or r.customer_id = v_customer)
    and (v_responsible is null or r.responsible_employee_id = v_responsible)
    and (v_type        is null or r.request_type = v_type)
    and (v_status      is null or r.status = v_status)
    and (v_source      is null or r.request_source = v_source)
    and (v_pm          is null or r.portal_approval_status = v_pm)
    and (v_city        is null or r.project_city = v_city);
end $function$
;

CREATE OR REPLACE FUNCTION public._portal_settings(p_customer_id uuid)
 RETURNS customer_portal_settings
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.customer_portal_settings;
begin
  select * into v from public.customer_portal_settings where customer_id = p_customer_id;
  if not found then
    v.customer_id                      := p_customer_id;
    v.portal_enabled                   := true;
    v.allow_rental_requests            := true;
    v.allow_purchase_requests          := true;
    v.allow_maintenance_requests       := true;
    v.allow_custom_requests            := true;
    v.allow_custom_item_requests       := true;
    v.allow_attachments                := true;
    v.require_project_manager_approval := false;
  end if;
  return v;
end $function$
;

CREATE OR REPLACE FUNCTION public._request_actor_kind()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when public.is_portal_user() then 'portal'
    when public.app_user_role() is not null then 'staff'
    else 'system' end;
$function$
;

CREATE OR REPLACE FUNCTION public._request_add_event(p_request_id uuid, p_event_type text, p_actor_kind text, p_message text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.request_events(request_id, event_type, actor_kind, actor_id, message, metadata)
  values (p_request_id, p_event_type, p_actor_kind, auth.uid(), nullif(p_message,''), coalesce(p_metadata,'{}'::jsonb));
$function$
;

CREATE OR REPLACE FUNCTION public.action_alert_assign(p_id uuid, p_user uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if v_role = 'technician' and (p_user is distinct from auth.uid()) then
    return json_build_object('ok', false, 'error', 'self_only');
  end if;
  if p_user is not null and not exists (
    select 1 from public.app_users u where u.id = p_user and coalesce(u.approval_status,'approved') = 'approved'
  ) then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  update public.action_alert_instances set
    assigned_to = p_user,
    assigned_by = case when p_user is null then null else auth.uid() end,
    assigned_at = case when p_user is null then null else now() end,
    last_action_at = now(), updated_at = now()
  where id = p_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  insert into public.action_alert_events (alert_instance_id, event_type, actor_id, metadata)
  values (p_id, case when p_user is null then 'unassigned' else 'assigned' end, auth.uid(),
          jsonb_strip_nulls(jsonb_build_object('assigned_to', p_user)));
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.action_alert_note(p_id uuid, p_note text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if coalesce(btrim(p_note), '') = '' then
    return json_build_object('ok', false, 'error', 'empty_note');
  end if;
  if not exists (select 1 from public.action_alert_instances where id = p_id) then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into public.action_alert_events (alert_instance_id, event_type, actor_id, note)
  values (p_id, 'note_added', auth.uid(), btrim(p_note));
  update public.action_alert_instances set last_action_at = now(), updated_at = now() where id = p_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.action_alert_start(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  update public.action_alert_instances set
    status = 'in_progress', last_action_at = now(), updated_at = now()
  where id = p_id and status in ('open','reopened');
  if not found then return json_build_object('ok', false, 'error', 'bad_status'); end if;
  insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
  values (p_id, 'in_progress', auth.uid());
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.action_alerts_sync(p_candidates jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := public.app_user_role();
  v_keys text[];
  c jsonb;
  v_id uuid;
  v_status text;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then
    return json_build_object('ok', false, 'error', 'bad_input');
  end if;

  select coalesce(array_agg(x->>'stable_key'), '{}') into v_keys
  from jsonb_array_elements(p_candidates) x;

  for c in select * from jsonb_array_elements(p_candidates) loop
    if coalesce(c->>'stable_key','') = '' or coalesce(c->>'alert_type','') = '' then
      continue;
    end if;

    select id, status into v_id, v_status
    from public.action_alert_instances where stable_key = c->>'stable_key';

    if v_id is null then
      insert into public.action_alert_instances
        (stable_key, alert_type, entity_type, entity_id, severity, metadata)
      values (
        c->>'stable_key', c->>'alert_type', coalesce(c->>'entity_type','general'),
        nullif(c->>'entity_id','')::uuid,
        case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else 'medium' end,
        jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int))
      )
      returning id into v_id;
      insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
      values (v_id, 'created', auth.uid());
    else
      update public.action_alert_instances set
        last_seen_at = now(),
        updated_at = now(),
        severity = case when c->>'severity' in ('critical','high','medium','low') then c->>'severity' else severity end,
        metadata = jsonb_strip_nulls(jsonb_build_object('label', c->'metadata'->>'label', 'count', (c->'metadata'->>'count')::int)),
        status = case when status = 'auto_resolved' then 'reopened' else status end,
        reopened_at = case when status = 'auto_resolved' then now() else reopened_at end,
        auto_resolved_at = case when status = 'auto_resolved' then null else auto_resolved_at end,
        occurrence_count = case when status = 'auto_resolved' then occurrence_count + 1 else occurrence_count end
      where id = v_id;
      if v_status = 'auto_resolved' then
        insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
        values (v_id, 'reopened', auth.uid());
      end if;
    end if;
  end loop;

  insert into public.action_alert_events (alert_instance_id, event_type, actor_id)
  select i.id, 'auto_resolved', auth.uid()
  from public.action_alert_instances i
  where i.status in ('open','in_progress','reopened') and not (i.stable_key = any(v_keys));

  update public.action_alert_instances set
    status = 'auto_resolved', auto_resolved_at = now(), updated_at = now()
  where status in ('open','in_progress','reopened') and not (stable_key = any(v_keys));

  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_user_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select r.key
  from public.app_users u
  join public.roles r on r.id = u.role_id
  where u.id = auth.uid()
    and coalesce(u.approval_status, 'approved') = 'approved'
$function$
;

CREATE OR REPLACE FUNCTION public.approve_user(p_user_id uuid, p_role_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_target text;
  v_role_id uuid;
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user_id = auth.uid() then
    return json_build_object('ok', false, 'error', 'cannot_manage_self');
  end if;

  select r.key into v_target
  from public.app_users u
  left join public.roles r on r.id = u.role_id
  where u.id = p_user_id
  for update of u;
  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  if v_target = 'admin' and v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_manage_admin');
  end if;
  if p_role_key = 'admin' and v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_grant_admin');
  end if;
  if p_role_key not in ('admin','it_manager','technician','auditor','viewer') then
    return json_build_object('ok', false, 'error', 'invalid_role');
  end if;
  select id into v_role_id from public.roles where key = p_role_key;
  if v_role_id is null then
    return json_build_object('ok', false, 'error', 'role_not_found');
  end if;
  update public.app_users
  set role_id = v_role_id,
      approval_status = 'approved',
      approved_at = now(),
      approved_by = auth.uid(),
      rejected_at = null, rejected_by = null, rejection_reason = null,
      last_approval_action_at = now(),
      updated_at = now()
  where id = p_user_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_assign(p_asset_id uuid, p_employee_id uuid, p_due_date date DEFAULT NULL::date)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_from asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select status into v_from from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  if exists (
    select 1 from public.asset_assignments
    where asset_id = p_asset_id and status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'already_assigned');
  end if;

  if not public.asset_status_allowed(v_from, 'assigned') then
    return json_build_object('ok', false, 'error', 'invalid_transition',
                             'from', v_from, 'to', 'assigned');
  end if;

  insert into public.asset_assignments (asset_id, employee_id, due_return_date, status)
  values (p_asset_id, p_employee_id, p_due_date, 'active');

  update public.assets
  set status = 'assigned', assigned_to_employee_id = p_employee_id
  where id = p_asset_id;

  insert into public.asset_movements
    (asset_id, movement_type, from_status, to_status, to_employee_id, performed_by, note)
  values
    (p_asset_id, 'assign', v_from, 'assigned', p_employee_id, auth.uid(), 'تسليم عهدة');

  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_change_status(p_asset_id uuid, p_to_status asset_status, p_note text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_from asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select status into v_from from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  if not public.asset_status_allowed(v_from, p_to_status) then
    return json_build_object('ok', false, 'error', 'invalid_transition',
                             'from', v_from, 'to', p_to_status);
  end if;

  if p_to_status in ('available','retired','disposed','lost') then
    -- الحالات التي تُنهي المسؤولية: نُفرغ المسؤول ونُغلق أي عهدة نشطة
    -- حتى لا يظهر الأصل «متاحًا» وبعهدة موظف في آنٍ واحد
    update public.asset_assignments
    set status = 'returned', returned_at = now()
    where asset_id = p_asset_id and status = 'active';

    update public.assets
    set status = p_to_status, assigned_to_employee_id = null
    where id = p_asset_id;
  else
    update public.assets set status = p_to_status where id = p_asset_id;
  end if;

  insert into public.asset_movements
    (asset_id, movement_type, from_status, to_status, performed_by, note)
  values
    (p_asset_id, 'status_change', v_from, p_to_status, auth.uid(),
     coalesce(nullif(p_note, ''), 'تغيير حالة'));

  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_pools_stamp_creator()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.created_by := auth.uid();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_pools_touch_updated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_return(p_asset_id uuid, p_condition text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_from asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select status into v_from from public.assets where id = p_asset_id for update;
  if not found then
    return json_build_object('ok', false, 'error', 'asset_not_found');
  end if;

  if not public.asset_status_allowed(v_from, 'available') then
    return json_build_object('ok', false, 'error', 'invalid_transition',
                             'from', v_from, 'to', 'available');
  end if;

  -- إغلاق كل العهد النشطة (إن وُجدت أكثر من واحدة تاريخيًا تُغلق جميعها)
  update public.asset_assignments
  set status = 'returned', returned_at = now(), return_condition = nullif(p_condition, '')
  where asset_id = p_asset_id and status = 'active';

  update public.assets
  set status = 'available', assigned_to_employee_id = null
  where id = p_asset_id;

  insert into public.asset_movements
    (asset_id, movement_type, from_status, to_status, performed_by, note)
  values
    (p_asset_id, 'return', v_from, 'available', auth.uid(), 'إرجاع عهدة');

  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.asset_status_allowed(p_old asset_status, p_new asset_status)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.assets_assign_tag()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.asset_tag is null or new.asset_tag = '' then
    new.asset_tag := next_asset_tag(new.category_id);
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.assets_financial(p_ids uuid[])
 RETURNS TABLE(id uuid, purchase_cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select a.id, a.purchase_cost from public.assets a
  where public.is_financial_viewer() and a.id = any(p_ids);
$function$
;

CREATE OR REPLACE FUNCTION public.assets_guard_serial_exempt()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_changed boolean;
begin
  if tg_op = 'UPDATE' then
    v_changed := new.serial_exempt is distinct from old.serial_exempt
      or new.serial_exempt_reason is distinct from old.serial_exempt_reason
      or new.serial_exempted_by is distinct from old.serial_exempted_by
      or new.serial_exempted_at is distinct from old.serial_exempted_at;
    if not v_changed then return new; end if;
  elsif tg_op = 'INSERT' then
    if not new.serial_exempt then return new; end if;
  end if;

  if coalesce(public.app_user_role(), '') not in ('admin','it_manager') then
    raise exception 'serial_exempt_forbidden';
  end if;

  if new.serial_exempt then
    if coalesce(btrim(new.serial_exempt_reason), '') = '' then
      raise exception 'serial_exempt_reason_required';
    end if;
    new.serial_exempted_by := auth.uid();
    new.serial_exempted_at := now();
  else
    new.serial_exempt_reason := null;
    new.serial_exempted_by := null;
    new.serial_exempted_at := null;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.assets_guard_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.status is distinct from old.status then
    if not asset_status_allowed(old.status, new.status) then
      raise exception 'انتقال حالة غير مسموح: % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.audit_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_id text;
begin
  v_id := coalesce((case when tg_op='DELETE' then old.id else new.id end)::text, '');
  insert into audit_logs(table_name, record_id, action, changed_by, old_data, new_data)
  values (
    tg_table_name, v_id, tg_op, current_user_id(),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE','INSERT') then to_jsonb(new) end
  );
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.consumable_stock_move(p_consumable_id uuid, p_type text, p_quantity integer, p_reason text DEFAULT NULL::text, p_unit_cost numeric DEFAULT NULL::numeric, p_supplier_id uuid DEFAULT NULL::uuid, p_invoice_number text DEFAULT NULL::text, p_invoice_date date DEFAULT NULL::date, p_employee_id uuid DEFAULT NULL::uuid, p_department_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role    text := public.app_user_role();
  v_current integer;
  v_next    integer;
  v_qty     integer;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_type not in ('in','out','adjust') then
    raise exception 'invalid_type' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;
  if p_type in ('in','out') and p_quantity = 0 then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;

  select quantity_on_hand into v_current
  from public.consumables
  where id = p_consumable_id
  for update;
  if not found then
    raise exception 'consumable_not_found' using errcode = 'P0002';
  end if;

  if p_type = 'in' then
    v_next := v_current + p_quantity;  v_qty := p_quantity;
  elsif p_type = 'out' then
    v_next := v_current - p_quantity;  v_qty := p_quantity;
  else
    v_next := p_quantity;              v_qty := abs(p_quantity - v_current);
  end if;

  if v_next < 0 then
    raise exception 'insufficient_stock' using errcode = '23514';
  end if;

  if v_qty > 0 then
    insert into public.consumable_transactions(
      consumable_id, txn_type, quantity, previous_quantity, balance_after,
      unit_cost, total_cost, supplier_id, invoice_number, invoice_date,
      related_employee_id, department_id, reason, performed_by
    ) values (
      p_consumable_id, p_type::consumable_txn_type, v_qty, v_current, v_next,
      case when p_type='in' then p_unit_cost else null end,
      case when p_type='in' and p_unit_cost is not null then p_unit_cost * p_quantity else null end,
      case when p_type='in' then p_supplier_id else null end,
      case when p_type='in' then p_invoice_number else null end,
      case when p_type='in' then p_invoice_date else null end,
      case when p_type='out' then p_employee_id else null end,
      case when p_type='out' then p_department_id else null end,
      p_reason, auth.uid()
    );
  end if;

  update public.consumables
     set quantity_on_hand = v_next,
         unit_cost = case when p_type='in' and p_unit_cost is not null then p_unit_cost else unit_cost end
   where id = p_consumable_id;

  return v_next;
end $function$
;

CREATE OR REPLACE FUNCTION public.consumable_txn_financial(p_ids uuid[])
 RETURNS TABLE(id uuid, unit_cost numeric, total_cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.id, t.unit_cost, t.total_cost from public.consumable_transactions t
  where public.is_financial_viewer() and t.id = any(p_ids);
$function$
;

CREATE OR REPLACE FUNCTION public.consumables_financial(p_ids uuid[])
 RETURNS TABLE(id uuid, unit_cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.unit_cost from public.consumables c
  where public.is_financial_viewer() and c.id = any(p_ids);
$function$
;

CREATE OR REPLACE FUNCTION public.create_customer_portal_invite(p_customer_id uuid, p_portal_role text DEFAULT 'authorized_requester'::text, p_valid_days integer DEFAULT 14, p_max_uses integer DEFAULT 1)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_code text; v_id uuid;
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists(select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  if p_portal_role not in ('project_manager','authorized_requester','viewer') then
    return json_build_object('ok', false, 'error', 'invalid_role'); end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.customer_portal_invites (code, customer_id, portal_role, expires_at, max_uses, created_by)
  values (v_code, p_customer_id, p_portal_role, now() + make_interval(days => greatest(p_valid_days, 1)), greatest(p_max_uses, 1), auth.uid())
  returning id into v_id;
  return json_build_object('ok', true, 'code', v_code, 'invite_id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.current_user_has_capability(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select public.has_capability(auth.uid(), p_key); $function$
;

CREATE OR REPLACE FUNCTION public.current_user_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  begin return auth.uid(); exception when others then return null; end;
end $function$
;

CREATE OR REPLACE FUNCTION public.depreciation_financial()
 RETURNS TABLE(id uuid, annual_rate numeric, salvage_rate numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select d.id, d.annual_rate, d.salvage_rate from public.depreciation_rules d
  where public.is_financial_viewer();
$function$
;

CREATE OR REPLACE FUNCTION public.feature_exposure_settings_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.get_customer_portal_settings(p_customer_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text := public.app_user_role(); v_s public.customer_portal_settings;
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  v_s := public._portal_settings(p_customer_id);
  return json_build_object('ok', true,
    'settings', json_build_object(
      'portal_enabled', v_s.portal_enabled,
      'allow_rental_requests', v_s.allow_rental_requests,
      'allow_purchase_requests', v_s.allow_purchase_requests,
      'allow_maintenance_requests', v_s.allow_maintenance_requests,
      'allow_custom_requests', v_s.allow_custom_requests,
      'allow_custom_item_requests', v_s.allow_custom_item_requests,
      'allow_attachments', v_s.allow_attachments,
      'require_project_manager_approval', v_s.require_project_manager_approval
    ),
    'allowed_companies', coalesce((
      select json_agg(json_build_object('company_id', c.id, 'name', c.name) order by c.name)
      from public.customer_allowed_companies ac join public.companies c on c.id = ac.company_id
      where ac.customer_id = p_customer_id), '[]'::json),
    'allowed_categories', coalesce((
      select json_agg(json_build_object('category_key', category_key,
        'label_ar', category_label_ar, 'label_en', category_label_en) order by category_key)
      from public.customer_allowed_categories where customer_id = p_customer_id), '[]'::json)
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.get_customer_request_analytics(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_summary json; v_breakdowns json; v_timing json;
begin
  if not public.current_user_has_capability('report.customer_requests') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  with f as materialized (select * from public._crq_filter(p_filters))
  select json_build_object(
    'total_requests',           (select count(*) from f),
    'client_portal_requests',   (select count(*) filter (where request_source = 'client_portal') from f),
    'internal_requests',        (select count(*) filter (where request_source = 'internal') from f),
    'open_requests',            (select count(*) filter (where status not in ('completed','returned','cancelled','rejected') and portal_approval_status not in ('rejected_by_project_manager','pending_project_manager')) from f),
    'completed_requests',       (select count(*) filter (where status in ('completed','returned')) from f),
    'rejected_requests',        (select count(*) filter (where status = 'rejected' or portal_approval_status = 'rejected_by_project_manager') from f),
    'needs_clarification',      (select count(*) filter (where status = 'needs_clarification') from f),
    'pending_project_manager',  (select count(*) filter (where portal_approval_status = 'pending_project_manager') from f),
    'pending_internal_review',  (select count(*) filter (where status in ('draft','under_review') and portal_approval_status <> 'pending_project_manager') from f),
    'in_progress',              (select count(*) filter (where status in ('approved','preparing','ready_for_pickup','delivered','partially_returned','overdue')) from f),
    'needs_purchase_items',     (select count(*) from public.request_items ri where ri.request_id in (select id from f) and ri.needs_purchase),
    'attachments_count',        (select count(*) from public.request_attachments ra where ra.request_id in (select id from f))
  ) into v_summary;
  with f as materialized (select * from public._crq_filter(p_filters))
  select json_build_object(
    'by_status',                  (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select status k, count(*) c from f group by status) t),
    'by_request_type',            (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select request_type k, count(*) c from f group by request_type) t),
    'by_source',                  (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select request_source k, count(*) c from f group by request_source) t),
    'by_portal_approval_status',  (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select portal_approval_status k, count(*) c from f group by portal_approval_status) t),
    'by_city',                    (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json) from (select coalesce(project_city,'—') k, count(*) c from f group by coalesce(project_city,'—')) t),
    'by_customer',                (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json)
                                   from (select coalesce(cu.name, f.customer_name_snapshot, '—') k, count(*) c
                                         from f left join public.customers cu on cu.id = f.customer_id
                                         group by coalesce(cu.name, f.customer_name_snapshot, '—')) t),
    'by_responsible_employee',    (select coalesce(json_agg(json_build_object('key', k, 'count', c) order by c desc),'[]'::json)
                                   from (select coalesce(u.full_name, u.email, '—') k, count(*) c
                                         from f left join public.app_users u on u.id = f.responsible_employee_id
                                         group by coalesce(u.full_name, u.email, '—')) t)
  ) into v_breakdowns;
  with f as materialized (select * from public._crq_filter(p_filters))
  select json_build_object(
    'avg_time_to_pm_approval',    (select round(avg(extract(epoch from (portal_approved_at - portal_approval_requested_at)) / 3600.0)::numeric, 1)
                                   from f where portal_approved_at is not null and portal_approval_requested_at is not null),
    'avg_time_to_approval',       (select round(avg(extract(epoch from (approved_at - created_at)) / 3600.0)::numeric, 1)
                                   from f where approved_at is not null),
    'avg_time_to_internal_review',(select round(avg(extract(epoch from (fa.first_action - tr.team_received)) / 3600.0)::numeric, 1)
                                   from f
                                   join lateral (
                                     select min(e.created_at) first_action from public.request_events e
                                     where e.request_id = f.id
                                       and ( (e.actor_kind = 'staff' and e.event_type = 'clarification_requested')
                                          or (e.event_type = 'status_changed' and e.metadata->>'to' in ('approved','rejected','needs_clarification')) )
                                   ) fa on true
                                   join lateral (
                                     select coalesce(
                                       f.portal_approved_at,
                                       (select min(e2.created_at) from public.request_events e2 where e2.request_id = f.id and e2.event_type = 'submitted'),
                                       f.created_at) team_received
                                   ) tr on true
                                   where fa.first_action is not null and fa.first_action >= tr.team_received),
    'avg_time_to_completion',     (select round(avg(extract(epoch from (ce.completed_at - f.created_at)) / 3600.0)::numeric, 1)
                                   from f
                                   join lateral (
                                     select min(e.created_at) completed_at from public.request_events e
                                     where e.request_id = f.id and e.event_type = 'status_changed' and e.metadata->>'to' = 'completed'
                                   ) ce on true
                                   where ce.completed_at is not null),
    'oldest_open_request_days',   (select floor(extract(epoch from (now() - min(created_at))) / 86400.0)::int
                                   from f where status not in ('completed','returned','cancelled','rejected') and portal_approval_status not in ('rejected_by_project_manager','pending_project_manager'))
  ) into v_timing;
  return json_build_object('ok', true, 'summary', v_summary, 'breakdowns', v_breakdowns, 'timing', v_timing);
exception when sqlstate '22023' then
  return json_build_object('ok', false, 'error', 'invalid_filters');
end $function$
;

CREATE OR REPLACE FUNCTION public.get_customer_request_operational_report(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rows json;
begin
  if not public.current_user_has_capability('report.customer_requests') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  with f as materialized (select * from public._crq_filter(p_filters)),
  base as (
    select r.* from f r
    where r.portal_approval_status not in ('pending_project_manager','rejected_by_project_manager')
    order by r.created_at desc
    limit 1000
  )
  select coalesce(json_agg(json_build_object(
    'request_number',        b.request_number,
    'customer_name',         coalesce(cu.name, b.customer_name_snapshot, '—'),
    'project_name',          b.project_name,
    'project_city',          b.project_city,
    'request_type',          b.request_type,
    'status',                b.status,
    'portal_approval_status',b.portal_approval_status,
    'responsible_name',      coalesce(u.full_name, u.email),
    'created_at',            b.created_at,
    'approved_at',           b.approved_at,
    'completed_at',          (select min(e.created_at) from public.request_events e where e.request_id = b.id and e.event_type = 'status_changed' and e.metadata->>'to' = 'completed'),
    'items_count',           (select count(*) from public.request_items ri where ri.request_id = b.id),
    'needs_purchase_count',  (select count(*) from public.request_items ri where ri.request_id = b.id and ri.needs_purchase),
    'attachments_count',     (select count(*) from public.request_attachments ra where ra.request_id = b.id),
    'last_event_at',         (select max(e.created_at) from public.request_events e where e.request_id = b.id)
  ) order by b.created_at desc), '[]'::json) into v_rows
  from base b
  left join public.customers cu on cu.id = b.customer_id
  left join public.app_users u  on u.id  = b.responsible_employee_id;
  return json_build_object('ok', true, 'rows', v_rows);
exception when sqlstate '22023' then
  return json_build_object('ok', false, 'error', 'invalid_filters');
end $function$
;

CREATE OR REPLACE FUNCTION public.get_customer_request_timeseries(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_gran text; v_series json;
begin
  if not public.current_user_has_capability('report.customer_requests') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  v_gran := coalesce(nullif(p_filters->>'granularity',''), 'day');
  if v_gran not in ('day','week','month') then
    return json_build_object('ok', false, 'error', 'invalid_filters');
  end if;
  with f as materialized (select * from public._crq_filter(p_filters)),
  ev as (
    select date_trunc(v_gran, created_at) b, 'created'::text m from f
    union all
    select date_trunc(v_gran, rejected_at), 'rejected' from f where rejected_at is not null
    union all
    select date_trunc(v_gran, portal_approval_requested_at), 'pending_pm' from f where portal_approval_requested_at is not null
    union all
    select date_trunc(v_gran, e.created_at), 'submitted' from public.request_events e join f on f.id = e.request_id where e.event_type = 'submitted'
    union all
    select date_trunc(v_gran, e.created_at), 'completed' from public.request_events e join f on f.id = e.request_id where e.event_type = 'status_changed' and e.metadata->>'to' = 'completed'
  ),
  agg as (
    select b,
      count(*) filter (where m = 'created')    created_count,
      count(*) filter (where m = 'submitted')  submitted_count,
      count(*) filter (where m = 'completed')  completed_count,
      count(*) filter (where m = 'rejected')   rejected_count,
      count(*) filter (where m = 'pending_pm') pending_pm_count
    from ev group by b
  )
  select coalesce(json_agg(json_build_object(
    'bucket', to_char(b, 'YYYY-MM-DD'),
    'created_count', created_count, 'submitted_count', submitted_count,
    'completed_count', completed_count, 'rejected_count', rejected_count, 'pending_pm_count', pending_pm_count
  ) order by b), '[]'::json) into v_series from agg;
  return json_build_object('ok', true, 'granularity', v_gran, 'series', v_series);
exception when sqlstate '22023' then
  return json_build_object('ok', false, 'error', 'invalid_filters');
end $function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_full_name text := nullif(meta->>'full_name','');
  v_phone     text := nullif(meta->>'phone','');
  v_note      text := nullif(meta->>'registration_note','');
  v_req_role  text := nullif(meta->>'requested_role','');
  v_code      text := nullif(meta->>'invite_code','');
  v_dept      uuid;
  v_mode      text;
  v_default_role text;
  v_invite    record;
  v_pinvite   record;
begin
  if coalesce(meta->>'user_type','') = 'portal' then
    select * into v_pinvite from public.customer_portal_invites
    where lower(code) = lower(coalesce(v_code,''))
      and is_active = true and expires_at > now() and used_count < max_uses
    order by created_at desc limit 1;
    if not found then
      raise exception 'invalid_portal_invite' using errcode = '22023';
    end if;
    insert into public.customer_portal_users (id, customer_id, contact_name, phone, portal_role, invited_by)
    values (new.id, v_pinvite.customer_id,
            coalesce(v_full_name, split_part(new.email,'@',1)),
            v_phone, v_pinvite.portal_role, v_pinvite.created_by);
    update public.customer_portal_invites set used_count = used_count + 1 where id = v_pinvite.id;
    return new;
  end if;

  begin v_dept := (meta->>'department_id')::uuid; exception when others then v_dept := null; end;

  select mode, default_requested_role into v_mode, v_default_role
  from public.registration_settings where id = 'main';
  v_default_role := coalesce(v_default_role, 'viewer');

  if v_code is not null then
    select * into v_invite from public.registration_invites
    where lower(code) = lower(v_code) and is_active = true
      and (expires_at is null or expires_at > now())
      and (max_uses is null or used_count < max_uses)
    limit 1;
    if found then
      v_req_role := coalesce(v_invite.default_role, v_req_role, v_default_role);
      update public.registration_invites set used_count = used_count + 1 where id = v_invite.id;
      insert into public.registration_invite_uses (invite_id, user_id, email)
      values (v_invite.id, new.id, new.email);
    end if;
  end if;

  if v_mode = 'gradual' then
    update public.registration_settings
    set remaining_slots = greatest(remaining_slots - 1, 0)
    where id = 'main' and remaining_slots > 0;
  end if;

  insert into public.app_users
    (id, email, role_id, full_name, phone, department_id,
     registration_note, requested_role, approval_status, is_active)
  values
    (new.id, new.email,
     (select id from public.roles where key = 'viewer'),
     v_full_name, v_phone, v_dept, v_note,
     coalesce(v_req_role, v_default_role, 'viewer'),
     'pending', true)
  on conflict (id) do nothing;

  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.has_capability(p_user uuid, p_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text; v_override boolean;
begin
  select r.key into v_role
  from public.app_users u join public.roles r on r.id = u.role_id
  where u.id = p_user and coalesce(u.approval_status,'approved') = 'approved';
  if v_role is null then return false; end if;
  if v_role = 'admin' then return true; end if;
  select up.allow into v_override
  from public.user_permissions up join public.permissions p on p.id = up.permission_id
  where up.user_id = p_user and p.key = p_key;
  if found then return v_override; end if;
  return exists (
    select 1 from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = (select role_id from public.app_users where id = p_user)
      and p.key = p_key);
end $function$
;

CREATE OR REPLACE FUNCTION public.import_inventory(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fin         boolean := public.is_financial_viewer();
  v_item        jsonb;
  v_type        text;
  v_id          uuid;
  v_status      asset_status;
  v_loc         uuid;
  v_qty         integer;
  v_cost        numeric;
  v_assets      integer := 0;
  v_consumables integer := 0;
  v_idx         integer := 0;
begin
  if not public.has_capability(auth.uid(), 'asset.import') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_idx  := v_idx + 1;
    v_type := v_item->>'item_type';
    if v_type = 'asset' then
      insert into public.assets (
        category_id, name, serial_number, status, location_id, company_id, supplier_id,
        purchase_date, purchase_cost, warranty_end, condition_grade, rfid_tag, notes
      ) values (
        (v_item->>'category_id')::uuid,
        nullif(v_item->>'name',''),
        nullif(v_item->>'serial_number',''),
        coalesce(nullif(v_item->>'status',''),'available')::asset_status,
        nullif(v_item->>'location_id','')::uuid,
        nullif(v_item->>'company_id','')::uuid,
        nullif(v_item->>'supplier_id','')::uuid,
        nullif(v_item->>'purchase_date','')::date,
        case when v_fin then nullif(v_item->>'purchase_cost','')::numeric else null end,
        nullif(v_item->>'warranty_end','')::date,
        nullif(v_item->>'condition_grade',''),
        nullif(v_item->>'rfid_tag',''),
        nullif(v_item->>'notes','')
      )
      returning id, status, location_id into v_id, v_status, v_loc;
      insert into public.asset_movements (asset_id, movement_type, to_status, to_location_id, performed_by, note)
      values (v_id, 'create'::movement_type, v_status, v_loc, auth.uid(), 'استيراد CSV');
      v_assets := v_assets + 1;
    elsif v_type = 'consumable' then
      v_qty  := coalesce(floor(nullif(v_item->>'quantity','')::numeric), 0)::integer;
      v_cost := case when v_fin then nullif(v_item->>'unit_cost','')::numeric else null end;
      insert into public.consumables (
        category_id, name, sku, unit, quantity_on_hand, reorder_level,
        company_id, supplier_id, location_id, unit_cost, rfid_tag, notes
      ) values (
        (v_item->>'category_id')::uuid,
        nullif(v_item->>'name',''),
        nullif(v_item->>'sku',''),
        coalesce(nullif(v_item->>'unit',''),'each'),
        v_qty,
        coalesce(floor(nullif(v_item->>'reorder_level','')::numeric), 0)::integer,
        nullif(v_item->>'company_id','')::uuid,
        nullif(v_item->>'supplier_id','')::uuid,
        nullif(v_item->>'location_id','')::uuid,
        v_cost,
        nullif(v_item->>'rfid_tag',''),
        nullif(v_item->>'notes','')
      )
      returning id into v_id;
      if v_qty > 0 then
        insert into public.consumable_transactions (
          consumable_id, txn_type, quantity, previous_quantity, balance_after,
          unit_cost, total_cost, supplier_id, reason, performed_by
        ) values (
          v_id, 'in'::consumable_txn_type, v_qty, 0, v_qty,
          v_cost, case when v_cost is not null then v_cost * v_qty else null end,
          nullif(v_item->>'supplier_id','')::uuid, 'رصيد افتتاحي (استيراد)', auth.uid()
        );
      end if;
      v_consumables := v_consumables + 1;
    else
      raise exception 'invalid_item_type at row %', v_idx using errcode = '22023';
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'assets', v_assets, 'consumables', v_consumables);
end $function$
;

CREATE OR REPLACE FUNCTION public.is_approved()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.app_users u
    where u.id = auth.uid()
      and coalesce(u.approval_status, 'approved') = 'approved'
  )
$function$
;

CREATE OR REPLACE FUNCTION public.is_financial_viewer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.app_user_role() in ('admin','it_manager') and public.is_approved();
$function$
;

CREATE OR REPLACE FUNCTION public.is_portal_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(select 1 from public.customer_portal_users where id = auth.uid() and is_active = true);
$function$
;

CREATE OR REPLACE FUNCTION public.list_customer_portal_invites(p_customer_id uuid)
 RETURNS SETOF customer_portal_invites
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.customer_portal_invites
  where public.app_user_role() in ('admin','it_manager') and customer_id = p_customer_id and is_active = true
  order by created_at desc;
$function$
;

CREATE OR REPLACE FUNCTION public.list_customer_portal_users(p_customer_id uuid)
 RETURNS SETOF customer_portal_users
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.customer_portal_users
  where public.app_user_role() in ('admin','it_manager') and customer_id = p_customer_id
  order by created_at desc;
$function$
;

CREATE OR REPLACE FUNCTION public.list_registration_requests(p_status text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, email text, full_name text, phone text, department_id uuid, department_name text, registration_note text, requested_role text, assigned_role text, approval_status text, created_at timestamp with time zone, approved_at timestamp with time zone, rejected_at timestamp with time zone, rejection_reason text, email_confirmed boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select u.id, u.email, u.full_name, u.phone,
         u.department_id, coalesce(d.name_ar, d.name),
         u.registration_note, u.requested_role, r.key,
         coalesce(u.approval_status, 'approved'), u.created_at,
         u.approved_at, u.rejected_at, u.rejection_reason,
         (au.email_confirmed_at is not null)
  from public.app_users u
  left join public.departments d on d.id = u.department_id
  left join public.roles r on r.id = u.role_id
  left join auth.users au on au.id = u.id
  where public.app_user_role() in ('admin','it_manager')
    and (p_status is null or coalesce(u.approval_status,'approved') = p_status)
  order by u.created_at desc
$function$
;

CREATE OR REPLACE FUNCTION public.maintenance_financial(p_ids uuid[])
 RETURNS TABLE(id uuid, cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select m.id, m.cost from public.maintenance_records m
  where public.is_financial_viewer() and m.id = any(p_ids);
$function$
;

CREATE OR REPLACE FUNCTION public.maintenance_guard_financial()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_financial_viewer() then
    if tg_op = 'INSERT' then
      new.cost := null;
    else
      new.cost := old.cost;
    end if;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.my_capabilities()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select p.key from public.permissions p where public.has_capability(auth.uid(), p.key); $function$
;

CREATE OR REPLACE FUNCTION public.next_asset_tag(p_category_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_year int := extract(year from now())::int; v_prefix text; v_seq int;
begin
  select prefix into v_prefix from categories where id = p_category_id;
  if v_prefix is null then raise exception 'Category % not found', p_category_id; end if;
  insert into tag_sequences (category_id, year, last_seq) values (p_category_id, v_year, 1)
  on conflict (category_id, year)
  do update set last_seq = tag_sequences.last_seq + 1
  returning last_seq into v_seq;
  return format('%s-%s-%s', v_prefix, v_year, lpad(v_seq::text, 4, '0'));
end $function$
;

CREATE OR REPLACE FUNCTION public.next_purchase_request_number()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_year int := extract(year from now())::int;
  v_seq int;
begin
  insert into public.purchase_request_sequences (year, last_seq) values (v_year, 1)
  on conflict (year) do update set last_seq = purchase_request_sequences.last_seq + 1
  returning last_seq into v_seq;
  return format('PR-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
end $function$
;

CREATE OR REPLACE FUNCTION public.next_request_number()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_year int := extract(year from now())::int; v_seq int;
begin
  insert into public.request_sequences (year, last_seq) values (v_year, 1)
  on conflict (year) do update set last_seq = request_sequences.last_seq + 1
  returning last_seq into v_seq;
  return format('REQ-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
end $function$
;

CREATE OR REPLACE FUNCTION public.notification_settings_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_add_item(p_request_id uuid, p_requested_kind text, p_requested_description text, p_requested_category text, p_quantity numeric, p_preferred_model text, p_accept_alternative boolean, p_needs_purchase boolean, p_preferred_company_id uuid DEFAULT NULL::uuid, p_category_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_kind text; v_cat_label text;
  v_company_count int; v_category_count int; v_needs boolean := coalesce(p_needs_purchase, false);
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;

  if v_needs and not v_s.allow_custom_item_requests then
    return json_build_object('ok', false, 'error', 'custom_item_not_allowed'); end if;

  if p_preferred_company_id is not null then
    select count(*) into v_company_count from public.customer_allowed_companies where customer_id = v_cid;
    if v_company_count = 0 then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
    if not exists (select 1 from public.customer_allowed_companies
                   where customer_id = v_cid and company_id = p_preferred_company_id) then
      return json_build_object('ok', false, 'error', 'company_not_allowed'); end if;
  end if;

  select count(*) into v_category_count from public.customer_allowed_categories where customer_id = v_cid;
  if v_category_count > 0 then
    if nullif(btrim(p_category_key),'') is null
       or not exists (select 1 from public.customer_allowed_categories
                      where customer_id = v_cid and category_key = p_category_key) then
      return json_build_object('ok', false, 'error', 'category_not_allowed');
    end if;
    select coalesce(category_label_ar, category_label_en, category_key)
      into v_cat_label
      from public.customer_allowed_categories
      where customer_id = v_cid and category_key = p_category_key;
  else
    v_cat_label := nullif(p_requested_category, '');
  end if;

  v_kind := case when p_requested_kind = 'consumable' then 'consumable' else 'custom' end;
  insert into public.request_items (
    request_id, item_kind, requested_kind, requested_description, requested_category,
    quantity, preferred_model, preferred_company_id, accept_alternative, needs_purchase
  ) values (
    p_request_id, 'custom', v_kind, nullif(p_requested_description,''), v_cat_label,
    greatest(coalesce(p_quantity,1), 1), nullif(p_preferred_model,''), p_preferred_company_id,
    coalesce(p_accept_alternative, true), v_needs
  );
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_can_read_request_attachment(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.request_attachments ra
    join public.requests r on r.id = ra.request_id
    where ra.storage_path = p_name
      and public.portal_customer_id() is not null
      and r.customer_id = public.portal_customer_id()
      and (public.portal_user_role() <> 'authorized_requester'
           or r.submitted_by is not distinct from auth.uid())
      and (ra.uploaded_by_kind = 'portal' or ra.visible_to_customer)
  );
$function$
;

CREATE OR REPLACE FUNCTION public.portal_can_upload_request_attachment(p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cid  uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_rid  uuid;
  v_req  public.requests%rowtype;
begin
  if v_cid is null then return false; end if;
  if v_role = 'viewer' then return false; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_create_request(p_project_name text, p_project_city text, p_contact_phone text, p_contact_email text, p_request_type text, p_pickup_date date, p_return_date date, p_notes text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_cust_name text; v_type text; v_id uuid; v_allowed boolean;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  v_type := case when p_request_type in ('rental','sale','service','mixed') then p_request_type else 'rental' end;
  v_allowed := case v_type
    when 'rental'  then v_s.allow_rental_requests
    when 'sale'    then v_s.allow_purchase_requests
    when 'service' then v_s.allow_maintenance_requests
    when 'mixed'   then v_s.allow_custom_requests
    else false end;
  if not v_allowed then return json_build_object('ok', false, 'error', 'request_type_not_allowed'); end if;
  select name into v_cust_name from public.customers where id = v_cid;
  insert into public.requests (
    customer_id, customer_name_snapshot, contact_phone_snapshot, contact_email_snapshot,
    project_name, project_city, request_type, status, request_source, submitted_by,
    pickup_date, return_date, notes, created_by
  ) values (
    v_cid, v_cust_name, nullif(p_contact_phone,''), nullif(p_contact_email,''),
    nullif(p_project_name,''), nullif(p_project_city,''), v_type, 'draft', 'client_portal', auth.uid(),
    p_pickup_date, case when v_type = 'sale' then null else p_return_date end,
    nullif(p_notes,''), auth.uid()
  ) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_customer_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select customer_id from public.customer_portal_users where id = auth.uid() and is_active = true;
$function$
;

CREATE OR REPLACE FUNCTION public.portal_get_context()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  select count(*) into v_companies  from public.customer_allowed_companies  where customer_id = v_cid;
  select count(*) into v_categories from public.customer_allowed_categories where customer_id = v_cid;
  return json_build_object('ok', true,
    'customer_name', v_name, 'contact_name', v_contact, 'portal_role', v_role,
    'portal_enabled', v_s.portal_enabled,
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
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_get_request(p_request_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_get_request_attachment_path(p_attachment_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_ra public.request_attachments%rowtype; v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  select * into v_ra from public.request_attachments where id = p_attachment_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  select * into v_req from public.requests where id = v_ra.request_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  if not (v_ra.uploaded_by_kind = 'portal' or v_ra.visible_to_customer) then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true, 'path', v_ra.storage_path);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_get_request_dashboard()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cid uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_s public.customer_portal_settings;
  v_result json;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  with mine as (
    select r.* from public.requests r
    where r.customer_id = v_cid
      and (v_role in ('project_manager','viewer') or r.submitted_by = auth.uid())
  ),
  recent as (select * from mine order by created_at desc limit 5)
  select json_build_object(
    'ok', true,
    'portal_role', v_role,
    'total_my_requests',   (select count(*) from mine),
    'open_requests',       (select count(*) from mine where status not in ('completed','returned','rejected','cancelled') and portal_approval_status <> 'rejected_by_project_manager'),
    'waiting_pm_approval', (select count(*) from mine where portal_approval_status = 'pending_project_manager'),
    'needs_clarification', (select count(*) from mine where status = 'needs_clarification'),
    'in_progress',         (select count(*) from mine where status in ('approved','preparing','ready_for_pickup','delivered','partially_returned','overdue')),
    'completed',           (select count(*) from mine where status in ('completed','returned')),
    'rejected',            (select count(*) from mine where status = 'rejected' or portal_approval_status = 'rejected_by_project_manager'),
    'counts_by_status',    (select coalesce(json_agg(json_build_object('status', status, 'portal_approval_status', portal_approval_status, 'count', c)), '[]'::json)
                            from (select status, portal_approval_status, count(*) c from mine group by status, portal_approval_status) t),
    'recent_requests',     (select coalesce(json_agg(json_build_object(
                              'id', id, 'request_number', request_number, 'status', status,
                              'portal_approval_status', portal_approval_status, 'request_type', request_type,
                              'project_name', project_name, 'created_at', created_at,
                              'item_count', (select count(*) from public.request_items ri where ri.request_id = recent.id)
                            ) order by created_at desc), '[]'::json) from recent)
  ) into v_result;
  return v_result;
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_list_allowed_categories()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  return json_build_object('ok', true, 'categories', coalesce((
    select json_agg(json_build_object('key', category_key,
      'label_ar', category_label_ar, 'label_en', category_label_en) order by category_key)
    from public.customer_allowed_categories where customer_id = v_cid
  ), '[]'::json));
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_list_allowed_companies()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  return json_build_object('ok', true, 'companies', coalesce((
    select json_agg(json_build_object('id', c.id, 'name', c.name) order by c.name)
    from public.customer_allowed_companies ac join public.companies c on c.id = ac.company_id
    where ac.customer_id = v_cid and c.is_active = true
  ), '[]'::json));
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_list_request_attachments(p_request_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role(); v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_list_requests()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_pm_approve_request(p_request_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role is distinct from 'project_manager' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' or v_req.portal_approval_status <> 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests
    set status = 'under_review',
        portal_approval_status = 'approved_by_project_manager',
        portal_approved_by = v_uid, portal_approved_at = now()
    where id = p_request_id;
  perform public._request_add_event(p_request_id, 'portal_pm_approved', 'portal', null, '{}'::jsonb);
  perform public._request_add_event(p_request_id, 'submitted', 'portal', null, '{}'::jsonb);
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_pm_reject_request(p_request_id uuid, p_reason text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role is distinct from 'project_manager' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' or v_req.portal_approval_status <> 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests
    set status = 'cancelled',
        portal_approval_status = 'rejected_by_project_manager',
        portal_rejected_by = v_uid, portal_rejected_at = now(),
        portal_rejection_reason = nullif(btrim(p_reason),'')
    where id = p_request_id;
  perform public._request_add_event(p_request_id, 'portal_pm_rejected', 'portal', nullif(btrim(p_reason),''), '{}'::jsonb);
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_register_request_attachment(p_request_id uuid, p_file_name text, p_storage_path text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cid  uuid := public.portal_customer_id();
  v_role text := public.portal_user_role();
  v_s    public.customer_portal_settings;
  v_req  public.requests%rowtype;
  v_mime text; v_size bigint; v_id uuid;
  v_allowed text[] := array[
    'application/pdf','image/png','image/jpeg','image/webp','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  if not v_s.allow_attachments then return json_build_object('ok', false, 'error', 'attachments_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then
    return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','needs_clarification') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  if p_storage_path !~ ('^requests/' || p_request_id::text || '/portal/[A-Za-z0-9._-]{1,150}$') then
    return json_build_object('ok', false, 'error', 'invalid_path'); end if;
  if coalesce(length(trim(p_file_name)),0) = 0 or length(p_file_name) > 200 then
    return json_build_object('ok', false, 'error', 'invalid_name'); end if;

  select nullif(o.metadata->>'mimetype',''), coalesce((o.metadata->>'size')::bigint, 0)
    into v_mime, v_size
    from storage.objects o
    where o.bucket_id = 'request-attachments' and o.name = p_storage_path and o.owner_id = auth.uid()::text;
  if not found then return json_build_object('ok', false, 'error', 'object_not_found'); end if;
  if v_mime is not null and v_mime <> all(v_allowed) then return json_build_object('ok', false, 'error', 'bad_type'); end if;
  if v_size > 10485760 then return json_build_object('ok', false, 'error', 'too_large'); end if;

  insert into public.request_attachments (
    request_id, uploaded_by_kind, uploaded_by, visible_to_customer,
    file_name, storage_path, mime_type, size_bytes
  ) values (
    p_request_id, 'portal', auth.uid(), true,
    p_file_name, p_storage_path, coalesce(v_mime,'application/octet-stream'), v_size
  )
  on conflict (storage_path) do nothing
  returning id into v_id;
  if v_id is null then return json_build_object('ok', false, 'error', 'already_registered'); end if;

  perform public._request_add_event(p_request_id, 'attachment_added', 'portal', p_file_name,
    jsonb_build_object('attachment_id', v_id));
  return json_build_object('ok', true, 'id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_remove_item(p_item_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select r.* into v_req from public.request_items ri join public.requests r on r.id = ri.request_id where ri.id = p_item_id;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  delete from public.request_items where id = p_item_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_reply_clarification(p_request_id uuid, p_message text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype;
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'needs_clarification' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests set status = 'under_review' where id = p_request_id;
  perform public._request_add_event(p_request_id, 'clarification_reply', 'portal', p_message, '{}'::jsonb);
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_submit_request(p_request_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cid uuid := public.portal_customer_id(); v_role text := public.portal_user_role();
  v_s public.customer_portal_settings; v_req public.requests%rowtype; v_items int; v_uid uuid := auth.uid();
begin
  if v_cid is null then return json_build_object('ok', false, 'error', 'not_portal'); end if;
  if v_role = 'viewer' then return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  v_s := public._portal_settings(v_cid);
  if not v_s.portal_enabled then return json_build_object('ok', false, 'error', 'portal_disabled'); end if;
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.customer_id is distinct from v_cid then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role = 'authorized_requester' and v_req.submitted_by is distinct from auth.uid() then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'draft' or v_req.portal_approval_status <> 'not_required' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  select count(*) into v_items from public.request_items where request_id = p_request_id;
  if v_items = 0 then return json_build_object('ok', false, 'error', 'no_items'); end if;

  if v_role = 'authorized_requester' and v_s.require_project_manager_approval then
    update public.requests
      set portal_approval_status = 'pending_project_manager',
          portal_approval_requested_by = v_uid, portal_approval_requested_at = now()
      where id = p_request_id;
    perform public._request_add_event(p_request_id, 'portal_pm_approval_requested', 'portal', null, '{}'::jsonb);
    return json_build_object('ok', true, 'pending_pm', true);
  end if;

  if v_role = 'project_manager' and v_s.require_project_manager_approval then
    update public.requests
      set status = 'under_review',
          portal_approval_status = 'approved_by_project_manager',
          portal_approved_by = v_uid, portal_approved_at = now()
      where id = p_request_id;
  else
    update public.requests set status = 'under_review' where id = p_request_id;
  end if;
  perform public._request_add_event(p_request_id, 'submitted', 'portal', null, '{}'::jsonb);
  return json_build_object('ok', true, 'pending_pm', false);
end $function$
;

CREATE OR REPLACE FUNCTION public.portal_user_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select portal_role from public.customer_portal_users where id = auth.uid() and is_active = true;
$function$
;

CREATE OR REPLACE FUNCTION public.pr_items_guard_financial()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_financial_viewer() then
    if tg_op = 'INSERT' then
      new.unit_cost := null;
    elsif new.unit_cost is distinct from old.unit_cost then
      new.unit_cost := old.unit_cost;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.public_asset_by_token(p_token text)
 RETURNS TABLE(asset_tag text, name text, status asset_status, category text, location text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select a.asset_tag, a.name, a.status,
         coalesce(c.name_ar, c.name) as category,
         coalesce(l.name_ar, l.name) as location
  from public.assets a
  left join public.categories c on c.id = a.category_id
  left join public.locations  l on l.id = a.location_id
  where a.qr_token = p_token and a.is_active = true
$function$
;

CREATE OR REPLACE FUNCTION public.purchase_request_item_receive(p_item_id uuid, p_qty numeric)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := public.app_user_role();
  v_pr uuid;
  v_status text;
  v_all_received boolean;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_qty is null or p_qty <= 0 then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;

  select i.purchase_request_id, pr.status into v_pr, v_status
  from public.purchase_request_items i
  join public.purchase_requests pr on pr.id = i.purchase_request_id
  where i.id = p_item_id for update of pr;
  if v_pr is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_status not in ('ordered','partially_received') then
    return json_build_object('ok', false, 'error', 'bad_status');
  end if;

  update public.purchase_request_items
  set received_quantity = received_quantity + p_qty, updated_at = now()
  where id = p_item_id;

  select bool_and(received_quantity >= requested_quantity) into v_all_received
  from public.purchase_request_items where purchase_request_id = v_pr;

  update public.purchase_requests
  set status = case when v_all_received then 'received' else 'partially_received' end
  where id = v_pr;

  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.purchase_request_items_financial(p_pr_ids uuid[])
 RETURNS TABLE(id uuid, unit_cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select i.id, i.unit_cost
  from public.purchase_request_items i
  where i.purchase_request_id = any (p_pr_ids) and public.is_financial_viewer();
$function$
;

CREATE OR REPLACE FUNCTION public.purchase_request_set_status(p_id uuid, p_to text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := public.app_user_role();
  v_cur text;
  v_requested_by uuid;
  v_ok boolean := false;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_allowed');
  end if;

  select status, requested_by into v_cur, v_requested_by
  from public.purchase_requests where id = p_id for update;
  if v_cur is null then return json_build_object('ok', false, 'error', 'not_found'); end if;

  if p_to = 'submitted' and v_cur = 'draft' then
    v_ok := true;
    update public.purchase_requests set status = 'submitted', submitted_at = now() where id = p_id;
  elsif p_to = 'approved' and v_cur = 'submitted' and v_role in ('admin','it_manager') then
    v_ok := true;
    update public.purchase_requests set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_id;
  elsif p_to = 'ordered' and v_cur = 'approved' then
    v_ok := true;
    update public.purchase_requests set status = 'ordered' where id = p_id;
  elsif p_to in ('partially_received','received') and v_cur in ('ordered','partially_received') then
    v_ok := true;
    update public.purchase_requests set status = p_to where id = p_id;
  elsif p_to = 'cancelled' and v_cur in ('draft','submitted','approved','ordered') then
    if v_role in ('admin','it_manager') or (v_cur = 'draft' and v_requested_by = auth.uid()) then
      v_ok := true;
      update public.purchase_requests set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now() where id = p_id;
    end if;
  end if;

  if not v_ok then return json_build_object('ok', false, 'error', 'bad_transition'); end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.purchase_requests_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.request_number is null or btrim(new.request_number) = '' then
      new.request_number := public.next_purchase_request_number();
    end if;
    new.requested_by := auth.uid();
    new.status := 'draft';
  end if;
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.registration_status()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'mode', s.mode,
    'require_email_verification', s.require_email_verification,
    'has_slots', (s.mode <> 'gradual' or s.remaining_slots > 0),
    'remaining_slots', case when s.mode = 'gradual' then s.remaining_slots else null end,
    'default_requested_role', s.default_requested_role,
    'message_ar', s.message_ar,
    'message_en', s.message_en,
    'departments', coalesce((
      select json_agg(json_build_object('id', d.id, 'name', d.name, 'name_ar', d.name_ar) order by d.name)
      from public.departments d
    ), '[]'::json)
  )
  from public.registration_settings s
  where s.id = 'main'
$function$
;

CREATE OR REPLACE FUNCTION public.reject_user(p_user_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_target text;
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user_id = auth.uid() then
    return json_build_object('ok', false, 'error', 'cannot_manage_self');
  end if;

  select r.key into v_target
  from public.app_users u
  left join public.roles r on r.id = u.role_id
  where u.id = p_user_id
  for update of u;
  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  if v_target = 'admin' and v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_manage_admin');
  end if;

  update public.app_users
  set approval_status = 'rejected',
      rejected_at = now(),
      rejected_by = auth.uid(),
      rejection_reason = nullif(p_reason,''),
      last_approval_action_at = now(),
      updated_at = now()
  where id = p_user_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_approve(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid();
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  update public.requests
  set status = 'approved',
      responsible_employee_id = coalesce(responsible_employee_id, v_uid)
  where id = p_id and status in ('draft','under_review','needs_clarification')
    and portal_approval_status <> 'pending_project_manager';
  if not found then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_attachment_registered(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(select 1 from public.request_attachments where storage_path = p_name);
$function$
;

CREATE OR REPLACE FUNCTION public.request_cancel(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','approved','preparing','ready_for_pickup') then
    return json_build_object('ok', false, 'error', 'cannot_cancel_after_deliver'); end if;
  if v_req.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'reserved' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'reserved', 'available', v_uid, 'إلغاء طلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'cancelled' where id = p_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_complete(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered','partially_returned','returned') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  for r in select ri.id, ri.asset_id, ri.delivered_quantity, a.status
           from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'rented' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'rented', 'available', v_uid, 'إكمال طلب '||v_req.request_number);
    update public.request_items set returned_quantity = delivered_quantity where id = r.id;
  end loop;
  update public.requests set status = 'completed' where id = p_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_deliver(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_req public.requests%rowtype;
  v_target asset_status;
  v_uid uuid := auth.uid();
  v_asset_ids uuid[];
  v_cons_ids uuid[];
  v_cur_status asset_status;
  v_cur int;
  v_need int;
  v_next int;
  r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('approved','preparing','ready_for_pickup') then
    return json_build_object('ok', false, 'error', 'state_not_deliverable');
  end if;
  if exists (select 1 from public.request_items where request_id = p_id and item_kind = 'custom' and coalesce(needs_purchase,false) = false) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items');
  end if;
  v_target := case when v_req.request_type = 'sale' then 'sold'::asset_status else 'rented'::asset_status end;

  select array_agg(asset_id) into v_asset_ids from public.request_items where request_id = p_id and item_kind = 'asset' and asset_id is not null;
  select array_agg(consumable_id) into v_cons_ids from public.request_items where request_id = p_id and item_kind = 'consumable' and consumable_id is not null;
  if v_asset_ids is not null then perform 1 from public.assets where id = any(v_asset_ids) order by id for update; end if;
  if v_cons_ids is not null then perform 1 from public.consumables where id = any(v_cons_ids) order by id for update; end if;

  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset'
             and (ri.quantity - coalesce(ri.delivered_quantity,0)) > 0 loop
    if r.status not in ('available','reserved') then
      return json_build_object('ok', false, 'error', 'asset_not_available');
    end if;
  end loop;

  for r in select ri.consumable_id, sum(ri.quantity - coalesce(ri.delivered_quantity,0)) as need, c.quantity_on_hand as qty
           from public.request_items ri join public.consumables c on c.id = ri.consumable_id
           where ri.request_id = p_id and ri.item_kind = 'consumable'
           group by ri.consumable_id, c.quantity_on_hand loop
    if r.need > 0 and r.need > r.qty then
      return json_build_object('ok', false, 'error', 'insufficient_stock');
    end if;
  end loop;

  for r in select ri.id, ri.item_kind, ri.asset_id, ri.consumable_id, ri.quantity, ri.delivered_quantity
           from public.request_items ri where ri.request_id = p_id loop
    if coalesce(r.delivered_quantity,0) >= r.quantity then continue; end if;
    if r.item_kind = 'asset' then
      select status into v_cur_status from public.assets where id = r.asset_id;
      update public.assets set status = v_target, assigned_to_employee_id = null where id = r.asset_id;
      insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
        values (r.asset_id, 'status_change', v_cur_status, v_target, v_uid, 'تسليم طلب '||v_req.request_number||' (عميل)');
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    elsif r.item_kind = 'consumable' then
      select quantity_on_hand into v_cur from public.consumables where id = r.consumable_id;
      v_need := (r.quantity - coalesce(r.delivered_quantity,0))::int;
      v_next := v_cur - v_need;
      insert into public.consumable_transactions (consumable_id, txn_type, quantity, previous_quantity, balance_after, reason, performed_by)
        values (r.consumable_id, 'out', v_need, v_cur, v_next, 'تسليم طلب '||v_req.request_number, v_uid);
      update public.consumables set quantity_on_hand = v_next where id = r.consumable_id;
      update public.request_items set delivered_quantity = r.quantity where id = r.id;
    end if;
  end loop;

  update public.requests
    set status = case when v_req.request_type = 'sale' then 'completed' else 'delivered' end,
        delivered_at = now()
  where id = p_id;

  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_item_convert_to_pr(p_item_id uuid, p_pr_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role      text := public.app_user_role();
  v_item      public.request_items%rowtype;
  v_req       public.requests%rowtype;
  v_pr_id     uuid;
  v_pr_number text;
  v_pr_status text;
  v_desc      text;
  v_company   text;
  v_notes     text;
  v_parts     text[] := array[]::text[];
begin
  if not (public.current_user_has_capability('request.approve') or v_role in ('admin','it_manager')) then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;

  select * into v_item from public.request_items where id = p_item_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_item.item_kind <> 'custom' then return json_build_object('ok', false, 'error', 'not_custom'); end if;
  if coalesce(v_item.delivered_quantity, 0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered'); end if;

  if exists (select 1 from public.purchase_request_items where source_request_item_id = p_item_id) then
    return json_build_object('ok', false, 'error', 'already_converted');
  end if;

  select * into v_req from public.requests where id = v_item.request_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('under_review','needs_clarification','approved','preparing') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;

  if p_pr_id is null then
    insert into public.purchase_requests (supplier_id, notes)
    values (null, 'طلب شراء مرتبط بالطلب ' || v_req.request_number)
    returning id, request_number into v_pr_id, v_pr_number;
  else
    select id, request_number, status into v_pr_id, v_pr_number, v_pr_status
    from public.purchase_requests where id = p_pr_id for update;
    if v_pr_id is null then return json_build_object('ok', false, 'error', 'pr_not_found'); end if;
    if v_pr_status <> 'draft' then return json_build_object('ok', false, 'error', 'pr_not_draft'); end if;
  end if;

  v_desc := coalesce(nullif(btrim(v_item.requested_description), ''),
                     nullif(btrim(v_item.requested_category), ''), 'عنصر مطلوب');
  if nullif(btrim(v_item.preferred_model), '') is not null then
    v_parts := v_parts || ('الموديل: ' || btrim(v_item.preferred_model));
  end if;
  if v_item.preferred_company_id is not null then
    select name into v_company from public.companies where id = v_item.preferred_company_id;
    if v_company is not null then v_parts := v_parts || ('الشركة المفضلة: ' || v_company); end if;
  end if;
  v_parts := v_parts || ('من الطلب ' || v_req.request_number);
  v_notes := array_to_string(v_parts, ' · ');

  insert into public.purchase_request_items
    (purchase_request_id, consumable_id, description, requested_quantity, notes, source_request_item_id)
  values
    (v_pr_id, null, v_desc, greatest(coalesce(v_item.quantity, 1), 1), v_notes, p_item_id);

  update public.request_items set needs_purchase = true where id = p_item_id;

  perform public._request_add_event(
    v_item.request_id, 'purchase_requested', 'staff', null,
    jsonb_build_object('item_id', p_item_id, 'pr_id', v_pr_id, 'pr_number', v_pr_number));

  return json_build_object('ok', true, 'pr_id', v_pr_id, 'pr_number', v_pr_number);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_item_fulfill(p_item_id uuid, p_asset_id uuid DEFAULT NULL::uuid, p_consumable_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_item public.request_items%rowtype; v_req public.requests%rowtype; v_astatus asset_status;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if (p_asset_id is null) = (p_consumable_id is null) then
    return json_build_object('ok', false, 'error', 'exactly_one_ref'); end if;
  select * into v_item from public.request_items where id = p_item_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  select * into v_req from public.requests where id = v_item.request_id for update;
  if v_req.status not in ('under_review','needs_clarification','approved','preparing') then
    return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  if coalesce(v_item.delivered_quantity,0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered'); end if;
  if p_asset_id is not null then
    select status into v_astatus from public.assets where id = p_asset_id;
    if v_astatus is null then return json_build_object('ok', false, 'error', 'asset_not_found'); end if;
    if v_astatus not in ('available','reserved') then
      return json_build_object('ok', false, 'error', 'asset_not_available'); end if;
    update public.request_items set item_kind = 'asset', asset_id = p_asset_id, consumable_id = null, needs_purchase = false where id = p_item_id;
  else
    perform 1 from public.consumables where id = p_consumable_id;
    if not found then return json_build_object('ok', false, 'error', 'consumable_not_found'); end if;
    update public.request_items set item_kind = 'consumable', consumable_id = p_consumable_id, asset_id = null, needs_purchase = false where id = p_item_id;
  end if;
  perform public._request_add_event(v_item.request_id, 'item_fulfilled', 'staff', null,
    jsonb_build_object('item_id', p_item_id, 'kind', case when p_asset_id is not null then 'asset' else 'consumable' end));
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_item_unfulfill(p_item_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_item public.request_items%rowtype;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_item from public.request_items where id = p_item_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if coalesce(v_item.delivered_quantity,0) > 0 then
    return json_build_object('ok', false, 'error', 'already_delivered'); end if;
  update public.request_items set item_kind = 'custom', asset_id = null, consumable_id = null where id = p_item_id;
  perform public._request_add_event(v_item.request_id, 'item_unfulfilled', 'staff', null, jsonb_build_object('item_id', p_item_id));
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_items_financial(p_request_ids uuid[])
 RETURNS TABLE(id uuid, request_id uuid, unit_price numeric, total_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select ri.id, ri.request_id, ri.unit_price, ri.total_price from public.request_items ri
  where public.is_financial_viewer() and ri.request_id = any(p_request_ids);
$function$
;

CREATE OR REPLACE FUNCTION public.request_mark_ready(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'preparing' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  update public.requests set status = 'ready_for_pickup' where id = p_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_reject(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('draft','under_review','needs_clarification','approved','preparing','ready_for_pickup') then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  if v_req.portal_approval_status = 'pending_project_manager' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'reserved' for update of a loop
    update public.assets set status = 'available' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'reserved', 'available', v_uid, 'رفض طلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'rejected', rejection_reason = nullif(p_reason,'') where id = p_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_request_clarification(p_id uuid, p_message text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_req public.requests%rowtype;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'under_review' then
    return json_build_object('ok', false, 'error', 'invalid_state');
  end if;
  update public.requests set status = 'needs_clarification' where id = p_id;
  perform public._request_add_event(p_id, 'clarification_requested', 'staff', p_message, '{}'::jsonb);
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_return(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid();
  r record; v_outstanding int := 0;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status not in ('delivered','partially_returned') then
    return json_build_object('ok', false, 'error', 'state_not_returnable'); end if;
  for r in select ri.id, ri.asset_id, ri.delivered_quantity, a.status
           from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset'
             and coalesce(ri.delivered_quantity,0) > coalesce(ri.returned_quantity,0)
           for update of a loop
    if r.status = 'rented' then
      update public.assets set status = 'available' where id = r.asset_id;
      insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
        values (r.asset_id, 'status_change', 'rented', 'available', v_uid, 'إرجاع طلب '||v_req.request_number);
      update public.request_items set returned_quantity = delivered_quantity where id = r.id;
    else
      v_outstanding := v_outstanding + 1;
    end if;
  end loop;
  if v_outstanding > 0 then
    update public.requests set status = 'partially_returned' where id = p_id;
  else
    update public.requests set status = 'returned', returned_at = now() where id = p_id;
  end if;
  return json_build_object('ok', true, 'outstanding', v_outstanding);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_set_responsible(p_id uuid, p_user_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ok boolean;
begin
  if not public.current_user_has_capability('request.approve') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select coalesce(approval_status,'approved') = 'approved' into v_ok from public.app_users where id = p_user_id;
  if not coalesce(v_ok, false) then
    return json_build_object('ok', false, 'error', 'invalid_user');
  end if;
  update public.requests set responsible_employee_id = p_user_id where id = p_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  perform public._request_add_event(p_id, 'responsible_assigned', 'staff', null, jsonb_build_object('user_id', p_user_id));
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_start_preparing(p_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_req public.requests%rowtype; v_uid uuid := auth.uid(); r record;
begin
  if v_caller is null or v_caller not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_req.status <> 'approved' then return json_build_object('ok', false, 'error', 'invalid_state'); end if;
  if exists (select 1 from public.request_items where request_id = p_id and item_kind = 'custom' and coalesce(needs_purchase,false) = false) then
    return json_build_object('ok', false, 'error', 'unfulfilled_items'); end if;
  for r in select ri.asset_id, a.status from public.request_items ri join public.assets a on a.id = ri.asset_id
           where ri.request_id = p_id and ri.item_kind = 'asset' and a.status = 'available' for update of a loop
    update public.assets set status = 'reserved' where id = r.asset_id;
    insert into public.asset_movements (asset_id, movement_type, from_status, to_status, performed_by, note)
      values (r.asset_id, 'status_change', 'available', 'reserved', v_uid, 'حجز لطلب '||v_req.request_number);
  end loop;
  update public.requests set status = 'preparing' where id = p_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_status_allowed(p_old text, p_new text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
begin
  if p_old = p_new then return true; end if;
  return case p_old
    when 'draft'               then p_new in ('under_review','approved','rejected','cancelled')
    when 'under_review'        then p_new in ('approved','rejected','cancelled','needs_clarification')
    when 'needs_clarification' then p_new in ('under_review','approved','rejected','cancelled')
    when 'approved'            then p_new in ('preparing','ready_for_pickup','delivered','completed','rejected','cancelled')
    when 'preparing'           then p_new in ('ready_for_pickup','delivered','completed','rejected','cancelled')
    when 'ready_for_pickup'    then p_new in ('delivered','completed','rejected','cancelled')
    when 'delivered'           then p_new in ('partially_returned','returned','completed','overdue')
    when 'partially_returned'  then p_new in ('returned','completed','overdue')
    when 'returned'            then p_new in ('completed')
    when 'overdue'             then p_new in ('partially_returned','returned','completed')
    when 'completed'           then false
    when 'rejected'            then false
    when 'cancelled'           then false
    else false
  end;
end $function$
;

CREATE OR REPLACE FUNCTION public.requests_assign_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.request_number is null or new.request_number = '' then
    new.request_number := public.next_request_number();
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.requests_guard_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role();
begin
  if new.status is distinct from old.status then
    if not public.request_status_allowed(old.status, new.status) then
      raise exception 'انتقال حالة طلب غير مسموح: % → %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status in ('approved','rejected') and not public.current_user_has_capability('request.approve') then
      raise exception 'الاعتماد/الرفض يتطلب صلاحية اعتماد الطلبات' using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'approved' then
      new.approved_by := auth.uid(); new.approved_at := now();
      new.rejected_by := null; new.rejected_at := null; new.rejection_reason := null;
    elsif new.status = 'rejected' then
      new.rejected_by := auth.uid(); new.rejected_at := now();
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    else
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
      new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at;
      new.rejection_reason := old.rejection_reason;
    end if;
  else
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at;
    new.rejection_reason := old.rejection_reason;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.requests_log_status_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status is distinct from old.status then
    insert into public.request_events(request_id, event_type, actor_kind, actor_id, metadata)
    values (new.id, 'status_changed', public._request_actor_kind(), auth.uid(),
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.reset_user_pending(p_user_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller text := public.app_user_role();
  v_target text;
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user_id = auth.uid() then
    return json_build_object('ok', false, 'error', 'cannot_manage_self');
  end if;

  select r.key into v_target
  from public.app_users u
  left join public.roles r on r.id = u.role_id
  where u.id = p_user_id
  for update of u;
  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  if v_target = 'admin' and v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_manage_admin');
  end if;

  update public.app_users
  set approval_status = 'pending',
      rejected_at = null, rejected_by = null, rejection_reason = null,
      approved_at = null, approved_by = null,
      last_approval_action_at = now(), updated_at = now()
  where id = p_user_id;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.revoke_customer_portal_invite(p_invite_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  update public.customer_portal_invites set is_active = false where id = p_invite_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.scan_logs_stamp_actor()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.performed_by := auth.uid();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.set_customer_allowed_categories(p_customer_id uuid, p_categories jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text := public.app_user_role(); v_el jsonb; v_key text;
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  delete from public.customer_allowed_categories where customer_id = p_customer_id;
  if p_categories is not null and jsonb_typeof(p_categories) = 'array' then
    for v_el in select * from jsonb_array_elements(p_categories) loop
      v_key := nullif(btrim(v_el->>'key'), '');
      if v_key is not null then
        insert into public.customer_allowed_categories (customer_id, category_key, category_label_ar, category_label_en, created_by)
        values (p_customer_id, v_key, nullif(v_el->>'label_ar',''), nullif(v_el->>'label_en',''), auth.uid())
        on conflict (customer_id, category_key) do update set
          category_label_ar = excluded.category_label_ar, category_label_en = excluded.category_label_en;
      end if;
    end loop;
  end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.set_customer_allowed_companies(p_customer_id uuid, p_company_ids uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text := public.app_user_role(); v_cid uuid;
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  if p_company_ids is not null then
    foreach v_cid in array p_company_ids loop
      if not exists (select 1 from public.companies where id = v_cid) then
        return json_build_object('ok', false, 'error', 'company_not_found'); end if;
    end loop;
  end if;
  delete from public.customer_allowed_companies where customer_id = p_customer_id;
  if p_company_ids is not null and array_length(p_company_ids, 1) is not null then
    insert into public.customer_allowed_companies (customer_id, company_id, created_by)
    select p_customer_id, x, auth.uid() from unnest(p_company_ids) as x
    on conflict do nothing;
  end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.set_customer_portal_user_active(p_user_id uuid, p_active boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role();
begin
  if v_caller is null or v_caller not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  update public.customer_portal_users set is_active = coalesce(p_active, true), updated_at = now() where id = p_user_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.set_role_capability(p_role_key text, p_key text, p_allowed boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_role uuid; v_perm uuid;
begin
  if v_caller is null or v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  select id into v_role from public.roles where key = p_role_key;
  select id into v_perm from public.permissions where key = p_key;
  if v_role is null or v_perm is null then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  delete from public.role_permissions where role_id = v_role and permission_id = v_perm;
  if p_allowed then
    insert into public.role_permissions(role_id, permission_id) values (v_role, v_perm);
  end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin new.updated_at := now(); return new; end $function$
;

CREATE OR REPLACE FUNCTION public.set_user_capability(p_user uuid, p_key text, p_state text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_caller text := public.app_user_role(); v_perm uuid; v_target_role text;
begin
  if v_caller is null or v_caller <> 'admin' then
    return json_build_object('ok', false, 'error', 'not_authorized');
  end if;
  if p_user = auth.uid() then
    return json_build_object('ok', false, 'error', 'cannot_modify_self');
  end if;
  select r.key into v_target_role
  from public.app_users u join public.roles r on r.id = u.role_id where u.id = p_user;
  if v_target_role = 'admin' then
    return json_build_object('ok', false, 'error', 'cannot_modify_admin');
  end if;
  select id into v_perm from public.permissions where key = p_key;
  if v_perm is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  delete from public.user_permissions where user_id = p_user and permission_id = v_perm;
  if p_state = 'allow' then
    insert into public.user_permissions(user_id, permission_id, allow) values (p_user, v_perm, true);
  elsif p_state = 'deny' then
    insert into public.user_permissions(user_id, permission_id, allow) values (p_user, v_perm, false);
  end if;
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.staff_register_request_attachment(p_request_id uuid, p_file_name text, p_storage_path text, p_visible_to_customer boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := public.app_user_role();
  v_req  public.requests%rowtype;
  v_mime text; v_size bigint; v_id uuid;
  v_allowed text[] := array[
    'application/pdf','image/png','image/jpeg','image/webp','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_req from public.requests where id = p_request_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if p_storage_path !~ ('^requests/' || p_request_id::text || '/staff/[A-Za-z0-9._-]{1,150}$') then
    return json_build_object('ok', false, 'error', 'invalid_path'); end if;
  if coalesce(length(trim(p_file_name)),0) = 0 or length(p_file_name) > 200 then
    return json_build_object('ok', false, 'error', 'invalid_name'); end if;

  select nullif(o.metadata->>'mimetype',''), coalesce((o.metadata->>'size')::bigint, 0)
    into v_mime, v_size
    from storage.objects o
    where o.bucket_id = 'request-attachments' and o.name = p_storage_path and o.owner_id = auth.uid()::text;
  if not found then return json_build_object('ok', false, 'error', 'object_not_found'); end if;
  if v_mime is not null and v_mime <> all(v_allowed) then return json_build_object('ok', false, 'error', 'bad_type'); end if;
  if v_size > 10485760 then return json_build_object('ok', false, 'error', 'too_large'); end if;

  insert into public.request_attachments (
    request_id, uploaded_by_kind, uploaded_by, visible_to_customer,
    file_name, storage_path, mime_type, size_bytes
  ) values (
    p_request_id, 'staff', auth.uid(), coalesce(p_visible_to_customer, false),
    p_file_name, p_storage_path, coalesce(v_mime,'application/octet-stream'), v_size
  )
  on conflict (storage_path) do nothing
  returning id into v_id;
  if v_id is null then return json_build_object('ok', false, 'error', 'already_registered'); end if;

  perform public._request_add_event(p_request_id, 'attachment_added', 'staff', p_file_name,
    jsonb_build_object('attachment_id', v_id, 'visible_to_customer', coalesce(p_visible_to_customer, false)));
  return json_build_object('ok', true, 'id', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.staff_set_request_attachment_visibility(p_attachment_id uuid, p_visible boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text := public.app_user_role(); v_ra public.request_attachments%rowtype;
begin
  if v_role is null or v_role not in ('admin','it_manager','technician') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  select * into v_ra from public.request_attachments where id = p_attachment_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_ra.uploaded_by_kind <> 'staff' then return json_build_object('ok', false, 'error', 'not_allowed'); end if;
  update public.request_attachments set visible_to_customer = coalesce(p_visible, false) where id = p_attachment_id;
  perform public._request_add_event(v_ra.request_id, 'attachment_visibility_changed', 'staff', v_ra.file_name,
    jsonb_build_object('attachment_id', v_ra.id, 'visible_to_customer', coalesce(p_visible, false)));
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.update_customer_portal_settings(p_customer_id uuid, p_portal_enabled boolean, p_allow_rental boolean, p_allow_purchase boolean, p_allow_maintenance boolean, p_allow_custom boolean, p_allow_custom_item boolean, p_allow_attachments boolean, p_require_pm boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_role text := public.app_user_role();
begin
  if v_role is null or v_role not in ('admin','it_manager') then
    return json_build_object('ok', false, 'error', 'not_authorized'); end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    return json_build_object('ok', false, 'error', 'customer_not_found'); end if;
  insert into public.customer_portal_settings (
    customer_id, portal_enabled, allow_rental_requests, allow_purchase_requests,
    allow_maintenance_requests, allow_custom_requests, allow_custom_item_requests,
    allow_attachments, require_project_manager_approval, updated_by, updated_at
  ) values (
    p_customer_id, coalesce(p_portal_enabled,true), coalesce(p_allow_rental,true), coalesce(p_allow_purchase,true),
    coalesce(p_allow_maintenance,true), coalesce(p_allow_custom,true), coalesce(p_allow_custom_item,true),
    coalesce(p_allow_attachments,true), coalesce(p_require_pm,false), auth.uid(), now()
  )
  on conflict (customer_id) do update set
    portal_enabled = excluded.portal_enabled,
    allow_rental_requests = excluded.allow_rental_requests,
    allow_purchase_requests = excluded.allow_purchase_requests,
    allow_maintenance_requests = excluded.allow_maintenance_requests,
    allow_custom_requests = excluded.allow_custom_requests,
    allow_custom_item_requests = excluded.allow_custom_item_requests,
    allow_attachments = excluded.allow_attachments,
    require_project_manager_approval = excluded.require_project_manager_approval,
    updated_by = auth.uid(), updated_at = now();
  return json_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.user_label(uid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when public.app_user_role() in ('admin','it_manager')
      then (select coalesce(nullif(full_name, ''), email) from public.app_users where id = uid)
    else null
  end
$function$
;

CREATE OR REPLACE FUNCTION public.validate_portal_invite(p_code text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record;
begin
  select i.portal_role, i.expires_at, c.name as customer_name into v
  from public.customer_portal_invites i join public.customers c on c.id = i.customer_id
  where lower(i.code) = lower(coalesce(p_code,'')) and i.is_active = true
    and i.expires_at > now() and i.used_count < i.max_uses
  limit 1;
  if not found then return json_build_object('valid', false); end if;
  return json_build_object('valid', true, 'customer_name', v.customer_name, 'portal_role', v.portal_role, 'expires_at', v.expires_at);
end $function$
;

CREATE OR REPLACE FUNCTION public.validate_registration_invite(p_code text)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'valid', (i.id is not null),
    'default_role', i.default_role
  )
  from (select 1) dummy
  left join public.registration_invites i
    on lower(i.code) = lower(p_code)
   and i.is_active = true
   and (i.expires_at is null or i.expires_at > now())
   and (i.max_uses is null or i.used_count < i.max_uses)
$function$
;

CREATE TRIGGER trg_app_users_updated BEFORE UPDATE ON public.app_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_asset_assignments_updated BEFORE UPDATE ON public.asset_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_asset_assignments AFTER INSERT OR DELETE OR UPDATE ON public.asset_assignments FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER trg_asset_pools_stamp_creator BEFORE INSERT ON public.asset_pools FOR EACH ROW EXECUTE FUNCTION asset_pools_stamp_creator();
CREATE TRIGGER trg_asset_pools_touch_updated BEFORE UPDATE ON public.asset_pools FOR EACH ROW EXECUTE FUNCTION asset_pools_touch_updated();
CREATE TRIGGER trg_assets_assign_tag BEFORE INSERT ON public.assets FOR EACH ROW EXECUTE FUNCTION assets_assign_tag();
CREATE TRIGGER trg_assets_guard_serial_exempt BEFORE INSERT OR UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION assets_guard_serial_exempt();
CREATE TRIGGER trg_assets_guard_status BEFORE UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION assets_guard_status();
CREATE TRIGGER trg_assets_updated BEFORE UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_assets AFTER INSERT OR DELETE OR UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER trg_categories_updated BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_consumables AFTER INSERT OR DELETE OR UPDATE ON public.consumables FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER trg_consumables_updated BEFORE UPDATE ON public.consumables FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_portal_settings_updated BEFORE UPDATE ON public.customer_portal_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_portal_users_updated BEFORE UPDATE ON public.customer_portal_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_customers AFTER INSERT OR DELETE OR UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_departments_updated BEFORE UPDATE ON public.departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employees_updated BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_feature_exposure_settings_stamp BEFORE INSERT OR UPDATE ON public.feature_exposure_settings FOR EACH ROW EXECUTE FUNCTION feature_exposure_settings_stamp();
CREATE TRIGGER trg_locations_updated BEFORE UPDATE ON public.locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_maintenance_records AFTER INSERT OR DELETE OR UPDATE ON public.maintenance_records FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER trg_maintenance_guard_financial BEFORE INSERT OR UPDATE ON public.maintenance_records FOR EACH ROW EXECUTE FUNCTION maintenance_guard_financial();
CREATE TRIGGER trg_maintenance_records_updated BEFORE UPDATE ON public.maintenance_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_models_updated BEFORE UPDATE ON public.models FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_notification_settings_stamp BEFORE INSERT OR UPDATE ON public.notification_settings FOR EACH ROW EXECUTE FUNCTION notification_settings_stamp();
CREATE TRIGGER trg_permissions_updated BEFORE UPDATE ON public.permissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pr_items_guard_financial BEFORE INSERT OR UPDATE ON public.purchase_request_items FOR EACH ROW EXECUTE FUNCTION pr_items_guard_financial();
CREATE TRIGGER trg_purchase_requests_stamp BEFORE INSERT OR UPDATE ON public.purchase_requests FOR EACH ROW EXECUTE FUNCTION purchase_requests_stamp();
CREATE TRIGGER trg_audit_request_items AFTER INSERT OR DELETE OR UPDATE ON public.request_items FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER trg_audit_requests AFTER INSERT OR DELETE OR UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER trg_requests_assign_number BEFORE INSERT ON public.requests FOR EACH ROW EXECUTE FUNCTION requests_assign_number();
CREATE TRIGGER trg_requests_guard_status BEFORE UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION requests_guard_status();
CREATE TRIGGER trg_requests_log_status_event AFTER UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION requests_log_status_event();
CREATE TRIGGER trg_requests_updated BEFORE UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_scan_logs_stamp_actor BEFORE INSERT ON public.scan_logs FOR EACH ROW EXECUTE FUNCTION scan_logs_stamp_actor();
CREATE TRIGGER trg_stocktakes_updated BEFORE UPDATE ON public.stocktakes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

alter table public.action_alert_events enable row level security;
alter table public.action_alert_instances enable row level security;
alter table public.app_users enable row level security;
alter table public.asset_assignments enable row level security;
alter table public.asset_movements enable row level security;
alter table public.asset_pools enable row level security;
alter table public.assets enable row level security;
alter table public.attachments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.categories enable row level security;
alter table public.companies enable row level security;
alter table public.consumable_transactions enable row level security;
alter table public.consumables enable row level security;
alter table public.customer_allowed_categories enable row level security;
alter table public.customer_allowed_companies enable row level security;
alter table public.customer_portal_invites enable row level security;
alter table public.customer_portal_settings enable row level security;
alter table public.customer_portal_users enable row level security;
alter table public.customers enable row level security;
alter table public.departments enable row level security;
alter table public.depreciation_rules enable row level security;
alter table public.employees enable row level security;
alter table public.feature_exposure_settings enable row level security;
alter table public.locations enable row level security;
alter table public.maintenance_records enable row level security;
alter table public.models enable row level security;
alter table public.notification_settings enable row level security;
alter table public.permissions enable row level security;
alter table public.purchase_request_items enable row level security;
alter table public.purchase_requests enable row level security;
alter table public.registration_invite_uses enable row level security;
alter table public.registration_invites enable row level security;
alter table public.registration_settings enable row level security;
alter table public.request_attachments enable row level security;
alter table public.request_events enable row level security;
alter table public.request_items enable row level security;
alter table public.request_sequences enable row level security;
alter table public.requests enable row level security;
alter table public.role_permissions enable row level security;
alter table public.roles enable row level security;
alter table public.scan_logs enable row level security;
alter table public.stocktake_items enable row level security;
alter table public.stocktakes enable row level security;
alter table public.supplier_categories enable row level security;
alter table public.suppliers enable row level security;
alter table public.tag_sequences enable row level security;
alter table public.user_permissions enable row level security;

create policy sel_auth on public.action_alert_events as permissive for select to authenticated using (is_approved());
create policy sel_auth on public.action_alert_instances as permissive for select to authenticated using (is_approved());
create policy del_admin on public.app_users as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.app_users as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_self_or_admin on public.app_users as permissive for select to authenticated using (((id = auth.uid()) OR (app_user_role() = 'admin'::text)));
create policy upd_admin on public.app_users as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy del_admin on public.asset_assignments as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.asset_assignments as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.asset_assignments as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.asset_assignments as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.asset_movements as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.asset_movements as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.asset_movements as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.asset_movements as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy ins_mgr on public.asset_pools as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_auth on public.asset_pools as permissive for select to authenticated using (is_approved());
create policy upd_mgr on public.asset_pools as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.assets as permissive for delete to public using (current_user_has_capability('asset.delete'::text));
create policy ins_ops on public.assets as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.assets as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.assets as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.attachments as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.attachments as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.attachments as permissive for select to authenticated using ((is_approved() AND ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])) OR (COALESCE(kind, ''::text) <> ALL (ARRAY['warranty_invoice'::text, 'purchase_invoice'::text, 'consumable_invoice'::text, 'replenishment_invoice'::text])))));
create policy upd_ops on public.attachments as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_audit on public.audit_logs as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.categories as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.categories as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.categories as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.categories as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy del_mgr on public.companies as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_mgr on public.companies as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_auth on public.companies as permissive for select to authenticated using (is_approved());
create policy upd_mgr on public.companies as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.consumable_transactions as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.consumable_transactions as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.consumable_transactions as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.consumable_transactions as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.consumables as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.consumables as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.consumables as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.consumables as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_mgr on public.customer_allowed_categories as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_mgr on public.customer_allowed_companies as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_mgr on public.customer_portal_invites as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_mgr on public.customer_portal_settings as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_mgr on public.customer_portal_users as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.customers as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_mgr on public.customers as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_auth on public.customers as permissive for select to authenticated using (is_approved());
create policy upd_mgr on public.customers as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.departments as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.departments as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.departments as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.departments as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy del_mgr on public.depreciation_rules as permissive for delete to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy ins_mgr on public.depreciation_rules as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_auth on public.depreciation_rules as permissive for select to authenticated using (is_approved());
create policy upd_mgr on public.depreciation_rules as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.employees as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.employees as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.employees as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.employees as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy ins_admin on public.feature_exposure_settings as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.feature_exposure_settings as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.feature_exposure_settings as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy del_admin on public.locations as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.locations as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.locations as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.locations as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy del_admin on public.maintenance_records as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.maintenance_records as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.maintenance_records as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.maintenance_records as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.models as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.models as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.models as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.models as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy ins_mgr on public.notification_settings as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_auth on public.notification_settings as permissive for select to authenticated using (is_approved());
create policy upd_mgr on public.notification_settings as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.permissions as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.permissions as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.permissions as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.permissions as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy del_ops_draft on public.purchase_request_items as permissive for delete to authenticated using (((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])) AND (EXISTS ( SELECT 1
   FROM purchase_requests pr
  WHERE ((pr.id = purchase_request_items.purchase_request_id) AND (pr.status = 'draft'::text))))));
create policy ins_ops_draft on public.purchase_request_items as permissive for insert to authenticated with check (((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])) AND (EXISTS ( SELECT 1
   FROM purchase_requests pr
  WHERE ((pr.id = purchase_request_items.purchase_request_id) AND (pr.status = 'draft'::text))))));
create policy sel_auth on public.purchase_request_items as permissive for select to authenticated using (is_approved());
create policy upd_ops_draft on public.purchase_request_items as permissive for update to authenticated using (((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])) AND (EXISTS ( SELECT 1
   FROM purchase_requests pr
  WHERE ((pr.id = purchase_request_items.purchase_request_id) AND (pr.status = 'draft'::text)))))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy ins_ops on public.purchase_requests as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.purchase_requests as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.purchase_requests as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_mgr on public.registration_invite_uses as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_mgr on public.registration_invite_uses as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_mgr on public.registration_invite_uses as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy upd_mgr on public.registration_invite_uses as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_mgr on public.registration_invites as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_mgr on public.registration_invites as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_mgr on public.registration_invites as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy upd_mgr on public.registration_invites as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_mgr on public.registration_settings as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_mgr on public.registration_settings as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_mgr on public.registration_settings as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy upd_mgr on public.registration_settings as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_staff on public.request_attachments as permissive for select to authenticated using (is_approved());
create policy sel_auth on public.request_events as permissive for select to authenticated using (is_approved());
create policy del_ops on public.request_items as permissive for delete to authenticated using (((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])) AND (EXISTS ( SELECT 1
   FROM requests r
  WHERE ((r.id = request_items.request_id) AND (r.status = ANY (ARRAY['draft'::text, 'under_review'::text])))))));
create policy ins_ops on public.request_items as permissive for insert to authenticated with check (((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])) AND (EXISTS ( SELECT 1
   FROM requests r
  WHERE ((r.id = request_items.request_id) AND (r.status = ANY (ARRAY['draft'::text, 'under_review'::text])))))));
create policy sel_auth on public.request_items as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.request_items as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.requests as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.requests as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.requests as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.requests as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.role_permissions as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.role_permissions as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.role_permissions as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.role_permissions as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy del_admin on public.roles as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.roles as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.roles as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.roles as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));
create policy ins_ops on public.scan_logs as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_ops on public.scan_logs as permissive for select to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.stocktake_items as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.stocktake_items as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.stocktake_items as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.stocktake_items as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.stocktakes as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.stocktakes as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.stocktakes as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.stocktakes as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_mgr on public.supplier_categories as permissive for delete to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy ins_mgr on public.supplier_categories as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_auth on public.supplier_categories as permissive for select to authenticated using (is_approved());
create policy upd_mgr on public.supplier_categories as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.suppliers as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.suppliers as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy sel_auth on public.suppliers as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.suppliers as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text])));
create policy del_admin on public.tag_sequences as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_ops on public.tag_sequences as permissive for insert to authenticated with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy sel_auth on public.tag_sequences as permissive for select to authenticated using (is_approved());
create policy upd_ops on public.tag_sequences as permissive for update to authenticated using ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text]))) with check ((app_user_role() = ANY (ARRAY['admin'::text, 'it_manager'::text, 'technician'::text])));
create policy del_admin on public.user_permissions as permissive for delete to authenticated using ((app_user_role() = 'admin'::text));
create policy ins_admin on public.user_permissions as permissive for insert to authenticated with check ((app_user_role() = 'admin'::text));
create policy sel_auth on public.user_permissions as permissive for select to authenticated using (is_approved());
create policy upd_admin on public.user_permissions as permissive for update to authenticated using ((app_user_role() = 'admin'::text)) with check ((app_user_role() = 'admin'::text));

set check_function_bodies = true;
