import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChartErrorBoundary } from "@/components/dashboard-v6/chart-error-boundary";

describe("dashboard chart component failure isolation", () => {
  it("maps a component exception to the supplied fallback without replacing sibling widgets", () => {
    const fallback = createElement("p", null, "chart unavailable");
    const child = createElement("svg");
    const boundary = new ChartErrorBoundary({
      children: child,
      fallback,
      resetKey: "success:2026-07-28T00:00:00Z",
    });

    expect(boundary.render()).toBe(child);
    boundary.state = ChartErrorBoundary.getDerivedStateFromError();
    expect(boundary.render()).toBe(fallback);
  });
});
