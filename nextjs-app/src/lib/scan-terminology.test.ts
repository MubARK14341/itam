import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const en = readFileSync(new URL("./translations/en.ts", import.meta.url), "utf8");
const ar = readFileSync(new URL("./translations/ar.ts", import.meta.url), "utf8");

describe("scan terminology", () => {
  it("uses the same Scan & Search concept in navigation and the page title", () => {
    expect(en).toContain('scan: "Scan & Search"');
    expect(en).toContain('title: "Scan & Search"');
    expect(ar).toContain('scan: "المسح والبحث"');
    expect(ar).toContain('title: "المسح والبحث"');
  });

  it("keeps guided check-in and check-out wording in the mode selector", () => {
    expect(en).toContain('modes: { smart: "Guided scan", search: "Search only", entry: "Check in", exit: "Check out" }');
    expect(ar).toContain('modes: { smart: "مسح موجه", search: "بحث فقط", entry: "تسجيل الدخول", exit: "تسجيل الخروج" }');
  });

  it("translates operational scan error codes instead of exposing database identifiers", () => {
    expect(en).toContain('asset_state_blocks_movement: "Asset state does not allow this movement"');
    expect(ar).toContain('asset_state_blocks_movement: "حالة الأصل لا تسمح بهذه الحركة"');
  });
});
