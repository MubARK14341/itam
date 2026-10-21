import { describe, expect, it, vi } from "vitest";
import { failureMetadata, reportOperationalFailure } from "./observability";

describe("safe operational failure reporting", () => {
  it("keeps useful codes while excluding raw messages and secrets", () => {
    const metadata = failureMetadata({
      name: "PostgrestError",
      code: "42501",
      status: 403,
      message: "Bearer secret-token user@example.com",
      details: "sensitive row",
    });
    expect(metadata).toEqual({ kind: "object", name: "PostgrestError", code: "42501", status: 403 });
    expect(JSON.stringify(metadata)).not.toContain("secret-token");
    expect(JSON.stringify(metadata)).not.toContain("user@example.com");
  });

  it("logs only bounded metadata", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reportOperationalFailure("financial_projection_failed", new Error("private database details"));
    expect(warn).toHaveBeenCalledWith(
      "financial_projection_failed",
      expect.objectContaining({ kind: "object", name: "Error" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private database details");
    warn.mockRestore();
  });
});
