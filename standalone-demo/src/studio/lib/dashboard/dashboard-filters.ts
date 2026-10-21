export const DASHBOARD_TIME_ZONE = "Asia/Riyadh";
export const DASHBOARD_TREND_DAYS = 30;
export const DASHBOARD_STALE_AFTER_MINUTES = 5;

export interface DashboardFilters {
  period: "30d";
  scope: "authorized_organization";
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  period: "30d",
  scope: "authorized_organization",
};

export function parseDashboardFilters(value: URLSearchParams | Record<string, string | string[] | undefined>): DashboardFilters {
  const rawPeriod = value instanceof URLSearchParams ? value.get("period") : value.period;
  return {
    period: rawPeriod === "30d" ? "30d" : DEFAULT_DASHBOARD_FILTERS.period,
    scope: DEFAULT_DASHBOARD_FILTERS.scope,
  };
}

export function dateKeyInDashboardTimeZone(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DASHBOARD_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function dashboardAgeDays(value: string | null | undefined, now: Date | string | number = new Date()): number {
  if (!value) return 0;
  const from = Date.parse(value);
  const to = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}
