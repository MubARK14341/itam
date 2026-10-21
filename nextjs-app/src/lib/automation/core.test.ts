import { describe, expect, it } from "vitest";
import { applyTestMode, assertNoFinancialFields, classifyHttpFailure, retryDelayMs, sanitizeError } from "../../../supabase/functions/itam-automation-worker/core.ts";

describe("ADR-004 automation core", () => {
  it("forces a single safe recipient in Test Mode", () => {
    const result = applyTestMode({ from: "ITAM <noreply@example.com>", to: ["real@example.com"], cc: ["cc@example.com"], bcc: ["hidden@example.com"], subject: "Alert", html: "<p>Body</p>", text: "Body" }, {
      enabled: true, testRecipient: " DEMO@EXAMPLE.INVALID ", intendedRecipient: "real@example.com", eventKey: "event-1", reference: "asset:1",
    });
    expect(result.to).toEqual(["demo@example.invalid"]);
    expect(result.cc).toEqual([]);
    expect(result.bcc).toEqual([]);
    expect(result.subject).toBe("[STAGING TEST] Alert");
    expect(result.html).toContain("Intended recipient: real@example.com");
    expect(result.tags.environment).toBe("test");
  });

  it("uses the approved retry schedule and classifies provider failures", () => {
    expect([1, 2, 3, 4, 8].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000]);
    expect(classifyHttpFailure(429).retryable).toBe(true);
    expect(classifyHttpFailure(400).retryable).toBe(false);
  });

  it("blocks financial fields recursively and redacts secrets", () => {
    expect(() => assertNoFinancialFields({ asset: { purchase_cost: 100 } })).toThrow("financial_field_forbidden");
    expect(() => assertNoFinancialFields({ asset_tag: "A-1", count: 2 })).not.toThrow();
    const sanitized = sanitizeError("Bearer abc123 re_secret user@example.com aaaabbbbbccccdddd.eeeeffffgggghhhh.iiiijjjjkkkkllll");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("user@example.com");
    expect(sanitized).not.toContain("aaaabbbbbccccdddd");
  });
});
