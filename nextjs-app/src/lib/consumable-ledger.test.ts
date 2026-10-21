import { describe, expect, it } from "vitest";
import { beginConsumableLedgerRead, canExportConsumableLedger, completeConsumableLedgerRead,
  CONSUMABLE_LEDGER_DISPLAY_PAGE, type ConsumableLedgerState } from "./consumable-ledger";
import { beginOperationalListRequest, cancelOperationalListRequest, completeOperationalListRequest,
  createOperationalListRequestGate } from "./operational-list-request-gate";

const rows = Array.from({ length: 1251 }, (_, index) => ({ id: String(index), cost: index === 0 ? 0 : null }));
const loaded = (): ConsumableLedgerState<typeof rows[number]> => ({ scope: "TEST-admin|consumable1", rows, complete: true, loading: false, error: null });

describe("ledger completeness and identity boundary", () => {
  it("keeps a complete1251-row collection for CSV while only200 rows initially render", () => {
    const state = loaded();
    expect(CONSUMABLE_LEDGER_DISPLAY_PAGE).toBe(200);
    expect(state.rows.slice(0, CONSUMABLE_LEDGER_DISPLAY_PAGE)).toHaveLength(200);
    expect(state.rows).toHaveLength(1251);
    expect(canExportConsumableLedger(state, state.scope)).toBe(true);
  });
  it("retains priorrows after a failed retry, blocks export, and restores completeness only after success", () => {
    const state = loaded(), retry = beginConsumableLedgerRead(state, state.scope);
    expect(retry.rows).toBe(rows); expect(canExportConsumableLedger(retry, state.scope)).toBe(false);
    const failed = completeConsumableLedgerRead(retry, state.scope, { rows: [], error: "TEST last page failed" });
    expect(failed.rows).toBe(rows); expect(failed.complete).toBe(false);
    expect(canExportConsumableLedger(failed, state.scope)).toBe(false);
    expect(canExportConsumableLedger(completeConsumableLedgerRead(failed, state.scope, { rows, error: null }), state.scope)).toBe(true);
  });
  it("clears rows across users, roles and consumables and ignores an oldscope completion", () => {
    const old = loaded();
    for (const scope of ["TEST-viewer|consumable1", "TEST-other-admin|consumable1", "TEST-admin|consumable2"]) {
      const changed = beginConsumableLedgerRead(old, scope);
      expect(changed.rows).toEqual([]); expect(canExportConsumableLedger(old, scope)).toBe(false);
      expect(completeConsumableLedgerRead(changed, old.scope, { rows, error: null })).toBe(changed);
    }
  });
  it("treats a provider's empty error message as failure, retaining priorrows without export", () => {
    const previous = loaded(), state = completeConsumableLedgerRead(previous, previous.scope, { rows: [], error: "" });
    expect(state.rows).toBe(rows); expect(state.error).toBe("consumable_history_failed");
    expect(state.complete).toBe(false); expect(canExportConsumableLedger(state, previous.scope)).toBe(false);
  });
  it("rejects late same-scope work after a newer retry or cleanup", () => {
    const gate = createOperationalListRequestGate();
    const first = beginOperationalListRequest(gate, true, true)!;
    const current = beginOperationalListRequest(gate, true, true)!;
    expect(completeOperationalListRequest(gate, first)).toBe(false);
    expect(completeOperationalListRequest(gate, current)).toBe(true);
    const departing = beginOperationalListRequest(gate, true, true)!;
    cancelOperationalListRequest(gate);
    expect(completeOperationalListRequest(gate, departing)).toBe(false);
  });
});
