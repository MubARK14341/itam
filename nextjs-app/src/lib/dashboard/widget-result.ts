import type { DashboardSource, WidgetResult } from "@/lib/dashboard/dashboard-types";

export function uniqueDashboardSources(sources: DashboardSource[]): DashboardSource[] {
  return [...new Set(sources)];
}

export function createArrayWidgetResult<T>(
  data: T[],
  updatedAt: string,
  unavailableSources: DashboardSource[] = [],
  allSourcesFailed = false,
): WidgetResult<T[]> {
  const unavailable = uniqueDashboardSources(unavailableSources);
  if (allSourcesFailed) {
    return { status: "error", message: "unavailable", retryable: true, unavailableSources: unavailable };
  }
  const base = {
    data,
    updatedAt,
    ...(unavailable.length ? { isPartial: true as const, unavailableSources: unavailable } : {}),
  };
  return data.length ? { status: "success", ...base } : { status: "empty", ...base };
}
