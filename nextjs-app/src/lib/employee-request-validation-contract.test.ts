import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  new URL("../app/(app)/my-requests/page-client.tsx", import.meta.url),
  "utf8",
);

describe("employee request validation accessibility contract", () => {
  it("uses a localized announced error instead of browser-native required validation", () => {
    expect(pageSource).toContain("setDescriptionError(true)");
    expect(pageSource).toContain("requestAnimationFrame(() => descriptionRef.current?.focus())");
    expect(pageSource).toContain('aria-describedby={descriptionError ? "employee-request-description-error" : undefined}');
    expect(pageSource).toContain('id="employee-request-description-error" role="alert"');
    expect(pageSource).toContain("{copy.description} {t.common.required}");
    expect(pageSource).not.toMatch(/<input\s+required\s+ref=\{descriptionRef\}/);
  });
});
