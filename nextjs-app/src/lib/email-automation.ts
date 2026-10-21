import { createClient } from "@/lib/supabase/client";

const supabase = () => createClient() as any;

export type EmailAutomationSettings = {
  email_enabled: boolean;
  test_mode: boolean;
  daily_digest_enabled: boolean;
  working_days: number[];
  digest_time: string;
  request_events_enabled: boolean;
  return_reminders_enabled: boolean;
  account_events_enabled: boolean;
  daily_warning_threshold: number;
  monthly_warning_threshold: number;
};

export type EmailDeliveryOverview = {
  sent_today: number; delivered_today: number; pending: number; failed: number;
  suppressed: number; last_dispatch: string | null; last_digest: string | null;
};

export type RecentEmailDelivery = {
  id: string; status: string; template_key: string; event_type: string;
  recipient_email: string; provider_message_id: string | null; safe_error: string | null;
  created_at: string; sent_at: string | null;
};

export async function getEmailAutomationSettings(): Promise<{ data: EmailAutomationSettings | null; error: string | null }> {
  const { data, error } = await supabase().rpc("automation_email_settings_get");
  return { data: data as EmailAutomationSettings | null, error: error?.message ?? null };
}

export async function updateEmailAutomationSettings(settings: Partial<EmailAutomationSettings>): Promise<{ data: EmailAutomationSettings | null; error: string | null }> {
  const { data, error } = await supabase().rpc("automation_email_settings_update", { p_settings: settings });
  return { data: data as EmailAutomationSettings | null, error: error?.message ?? null };
}

export async function getEmailDeliveryOverview(): Promise<{ data: EmailDeliveryOverview | null; error: string | null }> {
  const { data, error } = await supabase().rpc("automation_delivery_overview");
  return { data: data as EmailDeliveryOverview | null, error: error?.message ?? null };
}

export async function listRecentEmailDeliveries(): Promise<{ rows: RecentEmailDelivery[]; error: string | null }> {
  const { data, error } = await supabase().rpc("automation_delivery_recent", { p_limit: 20 });
  return { rows: (data ?? []) as RecentEmailDelivery[], error: error?.message ?? null };
}

export async function emailDeliveryAction(id: string, action: "retry" | "cancel"): Promise<string | null> {
  const { error } = await supabase().rpc("automation_delivery_action", { p_id: id, p_action: action });
  return error?.message ?? null;
}

export async function enqueueStagingTestEmail(): Promise<string | null> {
  const { error } = await supabase().rpc("automation_email_enqueue_staging_test");
  return error?.message ?? null;
}
