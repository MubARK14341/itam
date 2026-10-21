import { describe, expect, it } from "vitest";
import { shouldBlockIndexing } from "./deployment-indexing";

describe("deployment indexing policy", () => {
  it("blocks every documented staging or preview identity", () => {
    expect(shouldBlockIndexing({ APP_ENV: "staging" })).toBe(true);
    expect(shouldBlockIndexing({ DEPLOYMENT_ENV: "preview" })).toBe(true);
    expect(shouldBlockIndexing({ VERCEL_ENV: "preview" })).toBe(true);
  });

  it("does not classify a production identity as staging", () => {
    expect(shouldBlockIndexing({
      APP_ENV: "production",
      DEPLOYMENT_ENV: "production",
      VERCEL_ENV: "production",
    })).toBe(false);
  });
});
