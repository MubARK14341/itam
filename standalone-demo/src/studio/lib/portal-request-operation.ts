import { createClient } from "@/lib/supabase/client";
import {
  portalCreateRequestAtomic, portalGetRequest, portalSubmitRequest,
  type PortalCreateOperationResult, type PortalRequestBundle, type PortalRequestDetail,
} from "@/lib/portal";

interface PendingDraft { version: 1; operationId: string; fingerprint: string; id?: string }
export interface PortalDraftOperation {
  id: string | null;
  error: string | null;
  pending: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const markerKey = (actor: string) => `itam:portal-create:v1:${actor}`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function fingerprint(input: PortalRequestBundle) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(input)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface OperationSession { actorId: string; key: string; accessToken: string }
class ActorChanged extends Error {}

async function operationSession(expectedActorId?: string): Promise<OperationSession | null> {
  const { data, error } = await createClient().auth.getSession();
  const session = data.session;
  if (expectedActorId && session?.user.id !== expectedActorId) throw new ActorChanged();
  if (error || !session?.user.id || !session.access_token) return null;
  return { actorId: session.user.id, key: markerKey(session.user.id), accessToken: session.access_token };
}

async function requireSameActor(session: OperationSession) {
  const { data, error } = await createClient().auth.getSession();
  if (error || data.session?.user.id !== session.actorId) throw new ActorChanged();
}

function readMarker(key: string): PendingDraft | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("invalid_pending_operation");
  const marker = value as Partial<PendingDraft>;
  if (marker.version !== 1 || typeof marker.operationId !== "string" || !UUID.test(marker.operationId)
    || typeof marker.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(marker.fingerprint)
    || (marker.id !== undefined && (typeof marker.id !== "string" || !UUID.test(marker.id)))) {
    throw new Error("invalid_pending_operation");
  }
  return { version: 1, operationId: marker.operationId, fingerprint: marker.fingerprint, ...(marker.id ? { id: marker.id } : {}) };
}

function createdId(data: PortalCreateOperationResult | null): string | null {
  return data?.ok === true && typeof data.id === "string" && UUID.test(data.id)
    && data._operation?.type === "portal_create" && data._operation.target_id === data.id ? data.id : null;
}

const failed = (error: string, pending = true): PortalDraftOperation => ({ id: null, error, pending });

/** Persist only UUIDs and a digest. Never save project, contact, item or file data. */
export async function createPortalDraftOperation(input: PortalRequestBundle, expectedActorId?: string): Promise<PortalDraftOperation> {
  let session: OperationSession, key: string, marker: PendingDraft;
  try {
    const actor = await operationSession(expectedActorId);
    if (!actor) return failed("not_authorized", false);
    session = actor;
    key = actor.key;
    await requireSameActor(session);
    const digest = await fingerprint(input);
    await requireSameActor(session);
    const existing = readMarker(key);
    if (existing) {
      marker = existing;
      let id = existing.id;
      if (!id) {
        await requireSameActor(session);
        const lookup = await createClient().rpc("request_operation_result_lookup", { p_operation_id: marker.operationId })
          .setHeader("Authorization", `Bearer ${session.accessToken}`);
        await requireSameActor(session);
        if (!lookup.error && lookup.data != null) {
          id = createdId(lookup.data as PortalCreateOperationResult) ?? undefined;
          if (!id) return failed("operation_id_conflict");
          marker = { ...marker, id };
          sessionStorage.setItem(key, JSON.stringify(marker));
        }
      }
      if (id) return { id, error: marker.fingerprint === digest ? null : "operation_previous_completed", pending: false };
      if (marker.fingerprint !== digest) return failed("operation_pending");
    } else {
      marker = { version: 1, operationId: crypto.randomUUID(), fingerprint: digest };
      sessionStorage.setItem(key, JSON.stringify(marker));
    }
  } catch (error) {
    return failed(error instanceof ActorChanged ? "operation_actor_changed" : "operation_storage_unavailable");
  }

  try {
    await requireSameActor(session);
    const result = await portalCreateRequestAtomic(marker.operationId, input, session.accessToken);
    await requireSameActor(session);
    if (result.error) {
      return failed("operation_result_unknown");
    }
    const id = createdId(result.data);
    if (id) {
      sessionStorage.setItem(key, JSON.stringify({ ...marker, id }));
      return { id, error: null, pending: false };
    }
    if (result.data?.ok === false) {
      // Only SQL's post-lock validation signal proves earlier attempts did not
      // commit and this attempt rolled back. Auth/conflict/unknown retain recovery.
      if (result.data.definitive_rollback === true) {
        sessionStorage.removeItem(key);
        return failed(result.data.error ?? "failed", false);
      }
      return failed(result.data.error ?? "operation_result_unknown");
    }
    return failed("operation_result_unknown");
  } catch (error) {
    return failed(error instanceof ActorChanged ? "operation_actor_changed" : "operation_result_unknown");
  }
}

