import type { AssetInventoryRow } from "@/lib/types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
const localizedName = (value: unknown) => value === null || (record(value)
  && typeof value.name === "string" && nullableText(value.name_ar));

/** Validate only the selected operational list contract at its API boundary. */
export function isAssetInventoryRow(value: unknown): value is AssetInventoryRow {
  if (!record(value)) return false;
  return typeof value.id === "string" && typeof value.qr_token === "string"
    && typeof value.category_id === "string" && nullableText(value.asset_tag)
    && nullableText(value.name) && nullableText(value.serial_number)
    && typeof value.status === "string"
    && ["available", "reserved", "in_maintenance"].includes(value.status)
    && nullableText(value.location_id) && nullableText(value.company_id)
    && nullableText(value.pool_id) && nullableText(value.last_return_condition)
    && Object.prototype.hasOwnProperty.call(value, "special_attributes") && value.special_attributes !== undefined
    && localizedName(value.category) && localizedName(value.location)
    && localizedName(value.pool)
    && (value.model === null || (record(value.model)
      && nullableText(value.model.brand) && typeof value.model.model_name === "string"))
    && (value.holder === null || (record(value.holder)
      && typeof value.holder.full_name === "string" && nullableText(value.holder.full_name_ar)))
    && (value.company === null || (record(value.company) && typeof value.company.name === "string"));
}
