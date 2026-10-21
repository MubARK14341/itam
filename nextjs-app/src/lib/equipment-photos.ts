import { getAssetTemplate, readSpecialAttribute, type TemplateId } from "@/lib/asset-type-templates";

/** Public, illustrative equipment photos. These never contain inventory data. */
export const EQUIPMENT_PHOTOS = {
  laptop: "/studio-equipment/laptop.png",
  "paper-printer": "/studio-equipment/paper-printer.png",
  "card-printer": "/studio-equipment/card-printer.png",
  "label-printer": "/studio-equipment/label-printer.png",
  "receipt-printer": "/studio-equipment/receipt-printer.png",
  camera: "/studio-equipment/camera.png",
  scanner: "/studio-equipment/scanner.png",
  router: "/studio-equipment/router.png",
  display: "/studio-equipment/display.png",
  tablet: "/studio-equipment/tablet.png",
  pos: "/studio-equipment/pos.png",
} as const;

export type EquipmentPhotoKind = keyof typeof EQUIPMENT_PHOTOS;
export type EquipmentAsset = Parameters<typeof getAssetTemplate>[0];
export interface EquipmentAttachment {
  kind?: string | null;
  classification?: string | null;
  scan_status?: string | null;
  mime_type?: string | null;
  storage_path: string;
  file_name?: string;
  created_at?: string;
}

export function equipmentTemplate(asset?: EquipmentAsset, templateId?: TemplateId): TemplateId {
  return templateId ?? getAssetTemplate(asset).id;
}

export function equipmentPhotoKind(asset?: EquipmentAsset, templateId?: TemplateId): EquipmentPhotoKind | null {
  const type = equipmentTemplate(asset, templateId);
  if (type === "printer") {
    const subtype = readSpecialAttribute(asset, "printerType");
    if (subtype === "card") return "card-printer";
    if (subtype === "label") return "label-printer";
    if (subtype === "receipt" || subtype === "thermal") return "receipt-printer";
    if (subtype === "paper") return "paper-printer";
    const name = `${asset?.name ?? ""} ${asset?.category?.name ?? ""} ${asset?.category?.name_ar ?? ""}`.toLowerCase();
    if (/\b(card|matica|zenius|hiti|swiftcolor)\b|بطاق/.test(name)) return "card-printer";
    if (/\b(label|labels)\b|ملصق/.test(name)) return "label-printer";
    if (/\b(receipt|thermal)\b|إيصال|ايصال|حراري/.test(name)) return "receipt-printer";
    return "paper-printer";
  }
  return Object.prototype.hasOwnProperty.call(EQUIPMENT_PHOTOS, type) ? type as EquipmentPhotoKind : null;
}

/** Only already-loaded, scanned image attachments may be displayed privately. */
export function latestCleanEquipmentPhoto(attachments: readonly EquipmentAttachment[]): EquipmentAttachment | null {
  return attachments
    .filter((attachment) => attachment.kind === "asset_photo"
      && attachment.classification !== "financial"
      && attachment.scan_status === "clean"
      && attachment.mime_type?.startsWith("image/")
      && !!attachment.storage_path)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0] ?? null;
}
