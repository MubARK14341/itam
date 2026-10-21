import { rows, type DemoState, type Row } from "./types";

// Final 20260817170623 _portal_settings defaults. Reading a missing row must
// never enable a portal or create state as a side effect.
export function resolveDemoPortalSettings(s: DemoState, customerId: unknown): Row {
  const config: Row = {
    customer_id: customerId,
    portal_enabled: false,
    allow_rental_requests: true,
    allow_purchase_requests: true,
    allow_maintenance_requests: true,
    allow_custom_requests: true,
    allow_custom_item_requests: true,
    allow_attachments: true,
    require_project_manager_approval: false,
    ...rows(s, "customer_portal_settings").find(r => r.customer_id === customerId),
  };
  const customer = rows(s, "customers").find(r => r.id === customerId);
  if (customer?.is_active !== true || (customer.approval_status ?? "approved") !== "approved") config.portal_enabled = false;
  return config;
}
