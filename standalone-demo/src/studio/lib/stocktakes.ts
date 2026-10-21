import { createClient } from "@/lib/supabase/client";

export type StocktakeSession = {
  id: string;
  code: string;
  title: string;
  location_id: string;
  location_name?: string | null;
  status: "draft" | "in_progress" | "completed" | "cancelled";
  review_state: "counting" | "recount" | "submitted" | "approved" | "rejected";
  snapshot_at: string;
  started_at?: string | null;
  submitted_at?: string | null;
  completed_at?: string | null;
  expected_count: number;
  observed_count: number;
  variance_count: number;
  blind_count?: boolean;
  correction_of?: string | null;
  created_by?: string | null;
  reviewed_by?: string | null;
  scope_kind?: "full" | "partial";
  scope_category_id?: string | null;
  scope_label?: string | null;
};

export type StocktakeItem = {
  id: string;
  asset_id: string;
  asset_tag: string;
  asset_name: string;
  is_expected: boolean;
  scanned: boolean;
  classification: "found" | "missing" | "unexpected" | "wrong_location" | null;
  count_round: number;
  recount_required: boolean;
  variance_reason: string | null;
  adjustment_applied: boolean;
  observed_at: string | null;
  review_decision?: "approve_correction" | "keep_current" | "request_recheck" | null;
  review_note?: string | null;
};

export type StocktakeDetail = {
  session: StocktakeSession;
  items: StocktakeItem[];
  events: Array<{
    event_type: string;
    actor_id: string | null;
    item_id: string | null;
    reason: string | null;
    created_at: string;
  }>;
};

type RpcResult = {
  ok: boolean;
  id?: string;
  code?: string;
  expected_count?: number;
  observed_count?: number;
  variance_count?: number;
  item_id?: string;
  classification?: string;
  count_round?: number;
  adjustments_applied?: number;
};

export function newOperationId() {
  return crypto.randomUUID();
}

export async function listStocktakes() {
  const { data, error } = await createClient().rpc("stocktake_list");
  return {
    rows: (Array.isArray(data) ? data : []) as unknown as StocktakeSession[],
    error,
  };
}

export async function getStocktakeDetail(id: string) {
  const { data, error } = await createClient().rpc("stocktake_detail", {
    p_stocktake_id: id,
  });
  return { detail: data as unknown as StocktakeDetail | null, error };
}

export async function listStocktakeLocations() {
  const { data, error } = await createClient()
    .from("locations")
    .select("id,name")
    .eq("is_active", true)
    .order("name");
  return { rows: data ?? [], error };
}

export interface SystemInventoryReport {
  registered: number;
  available: number;
  reserved: number;
  delivered: number;
  inMaintenance: number;
  dataIssues: number;
}

// A read-only report only: it never creates a stocktake, changes an asset, or
// presents itself as field-count evidence.
export async function getSystemInventoryReport(locationId: string): Promise<{
  report: SystemInventoryReport | null;
  error: unknown;
}> {
  const { data, error } = await createClient()
    .rpc("stocktake_system_inventory_report", { p_location_id: locationId });
  return {
    report: error || !data ? null : data as unknown as SystemInventoryReport,
    error,
  };
}

export async function createStocktake(
  title: string,
  locationId: string,
  correctionOf: string | null = null,
  scopeKind: "full" | "partial" = "full",
  scopeCategoryId: string | null = null,
) {
  const { data, error } = await createClient().rpc("stocktake_create", {
    p_title: title,
    p_location_id: locationId,
    p_operation_id: newOperationId(),
    p_correction_of: correctionOf,
    p_scope_kind: scopeKind,
    p_scope_category_id: scopeCategoryId,
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function decideStocktakeItem(
  stocktakeId: string,
  itemId: string,
  decision: "approve_correction" | "keep_current" | "request_recheck",
  note: string,
) {
  const { data, error } = await createClient().rpc("stocktake_decide_item", {
    p_stocktake_id: stocktakeId,
    p_item_id: itemId,
    p_decision: decision,
    p_note: note,
    p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function startStocktake(id: string) {
  const { data, error } = await createClient().rpc("stocktake_start", {
    p_stocktake_id: id,
    p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function scanStocktakeAsset(id: string, identifier: string) {
  const { data, error } = await createClient().rpc("stocktake_scan", {
    p_stocktake_id: id,
    p_identifier: identifier,
    p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function submitStocktake(id: string) {
  const { data, error } = await createClient().rpc("stocktake_submit", {
    p_stocktake_id: id,
    p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function recountStocktakeItem(
  stocktakeId: string,
  itemId: string,
  reason: string,
) {
  const { data, error } = await createClient().rpc("stocktake_recount_item", {
    p_stocktake_id: stocktakeId,
    p_item_id: itemId,
    p_reason: reason,
    p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function setStocktakeVarianceReason(
  stocktakeId: string,
  itemId: string,
  reason: string,
) {
  const { data, error } = await createClient().rpc("stocktake_set_variance_reason", {
      p_stocktake_id: stocktakeId,
      p_item_id: itemId,
      p_reason: reason,
      p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function reviewStocktake(
  id: string,
  decision: "approved" | "rejected",
  reason: string,
) {
  const { data, error } = await createClient().rpc("stocktake_review", {
    p_stocktake_id: id,
    p_decision: decision,
    p_reason: reason,
    p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}

export async function applyStocktakeAdjustments(id: string) {
  const { data, error } = await createClient().rpc("stocktake_apply_adjustments", {
    p_stocktake_id: id,
    p_operation_id: newOperationId(),
  });
  return { data: data as unknown as RpcResult | null, error };
}
