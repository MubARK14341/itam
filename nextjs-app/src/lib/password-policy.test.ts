import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordPolicyError } from "./password-policy";

describe("shared registration password policy", () => {
  it("requires 12 characters in both scripts", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordPolicyError("")).toBe("required");
    expect(passwordPolicyError("a".repeat(11))).toBe("too_short");
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    expect(passwordPolicyError("a".repeat(12))).toBe("insufficient_variety");
    expect(passwordPolicyError("Password-123")).toBeNull();
    expect(passwordPolicyError("كلمة-مرور-123")).toBeNull();
    expect(passwordPolicyError(`Aa1!${"x".repeat(125)}`)).toBe("too_long");
  });

  it("is consumed by employee and customer registration", () => {
    const employee = fs.readFileSync("src/app/register/page.tsx", "utf8");
    const customer = fs.readFileSync("src/app/client-portal-register/page.tsx", "utf8");
    expect(employee).toContain("passwordPolicyError(f.password)");
    expect(customer).toContain("passwordPolicyError(f.password)");
  });

  it("ships an enforced local CSP without hosted Supabase connectivity", () => {
    const config = fs.readFileSync("next.config.mjs", "utf8");
    expect(config).toContain("Content-Security-Policy");
    expect(config).not.toContain("APPROVED_STAGING.supabaseApiHost");
    expect(config).toContain("connect-src 'self'");
    expect(config).not.toContain("https://*.supabase.co");
    expect(config).not.toContain("wss://*.supabase.co");
    expect(config).toContain("object-src 'none'");
  });
});
