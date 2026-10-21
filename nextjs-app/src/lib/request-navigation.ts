import { DISPLAY_REQUEST_STATUSES } from "@/lib/request-fulfillment";
import { isRequestStageKey } from "@/lib/request-stages";

const REQUEST_VIEWS = new Set(["warehouse", "overdue_return", "returns_due", "pending_approval"]);
const REQUEST_SOURCES = new Set(["portal", "customer", "employee"]);
const REQUEST_STATUSES = new Set<string>(DISPLAY_REQUEST_STATUSES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUEUE_IDS = 25;

export interface RequestQueueState {
  q: string;
  status: string;
  /** Stage-strip group (review/fulfillment/out/completed) — same status sets as the server counters. */
  stage: string;
  city: string;
  source: string;
  customer: string;
  responsible: string;
  overdueOnly: boolean;
  view: string;
}

export const EMPTY_REQUEST_QUEUE_STATE: RequestQueueState = {
  q: "",
  status: "",
  stage: "",
  city: "",
  source: "",
  customer: "",
  responsible: "",
  overdueOnly: false,
  view: "",
};

function clean(value: string | null, max = 160): string {
  return (value ?? "").trim().slice(0, max);
}

export function requestQueueStateFromSearch(search: string): RequestQueueState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const status = clean(params.get("status"), 40);
  const stage = clean(params.get("stage"), 20);
  const source = clean(params.get("source"), 20);
  const view = clean(params.get("view"), 40);
  const customer = clean(params.get("customer"), 80);
  const responsible = clean(params.get("responsible"), 80);
  return {
    q: clean(params.get("q")),
    status: REQUEST_STATUSES.has(status) ? status : "",
    stage: isRequestStageKey(stage) ? stage : "",
    city: clean(params.get("city"), 100),
    source: REQUEST_SOURCES.has(source) ? source : "",
    customer: customer === "" || UUID.test(customer) ? customer : "",
    responsible: responsible === "__mine" || responsible === "__unassigned" || UUID.test(responsible) ? responsible : "",
    overdueOnly: params.get("overdue") === "1",
    view: REQUEST_VIEWS.has(view) ? view : "",
  };
}

export function buildRequestQueuePath(state: Partial<RequestQueueState>, focusId?: string): string {
  const params = new URLSearchParams();
  const add = (key: string, value: string | undefined) => { if (value?.trim()) params.set(key, value.trim()); };
  add("q", state.q);
  add("status", state.status);
  add("stage", state.stage);
  add("city", state.city);
  add("source", state.source);
  add("customer", state.customer);
  add("responsible", state.responsible);
  if (state.overdueOnly) params.set("overdue", "1");
  add("view", state.view);
  const query = params.toString();
  const hash = focusId && UUID.test(focusId) ? `#request-${focusId}` : "";
  return `/requests${query ? `?${query}` : ""}${hash}`;
}

export function safeRequestReturnTo(candidate: string | null | undefined): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return "/requests";
  try {
    const url = new URL(candidate, "https://itam.local");
    if (url.origin !== "https://itam.local" || url.pathname !== "/requests") return "/requests";
    const state = requestQueueStateFromSearch(url.search);
    const focus = url.hash.match(/^#request-([0-9a-f-]+)$/i)?.[1];
    return buildRequestQueuePath(state, focus && UUID.test(focus) ? focus : undefined);
  } catch {
    return "/requests";
  }
}

export function safeRequestQueueIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const unique: string[] = [];
  for (const id of value.split(",")) {
    if (!UUID.test(id) || unique.includes(id)) continue;
    unique.push(id);
    if (unique.length === MAX_QUEUE_IDS) break;
  }
  return unique;
}

export function withRequestQueueContext(
  requestId: string,
  returnTo: string,
  queueIds: string[],
): string {
  if (!UUID.test(requestId)) return "/requests";
  const params = new URLSearchParams({ returnTo: safeRequestReturnTo(returnTo) });
  const queue = safeRequestQueueIds(queueIds.join(","));
  if (queue.length > 1) params.set("queue", queue.join(","));
  return `/requests/${requestId}?${params.toString()}`;
}

export function requestDetailNavigation(search: string, currentId: string): {
  returnTo: string;
  nextId: string | null;
  nextHref: string | null;
} {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const returnTo = safeRequestReturnTo(params.get("returnTo"));
  const queue = safeRequestQueueIds(params.get("queue"));
  const index = queue.indexOf(currentId);
  const nextId = index >= 0 ? queue[index + 1] ?? null : null;
  if (!nextId) return { returnTo, nextId: null, nextHref: null };
  const nextReturnTo = safeRequestReturnTo(returnTo.replace(/#request-[0-9a-f-]+$/i, `#request-${nextId}`));
  return {
    returnTo,
    nextId,
    nextHref: withRequestQueueContext(nextId, nextReturnTo, queue),
  };
}
