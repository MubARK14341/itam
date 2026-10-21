// Compatibility boundary for a legacy NOT NULL database column.
// This value is not a product-facing request classification and must never drive UI,
// reporting, availability, or fulfilment behaviour.
export const LEGACY_REQUEST_TYPE = "rental" as const;

export function legacyRequestTypeForInsert(): typeof LEGACY_REQUEST_TYPE {
  return LEGACY_REQUEST_TYPE;
}
