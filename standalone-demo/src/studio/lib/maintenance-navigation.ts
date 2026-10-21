import { MTYPE_OPTS, PROBLEM_TYPE_OPTS } from "@/lib/maintenance";

const STATUSES = new Set(["open", "in_progress", "completed", "cancelled"]);
const TYPES = new Set(MTYPE_OPTS.map(([value]) => value));
const PROBLEM_TYPES = new Set(PROBLEM_TYPE_OPTS.map(([value]) => value));
const VIEWS = new Set(["no_action", "long_maint", "followup", "past_due"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MaintenanceNavigationState {
  q: string;
  status: string;
  type: string;
  problemType: string;
  view: string;
  mineOnly: boolean;
  focusId: string;
}

function clean(value: string | null, max = 160): string {
  return (value ?? "").trim().slice(0, max);
}

export function maintenanceStateFromSearch(search: string): MaintenanceNavigationState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const status = clean(params.get("status"), 30);
  const type = clean(params.get("type"), 30);
  const problemType = clean(params.get("problem"), 40);
  const view = clean(params.get("view"), 40);
  const focusId = clean(params.get("m"), 80);
  return {
    q: clean(params.get("q")),
    status: STATUSES.has(status) ? status : "",
    type: TYPES.has(type) ? type : "",
    problemType: PROBLEM_TYPES.has(problemType) ? problemType : "",
    view: VIEWS.has(view) ? view : "",
    mineOnly: params.get("mine") === "1",
    focusId: UUID.test(focusId) ? focusId : "",
  };
}

export function buildMaintenancePath(state: Partial<MaintenanceNavigationState>): string {
  const params = new URLSearchParams();
  const add = (key: string, value: string | undefined) => { if (value?.trim()) params.set(key, value.trim()); };
  add("q", state.q);
  add("status", state.status);
  add("type", state.type);
  add("problem", state.problemType);
  add("view", state.view);
  if (state.mineOnly) params.set("mine", "1");
  if (state.focusId && UUID.test(state.focusId)) params.set("m", state.focusId);
  const query = params.toString();
  return `/maintenance${query ? `?${query}` : ""}`;
}
