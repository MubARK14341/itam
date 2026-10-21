import { describe, expect, it } from "vitest";
import {
  beginOperationalListRequest,
  completeOperationalListRequest,
  createOperationalListRequestGate,
  isCurrentOperationalListRequest,
  cancelOperationalListRequest,
  operationalListRequestSignal,
} from "./operational-list-request-gate";

describe("operational list request gate", () => {
  it("rejects overlapping continuations synchronously", () => {
    const gate = createOperationalListRequestGate();
    const first = beginOperationalListRequest(gate, false, true);

    expect(first).toBe(1);
    expect(beginOperationalListRequest(gate, false, true)).toBeNull();
    expect(completeOperationalListRequest(gate, first!)).toBe(true);
    expect(completeOperationalListRequest(gate, first!)).toBe(false);
    expect(beginOperationalListRequest(gate, false, true)).toBe(2);
  });

  it("rejects continuation when no next page is positively identified", () => {
    const gate = createOperationalListRequestGate();

    expect(beginOperationalListRequest(gate, false, false)).toBeNull();
    expect(gate).toEqual({ generation: 0, active: false });
  });

  it("allows a reset to supersede active work", () => {
    const gate = createOperationalListRequestGate();
    const continuation = beginOperationalListRequest(gate, false, true)!;
    const reset = beginOperationalListRequest(gate, true, false)!;

    expect(reset).toBeGreaterThan(continuation);
    expect(isCurrentOperationalListRequest(gate, continuation)).toBe(false);
    expect(isCurrentOperationalListRequest(gate, reset)).toBe(true);
  });

  it("does not let stale completion unlock a newer request", () => {
    const gate = createOperationalListRequestGate();
    const first = beginOperationalListRequest(gate, true, false)!;
    const second = beginOperationalListRequest(gate, true, false)!;

    expect(completeOperationalListRequest(gate, first)).toBe(false);
    expect(beginOperationalListRequest(gate, false, true)).toBeNull();
    expect(completeOperationalListRequest(gate, second)).toBe(true);
    expect(beginOperationalListRequest(gate, false, true)).toBe(3);
  });

  it("aborts superseded reads and gives the new generation a live signal", () => {
    const gate = createOperationalListRequestGate();
    const first = beginOperationalListRequest(gate, true, false)!;
    const firstSignal = operationalListRequestSignal(gate, first);
    const second = beginOperationalListRequest(gate, true, false)!;
    expect(firstSignal.aborted).toBe(true);
    expect(operationalListRequestSignal(gate, first).aborted).toBe(true);
    expect(operationalListRequestSignal(gate, second).aborted).toBe(false);
    expect(completeOperationalListRequest(gate, first)).toBe(false);
  });

  it("cancels work on filter cleanup/unmount and rejects its later completion", () => {
    const gate = createOperationalListRequestGate();
    const first = beginOperationalListRequest(gate, true, false)!;
    const signal = operationalListRequestSignal(gate, first);
    cancelOperationalListRequest(gate);
    expect(signal.aborted).toBe(true);
    expect(completeOperationalListRequest(gate, first)).toBe(false);
    expect(gate.active).toBe(false);
  });
});
