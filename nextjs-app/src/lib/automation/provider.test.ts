import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrevoProvider,
  normalizeIdempotencyKey,
  ResendProvider,
  SendGridProvider,
} from "../../../supabase/functions/itam-automation-worker/provider.ts";
import type { FrozenEmailSnapshot } from "../../../supabase/functions/itam-automation-worker/types.ts";

const message: FrozenEmailSnapshot = {
  from: "ITAM <demo@example.invalid>",
  to: ["demo@example.invalid"],
  cc: [],
  bcc: [],
  replyTo: "demo@example.invalid",
  subject: "Asset notification",
  html: "<p>Asset notification</p>",
  text: "Asset notification",
  tags: { event: "maintenance_due" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SendGrid provider adapter", () => {
  it("uses the AONE mailbox display name and captures SendGrid's X-Message-ID", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202, headers: { "x-message-id": "sg-message-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new SendGridProvider("SG.secret", "https://sendgrid.test/v3/mail/send").send({ ...message, from: "AONE <demo@example.invalid>" }, "event:123");
    expect(result).toEqual({ ok: true, providerMessageId: "sg-message-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sendgrid.test/v3/mail/send");
    expect(init?.headers).toMatchObject({ authorization: "Bearer SG.secret", "content-type": "application/json" });
    expect(init?.headers).not.toHaveProperty("idempotency-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: { name: "AONE", email: "demo@example.invalid" }, reply_to: { email: "demo@example.invalid" },
      personalizations: [{ to: [{ email: "demo@example.invalid" }], custom_args: { event: "maintenance_due" } }],
      content: [{ type: "text/plain", value: message.text }, { type: "text/html", value: message.html }],
    });
  });

  it("retries explicit transient failures but never repeats an ambiguous network result", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "Slow down", field: "rate" }] }), { status: 429, headers: { "content-type": "application/json" } })));
    expect(await new SendGridProvider("SG.secret").send(message, "event:123")).toMatchObject({ ok: false, retryable: true, deliveryUnknown: false });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed")));
    expect(await new SendGridProvider("SG.secret").send(message, "event:123")).toMatchObject({ ok: false, retryable: false, deliveryUnknown: true, code: "provider_network_error" });
  });
});

describe("Brevo provider adapter", () => {
  it("uses the verified AONE sender and captures Brevo's messageId", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ messageId: "<demo@example.invalid>" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new BrevoProvider("xkeysib-secret", "https://brevo.test/v3/smtp/email").send({ ...message, from: "AONE <demo@example.invalid>", replyTo: "demo@example.invalid" }, "event:123");
    expect(result).toEqual({ ok: true, providerMessageId: "<demo@example.invalid>" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://brevo.test/v3/smtp/email");
    expect(init?.headers).toMatchObject({ "api-key": "xkeysib-secret", accept: "application/json", "content-type": "application/json" });
    expect(init?.headers).not.toHaveProperty("idempotency-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      sender: { name: "AONE", email: "demo@example.invalid" }, replyTo: { email: "demo@example.invalid" },
      to: [{ email: "demo@example.invalid" }], tags: ["event:maintenance_due"],
      htmlContent: message.html, textContent: message.text,
    });
  });

  it("retries explicit transient failures but never repeats an ambiguous network result", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "rate_limit", message: "Slow down" }), { status: 429, headers: { "content-type": "application/json" } })));
    expect(await new BrevoProvider("xkeysib-secret").send(message, "event:123")).toMatchObject({ ok: false, retryable: true, deliveryUnknown: false });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed")));
    expect(await new BrevoProvider("xkeysib-secret").send(message, "event:123")).toMatchObject({ ok: false, retryable: false, deliveryUnknown: true, code: "provider_network_error" });
  });
});

describe("ADR-004 provider idempotency", () => {
  it("preserves safe keys and hashes oversized or invalid keys deterministically", async () => {
    expect(await normalizeIdempotencyKey("maintenance:123:recipient")).toBe("maintenance:123:recipient");
    const oversized = "حدث:".repeat(100);
    const first = await normalizeIdempotencyKey(oversized);
    expect(first).toMatch(/^itam-[a-f0-9]{64}$/);
    expect(await normalizeIdempotencyKey(oversized)).toBe(first);
  });

  it("sends the frozen snapshot with authorization and an idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-message-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ResendProvider("re_test_secret", "https://resend.test/emails")
      .send(message, "event:123:recipient");

    expect(result).toEqual({ ok: true, providerMessageId: "resend-message-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://resend.test/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer re_test_secret",
      "content-type": "application/json",
      "idempotency-key": "event:123:recipient",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      reply_to: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: [{ name: "event", value: "maintenance_due" }],
    });
  });

  it.each([
    [429, "rate_limit_exceeded"],
    [500, "internal_server_error"],
  ])("marks HTTP %i as retryable without claiming delivery is unknown", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ name: code, message: "Provider failure" }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ));

    const result = await new ResendProvider("re_test_secret").send(message, "event:123");

    expect(result).toMatchObject({
      ok: false,
      code,
      retryable: true,
      deliveryUnknown: false,
    });
  });

  it("retries a network failure using Resend's deterministic idempotency key", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed")));

    const result = await new ResendProvider("re_test_secret").send(message, "event:123");

    expect(result).toMatchObject({
      ok: false,
      code: "provider_network_error",
      retryable: true,
      deliveryUnknown: false,
    });
  });

  it("treats a successful response without a provider id as delivery-unknown", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ));

    const result = await new ResendProvider("re_test_secret").send(message, "event:123");

    expect(result).toEqual({
      ok: false,
      code: "missing_provider_id",
      message: "Provider accepted without a message id",
      retryable: false,
      deliveryUnknown: true,
    });
  });
});
