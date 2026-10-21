export interface OperationalListRequestGate {
  generation: number;
  active: boolean;
  controller?: AbortController;
}

export function createOperationalListRequestGate(): OperationalListRequestGate {
  return { generation: 0, active: false };
}

/**
 * Starts a list request. Continuations fail closed without a known next page or
 * while any request is active. Resets may supersede older work after a filter
 * or mutation change.
 */
export function beginOperationalListRequest(
  gate: OperationalListRequestGate,
  reset: boolean,
  hasNextPage: boolean,
): number | null {
  if (!reset && (!hasNextPage || gate.active)) return null;
  gate.controller?.abort();
  gate.controller = new AbortController();
  gate.active = true;
  gate.generation += 1;
  return gate.generation;
}

/** The signal belongs to this generation only; stale work may never start another read. */
export function operationalListRequestSignal(gate: OperationalListRequestGate, generation: number): AbortSignal {
  return isCurrentOperationalListRequest(gate, generation) && gate.controller
    ? gate.controller.signal : AbortSignal.abort();
}

export function cancelOperationalListRequest(gate: OperationalListRequestGate): void {
  gate.controller?.abort();
  delete gate.controller;
  gate.active = false;
  gate.generation += 1;
}

export function isCurrentOperationalListRequest(
  gate: OperationalListRequestGate,
  generation: number,
): boolean {
  return gate.active && gate.generation === generation;
}

/** Returns false for stale work without clearing the newer active request. */
export function completeOperationalListRequest(
  gate: OperationalListRequestGate,
  generation: number,
): boolean {
  if (!isCurrentOperationalListRequest(gate, generation)) return false;
  gate.active = false;
  delete gate.controller;
  return true;
}
