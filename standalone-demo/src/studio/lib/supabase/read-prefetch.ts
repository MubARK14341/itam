// Navigation prefetch for Data API reads (browser only).
//
// Every page loads its data in the browser straight from Supabase. From Saudi Arabia each round
// trip costs ~0.3 s, so a click waited for its data after the route changed. This module lets the
// shell warm a route's read requests *before* the click (hover / focus / touch, and once while idle)
// and hands each warmed response to the first identical request the page makes.
//
// Safety rules:
// - Only Data API GET/HEAD reads and an explicit allowlist of read-only RPCs are ever buffered.
//   Auth, session/role/capability/security RPCs, Storage and every write pass straight through.
// - A buffered response is single-use and expires after PREFETCH_TTL_MS, so refresh buttons and
//   later reloads always hit the network as before.
// - Any write (non-GET Data API call, non-allowlisted RPC, Storage write) clears the whole buffer.
// - Keys include the Authorization header, so different sessions never share a response.
// - Data lives only in memory. Only request *shapes* (path, query, RPC body — never tokens or
//   responses) are remembered per user in localStorage so the next session can prefetch; they are
//   cleared on sign-out.
//
// Server read seeds (see server-read-seed.ts): a route's server page can run the page's own first
// reads next to the database and send the recorded responses with the page. They follow the same
// rules (reads only, single use, PREFETCH_TTL_MS, cleared on writes) and are additionally bound to
// the user whose token fetched them and to the write epoch they were recorded under, so a payload
// from Next's router cache that predates a write (in any tab) is never used.

const PREFETCH_TTL_MS = 30_000;
const RECORD_WINDOW_MS = 5_000;
const MAX_ROUTE_REQUESTS = 24;
const MAX_BUFFER = 150;
const STORE_PREFIX = "itam:prefetch:v1:";

// Pure reads that are safe to hand to the page that asked for them.
const READ_RPCS = new Set([
  // Canonical SQL projections return only authorized financial columns. Keep these explicit:
  // an unknown RPC ending in _financial must never gain read-only treatment by naming alone.
  "assets_financial", "consumables_financial", "consumable_txn_financial", "depreciation_financial",
  "maintenance_financial", "purchase_request_items_financial", "request_items_financial",
  "action_alert_operational_counts", "automation_delivery_overview", "automation_delivery_recent",
  "automation_email_settings_get", "consumable_txn_financial_detail", "dashboard_operational_summary", "employee_my_assets",
  "employee_my_request", "employee_my_requests", "employee_my_return_requests",
  "financial_data_quality_list", "financial_data_quality_summary", "get_customer_portal_settings",
  "get_customer_request_analytics", "get_customer_request_operational_report",
  "get_customer_request_timeseries", "list_customer_portal_invites", "list_customer_portal_users",
  "list_registration_requests", "maintenance_financial_truth", "maintenance_operational_summary", "portal_get_profile",
  "portal_get_request", "portal_get_request_dashboard", "portal_item_availability",
  "portal_list_allowed_categories", "portal_list_allowed_companies", "portal_list_catalog",
  "portal_list_consumables", "portal_list_request_attachments", "portal_list_requests",
  "purchase_request_procurement_state", "request_asset_allocation_summary",
  "request_delivery_requirements", "request_filter_options", "request_operational_counts",
  "stocktake_detail", "stocktake_list", "stocktake_system_inventory_report", "user_label",
  "user_labels", "warehouse_employee_return_queue",
]);
// Reads that must never be buffered (session, identity, security) but are not writes either.
const NEUTRAL_RPCS = new Set([
  "auth_security_state", "app_user_role", "my_capabilities", "is_financial_viewer",
  "portal_get_context", "app_schema_compatibility", "registration_status",
  "validate_registration_invite", "validate_portal_invite", "request_operation_result_lookup",
  "public_asset_by_token", "portal_get_request_attachment_path",
]);
const KEY_HEADERS = ["authorization", "accept", "accept-profile", "content-profile", "prefer", "range"];
const REPLAY_HEADERS = ["accept", "accept-profile", "content-profile", "prefer", "range", "content-type"];
/** Request headers that identify a seeded response (KEY_HEADERS without the token). */
export const SEED_KEY_HEADERS = KEY_HEADERS.filter((h) => h !== "authorization");
/** Cookie holding the write epoch; any Data API write in any tab replaces it. */
export const READ_EPOCH_COOKIE = "itam_read_epoch";
export const READ_INVALIDATION_STORAGE_KEY = "itam:read-invalidation";
// Writes that never change what another page reads: the Action Center reconciles its own alert
// instances on every manager visit and reloads afterwards, so it must not invalidate other seeds.
const EPOCH_NEUTRAL_WRITE_RPCS = new Set(["action_alerts_sync"]);

