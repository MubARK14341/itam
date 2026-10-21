import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgePortalDraft, createPortalDraftOperation, recoverPortalDraftOperation, submitPortalDraft,
} from "./portal-request-operation";
import type { PortalRequestBundle } from "./portal";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), header: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  rpc: (name: string, params: unknown) => {
    const result = Promise.resolve(mocks.rpc(name, params));
    return Object.assign(result, { setHeader: (header: string, value: string) => {
      mocks.header(name, header, value);
      return result;
    } });
  },
  auth: { getSession: mocks.session },
}) }));

const actor = "11111111-1111-4111-8111-111111111111";
const anotherActor = "33333333-3333-4333-8333-333333333333";
const session = (id = actor) => ({ data: { session: { user: { id }, access_token: "TEST in-memory actor token" } }, error: null });
const id = "22222222-2222-4222-8222-222222222222";
const key = `itam:portal-create:v1:${actor}`;
const input: PortalRequestBundle = {
  project_name: "TEST private project", project_city: "Riyadh", contact_phone: null, contact_email: null,
  request_type: "rental", pickup_date: "2030-01-02", return_date: null, notes: "TEST private notes",
  items: [{ requested_kind: "custom", requested_description: "TEST private item", requested_category: null,
    quantity: 1, preferred_model: null, accept_alternative: false, needs_purchase: false,
    category_key: null, preferred_company_id: null }],
};
const created = { ok: true, id, _operation: { type: "portal_create", target_id: id, input_fingerprint: "server digest" } };
const lost = { code: "", message: "TEST connection lost" };
const detail = (status = "draft", approval = "not_required") => ({
  ok: true, creation_complete: true,
  request: { id, status, portal_approval_status: approval, can_submit_draft: true }, items: [], events: [],
});

