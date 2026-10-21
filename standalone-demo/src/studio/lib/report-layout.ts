export const REPORT_TAB_KEYS = [
  "executive",
  "requests",
  "inventory",
  "maintenance",
  "custody",
] as const;

export type ReportTab = (typeof REPORT_TAB_KEYS)[number];

export const REMOVED_REPORT_TAB_KEYS = [
  "alerts",
  "activity",
  "risk",
  "customerRequests",
  "assets",
  "consumables",
] as const;

export function hasDuplicateReportTabs(tabs: readonly string[]): boolean {
  return new Set(tabs).size !== tabs.length;
}
