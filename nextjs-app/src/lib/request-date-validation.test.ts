import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isStrictRequestDate,
  isSupportedRequestDate,
  requestDateMaximum,
  riyadhTodayISO,
} from "./request-date-validation";

describe("request date contract", () => {
  const today = "2026-08-12";

  it("allows strict Gregorian dates within ten years", () => {
    expect(isStrictRequestDate("2028-02-29")).toBe(true);
    expect(requestDateMaximum(today)).toBe("2036-08-12");
    expect(isSupportedRequestDate("2036-08-12", today)).toBe(true);
    expect(riyadhTodayISO(new Date("2026-08-11T22:00:00.000Z"))).toBe("2026-08-12");
  });

  it("rejects malformed, overflow, invalid, and outside dates", () => {
    for (const date of ["275760-08-20", "99999-01-01", "0000-01-01", "2026-13-01", "2026-02-30", "2026-02-29", "not-a-date", "2026-1-1"]) {
      expect(isStrictRequestDate(date)).toBe(false);
    }
    expect(isSupportedRequestDate("2026-08-11", today)).toBe(false);
    expect(isSupportedRequestDate("2036-08-13", today)).toBe(false);
  });

  it("keeps the authoritative database guard narrow and time-zone explicit", () => {
    const migration = readFileSync(resolve(import.meta.dirname, "../../migrations/20260812011500_request_date_contract.sql"), "utf8");
    expect(migration).toContain("before insert or update of pickup_date, return_date");
    expect(migration).toContain("time zone 'Asia/Riyadh'");
    expect(migration).toContain("interval '10 years'");
    expect(migration).toContain("request_date_out_of_range");
    expect(migration).toContain("return_date <= new.pickup_date");
  });
});
