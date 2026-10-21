import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CSP_REPORT_BYTES } from "@/lib/csp-report";
import { POST } from "./route";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/csp-report", () => {
  it("accepts and logs only a sanitized report", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = new Request("https://staging.example/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "blocked-uri": "https://blocked.example/a.js?credential=secret",
          "document-uri": "https://staging.example/login?credential=secret",
          "effective-directive": "script-src-elem",
          "original-policy": "must-not-be-logged",
        },
      }),
    });

    const result = await POST(request);

    expect(result.status).toBe(204);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(warning).toHaveBeenCalledTimes(1);
    const logged = warning.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("https://blocked.example/a.js");
    expect(logged).not.toContain("credential=secret");
    expect(logged).not.toContain("must-not-be-logged");
  });

  it("rejects unsupported, malformed, and oversized requests", async () => {
    const unsupported = await POST(
      new Request("https://staging.example/api/csp-report", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not-json",
      }),
    );
    expect(unsupported.status).toBe(415);

    const malformed = await POST(
      new Request("https://staging.example/api/csp-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(malformed.status).toBe(400);

    const oversized = await POST(
      new Request("https://staging.example/api/csp-report", {
        method: "POST",
        headers: {
          "Content-Length": String(MAX_CSP_REPORT_BYTES + 1),
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);
  });
});
