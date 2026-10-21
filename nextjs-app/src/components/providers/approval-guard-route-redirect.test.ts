import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guard = readFileSync(new URL("./approval-guard.tsx", import.meta.url), "utf8");

describe("ApprovalGuard restricted-route recovery", () => {
  it("replaces a forbidden direct URL instead of leaving a blank protected shell", () => {
    expect(guard).toContain("window.location.replace(defaultInternalLanding(role));");
    expect(guard).toContain('role="alert"');
    expect(guard).toContain("t.common.accessRestricted");
    expect(guard).toContain('role="status"');
    expect(guard).toContain("t.common.loading");
  });
});
