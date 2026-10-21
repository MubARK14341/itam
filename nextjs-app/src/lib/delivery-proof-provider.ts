export interface DeliveryOtpIssue {
  challengeId: string;
  recipientReference: string;
  expiresAt: string;
  providerMessageId: string;
}

export interface DeliveryOtpProvider {
  readonly name: string;
  issue(input: {
    challengeId: string;
    recipientReference: string;
    ttlSeconds: number;
    idempotencyKey: string;
    maxAttempts: number;
    resendCooldownSeconds: number;
  }): Promise<DeliveryOtpIssue>;
  verify(input: {
    challengeId: string;
    code: string;
    idempotencyKey: string;
  }): Promise<"verified" | "invalid" | "expired" | "attempts_exhausted">;
}

/**
 * Test-only provider. It deliberately refuses to exist outside NODE_ENV=test,
 * never logs the code, and keeps it in process memory only.
 */
export function createTestDeliveryOtpProvider(): DeliveryOtpProvider & {
  readCodeForTest(challengeId: string): string | null;
} {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test_otp_provider_forbidden_outside_tests");
  }
  const codes = new Map<string, string>();
  const challenges = new Map<string, {
    expiresAt: number;
    maxAttempts: number;
    attempts: number;
  }>();
  const issueReceipts = new Map<string, DeliveryOtpIssue>();
  const verificationResults = new Map<string, "verified" | "invalid" | "expired" | "attempts_exhausted">();
  return {
    name: "in_memory_test_only",
    async issue(input) {
      const previous = issueReceipts.get(input.idempotencyKey);
      if (previous) return previous;
      if (
        input.ttlSeconds < 1
        || input.maxAttempts < 1
        || input.maxAttempts > 5
        || input.resendCooldownSeconds < 1
      ) {
        throw new Error("invalid_test_otp_policy");
      }
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const code = String(100000 + (random[0] % 900000));
      codes.set(input.challengeId, code);
      const expiresAt = Date.now() + input.ttlSeconds * 1000;
      challenges.set(input.challengeId, {
        expiresAt,
        maxAttempts: input.maxAttempts,
        attempts: 0,
      });
      const receipt = {
        challengeId: input.challengeId,
        recipientReference: input.recipientReference,
        expiresAt: new Date(expiresAt).toISOString(),
        providerMessageId: `test-${input.challengeId}`,
      };
      issueReceipts.set(input.idempotencyKey, receipt);
      return receipt;
    },
    async verify(input) {
      const previous = verificationResults.get(input.idempotencyKey);
      if (previous) return previous;
      const challenge = challenges.get(input.challengeId);
      let result: "verified" | "invalid" | "expired" | "attempts_exhausted";
      if (!challenge || Date.now() >= challenge.expiresAt) {
        result = "expired";
      } else if (challenge.attempts >= challenge.maxAttempts) {
        result = "attempts_exhausted";
      } else {
        challenge.attempts += 1;
        result = codes.get(input.challengeId) === input.code
          ? "verified"
          : challenge.attempts >= challenge.maxAttempts
            ? "attempts_exhausted"
            : "invalid";
      }
      verificationResults.set(input.idempotencyKey, result);
      return result;
    },
    readCodeForTest(challengeId) {
      return codes.get(challengeId) ?? null;
    },
  };
}
