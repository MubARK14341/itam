export const CONSUMABLE_LEDGER_DISPLAY_PAGE = 200;

export interface ConsumableLedgerState<T> {
  scope: string;
  rows: T[];
  loading: boolean;
  complete: boolean;
  error: string | null;
}

/** Prior complete rows may remain visible on retry, but cannot be exported as current evidence. */
export function beginConsumableLedgerRead<T>(previous: ConsumableLedgerState<T>, scope: string): ConsumableLedgerState<T> {
  return { scope, rows: previous.scope === scope ? previous.rows : [], loading: true, complete: false, error: null };
}

export function completeConsumableLedgerRead<T>(
  previous: ConsumableLedgerState<T>, scope: string, result: { rows: T[]; error: string | null },
): ConsumableLedgerState<T> {
  if (previous.scope !== scope) return previous;
  return result.error !== null
    ? { ...previous, loading: false, complete: false, error: result.error || "consumable_history_failed" }
    : { scope, rows: result.rows, loading: false, complete: true, error: null };
}

export function canExportConsumableLedger<T>(state: ConsumableLedgerState<T>, scope: string): boolean {
  return state.scope === scope && state.complete && !state.loading && state.error === null;
}
