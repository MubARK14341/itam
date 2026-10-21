export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue | undefined }

export const TEMPLATE_KEYS = [
  "maintenance_opened",
  "maintenance_idle_reminder",
  "maintenance_escalated",
  "warehouse_daily_digest",
  "management_end_of_day",
  "custody_delivery_proof",
  "warranty_threshold",
  "useful_life_threshold",
  "sla_stalled_operation",
  "automation_failure",
  "weekly_warehouse_report",
  "weekly_maintenance_report",
  "monthly_management_report",
  // EDIT 5 transactional messages and the three role-specific 09:00 digests.
  "daily_manager_digest",
  "daily_warehouse_digest",
  "daily_office_employee_digest",
  "portal_request_created_customer",
  "portal_request_created_internal",
  "internal_request_created_requester",
  "internal_request_created_manager",
  "request_needs_clarification",
  "request_approved",
  "request_rejected",
  "request_cancelled",
  "request_ready_for_pickup",
  "additional_quantity_required_internal",
  "return_reminder_two_days",
  "return_reminder_due_today",
  "return_overdue_internal",
  "account_pending_user",
  "account_pending_manager",
  "account_approved",
  "account_rejected",
  "email_staging_test",
  "email_production_test",
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type MessageLanguage = "ar" | "en";

export interface MaintenancePayload extends JsonObject {
  maintenance_id: string;
  asset_id?: string;
  asset_tag?: string;
  priority?: string;
  workflow_stage?: string;
  problem_description?: string;
  reported_at?: string;
  business_days?: number;
  threshold_days?: number;
  link: string;
}

export interface DigestItem extends JsonObject {
  label: string;
  detail?: string;
  link?: string;
}

export interface DigestSection extends JsonObject {
  title: string;
  count: number;
  items?: DigestItem[];
}

export interface DigestPayload extends JsonObject {
  report_date: string;
  sections: DigestSection[];
  link: string;
}

export interface CustodyProofPayload extends JsonObject {
  proof_number: string;
  assignment_id: string;
  recipient_name?: string;
  assigned_by?: string;
  assigned_at: string;
  asset_id: string;
  asset_tag?: string;
  asset_name?: string;
  brand?: string;
  model?: string;
  serial_number?: string;
  condition?: string;
  accessories?: JsonValue;
  location?: string;
  return_date?: string;
  request_number?: string;
  link: string;
}

export interface ThresholdAsset extends JsonObject {
  asset_id: string;
  asset_tag?: string;
  name?: string;
  threshold_days: number;
  target_date: string;
  link: string;
}

export interface ThresholdPayload extends JsonObject {
  kind: "warranty" | "useful_life";
  assets: ThresholdAsset[];
  link: string;
}

export interface SlaPayload extends JsonObject {
  rule: "under_review" | "accepted_not_preparing" | "return_inspection_pending";
  request_id: string;
  request_number: string;
  status: string;
  elapsed_minutes_excluding_weekends: number;
  link: string;
}

export interface AutomationFailurePayload extends JsonObject {
  issue: string;
  severity: "warning" | "critical";
  observed_at: string;
  link: string;
}

export interface ReportPayload extends JsonObject {
  period_start: string;
  period_end: string;
  sections: DigestSection[];
  link: string;
}

/**
 * Safe common shape for EDIT 5 event emails.  It intentionally contains only
 * presentation-safe values and an in-app route—never prices, tokens, raw
 * notes, provider credentials, or a state-changing URL.
 */
export interface NotificationPayload extends JsonObject {
  recipient_name?: string;
  request_number?: string;
  project_name?: string;
  city?: string;
  return_date?: string;
  pickup_date?: string;
  summary?: string;
  reason?: string;
  sections?: DigestSection[];
  link: string;
}

export interface TemplatePayloadMap {
  maintenance_opened: MaintenancePayload;
  maintenance_idle_reminder: MaintenancePayload;
  maintenance_escalated: MaintenancePayload;
  warehouse_daily_digest: DigestPayload;
  management_end_of_day: DigestPayload;
  custody_delivery_proof: CustodyProofPayload;
  warranty_threshold: ThresholdPayload;
  useful_life_threshold: ThresholdPayload;
  sla_stalled_operation: SlaPayload;
  automation_failure: AutomationFailurePayload;
  weekly_warehouse_report: ReportPayload;
  weekly_maintenance_report: ReportPayload;
  monthly_management_report: ReportPayload;
  daily_manager_digest: NotificationPayload;
  daily_warehouse_digest: NotificationPayload;
  daily_office_employee_digest: NotificationPayload;
  portal_request_created_customer: NotificationPayload;
  portal_request_created_internal: NotificationPayload;
  internal_request_created_requester: NotificationPayload;
  internal_request_created_manager: NotificationPayload;
  request_needs_clarification: NotificationPayload;
  request_approved: NotificationPayload;
  request_rejected: NotificationPayload;
  request_cancelled: NotificationPayload;
  request_ready_for_pickup: NotificationPayload;
  additional_quantity_required_internal: NotificationPayload;
  return_reminder_two_days: NotificationPayload;
  return_reminder_due_today: NotificationPayload;
  return_overdue_internal: NotificationPayload;
  account_pending_user: NotificationPayload;
  account_pending_manager: NotificationPayload;
  account_approved: NotificationPayload;
  account_rejected: NotificationPayload;
  email_staging_test: NotificationPayload;
  email_production_test: NotificationPayload;
}

export interface OutboxRow {
  id: string;
  logical_message_key: string;
  event_key: string;
  event_type: string;
  recipient_type: string;
  recipient_ref: string | null;
  recipient_email: string;
  reference_type: string;
  reference_id: string | null;
  template_key: TemplateKey;
  language: MessageLanguage;
  payload: JsonObject;
  frozen_from: string | null;
  frozen_to: string[] | null;
  frozen_cc: string[] | null;
  frozen_bcc: string[] | null;
  frozen_reply_to: string | null;
  frozen_subject: string | null;
  frozen_html: string | null;
  frozen_text: string | null;
  snapshot_frozen_at: string | null;
  attempt_count: number;
  max_attempts: number;
  lock_token: string;
  provider: string;
  test_mode: boolean | null;
}

export interface FrozenEmailSnapshot {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  tags: Record<string, string>;
}

export interface ProviderSuccess {
  ok: true;
  providerMessageId: string;
}

export interface ProviderFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  deliveryUnknown: boolean;
}

export type ProviderResult = ProviderSuccess | ProviderFailure;
