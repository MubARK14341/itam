"use client";

// عرض سريع لعنصر من قائمة المخزون — يعرض فقط البيانات المحمّلة أصلًا في الصف (بلا أي جلب
// إضافي ولا أي حقل مالي)، مع رابط للصفحة الكاملة.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Drawer } from "@/components/ui/drawer";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import type { EquipmentAsset } from "@/lib/equipment-photos";
import { Button, buttonClass } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { StockChip, TypeBadge, type InventoryItemType, type StockLevel, type UnifiedRow } from "@/components/assets/unified-inventory-table";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { interpolate, type Lang } from "@/lib/i18n";
import type { AssetInventoryRow, AssetStatus } from "@/lib/types";

export interface QuickViewItem {
  type: InventoryItemType;
  code: string;
  name: string;
  href: string;
  category: string;
  company: string;
  location: string;
  assetStatus?: AssetStatus;
  stock?: StockLevel;
  holder?: string | null;
  quantity?: string;
  model?: string | null;
  serial?: string | null;
  equipment?: EquipmentAsset;
}

const pick = (lang: Lang, ar: string | null | undefined, en: string | null | undefined) =>
  (lang === "en" ? (en ?? ar) : (ar ?? en)) ?? null;

export function quickViewFromAsset(a: AssetInventoryRow, lang: Lang): QuickViewItem {
  return {
    type: "asset",
    code: a.asset_tag ?? "—",
    name: a.name ?? "—",
    href: `/assets/${a.id}`,
    category: pick(lang, a.category?.name_ar, a.category?.name) ?? "—",
    company: a.company?.name ?? "—",
    location: pick(lang, a.location?.name_ar, a.location?.name) ?? "—",
    assetStatus: a.status,
    holder: pick(lang, a.holder?.full_name_ar, a.holder?.full_name),
    model: a.model ? `${a.model.brand} ${a.model.model_name}` : null,
    serial: a.serial_number,
    equipment: a,
  };
}

export function quickViewFromUnified(r: UnifiedRow): QuickViewItem {
  return {
    type: r.type,
    code: r.code,
    name: r.name,
    href: r.href,
    category: r.categoryLabel,
    company: r.company,
    location: r.location,
    assetStatus: r.assetStatus,
    stock: r.stock,
    holder: r.type === "asset" && r.holderOrQty !== "—" ? r.holderOrQty : null,
    quantity: r.type === "consumable" ? r.holderOrQty : undefined,
    equipment: r.equipment,
  };
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("");
}

export function InventoryQuickView({
  item, onClose, openHref,
}: {
  item: QuickViewItem | null; onClose: () => void; openHref: (href: string) => string;
}) {
  const { t } = useAppPreferences();
  const lu = t.assets.listUx;
  const h = t.assets.headers;
  if (!item) return null;
  const isAsset = item.type === "asset";
  const rows: [string, React.ReactNode][] = [
    [h.type, <TypeBadge key="type" type={item.type} />],
    [h.location, item.location],
    ...(isAsset ? [
      [h.model, item.model ?? "—"] as [string, React.ReactNode],
      [lu.serial, item.serial ? <span className="tag">{item.serial}</span> : "—"] as [string, React.ReactNode],
    ] : [
      [lu.quantity, <span key="qty" className="tabular-nums">{item.quantity || "—"}</span>] as [string, React.ReactNode],
    ]),
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      eyebrow={
        <span className="flex flex-wrap items-center gap-2">
          <span className="tag font-medium text-brand-ink">{item.code}</span>
          {item.assetStatus ? <StatusBadge status={item.assetStatus} /> : item.stock ? <StockChip level={item.stock} /> : null}
        </span>
      }
      title={item.name}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>{t.common.close}</Button>
          <Link href={openHref(item.href)} className={buttonClass("primary", "md", "flex-1 sm:flex-none")}>
            {lu.openFull}
            <ArrowLeft aria-hidden="true" className="h-4 w-4 ltr:rotate-180" />
          </Link>
        </>
      }
    >
      <div className="space-y-5">
        <EquipmentPhoto asset={item.equipment ?? { name: item.name, category: { name: item.category } }} templateId={!isAsset ? "consumable" : undefined} size="stage" />
        <p className="text-[13px] text-muted">{item.category} · {item.company}</p>

        <section>
          <h3 className="mb-2 text-[13px] font-semibold text-muted">{lu.details}</h3>
          <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-y-2.5 text-[13.5px]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="min-w-0 break-words text-fg">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {isAsset && (
          <section className="rounded-card border border-line bg-surface-2 p-3.5">
            <h3 className="mb-2.5 text-[13px] font-semibold text-muted">{lu.custody}</h3>
            {item.holder ? (
              <div className="flex items-center gap-2.5">
                <span aria-hidden="true" className="ui-avatar h-9 w-9">{initials(item.holder)}</span>
                <span className="font-semibold text-fg">{item.holder}</span>
              </div>
            ) : (
              <p className="text-[13.5px] text-fg-2">
                {item.location && item.location !== "—" ? interpolate(lu.unassignedAt, { location: item.location }) : lu.unassigned}
              </p>
            )}
          </section>
        )}
      </div>
    </Drawer>
  );
}
