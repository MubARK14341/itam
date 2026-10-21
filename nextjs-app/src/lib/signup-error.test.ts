import { describe, it, expect } from "vitest";
import { classifySignUpError } from "./signup-error";

describe("classifySignUpError", () => {
  // الأخطاء الحقيقية المرصودة في سجلّ auth أثناء /register:
  it("maps the email rate limit (Confirm email ON) to rate_limit", () => {
    expect(classifySignUpError("email rate limit exceeded", 429, "over_email_send_rate_limit")).toBe("rate_limit");
    expect(classifySignUpError("429: email rate limit exceeded", 429, undefined)).toBe("rate_limit");
  });

  it("maps a rejected email address to email_invalid", () => {
    expect(classifySignUpError('Email address "demo@example.invalid" is invalid', 400, "email_address_invalid")).toBe("email_invalid");
    expect(classifySignUpError('Email address "demo@example.invalid" is invalid', 400, undefined)).toBe("email_invalid");
  });

  it("maps an already-registered email to email_exists", () => {
    expect(classifySignUpError("User already registered", 400, "user_already_exists")).toBe("email_exists");
    expect(classifySignUpError("A user with this email address has already been registered", 422, undefined)).toBe("email_exists");
  });

  it("maps a weak/short password to weak_password", () => {
    expect(classifySignUpError("Password should be at least 6 characters", 422, "weak_password")).toBe("weak_password");
  });

  it("maps disabled signups to signups_disabled", () => {
    expect(classifySignUpError("Signups not allowed for this instance", 422, "signup_disabled")).toBe("signups_disabled");
  });

  it("falls back to unknown for unrecognized errors", () => {
    expect(classifySignUpError("some unexpected server error", 500, undefined)).toBe("unknown");
    expect(classifySignUpError(undefined, undefined, undefined)).toBe("unknown");
  });

  it("does not misclassify the rate-limit message (which contains 'email') as email_invalid", () => {
    expect(classifySignUpError("email rate limit exceeded", undefined, "over_email_send_rate_limit")).toBe("rate_limit");
  });
});
