import type { AssetStatus } from "@/lib/types";

export interface NewPhysicalAssetRequiredFields {
  categoryId: string;
  locationId: string;
  companyId: string;
  serialNumber: string;
}

export type NewPhysicalAssetRequiredError = "category" | "location" | "company" | "serial";

export function validateNewPhysicalAssetRequired(
  input: NewPhysicalAssetRequiredFields,
): NewPhysicalAssetRequiredError[] {
  const errors: NewPhysicalAssetRequiredError[] = [];
  if (!input.categoryId.trim()) errors.push("category");
  if (!input.locationId.trim()) errors.push("location");
  // asset_create_atomic/asset_update_atomic reject a missing company (required_asset_fields).
  if (!input.companyId.trim()) errors.push("company");
  if (!input.serialNumber.trim()) errors.push("serial");
  return errors;
}

export function stampAssetCreator<T extends { status: AssetStatus; assigned_to_employee_id: string | null }>(
  input: T,
  creatorId: string,
): T & { created_by: string } {
  return {
    ...input,
    created_by: creatorId,
    assigned_to_employee_id: null,
  };
}
