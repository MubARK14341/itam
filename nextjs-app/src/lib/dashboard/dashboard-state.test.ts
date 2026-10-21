import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dashboardAgeDays, dateKeyInDashboardTimeZone, parseDashboardFilters } from "./dashboard-filters";
import { createArrayWidgetResult, uniqueDashboardSources } from "./widget-result";
import { LtrText } from "@/components/dashboard-v6/dashboard-ui";

describe("dashboard filters and numeric calculations", () => {
  it("accepts only the supported bounded period", () => {
    expect(parseDashboardFilters(new URLSearchParams("period=30d"))).toEqual({
      period: "30d",
      scope: "authorized_organization",
    });
    expect(parseDashboardFilters({ period: "all" }).period).toBe("30d");
  });

  it("uses Riyadh date boundaries and non-negative ages", () => {
    expect(dateKeyInDashboardTimeZone("2026-07-11T20:59:59Z")).toBe("2026-07-11");
    expect(dateKeyInDashboardTimeZone("2026-07-11T21:00:00Z")).toBe("2026-07-12");
    expect(dashboardAgeDays("2026-07-10T12:00:00Z", "2026-07-14T12:00:00Z")).toBe(4);
    expect(dashboardAgeDays("2026-07-20", "2026-07-14")).toBe(0);
  });
});

describe("honest widget result mapping", () => {
  it("keeps an empty verified result distinct from an error", () => {
    expect(createArrayWidgetResult([], "2026-07-14T00:00:00Z").status).toBe("empty");
    expect(createArrayWidgetResult([], "2026-07-14T00:00:00Z", ["requests"], true)).toEqual({
      status: "error",
      message: "unavailable",
      retryable: true,
      unavailableSources: ["requests"],
    });
  });

  it("marks successful partial data and deduplicates failed sources", () => {
    const result = createArrayWidgetResult([1], "2026-07-14T00:00:00Z", ["requests", "requests", "assets"]);
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.isPartial).toBe(true);
      expect(result.unavailableSources).toEqual(["requests", "assets"]);
    }
    expect(uniqueDashboardSources(["summary", "summary"])).toEqual(["summary"]);
  });
});

describe("dashboard text safety", () => {
  it("renders hostile text as escaped text, never an element", () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(createElement(LtrText, null, payload));
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });
});
