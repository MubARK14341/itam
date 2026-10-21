import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardPriorityItem, WidgetResult } from "@/lib/dashboard/dashboard-types";
import { PriorityNow } from "./priority-now";

const preferences = vi.hoisted(() => {
  const state: { lang: "ar" | "en" } = { lang: "en" };
  return state;
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ prefetch: vi.fn() }) }));
vi.mock("@/components/providers/app-preferences-provider", async () => {
  const { getDict } = await import("@/lib/i18n");
  return { useAppPreferences: () => ({ lang: preferences.lang, t: getDict(preferences.lang) }) };
});

afterEach(() => vi.restoreAllMocks());

const item: DashboardPriorityItem = {
  id: "maintenance-priority",
  kind: "unassigned_maintenance",
  severity: "warning",
  entityType: "maintenance",
  entityId: "maintenance-record",
  entityLabel: "TEST maintenance",
  createdAt: "2026-10-10T08:00:00Z",
  dueAt: null,
  overdueDays: 0,
  owner: null,
  ownerKind: "unassigned",
  location: null,
  company: null,
  status: "open",
  slaStatus: "not_applicable",
  impact: "service",
  href: "/maintenance",
  action: "review",
};

function renderPriority(updatedAt: string): string {
  const result: WidgetResult<DashboardPriorityItem[]> = { status: "success", data: [item], updatedAt };
  return renderToString(createElement(PriorityNow, { result, onRetry: () => undefined }));
}

describe("PriorityNow server and initial client markup", () => {
  it.each([
    { lang: "ar", label: "الآن" },
    { lang: "en", label: "just now" },
  ] as const)("keeps $lang markup identical when hydration crosses the minute boundary", ({ lang, label }) => {
    preferences.lang = lang;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T08:00:59Z"));
    const server = renderPriority("2026-10-10T08:00:59Z");
    clock.mockReturnValue(Date.parse("2026-10-10T08:01:01Z"));
    const initialClient = renderPriority("2026-10-10T08:00:59Z");
    expect(initialClient).toBe(server);
    expect(server).toContain(`>${label}</bdi>`);
    expect(clock).not.toHaveBeenCalled();
  });

  it.each(["ar", "en"] as const)("keeps invalid $lang snapshot time unknown without a local-clock fallback", (lang) => {
    preferences.lang = lang;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T08:01:01Z"));
    const html = renderPriority("not-a-date");
    expect(html).toContain(">—</bdi>");
    expect(clock).not.toHaveBeenCalled();
  });
});
