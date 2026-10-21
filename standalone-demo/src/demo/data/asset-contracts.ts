import { DemoError, find, str, type DemoState, type Row } from "./types";

export function validateDemoAssetIntegrity(s: DemoState, next: Row, previous?: Row): void {
  if (!previous) {
    if (!next.created_by) throw new DemoError("23514", "asset_creator_required");
    if (!next.company_id) throw new DemoError("23514", "asset_company_required");
    if (!next.location_id) throw new DemoError("23514", "asset_location_required");
    if (!str(next.serial_number).trim() && next.serial_exempt !== true) throw new DemoError("23514", "asset_serial_required");
  } else {
    if (previous.company_id != null && next.company_id == null) throw new DemoError("23514", "asset_company_cannot_be_cleared");
    if (previous.location_id != null && next.location_id == null) throw new DemoError("23514", "asset_location_cannot_be_cleared");
    if (previous.created_by != null && next.created_by !== previous.created_by) throw new DemoError("23514", "asset_creator_immutable");
  }
  if (!["available", "reserved", "in_maintenance"].includes(str(next.status))) throw new DemoError("23514", "asset_primary_status_invalid");
  find(s, "categories", next.category_id);
  if (next.company_id) find(s, "companies", next.company_id);
  if (next.location_id) find(s, "locations", next.location_id);
}
