import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reports = readFileSync(new URL("../app/(app)/reports/page-client.tsx", import.meta.url), "utf8");

describe("custody report integrity", () => {
  it("reports custody as a relationship without treating allocation reservations as anonymous employees", () => {
    expect(reports).toContain("const custodyAssets");
    expect(reports).toContain('a.status === "reserved" && a.holder');
    expect(reports).not.toContain("assignedWithoutEmployee");
    expect(reports).toContain("k.full_name_ar ?? k.full_name ?? k.name_ar ?? k.name");
  });
});
