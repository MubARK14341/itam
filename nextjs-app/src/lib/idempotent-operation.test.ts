import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeIdempotentMutation, recoverCompletedOperations } from "./idempotent-operation";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  rpc: mocks.rpc, auth: { getSession: mocks.session },
}) }));

const actor = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const operation = "33333333-3333-4333-8333-333333333333";
const key = `itam:pending-operation:v1:${actor}:consumable_stock_move:${target}`;
const input = {
  type: "consumable_stock_move" as const, targetId: target,
  rpcName: "consumable_stock_move_idempotent" as const,
  params: { p_consumable_id: target, p_type: "in", p_quantity: 2, p_unit_cost: 31, p_invoice_number: "TEST private invoice" },
  operationId: operation,
};
const result = { ok: true, balance_after: 2, _operation: { type: input.type, target_id: target } };
const transportError = { code: "", message: "TEST response lost" };

describe("durable receipt and stock operation retries", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    vi.resetAllMocks();
    stored = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => stored.set(name, value),
      removeItem: (name: string) => stored.delete(name),
    });
    mocks.session.mockResolvedValue({ data: { session: { user: { id: actor } } }, error: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("acknowledges a committed movement after a lost response without another write", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError })
      .mockResolvedValueOnce({ data: result, error: null });
    expect(await executeIdempotentMutation(input)).toBe("operation_result_unknown");
    expect(stored.has(key)).toBe(true);
    expect(await executeIdempotentMutation({ ...input, operationId: crypto.randomUUID() })).toBeNull();
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([input.rpcName, "request_operation_result_lookup"]);
    expect(mocks.rpc.mock.calls[1][1]).toEqual({ p_operation_id: operation });
    expect(stored.size).toBe(0);
  });

  it("resubmits the same UUID if lookup cannot yet see a committed result", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: result, error: null });
    await executeIdempotentMutation(input);
    expect(await executeIdempotentMutation({ ...input, operationId: crypto.randomUUID() })).toBeNull();
    const writes = mocks.rpc.mock.calls.filter(([name]) => name === input.rpcName);
    expect(writes).toHaveLength(2);
    expect(writes.every(([, params]) => params.p_operation_id === operation)).toBe(true);
  });

  it("blocks changed inputs while an earlier outcome is unconfirmed", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError })
      .mockResolvedValueOnce({ data: null, error: transportError });
    await executeIdempotentMutation(input);
    const pending = stored.get(key);
    expect(await executeIdempotentMutation({ ...input, params: { ...input.params, p_quantity: 4 } })).toBe("operation_pending");
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(stored.get(key)).toBe(pending);
  });

  it("reports that changed inputs were not written after recovering an earlier commit", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError })
      .mockResolvedValueOnce({ data: result, error: null });
    await executeIdempotentMutation(input);
    expect(await executeIdempotentMutation({ ...input, params: { ...input.params, p_quantity: 4 } })).toBe("operation_previous_completed");
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });

  it("stores only the operation identity and digest, without financial form data", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError });
    await executeIdempotentMutation(input);
    const marker = JSON.parse(stored.get(key)!);
    expect(Object.keys(marker).sort()).toEqual(["fingerprint", "operationId", "version"]);
    expect(marker.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.get(key)).not.toContain("invoice");
    expect(stored.get(key)).not.toContain("unit_cost");
    expect(console.warn).toHaveBeenCalledWith("idempotent_mutation_failed", { kind: "object", code: "" });
  });

  it("does not acknowledge another target or operation kind", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError })
      .mockResolvedValueOnce({ data: { ...result, _operation: { type: "purchase_receipt", target_id: target } }, error: null });
    await executeIdempotentMutation(input);
    expect(await executeIdempotentMutation(input)).toBe("operation_id_conflict");
    expect(stored.has(key)).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("scopes pending operations by the current authenticated actor", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError })
      .mockResolvedValueOnce({ data: result, error: null });
    await executeIdempotentMutation(input);
    mocks.session.mockResolvedValue({ data: { session: { user: { id: "another-actor" } } }, error: null });
    expect(await executeIdempotentMutation(input)).toBeNull();
    expect(mocks.rpc.mock.calls.every(([name]) => name === input.rpcName)).toBe(true);
    expect(stored.has(key)).toBe(true);
  });

  it("clears a definitively rolled-back SQL failure so corrected input can be submitted", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "23514", message: "insufficient_stock" } });
    expect(await executeIdempotentMutation(input)).toBe("insufficient_stock");
    expect(stored.size).toBe(0);
  });

  it("retains the marker when a successful-looking result lacks matching metadata", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
    expect(await executeIdempotentMutation(input)).toBe("operation_result_unknown");
    expect(stored.has(key)).toBe(true);
  });

  it("fails closed before a write when storage or the authenticated session is unavailable", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("TEST disabled storage"); } });
    expect(await executeIdempotentMutation(input)).toBe("operation_storage_unavailable");
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue({ data: { session: null }, error: null });
    expect(await executeIdempotentMutation(input)).toBe("not_authorized");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("recovers a receipt hidden by its now-received header without initiating any write", async () => {
    const receipt = { ...input, type: "purchase_receipt" as const, rpcName: "purchase_request_item_receive_idempotent" as const, params: { p_item_id: target, p_qty: 2 } };
    mocks.rpc.mockResolvedValueOnce({ data: null, error: transportError })
      .mockResolvedValueOnce({ data: { ok: true, _operation: { type: "purchase_receipt", target_id: target } }, error: null });
    await executeIdempotentMutation(receipt);
    expect(await recoverCompletedOperations("purchase_receipt", [target, "no-pending-operation"])).toEqual([target]);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([receipt.rpcName, "request_operation_result_lookup"]);
    expect(stored.size).toBe(0);
  });
});
