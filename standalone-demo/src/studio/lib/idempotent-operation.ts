import { createClient } from "@/lib/supabase/client";
import { reportOperationalFailure } from "@/lib/observability";

type OperationType = "purchase_receipt" | "consumable_stock_move";
interface PendingOperation { version: 1; operationId: string; fingerprint: string }
interface OperationResult {
  ok?: boolean;
  error?: string;
  _operation?: { type?: string; target_id?: string };
}

function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalInput(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function fingerprintOf(params: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalInput(params));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function completed(result: OperationResult | null, type: OperationType, targetId: string): boolean {
  return result?.ok === true
    && result._operation?.type === type
    && result._operation.target_id === targetId;
}

/** A received header can hide its receipt control after a lost response.
 * Confirm only actor-scoped pending results while refreshing its item list. */
export async function recoverCompletedOperations(type: OperationType, targetIds: string[]): Promise<string[]> {
  const recovered: string[] = [];
  try {
    const sb = createClient();
    const { data, error } = await sb.auth.getSession();
    const actorId = data.session?.user.id;
    if (error || !actorId) return recovered;
    for (const targetId of targetIds) {
      const key = `itam:pending-operation:v1:${actorId}:${type}:${targetId}`;
      const stored = sessionStorage.getItem(key);
      if (!stored) continue;
      const pending = JSON.parse(stored) as Partial<PendingOperation>;
      if (pending.version !== 1 || typeof pending.operationId !== "string") continue;
      const previous = await sb.rpc("request_operation_result_lookup", { p_operation_id: pending.operationId });
      if (!previous.error && completed(previous.data as OperationResult | null, type, targetId)) {
        sessionStorage.removeItem(key);
        recovered.push(targetId);
      }
    }
  } catch (error) {
    reportOperationalFailure("operation_recovery_failed", error);
  }
  return recovered;
}

/**
 * Persist only UUIDs and a digest, never form, invoice, credential or cost data.
 * A transport failure retains the same operation across retries, modal closure
 * and page reload. The existing lookup is scoped to auth.uid() in PostgreSQL.
 */
export async function executeIdempotentMutation(input: {
  type: OperationType;
  targetId: string;
  rpcName: "purchase_request_item_receive_idempotent" | "consumable_stock_move_idempotent";
  params: Record<string, unknown>;
  operationId?: string;
}): Promise<string | null> {
  const sb = createClient();
  let key: string;
  let pending: PendingOperation;
  try {
    const { data, error } = await sb.auth.getSession();
    const actorId = data.session?.user.id;
    if (error || !actorId) return "not_authorized";
    key = `itam:pending-operation:v1:${actorId}:${input.type}:${input.targetId}`;
    const fingerprint = await fingerprintOf(input.params);
    const stored = sessionStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<PendingOperation>;
      if (parsed.version !== 1 || typeof parsed.operationId !== "string"
        || typeof parsed.fingerprint !== "string") return "operation_pending";
      pending = parsed as PendingOperation;
      const previous = await sb.rpc("request_operation_result_lookup", { p_operation_id: pending.operationId });
      if (!previous.error && previous.data != null) {
        const result = previous.data as OperationResult;
        if (!completed(result, input.type, input.targetId)) return "operation_id_conflict";
        sessionStorage.removeItem(key);
        // A lost response is already committed. A retry acknowledges that
        // operation rather than creating another movement or receipt.
        return pending.fingerprint === fingerprint ? null : "operation_previous_completed";
      } else if (pending.fingerprint !== fingerprint) {
        // Do not replace the identity of a still-unconfirmed operation.
        return "operation_pending";
      } else {
        // Re-submit the exact same UUID; the DB lock handles a request which
        // may still be running when lookup found no committed result yet.
        return await submit(sb, input, key, pending);
      }
    }
    pending = { version: 1, operationId: input.operationId ?? crypto.randomUUID(), fingerprint };
    sessionStorage.setItem(key, JSON.stringify(pending));
  } catch (error) {
    reportOperationalFailure("operation_storage_or_session_failed", error);
    return "operation_storage_unavailable";
  }
  return submit(sb, input, key, pending);
}

async function submit(
  sb: ReturnType<typeof createClient>,
  input: Parameters<typeof executeIdempotentMutation>[0],
  key: string,
  pending: PendingOperation,
): Promise<string | null> {
  try {
    const { data, error } = await sb.rpc(input.rpcName, {
      ...input.params, p_operation_id: pending.operationId,
    });
    if (error) {
      reportOperationalFailure("idempotent_mutation_failed", error);
      // A SQL exception rolls the transaction back. Gateway/connection failures
      // can hide a commit, so they must retain the operation and be retried.
      if (/^[0-9A-Z]{5}$/.test(error.code ?? "")) {
        sessionStorage.removeItem(key);
        return error.message;
      }
      return "operation_result_unknown";
    }
    const result = data as OperationResult | null;
    if (completed(result, input.type, input.targetId)) {
      sessionStorage.removeItem(key);
      return null;
    }
    if (result?.ok === false) {
      if (result.error !== "operation_id_conflict") sessionStorage.removeItem(key);
      return result.error ?? "failed";
    }
    return "operation_result_unknown";
  } catch (error) {
    reportOperationalFailure("idempotent_mutation_transport_failed", error);
    return "operation_result_unknown";
  }
}
