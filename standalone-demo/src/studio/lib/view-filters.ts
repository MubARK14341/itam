import { REPORT_TAB_KEYS, type ReportTab } from "./report-layout";
import { resolveReportTab } from "./report-load-plan";
import { portalDashboardFilterFromQuery, type PortalDashboardFilter, type PortalStatusKey } from "./portal-status";

export type FilterValues = Record<string, string>;
export type ReportViewFilters = {
  tab: ReportTab; category: string; status: string; location: string; department: string; company: string;
  from: string; to: string; kind: "all" | "asset" | "consumable"; source: "all" | "customer" | "employee"; low: string;
};
export type PortalViewFilters = {
  q: string; status: string; from: string; to: string; bucket: PortalDashboardFilter | ""; view: "all" | "open" | "done";
};
export const PORTAL_VIEW_STATUSES: PortalStatusKey[] = [
  "draft", "reviewing", "pending_pm", "clarify", "accepted", "preparing", "delivered", "returned", "completed", "rejected", "pm_rejected", "cancelled",
];
const identifier = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : "";
const choice = <T extends string>(value: string, values: readonly T[], fallback: T): T => values.find((candidate) => candidate === value) ?? fallback;
function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : "";
}
function dates(params: URLSearchParams) {
  const from = date(params.get("from") ?? ""), to = date(params.get("to") ?? "");
  // Preserve both valid inputs while a user edits the range. An inverted range
  // naturally has no matches; never broaden it by silently clearing filters.
  return { from, to };
}
export function filterParams(values: FilterValues): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return params;
}
export function parseReportView(params: URLSearchParams, visibleTabs: readonly ReportTab[] = REPORT_TAB_KEYS): ReportViewFilters {
  return {
    tab: resolveReportTab(params.get("tab"), visibleTabs),
    category: identifier(params.get("category") ?? ""), location: identifier(params.get("location") ?? ""),
    department: identifier(params.get("department") ?? ""), company: identifier(params.get("company") ?? ""),
    status: choice(params.get("status") ?? "", ["", "available", "reserved", "in_maintenance"], ""),
    ...dates(params), kind: choice(params.get("kind") ?? "", ["all", "asset", "consumable"], "all"),
    source: choice(params.get("source") ?? "", ["all", "customer", "employee"], "all"),
    low: params.get("low") === "1" ? "1" : "",
  };
}
export function reportViewValues(state: ReportViewFilters): FilterValues {
  return { ...state, kind: state.kind === "all" ? "" : state.kind, source: state.source === "all" ? "" : state.source };
}
export function parsePortalView(params: URLSearchParams): PortalViewFilters {
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    status: choice(params.get("status") ?? "", [...PORTAL_VIEW_STATUSES, ""], ""), ...dates(params),
    bucket: portalDashboardFilterFromQuery(params.get("bucket")) ?? "",
    view: choice(params.get("view") ?? "", ["all", "open", "done"], "all"),
  };
}
export function portalViewValues(state: PortalViewFilters): FilterValues {
  return { ...state, view: state.view === "all" ? "" : state.view };
}

export type PrivateView = { id: string; name: string; filters: FilterValues };
export const PRIVATE_VIEW_LIMIT = 20;
export function privateViewStorageKey(actorId: string | null, surface: "reports" | "portal-requests") {
  return actorId ? `itam.private-views.v1:${surface}:${encodeURIComponent(actorId)}` : null;
}
/** Parse only the named filter envelope. Result rows, financial values and arbitrary keys never survive. */
export function readPrivateViews(raw: string | null, normalize: (values: FilterValues) => FilterValues): PrivateView[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("views" in value) || !Array.isArray(value.views)) return [];
  const seen = new Set<string>();
  return value.views.slice(0, PRIVATE_VIEW_LIMIT).flatMap((view: unknown) => {
    if (!view || typeof view !== "object" || !("id" in view) || typeof view.id !== "string" || !identifier(view.id)
      || seen.has(view.id) || !("name" in view) || typeof view.name !== "string" || !view.name.trim()
      || !("filters" in view) || !view.filters || typeof view.filters !== "object" || Array.isArray(view.filters)) return [];
    seen.add(view.id);
    const filters = Object.fromEntries(Object.entries(view.filters).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return [{ id: view.id, name: view.name.trim().slice(0, 60), filters: normalize(filters) }];
  });
}
export function encodePrivateViews(views: readonly PrivateView[], normalize: (values: FilterValues) => FilterValues) {
  return JSON.stringify({ version: 1, views: views.slice(0, PRIVATE_VIEW_LIMIT).map((view) => ({
    id: view.id, name: view.name.trim().slice(0, 60), filters: normalize(view.filters),
  })) });
}
