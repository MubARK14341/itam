import { describe, expect, it } from "vitest";
import { businessDaysBetween, elapsedWeekdayMinutesBetween, calendarDaysUntil, scannerSchedule } from "../../../supabase/functions/itam-automation-worker/calendar.ts";

describe("ADR-004 Riyadh calendar", () => {
  it("excludes Friday and Saturday", () => {
    const thursdayMidnightRiyadh = new Date("2026-07-15T21:00:00.000Z");
    const sundayMidnightRiyadh = new Date("2026-07-18T21:00:00.000Z");
    expect(businessDaysBetween(thursdayMidnightRiyadh, sundayMidnightRiyadh)).toBe(1);
  });

  it("computes 2/6/10 business-day and SLA minute boundaries", () => {
    const start = new Date("2026-07-11T21:00:00.000Z");
    expect(businessDaysBetween(start, new Date("2026-07-13T21:00:00.000Z"))).toBe(2);
    expect(businessDaysBetween(start, new Date("2026-07-19T21:00:00.000Z"))).toBe(6);
    expect(businessDaysBetween(start, new Date("2026-07-23T21:00:00.000Z"))).toBe(10);
    expect(elapsedWeekdayMinutesBetween(start, new Date("2026-07-12T21:00:00.000Z"))).toBe(1440);
  });

  it("recognizes Riyadh morning schedules and exact calendar thresholds", () => {
    const sundayNine = new Date("2026-07-12T06:00:00.000Z");
    expect(scannerSchedule(sundayNine)).toMatchObject({ morningDigest: true, dateKey: "2026-07-12" });
    expect(calendarDaysUntil("2026-07-19", sundayNine)).toBe(7);
  });
});
