"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Bike, Boxes, Cable, Cctv, ContactRound, CreditCard, Laptop, Monitor, Package, Printer, Router, ScanBarcode, Tablet } from "lucide-react";
import { getAttachmentUrl } from "@/lib/queries";
import type { TemplateId } from "@/lib/asset-type-templates";
import { EQUIPMENT_PHOTOS, equipmentPhotoKind, equipmentTemplate, latestCleanEquipmentPhoto, type EquipmentAsset, type EquipmentAttachment } from "@/lib/equipment-photos";
import styles from "./equipment-photo.module.css";

const ICONS = { sim: ContactRound, router: Router, printer: Printer, laptop: Laptop, scanner: ScanBarcode, tablet: Tablet, pos: CreditCard, display: Monitor, camera: Cctv, scooter: Bike, accessory: Cable, consumable: Package, other: Boxes };
const NO_ATTACHMENTS: readonly EquipmentAttachment[] = [];

/** Pass attachments only on internal details with logs already loaded. Lists and public/portal surfaces use public illustrations only. */
export function EquipmentPhoto({ asset, templateId, attachments = NO_ATTACHMENTS, size = "row", unframed = false, className = "" }: {
  asset?: EquipmentAsset;
  templateId?: TemplateId;
  attachments?: readonly EquipmentAttachment[];
  size?: "row" | "preview" | "stage";
  unframed?: boolean;
  className?: string;
}) {
  const photo = latestCleanEquipmentPhoto(attachments);
  const path = photo?.storage_path;
  const fileName = photo?.file_name;
  const [signed, setSigned] = useState<{ path: string; url: string } | null>(null);
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!path) return;
    let current = true;
    void getAttachmentUrl(path, fileName).then(({ url }) => {
      if (current && url) setSigned({ path, url });
    }, () => {
      // A private photo is optional; signing failures retain the public illustration.
      if (current) setSigned(null);
    });
    return () => { current = false; };
  }, [path, fileName]);

  const template = equipmentTemplate(asset, templateId);
  const kind = equipmentPhotoKind(asset, template);
  const illustration = kind ? EQUIPMENT_PHOTOS[kind] : null;
  const privateUrl = path && signed?.path === path && !failedSources.has(signed.url) ? signed.url : null;
  const source = privateUrl ?? (illustration && !failedSources.has(illustration) ? illustration : null);
  const handleImageError = useCallback(() => {
    if (!source) return;
    setFailedSources((current) => current.has(source) ? current : new Set(current).add(source));
  }, [source]);
  const Icon = ICONS[template];
  return (
    <span aria-hidden="true" className={`${styles.photo} ${styles[size]} ${unframed ? styles.unframed : ""} ${className}`}>
      {source ? <Image src={source} alt="" width={420} height={350} unoptimized={!!privateUrl} onError={handleImageError} sizes={size === "row" ? "64px" : "(max-width: 640px) 90vw, 340px"} /> : <Icon className={styles.icon} />}
    </span>
  );
}
