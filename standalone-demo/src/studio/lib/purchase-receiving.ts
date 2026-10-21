export type ReceiptValidationError =
  | "bad_qty"
  | "already_received"
  | "quantity_exceeds_remaining";

export interface ReceiptValidation {
  quantity: number | null;
  remaining: number;
  error: ReceiptValidationError | null;
}

export function validateReceiptQuantity(
  raw: string | number,
  requestedQuantity: number,
  receivedQuantity: number,
): ReceiptValidation {
  const requested = Number(requestedQuantity);
  const received = Number(receivedQuantity);
  const quantity = typeof raw === "number"
    ? raw
    : raw.trim() === ""
      ? Number.NaN
      : Number(raw);
  const remaining = requested - received;

  if (
    !Number.isFinite(requested)
    || !Number.isInteger(requested)
    || requested <= 0
    || !Number.isFinite(received)
    || !Number.isInteger(received)
    || received < 0
    || remaining <= 0
  ) {
    return { quantity: null, remaining: Math.max(remaining, 0), error: "already_received" };
  }
  if (
    !Number.isFinite(quantity)
    || !Number.isInteger(quantity)
    || quantity <= 0
    || quantity > 1_000_000
  ) {
    return { quantity: null, remaining, error: "bad_qty" };
  }
  if (quantity > remaining) {
    return { quantity: null, remaining, error: "quantity_exceeds_remaining" };
  }
  return { quantity, remaining, error: null };
}
