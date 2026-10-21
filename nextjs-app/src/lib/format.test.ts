import { afterEach, describe, expect, it, vi } from "vitest";
import { dateKeyInTimeZone, formatDate, formatDateTime, formatRelative, formatSAR } from "./format";

afterEach(() => vi.restoreAllMocks());

describe("calendar dates and currency", () => {
  it("uses the Riyadh calendar day instead of the UTC day near midnight", () => {
    expect(dateKeyInTimeZone(new Date("2026-07-12T22:30:00Z"))).toBe("2026-07-13");
  });

  it("keeps a date-only value on the same calendar day in Arabic and English", () => {
    expect(formatDate("2026-08-03", "en")).toBe("3 Aug 2026");
    expect(formatDate("2026-08-03", "ar")).toBe("3 أغسطس 2026");
  });

  it("formats request timestamps in Riyadh without the broken RTL numeric order", () => {
    const timestamp = "2026-08-03T07:15:00.000Z";
    expect(formatDateTime(timestamp, "en")).toBe("3 Aug 2026, 10:15 AM");
    expect(formatDateTime(timestamp, "ar")).toBe("3 أغسطس 2026، 10:15 ص");
    expect(formatDateTime(timestamp, "ar")).not.toContain("032026/08/");
  });

  it("handles null and invalid request dates safely", () => {
    expect(formatDate(null, "ar")).toBe("—");
    expect(formatDateTime(null, "en")).toBe("—");
    expect(formatDateTime("not-a-date", "ar")).toBe("—");
  });

  it("preserves decimal currency without rounding 1234.56 to an integer", () => {
    expect(formatSAR(1234.56, "en")).toContain("1,234.56");
    expect(formatSAR(1234.56, "ar")).toContain("1,234.56");
  });
});

describe("relative dates", () => {
  const createdAt = "2026-10-10T08:00:00Z";

  it("uses the supplied snapshot across a local clock boundary in both languages", () => {
    const referenceMs = Date.parse("2026-10-10T08:00:59Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T08:01:01Z"));
    expect(formatRelative(createdAt, "en", referenceMs)).toBe("just now");
    expect(formatRelative(createdAt, "ar", referenceMs)).toBe("الآن");
    expect(clock).not.toHaveBeenCalled();
    expect(formatRelative(createdAt, "en", referenceMs + 1_000)).toBe("1m ago");
    expect(formatRelative(createdAt, "ar", referenceMs + 1_000)).toBe("قبل دقيقة");
  });

  it("preserves the current-clock behavior when no snapshot is supplied", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T08:00:59Z"));
    expect(formatRelative(createdAt, "en")).toBe("just now");
    clock.mockReturnValue(Date.parse("2026-10-10T08:01:01Z"));
    expect(formatRelative(createdAt, "en")).toBe("1m ago");
    expect(formatRelative(createdAt)).toBe("قبل دقيقة");
  });

  it.each([NaN, Infinity, -Infinity])("keeps an invalid snapshot unknown instead of using the local clock (%s)", (referenceMs) => {
    const clock = vi.spyOn(Date, "now");
    expect(formatRelative(createdAt, "en", referenceMs)).toBe("—");
    expect(formatRelative(createdAt, "ar", referenceMs)).toBe("—");
    expect(clock).not.toHaveBeenCalled();
  });

  it("preserves missing dates and clamps a future date relative to the snapshot", () => {
    const referenceMs = Date.parse(createdAt);
    expect(formatRelative(null, "en", referenceMs)).toBe("—");
    expect(formatRelative("not-a-date", "ar", referenceMs)).toBe("—");
    expect(formatRelative("2026-10-10T08:01:00Z", "en", referenceMs)).toBe("just now");
  });
});


describe("dateKeyInTimeZone formatter reuse", () => {
  it.each([
    ["2026-07-12T20:59:59.999Z", "Asia/Riyadh", "2026-07-12"],
    ["2026-07-12T21:00:00.000Z", "Asia/Riyadh", "2026-07-13"],
    ["2024-02-29T20:59:59.999Z", "Asia/Riyadh", "2024-02-29"],
    ["2024-02-29T21:00:00.000Z", "Asia/Riyadh", "2024-03-01"],
    ["2026-12-31T20:59:59.999Z", "Asia/Riyadh", "2026-12-31"],
    ["2026-12-31T21:00:00.000Z", "Asia/Riyadh", "2027-01-01"],
    ["2026-07-12T23:59:59.999Z", "UTC", "2026-07-12"],
    ["2026-07-13T00:00:00.000Z", "UTC", "2026-07-13"],
    ["2026-07-12T15:00:00.000Z", "Asia/Tokyo", "2026-07-13"],
    ["2026-03-08T04:59:59.999Z", "America/New_York", "2026-03-07"],
    ["2026-03-08T05:00:00.000Z", "America/New_York", "2026-03-08"],
    ["2026-03-09T03:59:59.999Z", "America/New_York", "2026-03-08"],
    ["2026-03-09T04:00:00.000Z", "America/New_York", "2026-03-09"],
    ["2026-11-02T04:59:59.999Z", "America/New_York", "2026-11-01"],
    ["2026-11-02T05:00:00.000Z", "America/New_York", "2026-11-02"],
    ["2026-03-28T23:00:00.000Z", "Europe/London", "2026-03-28"],
    ["2026-03-29T23:00:00.000Z", "Europe/London", "2026-03-30"],
  ])("preserves the calendar key for %s in %s", (timestamp, timeZone, expected) => {
    expect(dateKeyInTimeZone(new Date(timestamp), timeZone)).toBe(expected);
  });

  it("keeps the implicit and explicit Riyadh defaults equivalent without reusing a date result", () => {
    const date = new Date("2026-07-12T20:59:59.999Z");
    expect(dateKeyInTimeZone(date)).toBe("2026-07-12");
    expect(dateKeyInTimeZone(date, "Asia/Riyadh")).toBe("2026-07-12");
    date.setTime(Date.parse("2026-07-12T21:00:00.000Z"));
    expect(dateKeyInTimeZone(date)).toBe("2026-07-13");
    expect(date.getTime()).toBe(Date.parse("2026-07-12T21:00:00.000Z"));
  });

  it("uses the current clock on every implicit-date call across the Riyadh day boundary", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-12T20:59:59.999Z"));
      expect(dateKeyInTimeZone()).toBe("2026-07-12");
      vi.advanceTimersByTime(1);
      expect(dateKeyInTimeZone()).toBe("2026-07-13");
      expect(dateKeyInTimeZone(undefined, "UTC")).toBe("2026-07-12");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["Asia/Riyadh", "UTC"])("preserves the RangeError for invalid dates in %s", (timeZone) => {
    expect(() => dateKeyInTimeZone(new Date(NaN), timeZone)).toThrow(RangeError);
  });

  it.each(["not-a-time-zone", "Asia/Riyadh\u0000"])("preserves the RangeError for an invalid timezone %s", (timeZone) => {
    expect(() => dateKeyInTimeZone(new Date("2026-07-12T00:00:00Z"), timeZone)).toThrow(RangeError);
  });
});
