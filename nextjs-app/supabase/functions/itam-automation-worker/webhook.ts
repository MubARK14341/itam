import { constantTimeEqual, isRecord, toJsonObject } from "./core.ts";
import type { JsonObject } from "./types.ts";

const ALLOWED_EVENTS = new Set([
  "email.sent", "email.delivered", "email.delivery_delayed", "email.failed",
  "email.bounced", "email.complained", "email.suppressed",
]);

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export async function verifyResendWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const id = headers.get("svix-id") ?? "";
  const timestamp = headers.get("svix-timestamp") ?? "";
  const signatures = headers.get("svix-signature") ?? "";
  const timestampSeconds = Number(timestamp);
  if (!id || !Number.isFinite(timestampSeconds) || Math.abs(nowMs - timestampSeconds * 1000) > 300_000) return false;
  const key = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    const decoded = decodeBase64(key);
    const keyBytes = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
    const expected = encodeBase64(await crypto.subtle.sign("HMAC", cryptoKey, signed));
    return signatures.split(" ").some(part => part.startsWith("v1,") && constantTimeEqual(part.slice(3), expected));
  } catch {
    return false;
  }
}

export interface NormalizedDeliveryEvent {
  providerEventId: string;
  providerMessageId: string;
  eventType: string;
  eventAt: string;
  sanitizedPayload: JsonObject;
}

export function normalizeResendEvent(raw: unknown, providerEventId: string): NormalizedDeliveryEvent {
  if (!isRecord(raw) || typeof raw.type !== "string" || !ALLOWED_EVENTS.has(raw.type)) throw new Error("unsupported_webhook_event");
  const data = isRecord(raw.data) ? raw.data : {};
  const messageId = typeof data.email_id === "string" ? data.email_id : "";
  const eventId = providerEventId.trim();
  if (!eventId || !messageId) throw new Error("invalid_webhook_event");
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString();
  const detail = toJsonObject(data.bounce ?? data.failed ?? data.complaint ?? {});
  const sanitizedPayload: JsonObject = {};
  for (const key of ["type", "subType", "message"]) {
    const value = detail[key];
    if (typeof value === "string") sanitizedPayload[key] = value.slice(0, 200);
  }
  return { providerEventId: eventId, providerMessageId: messageId, eventType: raw.type, eventAt: createdAt, sanitizedPayload };
}

const SENDGRID_EVENT_TYPES: Record<string, string> = {
  processed: "email.sent",
  delivered: "email.delivered",
  deferred: "email.delivery_delayed",
  bounce: "email.bounced",
  dropped: "email.suppressed",
  spamreport: "email.complained",
};

function decodePem(pem: string): Uint8Array {
  const base64 = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  if (!base64) throw new Error("invalid_public_key");
  return decodeBase64(base64);
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number; next: number } {
  const first = bytes[offset];
  if (first == null) throw new Error("invalid_der");
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const size = first & 0x7f;
  if (!size || size > 2 || offset + size >= bytes.length) throw new Error("invalid_der");
  let length = 0;
  for (let index = 0; index < size; index += 1) length = (length << 8) | bytes[offset + 1 + index];
  return { length, next: offset + 1 + size };
}

