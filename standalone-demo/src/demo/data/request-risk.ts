import { rows, num, type DemoState } from "./types";

// Final source _request_delivery_risk: individual allocated asset cost, not the
// request total or a stale UI snapshot. Only the risk enum leaves this helper.
export function demoRequestRisk(s: DemoState, requestId: unknown): { level: "low" | "high"; reason: "standard_delivery" | "high_value_asset" } {
  const high=rows(s,"request_items").some(it=>it.request_id===requestId&&it.item_kind==="asset"&&rows(s,"assets").some(a=>a.id===it.asset_id&&num(a.purchase_cost)>=10000));
  return high?{level:"high",reason:"high_value_asset"}:{level:"low",reason:"standard_delivery"};
}
