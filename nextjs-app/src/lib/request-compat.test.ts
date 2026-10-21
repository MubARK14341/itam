import { describe, expect, it } from "vitest";
import { LEGACY_REQUEST_TYPE, legacyRequestTypeForInsert } from "./request-compat";

describe("legacy request type compatibility", () => {
  it("keeps the legacy value at one explicit insert boundary", () => {
    expect(legacyRequestTypeForInsert()).toBe(LEGACY_REQUEST_TYPE);
  });

  it("does not expose a user-facing request-type label", () => {
    expect(Object.keys({ LEGACY_REQUEST_TYPE, legacyRequestTypeForInsert })).not.toContain("label");
  });
});
