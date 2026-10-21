import { describe, expect, it } from "vitest";
import { shouldShowManagerDemo } from "./manager-demo";

describe("shouldShowManagerDemo", () => {
  it("shows the disclosure in staging", () => {
    expect(shouldShowManagerDemo({ APP_ENV: "staging" })).toBe(true);
  });

  it("shows the disclosure when the explicit server flag is enabled", () => {
    expect(shouldShowManagerDemo({ MANAGER_DEMO: "true" })).toBe(true);
  });

  it("stays hidden outside demo environments", () => {
    expect(shouldShowManagerDemo({ APP_ENV: "production" })).toBe(false);
  });
});
