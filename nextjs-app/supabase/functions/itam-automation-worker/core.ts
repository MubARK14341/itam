import type { FrozenEmailSnapshot, JsonObject, JsonValue, ProviderFailure } from "./types.ts";

const FINANCIAL_KEY = /(^|_)(cost|price|amount|currency|invoice|salvage|annual_rate|unit_cost|total_price)(_|$)/i;
const SECRET_PATTERN = /(re_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9_-]+|Bearer\s+\S+|apikey[=:]\S+|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/gi;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  return value as JsonObject;
}

export function assertNoFinancialFields(value: JsonValue | undefined, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFinancialFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (FINANCIAL_KEY.test(key)) throw new Error(`financial_field_forbidden:${path}.${key}`);
    assertNoFinancialFields(child, `${path}.${key}`);
  }
}

export function sanitizeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "unknown_error");
  return message.replace(SECRET_PATTERN, "[redacted]").slice(0, 500);
}

export function retryDelayMs(attemptCount: number): number {
  const schedule = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;
  return schedule[Math.min(Math.max(attemptCount - 1, 0), schedule.length - 1)];
}

export function classifyHttpFailure(status: number, code = "provider_error", message = "Provider rejected request"): ProviderFailure {
  const retryable = status === 408 || status === 429 || status >= 500;
  return { ok: false, code, message: sanitizeError(message), retryable, deliveryUnknown: false };
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === "") return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error("invalid_boolean_environment_value");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    mismatch |= (a[index % Math.max(a.length, 1)] ?? 0) ^ (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return mismatch === 0;
}

export interface SnapshotDraft {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  tags?: Record<string, string>;
}

export interface TestModeOptions {
  enabled: boolean;
  testRecipient?: string;
  intendedRecipient: string;
  eventKey: string;
  reference: string;
}

export function applyTestMode(draft: SnapshotDraft, options: TestModeOptions): FrozenEmailSnapshot {
  if (!options.enabled) {
    return {
      from: draft.from,
      to: [...draft.to],
      cc: [...(draft.cc ?? [])],
      bcc: [...(draft.bcc ?? [])],
      replyTo: draft.replyTo,
      subject: draft.subject,
      html: draft.html,
      text: draft.text,
      tags: { ...(draft.tags ?? {}), environment: "production" },
    };
  }
  const testRecipient = options.testRecipient?.trim().toLowerCase();
  if (!testRecipient) throw new Error("missing_test_recipient");
  const htmlNotice = `<div style="border:1px solid #d97706;padding:12px;margin-bottom:16px;background:#fffbeb;color:#78350f"><strong>STAGING TEST</strong><br>Intended recipient: ${escapeHtml(options.intendedRecipient)}<br>Event: ${escapeHtml(options.eventKey)}<br>Reference: ${escapeHtml(options.reference)}</div>`;
  const textNotice = `[STAGING TEST]\nIntended recipient: ${options.intendedRecipient}\nEvent: ${options.eventKey}\nReference: ${options.reference}\n\n`;
  return {
    from: draft.from,
    to: [testRecipient],
    cc: [],
    bcc: [],
    replyTo: draft.replyTo,
    subject: draft.subject.startsWith("[STAGING TEST]") ? draft.subject : `[STAGING TEST] ${draft.subject}`,
    html: htmlNotice + draft.html,
    text: textNotice + draft.text,
    tags: { ...(draft.tags ?? {}), environment: "test" },
  };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (!/^https?:$/.test(base.protocol)) throw new Error("invalid_base_url");
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error("external_link_forbidden");
  return target.toString();
}
