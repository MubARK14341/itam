import { describe, expect, it } from "vitest";
import { createTestDeliveryOtpProvider } from "./delivery-proof-provider";

describe("test delivery OTP provider", () => {
  it("keeps a six-digit code in memory and does not return it from issue", async () => {
    const provider = createTestDeliveryOtpProvider();
    const receipt = await provider.issue({
      challengeId: "challenge-1",
      recipientReference: "masked-recipient",
      ttlSeconds: 120,
      idempotencyKey: "send-1",
      maxAttempts: 2,
      resendCooldownSeconds: 30,
    });
    expect(receipt).not.toHaveProperty("code");
    expect(provider.readCodeForTest("challenge-1")).toMatch(/^\d{6}$/);
    expect(await provider.verify({
      challengeId: "challenge-1",
      code: provider.readCodeForTest("challenge-1") ?? "",
      idempotencyKey: "verify-1",
    })).toBe("verified");
  });

  it("enforces verification attempt limits and idempotent results", async () => {
    const provider = createTestDeliveryOtpProvider();
    const first = await provider.issue({
      challengeId: "challenge-2",
      recipientReference: "masked-recipient",
      ttlSeconds: 120,
      idempotencyKey: "send-2",
      maxAttempts: 2,
      resendCooldownSeconds: 30,
    });
    const duplicate = await provider.issue({
      challengeId: "challenge-2",
      recipientReference: "masked-recipient",
      ttlSeconds: 120,
      idempotencyKey: "send-2",
      maxAttempts: 2,
      resendCooldownSeconds: 30,
    });
    expect(duplicate).toEqual(first);
    await expect(provider.verify({
      challengeId: "challenge-2",
      code: "000000",
      idempotencyKey: "verify-2a",
    })).resolves.toBe("invalid");
    await expect(provider.verify({
      challengeId: "challenge-2",
      code: "000000",
      idempotencyKey: "verify-2b",
    })).resolves.toBe("attempts_exhausted");
    await expect(provider.verify({
      challengeId: "challenge-2",
      code: "000000",
      idempotencyKey: "verify-2b",
    })).resolves.toBe("attempts_exhausted");
  });
});
