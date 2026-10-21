import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeBrevoEvent, normalizeResendEvent, normalizeSendGridEvents, verifyBrevoWebhook, verifyResendWebhook, verifySendGridWebhook } from "../../../supabase/functions/itam-automation-worker/webhook.ts";

async function signedHeaders(body: string, secretBase64: string, timestamp: number): Promise<Headers> {
  const id = "evt_test";
  const key = Uint8Array.from(atob(secretBase64), character => character.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  let binary = "";
  signature.forEach(byte => { binary += String.fromCharCode(byte); });
  return new Headers({ "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${btoa(binary)}` });
}

describe("ADR-004 Resend webhook", () => {
  it("verifies the raw body and rejects stale replays", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg-1" } });
    const now = 1_800_000_000_000;
    const secret = btoa("local-webhook-secret");
    const headers = await signedHeaders(body, secret, now / 1000);
    expect(await verifyResendWebhook(body, headers, `whsec_${secret}`, now)).toBe(true);
    expect(await verifyResendWebhook(`${body} `, headers, `whsec_${secret}`, now)).toBe(false);
    expect(await verifyResendWebhook(body, headers, `whsec_${secret}`, now + 301_000)).toBe(false);
  });

  it("normalizes only the minimal delivery payload", () => {
    const event = normalizeResendEvent({
      type: "email.bounced",
      created_at: "2026-07-14T00:00:00Z",
      data: { email_id: "msg-1", to: ["secret@example.com"], bounce: { type: "hard", message: "Rejected" } },
    }, "evt_resend_1");
    expect(event.providerEventId).toBe("evt_resend_1");
    expect(event.sanitizedPayload).toEqual({ type: "hard", message: "Rejected" });
    expect(JSON.stringify(event)).not.toContain("secret@example.com");
    expect(() => normalizeResendEvent({ type: "contact.created", data: { email_id: "m" } }, "evt_x")).toThrow("unsupported_webhook_event");
  });
});

describe("SendGrid signed event webhook", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

  async function signedSendGridHeaders(body: string, timestamp = "1800000000"): Promise<Headers> {
    const signature = sign("sha256", Buffer.from(`${timestamp}${body}`), { key: keys.privateKey, dsaEncoding: "der" }).toString("base64");
    return new Headers({ "x-twilio-email-event-webhook-signature": signature, "x-twilio-email-event-webhook-timestamp": timestamp });
  }

  it("verifies the raw body and rejects an invalid signature", async () => {
    const body = JSON.stringify([{ event: "delivered", sg_event_id: "event-1", sg_message_id: "sg-message-1", timestamp: 1_800_000_000 }]);
    const headers = await signedSendGridHeaders(body);
    expect(await verifySendGridWebhook(new TextEncoder().encode(body), headers, publicKey)).toBe(true);
    expect(await verifySendGridWebhook(new TextEncoder().encode(`${body} `), headers, publicKey)).toBe(false);
  });

  it("maps SendGrid delivery events without retaining recipient data", () => {
    const events = normalizeSendGridEvents([
      { event: "processed", sg_event_id: "e-1", sg_message_id: "m-1", email: "secret@example.com", timestamp: 1_800_000_000 },
      { event: "delivered", sg_event_id: "e-2", sg_message_id: "m-1", timestamp: 1_800_000_001 },
      { event: "deferred", sg_event_id: "e-3", sg_message_id: "m-1", reason: "temporary", timestamp: 1_800_000_002 },
      { event: "bounce", sg_event_id: "e-4", sg_message_id: "m-1", type: "blocked", timestamp: 1_800_000_003 },
      { event: "dropped", sg_event_id: "e-5", sg_message_id: "m-1", reason: "suppressed", timestamp: 1_800_000_004 },
      { event: "spamreport", sg_event_id: "e-6", sg_message_id: "m-1", timestamp: 1_800_000_005 },
    ]);
    expect(events.map(event => event.eventType)).toEqual(["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.suppressed", "email.complained"]);
    expect(JSON.stringify(events)).not.toContain("secret@example.com");
  });
});

describe("Brevo authenticated transactional webhook", () => {
  it("requires the configured bearer token", () => {
    expect(verifyBrevoWebhook(new Headers({ authorization: "Bearer callback-secret" }), "callback-secret")).toBe(true);
    expect(verifyBrevoWebhook(new Headers({ authorization: "Bearer incorrect" }), "callback-secret")).toBe(false);
    expect(verifyBrevoWebhook(new Headers(), "callback-secret")).toBe(false);
  });

  it("maps delivery events without retaining the recipient", () => {
    const event = normalizeBrevoEvent({
      event: "delivered", "message-id": "<demo@example.invalid>", email: "secret@example.com", ts_event: 1_800_000_000,
      description: "Accepted by mailbox",
    });
    expect(event).toMatchObject({ providerEventId: "brevo:<demo@example.invalid>:delivered:1800000000", providerMessageId: "<demo@example.invalid>", eventType: "email.delivered" });
    expect(JSON.stringify(event)).not.toContain("secret@example.com");
    expect(() => normalizeBrevoEvent({ event: "opened", "message-id": "m", ts_event: 1 })).toThrow("unsupported_webhook_event");
  });

  it("accepts Brevo's documented camel-case bounce event names", () => {
    expect(normalizeBrevoEvent({ event: "hardBounce", "message-id": "m-hard", ts_event: 1_800_000_001 }).eventType).toBe("email.bounced");
    expect(normalizeBrevoEvent({ event: "softBounce", "message-id": "m-soft", ts_event: 1_800_000_002 }).eventType).toBe("email.bounced");
  });
});
