export type Row = Record<string, unknown>;
export type DemoRole = "it_manager" | "employee" | "warehouse_manager" | "viewer" | "admin" | "technician" | "auditor";
export type DemoActor = { id: string; userId: string; role: DemoRole | null; portalRole?: "project_manager" | "authorized_requester" | "viewer"; customerId?: string; employeeId?: string; email: string; name: string; nameAr: string; capabilities: string[] };
export type DemoState = { version: 1; generation: number; revision: number; actorId: string | null; tables: Record<string, Row[]>; operations: Record<string, { fingerprint: string; result: unknown; actorId: string }>; blobs: Record<string, Blob>; mfa: Record<string, Row[]>; authScenario?: { actorId: string; status: "pending" | "rejected" | "approved" } };
export type OperationContext = { actor: DemoActor | null; generation: number; revision: number; authorizationFingerprint: string };
export class DemoError extends Error {
  constructor(public code: string, message: string, public status = 400, public details: string | null = null) { super(message); this.name = "DemoError"; }
}
export function object(value: unknown): Row { if (!value || typeof value !== "object" || Array.isArray(value)) throw new DemoError("22023", "invalid_input"); return value as Row; }
export function str(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
export function num(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
export function rows(state: DemoState, table: string): Row[] { const result = state.tables[table]; if (!result) throw new DemoError("DEMO_UNSUPPORTED_OPERATION", `Unsupported demo table: ${table}`, 404); return result; }
export function find(state: DemoState, table: string, id: unknown): Row { const row = rows(state, table).find(r => r.id === id); if (!row) throw new DemoError("P0002", `${table}_not_found`, 404); return row; }
export function uid(): string { return crypto.randomUUID(); }
export function now(): string { return new Date().toISOString(); }
export function quantity(value: unknown): number { const n = num(value, NaN); if (!Number.isSafeInteger(n) || n < 1) throw new DemoError("22023", "invalid_quantity"); return n; }
export function requireActor(ctx: OperationContext): DemoActor { if (!ctx.actor) throw new DemoError("42501", "no_session", 401); return ctx.actor; }
export function manager(ctx: OperationContext): DemoActor { const actor = requireActor(ctx); if (!actor.role || !["it_manager", "admin"].includes(actor.role)) throw new DemoError("42501", "not_authorized", 403); return actor; }
export function operator(ctx: OperationContext): DemoActor { const actor = requireActor(ctx); if (!actor.role || !["it_manager", "admin", "warehouse_manager", "technician"].includes(actor.role)) throw new DemoError("42501", "not_authorized", 403); return actor; }
export function staff(ctx: OperationContext): DemoActor { const actor = requireActor(ctx); if (!actor.role) throw new DemoError("42501", "staff_required", 403); return actor; }
export function portal(ctx: OperationContext, write = false): DemoActor { const actor = requireActor(ctx); if (!actor.portalRole || (write && actor.portalRole === "viewer")) throw new DemoError("42501", "not_authorized", 403); return actor; }
export function financial(ctx: OperationContext): boolean { return ctx.actor?.role === "admin" || ctx.actor?.role === "it_manager"; }
export function addEvent(state: DemoState, ctx: OperationContext, table: string, row: Row): Row { const event = { id: uid(), actor_id: ctx.actor?.userId ?? null, actor_kind: ctx.actor?.portalRole ? "portal" : "staff", created_at: now(), ...row }; rows(state, table).push(event); return event; }
export function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
export function idempotent(state: DemoState, ctx: OperationContext, operationId: unknown, operation: string, input: unknown, work: () => unknown): unknown {
  if (!operationId) return work();
  const actor = requireActor(ctx); const key = `${actor.userId}:${str(operationId)}`; const fingerprint = stableJson({ operation, input }); const prior = state.operations[key];
  if (prior) { if (prior.fingerprint !== fingerprint) throw new DemoError("22023", "operation_input_mismatch"); return structuredClone(prior.result); }
  const result = work(); state.operations[key] = { fingerprint, result: structuredClone(result), actorId: actor.userId }; return result;
}
