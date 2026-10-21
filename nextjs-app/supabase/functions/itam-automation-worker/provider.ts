import { classifyHttpFailure, sanitizeError } from "./core.ts";
import type { FrozenEmailSnapshot, ProviderResult } from "./types.ts";

export interface EmailProvider {
  send(message: FrozenEmailSnapshot, idempotencyKey: string): Promise<ProviderResult>;
}

export async function normalizeIdempotencyKey(value: string): Promise<string> {
  if (/^[A-Za-z0-9._:-]{1,200}$/.test(value)) return value;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `itam-${hex}`;
}

export class ResendProvider implements EmailProvider {
  constructor(private readonly apiKey: string, private readonly endpoint = "https://api.resend.com/emails") {}

  async send(message: FrozenEmailSnapshot, idempotencyKey: string): Promise<ProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const providerKey = await normalizeIdempotencyKey(idempotencyKey);
      const response = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": providerKey,
        },
        body: JSON.stringify({
          from: message.from, to: message.to, cc: message.cc, bcc: message.bcc,
          reply_to: message.replyTo, subject: message.subject, html: message.html, text: message.text,
          tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })),
        }),
      });
      const body = await response.json().catch(() => ({})) as { id?: string; name?: string; message?: string };
      if (!response.ok) return classifyHttpFailure(response.status, body.name ?? `http_${response.status}`, body.message);
      if (!body.id) return { ok: false, code: "missing_provider_id", message: "Provider accepted without a message id", retryable: false, deliveryUnknown: true };
      return { ok: true, providerMessageId: body.id };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "provider_timeout" : "provider_network_error",
        message: sanitizeError(error),
        // The deterministic Resend idempotency key makes repeating an
        // unknown network result safe; do not strand transient failures.
        retryable: true,
        deliveryUnknown: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface SendGridErrorResponse {
  errors?: Array<{ message?: string; field?: string }>;
}

interface BrevoErrorResponse {
  code?: string;
  message?: string;
}

interface Mailbox {
  email: string;
  name?: string;
}

function mailbox(value: string): Mailbox {
  const match = value.trim().match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (match) return { email: match[2], ...(match[1].trim() ? { name: match[1].trim() } : {}) };
  const email = value.trim();
  if (!email.includes("@")) throw new Error("invalid_mailbox");
  return { email };
}

function sendGridError(body: SendGridErrorResponse, status: number): { code: string; message: string } {
  const first = body.errors?.[0];
  return {
    code: first?.field ? `sendgrid_${first.field.replace(/[^a-z0-9_]/gi, "_").slice(0, 80)}` : `sendgrid_http_${status}`,
    message: first?.message ?? "Provider rejected request",
  };
}

/**
 * SendGrid does not provide a request idempotency header.  A failed connection
 * can therefore mean the provider accepted a message even though no response
 * reached the worker, so those attempts are deliberately delivery-unknown and
 * are never automatically repeated.
 */
export class SendGridProvider implements EmailProvider {
  constructor(private readonly apiKey: string, private readonly endpoint = "https://api.sendgrid.com/v3/mail/send") {}

  async send(message: FrozenEmailSnapshot, _idempotencyKey: string): Promise<ProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          personalizations: [{
            to: message.to.map(mailbox),
            ...(message.cc.length ? { cc: message.cc.map(mailbox) } : {}),
            ...(message.bcc.length ? { bcc: message.bcc.map(mailbox) } : {}),
            // These values are fixed internal event/template identifiers, never
            // recipient or asset data.  SendGrid retains custom arguments.
            custom_args: Object.fromEntries(Object.entries(message.tags).map(([key, value]) => [key.slice(0, 64), value.slice(0, 255)])),
          }],
          from: mailbox(message.from),
          ...(message.replyTo ? { reply_to: mailbox(message.replyTo) } : {}),
          subject: message.subject,
          content: [{ type: "text/plain", value: message.text }, { type: "text/html", value: message.html }],
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as SendGridErrorResponse;
        const error = sendGridError(body, response.status);
        return classifyHttpFailure(response.status, error.code, error.message);
      }
      const providerMessageId = response.headers.get("x-message-id")?.trim();
      if (!providerMessageId) return { ok: false, code: "missing_provider_id", message: "Provider accepted without an X-Message-ID", retryable: false, deliveryUnknown: true };
      return { ok: true, providerMessageId };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "provider_timeout" : "provider_network_error",
        message: sanitizeError(error),
        retryable: false,
        deliveryUnknown: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Brevo's transactional endpoint has no documented request-idempotency
 * facility. A connection failure is therefore delivery-unknown and must not
 * be retried automatically; explicit transient HTTP responses remain safe to
 * retry because Brevo did not accept the message.
 */
export class BrevoProvider implements EmailProvider {
  constructor(private readonly apiKey: string, private readonly endpoint = "https://api.brevo.com/v3/smtp/email") {}

  async send(message: FrozenEmailSnapshot, _idempotencyKey: string): Promise<ProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "api-key": this.apiKey, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          sender: mailbox(message.from),
          to: message.to.map(mailbox),
          ...(message.cc.length ? { cc: message.cc.map(mailbox) } : {}),
          ...(message.bcc.length ? { bcc: message.bcc.map(mailbox) } : {}),
          ...(message.replyTo ? { replyTo: mailbox(message.replyTo) } : {}),
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
          // Tags are fixed internal event/template labels only. They let the
          // provider include non-recipient context in delivery webhooks.
          tags: Object.entries(message.tags).map(([key, value]) => `${key.slice(0, 32)}:${value.slice(0, 128)}`),
        }),
      });
      const body = await response.json().catch(() => ({})) as BrevoErrorResponse & { messageId?: string };
      if (!response.ok) return classifyHttpFailure(response.status, body.code ? `brevo_${body.code}` : `brevo_http_${response.status}`, body.message);
      const providerMessageId = body.messageId?.trim();
      if (!providerMessageId) return { ok: false, code: "missing_provider_id", message: "Provider accepted without a messageId", retryable: false, deliveryUnknown: true };
      return { ok: true, providerMessageId };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "provider_timeout" : "provider_network_error",
        message: sanitizeError(error),
        retryable: false,
        deliveryUnknown: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