export type DataRequestKind = "read" | "neutral" | "write";
type Kind = DataRequestKind;
type Buffered = { at: number; status: number; statusText: string; headers: [string, string][]; body: string };
type Shape = { method: string; url: string; body: string | null; headers: Record<string, string> };

/** One Data API read recorded on the server for the page that will make the same request. */
export type ReadSeedEntry = {
  method: string;
  url: string;
  body: string | null;
  /** SEED_KEY_HEADERS of the request. */
  headers: Record<string, string>;
  status: number;
  statusText: string;
  responseHeaders: [string, string][];
  responseBody: string;
};
export type ReadSeed = { id: string; userId: string; epoch: string; entries: ReadSeedEntry[] };

const buffer = new Map<string, Buffered>();
const inflight = new Map<string, Promise<Buffered | null>>();
const warmControllers = new Set<AbortController>();
const invalidationListeners = new Set<() => void>();
const seeds = new Map<string, { userId: string; entries: Buffered[] }>();
// Seed id -> when it was last applied. A page payload Next reuses from its router cache (<= 30 s)
// may apply its seed again on a later visit; repeated renders of one visit must not.
const appliedSeeds = new Map<string, number>();
const REAPPLY_AFTER_MS = 1_000;
let generation = 0;
let recordingRoute: string | null = null;
let recordingUntil = 0;
let recordedUser: string | null = null;
const routeShapes = new Map<string, Map<string, Shape>>();

const isBrowser = () => typeof window !== "undefined";

function rpcName(pathname: string): string | null {
  const match = pathname.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
  return match ? match[1] : null;
}

/** read = may be buffered or seeded; write = clears everything; neutral = passes through. */
export function classifyDataRequest(method: string, url: URL): DataRequestKind {
  return classify(method, url);
}