/** Reload recovery only reads. Without a form payload it can never issue a create. */
export async function recoverPortalDraftOperation(expectedActorId?: string): Promise<PortalDraftOperation> {
  try {
    const session = await operationSession(expectedActorId);
    if (!session) return failed("not_authorized", false);
    await requireSameActor(session);
    const key = session.key;
    const marker = readMarker(key);
    if (!marker) return { id: null, error: null, pending: false };
    let id = marker.id;
    if (!id) {
      await requireSameActor(session);
      const lookup = await createClient().rpc("request_operation_result_lookup", { p_operation_id: marker.operationId })
        .setHeader("Authorization", `Bearer ${session.accessToken}`);
      await requireSameActor(session);
      if (lookup.error || lookup.data == null) return failed("operation_result_unknown");
      id = createdId(lookup.data as PortalCreateOperationResult) ?? undefined;
      if (!id) return failed("operation_id_conflict");
    }
    await requireSameActor(session);
    const read = await portalGetRequest(id, session.accessToken);
    await requireSameActor(session);
    if (read.error || !read.data || read.data.request.id !== id) return failed(read.error ?? "not_found");
    sessionStorage.setItem(key, JSON.stringify({ ...marker, id }));
    return { id, error: null, pending: false };
  } catch (error) {
    return failed(error instanceof ActorChanged ? "operation_actor_changed" : "operation_storage_unavailable");
  }
}

/** Clear a recovered creation only after the exact owned request is visible. */
export async function acknowledgePortalDraft(id: string, expectedActorId?: string): Promise<void> {
  try {
    const session = await operationSession(expectedActorId);
    if (!session) return;
    await requireSameActor(session);
    if (readMarker(session.key)?.id === id) sessionStorage.removeItem(session.key);
  } catch { /* The marker remains recoverable when browser storage is unavailable. */ }
}

export function portalRequestWasSubmitted(data: PortalRequestDetail): boolean {
  return data.request.status !== "draft" || data.request.portal_approval_status !== "not_required";
}

/** A lost submit reply is reconciled from this same owned request, never from a new create. */
export async function submitPortalDraft(id: string, expectedActorId?: string): Promise<{ error: string | null; pendingPm: boolean; data: PortalRequestDetail | null }> {
  let error: string | null;
  let session: OperationSession;
  try {
    const current = await operationSession(expectedActorId);
    if (!current) return { error: "not_authorized", pendingPm: false, data: null };
    session = current;
    await requireSameActor(session);
  } catch (caught) {
    return { error: caught instanceof ActorChanged ? "operation_actor_changed" : "operation_result_unknown", pendingPm: false, data: null };
  }
  try {
    const result = await portalSubmitRequest(id, session.accessToken);
    await requireSameActor(session);
    if (!result.error) return { error: null, pendingPm: result.pendingPm, data: null };
    error = result.outcomeUnknown ? "operation_result_unknown" : result.error;
  } catch (caught) {
    if (caught instanceof ActorChanged) return { error: "operation_actor_changed", pendingPm: false, data: null };
    error = "operation_result_unknown";
  }
  try {
    await requireSameActor(session);
    const read = await portalGetRequest(id, session.accessToken);
    await requireSameActor(session);
    if (!read.error && read.data?.request.id === id) {
      if (portalRequestWasSubmitted(read.data)) return {
        error: null, pendingPm: read.data.request.portal_approval_status === "pending_project_manager", data: read.data,
      };
      return { error, pendingPm: false, data: read.data };
    }
  } catch (caught) {
    if (caught instanceof ActorChanged) return { error: "operation_actor_changed", pendingPm: false, data: null };
    // Unknown outcomes keep this same draft for another confirmation attempt.
  }
  return { error: "operation_result_unknown", pendingPm: false, data: null };
}