/** Convert SendGrid's base64 ASN.1 DER ECDSA signature to Web Crypto P-256 format. */
function derSignatureToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("invalid_der");
  const sequence = readDerLength(der, 1);
  let offset = sequence.next;
  if (offset + sequence.length !== der.length) throw new Error("invalid_der");
  const integer = (): Uint8Array => {
    if (der[offset] !== 0x02) throw new Error("invalid_der");
    const part = readDerLength(der, offset + 1);
    offset = part.next + part.length;
    if (offset > der.length || !part.length) throw new Error("invalid_der");
    let value = der.slice(part.next, offset);
    while (value.length > 1 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error("invalid_der");
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const result = new Uint8Array(64);
  result.set(integer(), 0);
  result.set(integer(), 32);
  if (offset !== der.length) throw new Error("invalid_der");
  return result;
}

function signedWebhookBytes(timestamp: string, rawBody: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(timestamp);
  const result = new Uint8Array(prefix.length + rawBody.length);
  result.set(prefix);
  result.set(rawBody, prefix.length);
  return result;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Verifies the raw body against SendGrid's configured P-256 public key. */
export async function verifySendGridWebhook(rawBody: Uint8Array, headers: Headers, publicKeyPem: string): Promise<boolean> {
  const signature = headers.get("x-twilio-email-event-webhook-signature") ?? "";
  const timestamp = headers.get("x-twilio-email-event-webhook-timestamp") ?? "";
  if (!signature || !timestamp) return false;
  try {
    const keyBytes = decodePem(publicKeyPem);
    const key = await crypto.subtle.importKey(
      "spki", ownedArrayBuffer(keyBytes),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, ownedArrayBuffer(derSignatureToP1363(decodeBase64(signature))), ownedArrayBuffer(signedWebhookBytes(timestamp, rawBody)),
    );
  } catch {
    return false;
  }
}

export function normalizeSendGridEvents(raw: unknown): NormalizedDeliveryEvent[] {
  if (!Array.isArray(raw)) throw new Error("invalid_webhook_event");
  return raw.map(value => {
    if (!isRecord(value) || typeof value.event !== "string" || !SENDGRID_EVENT_TYPES[value.event]) throw new Error("unsupported_webhook_event");
    const providerEventId = typeof value.sg_event_id === "string" ? value.sg_event_id.trim() : "";
    const providerMessageId = typeof value.sg_message_id === "string" ? value.sg_message_id.trim() : "";
    if (!providerEventId || !providerMessageId) throw new Error("invalid_webhook_event");
    const timestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? new Date(value.timestamp * 1000).toISOString() : new Date().toISOString();
    const sanitizedPayload: JsonObject = {};
    for (const key of ["reason", "status", "type"]) {
      const detail = value[key];
      if (typeof detail === "string") sanitizedPayload[key] = detail.slice(0, 200);
    }
    return { providerEventId, providerMessageId, eventType: SENDGRID_EVENT_TYPES[value.event], eventAt: timestamp, sanitizedPayload };
  });
}

const BREVO_EVENT_TYPES: Record<string, string> = {
  request: "email.sent",
  delivered: "email.delivered",
  deferred: "email.delivery_delayed",
  softBounce: "email.bounced",
  hardBounce: "email.bounced",
  soft_bounce: "email.bounced",
  hard_bounce: "email.bounced",
  blocked: "email.suppressed",
  invalid: "email.suppressed",
  spam: "email.complained",
  unsubscribed: "email.suppressed",
  error: "email.failed",
};

/** Brevo supports a bearer token on each transactional webhook callback. */
export function verifyBrevoWebhook(headers: Headers, token: string): boolean {
  const authorization = headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(match?.[1]) && constantTimeEqual(match![1], token);
}

export function normalizeBrevoEvent(raw: unknown): NormalizedDeliveryEvent {
  if (!isRecord(raw) || typeof raw.event !== "string" || !BREVO_EVENT_TYPES[raw.event]) throw new Error("unsupported_webhook_event");
  const providerMessageId = typeof raw["message-id"] === "string" ? raw["message-id"].trim() : "";
  const timestamp = typeof raw.ts_event === "number" && Number.isFinite(raw.ts_event) ? raw.ts_event : null;
  if (!providerMessageId || timestamp == null) throw new Error("invalid_webhook_event");
  // Brevo's `id` identifies the webhook, not an individual delivery event.
  // Combining the provider message id, event, and provider timestamp gives the
  // durable event table a deterministic dedupe key without retaining a recipient.
  const providerEventId = `brevo:${providerMessageId}:${raw.event}:${timestamp}`;
  const sanitizedPayload: JsonObject = {};
  for (const key of ["reason", "status", "description", "error_code"]) {
    const detail = raw[key];
    if (typeof detail === "string") sanitizedPayload[key] = detail.slice(0, 200);
    if (typeof detail === "number" && Number.isFinite(detail)) sanitizedPayload[key] = detail;
  }
  return {
    providerEventId,
    providerMessageId,
    eventType: BREVO_EVENT_TYPES[raw.event],
    eventAt: new Date(timestamp * 1000).toISOString(),
    sanitizedPayload,
  };
}
