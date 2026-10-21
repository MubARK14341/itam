import { DemoError, requireActor, type OperationContext, type Row } from "./types";

// These are explicit current_user_has_capability checks from the final SQL
// functions in the source snapshot. Role checks remain inside each handler.
const requiredCapabilities: Readonly<Record<string, string>> = {
  asset_assign: "asset.assign", asset_return: "asset.assign", asset_move_atomic: "asset.move",
  asset_create_atomic: "asset.create", asset_update_atomic: "asset.update",
  asset_change_status: "asset.update", asset_set_serial: "asset.update", asset_set_serial_exempt: "asset.update",
  consumable_create_with_opening_stock: "consumable.manage", consumable_update_atomic: "consumable.manage",
  maintenance_create_atomic: "maintenance.manage", maintenance_update_safe: "maintenance.manage",
  maintenance_assign_technician: "maintenance.manage", maintenance_add_time_entry: "maintenance.manage",
  maintenance_plan_part: "maintenance.manage", maintenance_confirm_handoff: "maintenance.manage",
  purchase_requests_create_from_shortages: "purchase.manage",
  request_item_convert_to_pr: "request.approve", request_request_clarification: "request.approve",
  request_secondary_approve: "request.approve", request_set_responsible: "request.approve",
  registration_settings_update_atomic: "settings.manage", registration_invite_create_atomic: "settings.manage",
  registration_invite_update_atomic: "settings.manage", registration_invite_set_active: "settings.manage",
  depreciation_rule_save_atomic: "settings.manage", depreciation_rule_set_active: "settings.manage",
  get_customer_request_analytics: "report.customer_requests", get_customer_request_operational_report: "report.customer_requests",
  get_customer_request_timeseries: "report.customer_requests",
  employee_my_assets: "custody.self.read", employee_my_return_requests: "custody.self.read",
  employee_my_request: "request.self.read", employee_my_requests: "request.self.read",
  employee_reply_request_clarification: "request.self.reply", request_create_employee_self: "request.self.create",
  employee_report_asset_issue: "maintenance.self.report", employee_request_asset_return: "custody.self.return_request",
  scan_warehouse_exit: "scan.warehouse_move", scan_warehouse_move: "scan.warehouse_move",
};
const stocktakeWrites = new Set([
  "stocktake_create", "stocktake_start", "stocktake_scan", "stocktake_submit", "stocktake_recount_item",
  "stocktake_set_variance_reason", "stocktake_decide_item", "stocktake_review", "stocktake_apply_adjustments",
]);
export function authorizeDemoRpc(ctx: OperationContext, name: string, input: Row): void {
  if (["portal_create_request_atomic", "request_execute_idempotent", "request_deliver_with_proof", "consumable_stock_move_idempotent", "purchase_request_item_receive_idempotent", "procurement_record_external_document", "maintenance_add_time_entry", "maintenance_plan_part", "maintenance_confirm_handoff", "maintenance_update_safe"].includes(name) && !input.p_operation_id) throw new DemoError("22023", "operation_id_required");
  if ((name.startsWith("employee_") || name === "request_create_employee_self") && requireActor(ctx).role !== "employee") throw new DemoError("42501", "employee_role_required", 403);
  if (["stocktake_list", "stocktake_detail", "stocktake_system_inventory_report"].includes(name)) { const actor = requireActor(ctx); if (!actor.role || !["admin", "it_manager", "warehouse_manager", "auditor"].includes(actor.role)) throw new DemoError("42501", "not_authorized", 403); }
  let capability = requiredCapabilities[name];
  if (name === "request_execute_idempotent" && ["approve", "reject"].includes(String(input.p_operation_type))) capability = "request.approve";
  if (name === "procurement_record_external_document" && ctx.actor?.role !== "warehouse_manager") capability = "purchase.manage";
  if(stocktakeWrites.has(name)&&!input.p_operation_id)throw new DemoError("22023","operation_id_required");
  if (stocktakeWrites.has(name)) {
    const actor = requireActor(ctx);
    if (!actor.role || !["admin", "it_manager", "warehouse_manager"].includes(actor.role)) throw new DemoError("42501", "not_authorized", 403);
    capability = "stocktake.manage";
  }
  if (capability && !requireActor(ctx).capabilities.includes(capability)) throw new DemoError("42501", "capability_not_authorized", 403);
  if (name === "consumable_stock_move_idempotent") {
    const actor = requireActor(ctx);
    if (!actor.role || !["admin", "it_manager", "technician"].includes(actor.role)) throw new DemoError("42501", "not_authorized", 403);
  }
}
