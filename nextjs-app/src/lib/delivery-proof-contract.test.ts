import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "migrations/20260902180000_restore_exact_delivery_strong_proof.sql",
  ),
  "utf8",
);

describe("exact-asset delivery proof regression contract", () => {
  it("restores signature and OTP evidence without relaxing exact verification or SoD", () => {
    expect(migration).toContain("v_method not in ('acknowledgement','otp','signature')");
    expect(migration).toContain("signature_reference_required");
    expect(migration).toContain("verified_otp_required");
    expect(migration).toContain("strong_proof_required");
    expect(migration).toContain("request_deliver_with_proof_exact_contract_unexpected");
  });

  it("keeps proofless browser delivery closed", () => {
    expect(migration).toMatch(
      /revoke all on function public\.request_deliver\(uuid\)[\s\S]*from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.request_deliver\(uuid\)[\s\S]*to service_role/,
    );
  });
});