describe("portal draft operation recovery", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    vi.resetAllMocks();
    stored = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => stored.set(name, value),
      removeItem: (name: string) => stored.delete(name),
    });
    mocks.session.mockResolvedValue(session());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates one atomic bundle and stores only identities and a digest", async () => {
    mocks.rpc.mockResolvedValue({ data: created, error: null });
    expect(await createPortalDraftOperation(input)).toEqual({ id, error: null, pending: false });
    expect(mocks.rpc).toHaveBeenCalledWith("portal_create_request_atomic", { p_operation_id: expect.any(String), p_input: input });
    const marker = JSON.parse(stored.get(key)!);
    expect(Object.keys(marker).sort()).toEqual(["fingerprint", "id", "operationId", "version"]);
    expect(marker.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.get(key)).not.toContain("TEST private");
    expect(stored.get(key)).not.toContain("pickup_date");
    expect(stored.get(key)).not.toContain("TEST in-memory actor token");
    expect(mocks.header).toHaveBeenCalledWith("portal_create_request_atomic", "Authorization", "Bearer TEST in-memory actor token");
  });

  it("recovers a lost create response without writing another bundle", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost }).mockResolvedValueOnce({ data: created, error: null });
    expect(await createPortalDraftOperation(input)).toMatchObject({ error: "operation_result_unknown", pending: true });
    const operation = JSON.parse(stored.get(key)!).operationId;
    expect(await createPortalDraftOperation(input)).toEqual({ id, error: null, pending: false });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["portal_create_request_atomic", "request_operation_result_lookup"]);
    expect(mocks.rpc.mock.calls[1][1]).toEqual({ p_operation_id: operation });
  });

  it("replays exactly the same UUID when an earlier commit is not yet visible", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: created, error: null });
    await createPortalDraftOperation(input);
    const operation = JSON.parse(stored.get(key)!).operationId;
    expect(await createPortalDraftOperation(input)).toMatchObject({ id, error: null });
    const writes = mocks.rpc.mock.calls.filter(([name]) => name === "portal_create_request_atomic");
    expect(writes).toHaveLength(2);
    expect(writes.every(([, params]) => params.p_operation_id === operation)).toBe(true);
  });

  it("shares one persisted operation across overlapping identical creates", async () => {
    let started!: () => void, release!: (value: unknown) => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let writes = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "request_operation_result_lookup") return { data: null, error: null };
      if (++writes === 1) { started(); return new Promise((resolve) => { release = resolve; }); }
      return { data: created, error: null };
    });
    const first = createPortalDraftOperation(input);
    await firstStarted;
    expect(await createPortalDraftOperation(input)).toMatchObject({ id, error: null });
    release({ data: created, error: null });
    expect(await first).toMatchObject({ id, error: null });
    const operations = mocks.rpc.mock.calls.filter(([name]) => name === "portal_create_request_atomic")
      .map(([, params]) => params.p_operation_id);
    expect(operations).toHaveLength(2);
    expect(new Set(operations).size).toBe(1);
  });

  it("blocks changed input while the earlier request remains unconfirmed", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost }).mockResolvedValueOnce({ data: null, error: null });
    await createPortalDraftOperation(input);
    const marker = stored.get(key);
    expect(await createPortalDraftOperation({ ...input, notes: "different" })).toMatchObject({ error: "operation_pending" });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(stored.get(key)).toBe(marker);
  });

  it("returns the previous draft instead of applying changed form data", async () => {
    mocks.rpc.mockResolvedValue({ data: created, error: null });
    await createPortalDraftOperation(input);
    expect(await createPortalDraftOperation({ ...input, items: [{ ...input.items[0], quantity: 2 }] }))
      .toEqual({ id, error: "operation_previous_completed", pending: false });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("scopes the pending draft to the current authenticated actor", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost }).mockResolvedValueOnce({ data: created, error: null });
    await createPortalDraftOperation(input);
    mocks.session.mockResolvedValue(session(anotherActor));
    expect(await createPortalDraftOperation(input)).toMatchObject({ id, error: null });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["portal_create_request_atomic", "portal_create_request_atomic"]);
    expect(stored.has(key)).toBe(true);
  });

  it("rejects a caller whose expected form actor differs before any marker or RPC", async () => {
    expect(await createPortalDraftOperation(input, anotherActor)).toMatchObject({ error: "operation_actor_changed" });
    expect(stored.size).toBe(0); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rechecks the actor after fingerprinting before creating a marker or RPC", async () => {
    mocks.session.mockResolvedValueOnce(session()).mockResolvedValueOnce(session()).mockResolvedValue(session(anotherActor));
    expect(await createPortalDraftOperation(input, actor)).toMatchObject({ error: "operation_actor_changed" });
    expect(stored.size).toBe(0); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("pins a create to the original token and discards its result after an account switch", async () => {
    mocks.rpc.mockImplementationOnce(() => { mocks.session.mockResolvedValue(session(anotherActor)); return { data: created, error: null }; });
    expect(await createPortalDraftOperation(input, actor)).toMatchObject({ id: null, error: "operation_actor_changed", pending: true });
    expect(mocks.header).toHaveBeenCalledWith("portal_create_request_atomic", "Authorization", "Bearer TEST in-memory actor token");
    expect(JSON.parse(stored.get(key)!)).not.toHaveProperty("id");
    expect(stored.has(`itam:portal-create:v1:${anotherActor}`)).toBe(false);
  });

  it("does not store a looked-up id or read details after the operation actor changes", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost });
    await createPortalDraftOperation(input, actor);
    const marker = stored.get(key);
    mocks.rpc.mockImplementationOnce(() => { mocks.session.mockResolvedValue(session(anotherActor)); return { data: created, error: null }; });
    expect(await recoverPortalDraftOperation(actor)).toMatchObject({ id: null, error: "operation_actor_changed" });
    expect(stored.get(key)).toBe(marker);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["portal_create_request_atomic", "request_operation_result_lookup"]);
  });

  it("discards a known draft read if the original actor changes during recovery", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: created, error: null });
    await createPortalDraftOperation(input, actor);
    const marker = stored.get(key);
    mocks.rpc.mockImplementationOnce(() => { mocks.session.mockResolvedValue(session(anotherActor)); return { data: detail(), error: null }; });
    expect(await recoverPortalDraftOperation(actor)).toMatchObject({ id: null, error: "operation_actor_changed" });
    expect(stored.get(key)).toBe(marker);
    expect(mocks.header).toHaveBeenCalledWith("portal_get_request", "Authorization", "Bearer TEST in-memory actor token");
  });

  it("allows correction after a definitively rolled back first bundle", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, error: "invalid_quantity", definitive_rollback: true }, error: null });
    expect(await createPortalDraftOperation(input)).toEqual({ id: null, error: "invalid_quantity", pending: false });
    expect(stored.size).toBe(0);
    mocks.rpc.mockResolvedValueOnce({ data: created, error: null });
    expect(await createPortalDraftOperation(input)).toMatchObject({ id, error: null });
  });

  it("releases a lost rejected attempt only after SQL proves rollback, then uses a new corrected operation", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { ok: false, error: "invalid_quantity", definitive_rollback: true }, error: null });
    expect(await createPortalDraftOperation(input)).toMatchObject({ pending: true });
    const operation = JSON.parse(stored.get(key)!).operationId;
    expect(await createPortalDraftOperation(input)).toEqual({ id: null, error: "invalid_quantity", pending: false });
    expect(stored.size).toBe(0);
    mocks.rpc.mockResolvedValueOnce({ data: created, error: null });
    expect(await createPortalDraftOperation({ ...input, items: [{ ...input.items[0], quantity: 2 }] }))
      .toEqual({ id, error: null, pending: false });
    const operations = mocks.rpc.mock.calls.filter(([name]) => name === "portal_create_request_atomic")
      .map(([, params]) => params.p_operation_id);
    expect(operations.slice(0, 2)).toEqual([operation, operation]);
    expect(operations[2]).not.toBe(operation);
  });

  for (const flag of [undefined, false, "true", 1]) {
    it(`retains recovery when a validation denial lacks strict SQL proof (${String(flag)})`, async () => {
      mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: { ok: false, error: "invalid_quantity", definitive_rollback: flag }, error: null });
      await createPortalDraftOperation(input);
      const marker = stored.get(key);
      expect(await createPortalDraftOperation(input)).toMatchObject({ error: "invalid_quantity", pending: true });
      expect(stored.get(key)).toBe(marker);
    });
  }

  it("does not forget a possibly committed operation when a replay is denied", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: null, error: { code: "42501", message: "not_authorized" } })
      .mockResolvedValueOnce({ data: { ok: false, error: "not_authorized" }, error: null });
    await createPortalDraftOperation(input);
    const marker = stored.get(key);
    expect(await createPortalDraftOperation(input)).toMatchObject({ error: "not_authorized", pending: true });
    expect(stored.get(key)).toBe(marker);
  });

  it("recovers after reload using only an actor lookup and an owned request read", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: created, error: null }).mockResolvedValueOnce({ data: detail(), error: null });
    await createPortalDraftOperation(input);
    expect(await recoverPortalDraftOperation()).toEqual({ id, error: null, pending: false });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "portal_create_request_atomic", "request_operation_result_lookup", "portal_get_request",
    ]);
  });

  it("keeps the marker when the saved request is no longer readable", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: created, error: null })
      .mockResolvedValueOnce({ data: { ok: false, error: "not_found" }, error: null });
    await createPortalDraftOperation(input);
    const marker = stored.get(key);
    expect(await recoverPortalDraftOperation()).toMatchObject({ id: null, error: "not_found", pending: true });
    expect(stored.get(key)).toBe(marker);
  });

  it("clears the marker only for the acknowledged request", async () => {
    mocks.rpc.mockResolvedValue({ data: created, error: null });
    await createPortalDraftOperation(input);
    await acknowledgePortalDraft(actor);
    expect(stored.has(key)).toBe(true);
    await acknowledgePortalDraft(id);
    expect(stored.has(key)).toBe(false);
  });

  it("rejects another operation kind and malformed browser markers without a new write", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: { ...created, _operation: { type: "purchase_receipt", target_id: id } }, error: null });
    await createPortalDraftOperation(input);
    expect(await recoverPortalDraftOperation()).toMatchObject({ error: "operation_id_conflict" });
    stored.set(key, JSON.stringify({ version: 1, operationId: "not-a-uuid", fingerprint: "bad" }));
    expect(await createPortalDraftOperation(input)).toMatchObject({ error: "operation_storage_unavailable" });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("refuses to write when browser storage or the session is unavailable", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("TEST disabled storage"); } });
    expect(await createPortalDraftOperation(input)).toMatchObject({ error: "operation_storage_unavailable" });
    mocks.session.mockResolvedValue({ data: { session: null }, error: null });
    expect(await createPortalDraftOperation(input)).toMatchObject({ error: "not_authorized" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("portal submit reconciliation", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.session.mockResolvedValue(session()); });

  it("pins submission to the form actor and never accepts a new actor's state", async () => {
    mocks.rpc.mockImplementationOnce(() => { mocks.session.mockResolvedValue(session(anotherActor)); return { data: { ok: true }, error: null }; });
    expect(await submitPortalDraft(id, actor)).toEqual({ error: "operation_actor_changed", pendingPm: false, data: null });
    expect(mocks.header).toHaveBeenCalledWith("portal_submit_request", "Authorization", "Bearer TEST in-memory actor token");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("discards a submit reconciliation read when its operation actor changes", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockImplementationOnce(() => { mocks.session.mockResolvedValue(session(anotherActor)); return { data: detail("under_review"), error: null }; });
    expect(await submitPortalDraft(id, actor)).toEqual({ error: "operation_actor_changed", pendingPm: false, data: null });
    expect(mocks.header).toHaveBeenCalledWith("portal_get_request", "Authorization", "Bearer TEST in-memory actor token");
  });

  it("acknowledges a lost send response from the same pending-PM request", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: detail("draft", "pending_project_manager"), error: null });
    expect(await submitPortalDraft(id)).toMatchObject({ error: null, pendingPm: true });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["portal_submit_request", "portal_get_request"]);
    expect(mocks.rpc.mock.calls.every(([, params]) => params.p_request_id === id)).toBe(true);
  });

  it("retains a draft and the actual validation error when sending did not commit", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, error: "availability_unavailable" }, error: null })
      .mockResolvedValueOnce({ data: detail(), error: null });
    expect(await submitPortalDraft(id)).toMatchObject({ error: "availability_unavailable", pendingPm: false });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps a transport failure unconfirmed even if the first reread still shows draft", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: detail(), error: null });
    expect(await submitPortalDraft(id)).toMatchObject({ error: "operation_result_unknown", pendingPm: false });
  });

  it("does not claim submission from an unreadable or different request", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: lost })
      .mockResolvedValueOnce({ data: { ...detail("under_review"), request: { ...detail().request, id: actor } }, error: null });
    expect(await submitPortalDraft(id)).toMatchObject({ error: "operation_result_unknown" });
  });

  it("returns the actual pending-PM result without an unnecessary read", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true, pending_pm: true }, error: null });
    expect(await submitPortalDraft(id)).toEqual({ error: null, pendingPm: true, data: null });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
