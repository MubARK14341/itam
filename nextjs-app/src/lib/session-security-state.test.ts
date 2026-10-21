import { describe, expect, it } from "vitest";
import type { StaffAccessState } from "./auth-security";
import { resolveStaffAccess } from "./session";

describe("resolveStaffAccess", () => {
  const access: StaffAccessState = {
    approval_status: "approved",
    is_active: true,
    role: "admin",
  };

  it("resolves an approved active admin from the direct staff routing state", () => {
    expect(resolveStaffAccess(access)).toEqual({ approvalStatus: "approved", role: "admin" });
  });

  it("fails closed when an approved account is inactive or has no valid role", () => {
    expect(resolveStaffAccess({ ...access, is_active: false })).toBeNull();
    expect(resolveStaffAccess({ ...access, role: null })).toBeNull();
  });

  it("keeps pending staff role-less and rejects unknown roles", () => {
    expect(resolveStaffAccess({ ...access, approval_status: "pending", role: null })).toEqual({
      approvalStatus: "pending",
      role: null,
    });
    expect(resolveStaffAccess({ ...access, role: "unexpected_role" })).toBeNull();
  });
});
