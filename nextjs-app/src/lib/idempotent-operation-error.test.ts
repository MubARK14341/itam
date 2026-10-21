import { afterEach, describe, expect, it, vi } from "vitest";
import { getDict } from "./i18n";
import { friendlyErrorStrict } from "./user-facing-errors";

describe("safe stock and receipt retry guidance", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("shows controlled retry codes in both languages through the strict toast boundary", () => {
    for (const lang of ["ar", "en"] as const) {
      const common = getDict(lang).common;
      expect(friendlyErrorStrict("operation_result_unknown", lang)).toBe(common.operationPending);
      expect(friendlyErrorStrict("operation_pending", lang)).toBe(common.operationPendingHint);
      expect(friendlyErrorStrict("operation_id_conflict", lang)).toBe(common.operationConflict);
      expect(friendlyErrorStrict("operation_storage_unavailable", lang)).toBe(common.operationStorageUnavailable);
    }
  });
  it("never trusts extra arbitrary text adjacent to an operation code", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = "operation_result_unknown: TEST private invoice or financial data";
    const safe = friendlyErrorStrict(raw, "en");
    expect(safe).not.toContain("TEST private");
    expect(safe).not.toContain("financial data");
    expect(safe).not.toBe(getDict("en").common.operationPending);
  });
});
