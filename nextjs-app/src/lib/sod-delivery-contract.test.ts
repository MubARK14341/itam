import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../migrations/20260731180000_risk_based_sod_delivery_proof.sql", import.meta.url),
  "utf8",
);
const client = readFileSync(new URL("./requests.ts", import.meta.url), "utf8");
const provider = readFileSync(new URL("./delivery-proof-provider.ts", import.meta.url), "utf8");

describe("risk-based SoD and delivery evidence contract", () => {
  it("closes legacy delivery and requires the evidence RPC", () => {
    expect(migration).toMatch(
      /revoke all on function public\.request_deliver\(uuid\)[\s\S]*authenticated/,
    );
    expect(migration).toContain("request_deliver_with_proof");
    expect(client).toContain('requestRpc("request_deliver_with_proof"');
  });

  it("separates high-risk actors and financial purchase approvals", () => {
    expect(migration).toContain("independent_approver_required");
    expect(migration).toContain("independent_deliverer_required");
    expect(migration).toContain("independent_second_approver_required");
    expect(migration).toContain("independent_receiver_required");
    expect(migration).toContain("manual_adjustment_requires_stocktake");
  });

  it("stores delivery device/receiver/actor/time evidence without plaintext OTP", () => {
    expect(migration).toContain("device_snapshot");
    expect(migration).toContain("receiver_name");
    expect(migration).toContain("delivered_by");
    expect(migration).toContain("acknowledged_at");
    expect(migration).toContain("code_digest");
    expect(migration).toContain("extensions.digest(p_code, 'sha256')");
    expect(migration).not.toMatch(/code_plain|plain_?text_?code/i);
  });

  it("keeps the mock provider test-only and does not return the code", () => {
    expect(provider).toContain('process.env.NODE_ENV !== "test"');
    expect(provider).toContain("test_otp_provider_forbidden_outside_tests");
    expect(provider).not.toMatch(/console\.(log|info|debug)/);
  });
});
