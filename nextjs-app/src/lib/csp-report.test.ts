import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_CSP_REPORT_BYTES,
  MAX_CSP_REPORTS_PER_REQUEST,
  sanitizeCspReports,
} from "./csp-report";

describe("CSP report sanitization", () => {
  it("strips query strings, fragments, and original policy content", () => {
    expect(
      sanitizeCspReports({
        "csp-report": {
          "blocked-uri": "https://evil.example/script.js?token=secret#fragment",
          "document-uri": "https://staging.example/assets/opaque-id?session=secret",
          "effective-directive": "script-src-elem",
          "line-number": 12.9,
          "original-policy": "secret-policy-value",
          "source-file": "https://staging.example/app.js?key=secret",
          "status-code": 200,
          "violated-directive": "script-src-elem",
        },
      }),
    ).toEqual([
      {
        blockedUrl: "https://evil.example/script.js",
        columnNumber: null,
        documentUrl: "https://staging.example/assets/opaque-id",
        effectiveDirective: "script-src-elem",
        lineNumber: 12,
        sourceFile: "https://staging.example/app.js",
        statusCode: 200,
        violatedDirective: "script-src-elem",
      },
    ]);
  });

  it("accepts Reporting API batches and caps request fan-out", () => {
    const reports = Array.from({ length: MAX_CSP_REPORTS_PER_REQUEST + 5 }, () => ({
      body: {
        blockedURL: "data:text/javascript,secret",
        documentURL: "https://staging.example/login#secret",
        effectiveDirective: "script-src-elem",
      },
      type: "csp-violation",
    }));

    const sanitized = sanitizeCspReports(reports);
    expect(sanitized).toHaveLength(MAX_CSP_REPORTS_PER_REQUEST);
    expect(sanitized[0]?.blockedUrl).toBe("data:");
    expect(sanitized[0]?.documentUrl).toBe("https://staging.example/login");
  });

  it("ignores unrelated payloads and wires a bounded local policy", () => {
    expect(sanitizeCspReports({ message: "ignore me" })).toEqual([]);
    expect(MAX_CSP_REPORT_BYTES).toBe(16 * 1024);

    const config = fs.readFileSync("next.config.mjs", "utf8");
    expect(config).toContain("Content-Security-Policy");
    expect(config).toContain("connect-src 'self'");
  });
});
