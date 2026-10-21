// Asset Pools are an immature internal data dimension, not the department field.
// The product owner explicitly keeps their UI hidden while preserving pool_id on
// existing records and save payloads so historic data is never erased implicitly.
export const ASSET_POOLS_UI_VISIBLE = false;