function classify(method: string, url: URL): Kind {
  const rpc = rpcName(url.pathname);
  if (rpc) {
    if (method === "GET" || method === "HEAD") return READ_RPCS.has(rpc) ? "read" : "neutral";
    if (READ_RPCS.has(rpc)) return "read";
    return NEUTRAL_RPCS.has(rpc) ? "neutral" : "write";
  }
  if (url.pathname.startsWith("/rest/v1/")) return method === "GET" || method === "HEAD" ? "read" : "write";
  if (url.pathname.startsWith("/storage/v1/")) return method === "GET" || method === "HEAD" ? "neutral" : "write";
  return "neutral"; // Auth and everything else: never buffered, never invalidates.
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

function keyOf(method: string, url: string, body: string | null, headers: Record<string, string>): string {
  return [method, url, body ?? "", ...KEY_HEADERS.map((h) => `${h}=${headers[h] ?? ""}`)].join("\u0001");
}

function seedKeyOf(method: string, url: string, body: string | null, headers: Record<string, string>): string {
  return keyOf(method, url, body, { ...headers, authorization: "" });
}

function toResponse(entry: Buffered): Response {
  return new Response(entry.status === 204 ? null : entry.body, {
    status: entry.status, statusText: entry.statusText, headers: entry.headers,
  });
}

function fresh(entry: Buffered | undefined): entry is Buffered {
  return !!entry && Date.now() - entry.at <= PREFETCH_TTL_MS;
}

/** Drop every buffered response (called on any write and on sign-out). */
export function clearReadPrefetch(notify = true) {
  generation += 1;
  for (const controller of warmControllers) controller.abort();
  warmControllers.clear();
  buffer.clear();
  inflight.clear();
  seeds.clear();
  if (notify) invalidationListeners.forEach((listener) => listener());
}

/** Decoration caches follow the same write/sign-out boundary without importing a React hook. */
export function subscribeReadInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

export function readEpochCookie(): string {
  if (!isBrowser()) return "";
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${READ_EPOCH_COOKIE}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

// A fresh random epoch per write: server pages record the epoch they saw, so a page payload fetched
// before this write (in this or another tab) is recognised and its seed ignored.
function bumpReadEpoch() {
  if (!isBrowser()) return;
  try {
    const epoch = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${READ_EPOCH_COOKIE}=${epoch}; Path=/; SameSite=Lax${secure}`;
    // Non-sensitive epoch only. Other tabs can refresh decorative counts and discard old buffers.
    window.localStorage.setItem(READ_INVALIDATION_STORAGE_KEY, epoch);
  } catch { /* cookies unavailable: seeds then stay bound to the old epoch and are ignored */ }
}

/**
 * Accept a server read seed for the page about to mount. Called during render (before any effect)
 * once per page mount. Ignored when it was recorded under an older write epoch.
 */
export function seedReadPrefetch(seed: ReadSeed | null | undefined) {
  if (!isBrowser() || !seed) return;
  const lastApplied = appliedSeeds.get(seed.id);
  if (lastApplied !== undefined && Date.now() - lastApplied < REAPPLY_AFTER_MS) return;
  appliedSeeds.set(seed.id, Date.now());
  if (seed.epoch !== readEpochCookie()) return;
  const at = Date.now();
  for (const entry of seed.entries) {
    let url: URL;
    try { url = new URL(entry.url); } catch { continue; }
    if (classify(entry.method, url) !== "read") continue;
    const key = seedKeyOf(entry.method, url.toString(), entry.body, entry.headers);
    const buffered: Buffered = {
      at, status: entry.status, statusText: entry.statusText, headers: entry.responseHeaders, body: entry.responseBody,
    };
    const slot = seeds.get(key);
    if (slot && slot.userId === seed.userId) slot.entries.push(buffered);
    else seeds.set(key, { userId: seed.userId, entries: [buffered] });
  }
}

function takeSeed(key: string, requester: string | null): Buffered | null {
  const slot = seeds.get(key);
  if (!slot) return null;
  while (slot.entries.length && !fresh(slot.entries[0])) slot.entries.shift();
  const entry = requester && requester === slot.userId ? slot.entries.shift() ?? null : null;
  if (!entry || !slot.entries.length) seeds.delete(key);
  return entry;
}

/** Forget remembered request shapes for the signed-in user (sign-out). */
export function forgetPrefetchShapes() {
  clearReadPrefetch();
  routeShapes.clear();
  if (!isBrowser()) return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(STORE_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}

function persistShapes() {
  if (!isBrowser() || !recordedUser) return;
  try {
    const data: Record<string, Shape[]> = {};
    routeShapes.forEach((shapes, route) => { data[route] = [...shapes.values()]; });
    window.localStorage.setItem(STORE_PREFIX + recordedUser, JSON.stringify(data));
  } catch { /* storage unavailable or full */ }
}

function loadShapes(userId: string) {
  if (recordedUser === userId) return;
  recordedUser = userId;
  routeShapes.clear();
  if (!isBrowser()) return;
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + userId);
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, Shape[]>;
    for (const [route, shapes] of Object.entries(data)) {
      const map = new Map<string, Shape>();
      for (const shape of shapes.slice(0, MAX_ROUTE_REQUESTS)) map.set(keyOf(shape.method, shape.url, shape.body, {}), shape);
      routeShapes.set(route, map);
    }
  } catch { /* corrupt entry: ignore */ }
}

function record(method: string, url: string, body: string | null, headers: Record<string, string>) {
  if (!recordingRoute || Date.now() > recordingUntil) return;
  const shapes = routeShapes.get(recordingRoute) ?? new Map<string, Shape>();
  const kept: Record<string, string> = {};
  for (const h of REPLAY_HEADERS) if (headers[h]) kept[h] = headers[h];
  const shapeKey = keyOf(method, url, body, {});
  const previous = shapes.get(shapeKey);
  if (previous && previous.method === method && previous.url === url && previous.body === body
    && previous.headers && REPLAY_HEADERS.every((header) => previous.headers[header] === kept[header])) return;
  if (!previous && shapes.size >= MAX_ROUTE_REQUESTS) return;
  shapes.set(shapeKey, { method, url, body, headers: kept });
  routeShapes.set(recordingRoute, shapes);
  persistShapes();
}

/**
 * Namespaces remembered shapes and seeds per user. Decoded, not verified: never used for
 * authorization (PostgREST verifies the token on every request that reaches it).
 */
export function userIdFromAuthorization(value: string | undefined): string | null {
  const token = value?.replace(/^Bearer\s+/i, "");
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

// Requests issued within a few seconds of a route change belong to that route's load.
function trackRoute(headers: Record<string, string>) {
  const userId = userIdFromAuthorization(headers.authorization);
  if (userId) loadShapes(userId);
  const path = window.location.pathname;
  if (path !== recordingRoute) {
    recordingRoute = path;
    recordingUntil = Date.now() + RECORD_WINDOW_MS;
  }
}

async function networkEntry(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Buffered | null> {
  const response = await fetch(input, init);
  if (!response.ok) return null;
  const body = await response.text();
  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => headers.push([key, value]));
  return { at: Date.now(), status: response.status, statusText: response.statusText, headers, body };
}

function remember(key: string, entry: Buffered) {
  if (buffer.size >= MAX_BUFFER) {
    const oldest = buffer.keys().next().value;
    if (oldest !== undefined) buffer.delete(oldest);
  }
  buffer.set(key, entry);
}

/** fetch() used by the browser Supabase client. */
export async function prefetchAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isBrowser()) return fetch(input, init);
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const url = new URL(request?.url ?? String(input), window.location.href);
  const kind = classify(method, url);
  if (kind === "neutral") return fetch(input, init);
  if (kind === "write") {
    const rpc = rpcName(url.pathname);
    clearReadPrefetch(false);
    try {
      return await fetch(input, init);
    } finally {
      // After the write settles: pages requested from now on record the new epoch.
      if (!(rpc && EPOCH_NEUTRAL_WRITE_RPCS.has(rpc))) bumpReadEpoch();
      clearReadPrefetch();
    }
  }

  const body = typeof init?.body === "string" ? init.body : init?.body == null ? null : undefined;
  if (body === undefined) return fetch(input, init); // non-string bodies are never buffered
  const signal = init?.signal ?? request?.signal;
  signal?.throwIfAborted();
  const headers = headerRecord(init?.headers ?? request?.headers);
  const key = keyOf(method, url.toString(), body, headers);
  trackRoute(headers);
  if (recordedUser) record(method, url.toString(), body, headers);

  const seeded = takeSeed(seedKeyOf(method, url.toString(), body, headers), userIdFromAuthorization(headers.authorization));
  if (seeded) return toResponse(seeded);

  const buffered = buffer.get(key);
  if (fresh(buffered)) { buffer.delete(key); return toResponse(buffered); }
  buffer.delete(key);
  const pending = inflight.get(key);
  if (pending) {
    const startedGeneration = generation;
    let removeAbort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      if (!signal) return;
      const abort = () => reject(signal.reason ?? new DOMException("Read cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    });
    let entry: Buffered | null;
    try { entry = await Promise.race([pending, cancelled]); } finally { removeAbort(); }
    signal?.throwIfAborted();
    buffer.delete(key);
    if (generation === startedGeneration && entry && fresh(entry)) return toResponse(entry);
  }
  return fetch(input, init);
}

/** Warm the remembered read requests of a route (single-use, short-lived). */
export async function prefetchRouteData(pathname: string, auth: { accessToken: string; apiKey: string; userId: string }, signal?: AbortSignal) {
  if (!isBrowser()) return;
  loadShapes(auth.userId);
  const shapes = routeShapes.get(pathname);
  if (!shapes || shapes.size === 0) return;
  const startedGeneration = generation;
  const queue = [...shapes.values()];
  const warm = async () => {
    while (queue.length && generation === startedGeneration && !signal?.aborted) {
      const shape = queue.shift()!;
      const headers: Record<string, string> = {
        ...shape.headers,
        apikey: auth.apiKey,
        authorization: `Bearer ${auth.accessToken}`,
      };
      const key = keyOf(shape.method, shape.url, shape.body, headers);
      if (fresh(buffer.get(key)) || inflight.has(key)) continue;
      const controller = new AbortController();
      warmControllers.add(controller);
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const promise = networkEntry(shape.url, { method: shape.method, headers, body: shape.body ?? undefined, signal: requestSignal })
        .catch(() => null);
      inflight.set(key, promise);
      const entry = await promise;
      if (inflight.get(key) === promise) inflight.delete(key);
      warmControllers.delete(controller);
      if (entry && !requestSignal.aborted && generation === startedGeneration) remember(key, entry);
    }
  };
  await Promise.all([warm(), warm()]);
}
