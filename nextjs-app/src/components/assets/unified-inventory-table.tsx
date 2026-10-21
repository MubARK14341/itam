"use client";

// ============================================================================
//  العرض الموحّد للمخزون (أصول + مستهلكات) — طبقة **واجهة فقط**، بلا دمج جداول.
//  يُبنى من نفس مصدري البيانات القائمين (جدول الأصول + listConsumables) ويوجّه كل
//  صف لصفحته الصحيحة. لا ماليات، لا يلمس روابط ?view= (قوائم العمل تبقى في عرض الأصول).
// ============================================================================

import Link from "next/link";
import { memo } from "react";
import { Eye, SearchX } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { StatusChip } from "@/components/ui/status-chip";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { SelectCheckbox } from "@/components/assets/inventory-selection";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import type { EquipmentAsset } from "@/lib/equipment-photos";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useMediaQuery } from "@/components/action-center/use-media-query";
import { withInventoryReturnTo } from "@/lib/inventory-navigation";
import { interpolate } from "@/lib/i18n";
import { isVisibleLocation } from "@/lib/locations";
import type { Tone } from "@/lib/tone";
import type { AssetInventoryRow, AssetStatus, ConsumableRow, LocationRow } from "@/lib/types";

export type InventoryItemType = "asset" | "consumable";
export type StockLevel = "out" | "low" | "good";

export interface UnifiedRow {
  key: string;
  id: string;
  type: InventoryItemType;
  code: string; // asset_tag أو SKU
  name: string;
  categoryLabel: string;
  location: string;
  company: string;
  holderOrQty: string; // المستلِم (أصل) أو الكمية+الوحدة (مستهلك)
  href: string;
  assetStatus?: AssetStatus;
  stock?: StockLevel;
  equipment?: EquipmentAsset;
  // حقول التصفية (تُطابق فلاتر صفحة الأصول)
  category_id: string | null;
  location_id: string | null;
  company_id: string | null;
  searchHay: string;
}

const NO_LOCATION_FALLBACK: LocationRow[] = [];

/** Joined inventory locations are authoritative; reference options matter only to legacy unjoined rows. */
export function unifiedLocationFallback(consumables: ConsumableRow[], locations: LocationRow[]): LocationRow[] {
  return consumables.some((row) => row.location === undefined) ? locations : NO_LOCATION_FALLBACK;
}

/** يبني الصفوف الموحّدة من الأصول والمستهلكات (الأصول أولًا ثم المستهلكات، بحفظ الترتيب الوارد). */
export function buildUnifiedRows(
  assets: AssetInventoryRow[],
  consumables: ConsumableRow[],
  locs: LocationRow[],
): UnifiedRow[] {
  const locName = new Map(locs.map((l) => [l.id, l.name_ar ?? l.name] as const));
  const assetRows: UnifiedRow[] = assets.map((a) => ({
    key: `a:${a.id}`,
    id: a.id,
    type: "asset",
    code: a.asset_tag ?? "—",
    name: a.name ?? "—",
    categoryLabel: a.category?.name_ar ?? a.category?.name ?? "—",
    location: a.location?.name_ar ?? a.location?.name ?? "—",
    company: a.company?.name ?? "—",
    holderOrQty: a.holder?.full_name_ar ?? a.holder?.full_name ?? "—",
    href: `/assets/${a.id}`,
    assetStatus: a.status,
    equipment: a,
    category_id: a.category_id,
    location_id: a.location_id ?? null,
    company_id: a.company_id ?? null,
    searchHay: `${a.asset_tag ?? ""} ${a.name ?? ""} ${a.serial_number ?? ""} ${a.model?.brand ?? ""} ${a.model?.model_name ?? ""}`.toLowerCase(),
  }));
  const consRows: UnifiedRow[] = consumables.map((c) => {
    const qty = Number(c.quantity_on_hand);
    const reorder = Number(c.reorder_level);
    const stock: StockLevel = qty <= 0 ? "out" : qty <= reorder ? "low" : "good";
    return {
      key: `c:${c.id}`,
      id: c.id,
      type: "consumable",
      code: c.sku ?? "—",
      name: c.name,
      categoryLabel: c.category?.name_ar ?? c.category?.name ?? "—",
      location: c.location === undefined
        ? c.location_id ? (locName.get(c.location_id) ?? "—") : "—"
        : isVisibleLocation(c.location) ? (c.location?.name_ar ?? c.location?.name ?? "—") : "—",
      company: c.company?.name ?? "—",
      holderOrQty: `${Number.isFinite(qty) ? qty : 0} ${c.unit ?? ""}`.trim(),
      href: `/consumables/${c.id}`,
      stock,
      category_id: c.category_id,
      location_id: c.location_id ?? null,
      company_id: c.company_id ?? null,
      searchHay: `${c.sku ?? ""} ${c.name ?? ""} ${c.brand ?? ""}`.toLowerCase(),
    };
  });
  return [...assetRows, ...consRows];
}

export interface UnifiedFilters {
  q: string;
  cat: string;
  status: string;
  loc: string;
  company: string;
}

/** يطبّق نفس فلاتر صفحة الأصول. فلتر حالة الأصل يخص الأصول فقط (يستبعد المستهلكات عند ضبطه). */
export function unifiedRowMatches(r: UnifiedRow, f: UnifiedFilters): boolean {
  if (f.cat && r.category_id !== f.cat) return false;
  if (f.loc && r.location_id !== f.loc) return false;
  if (f.company && r.company_id !== f.company) return false;
  if (f.status && (r.type !== "asset" || r.assetStatus !== f.status)) return false;
  if (f.q && !r.searchHay.includes(f.q.toLowerCase())) return false;
  return true;
}

export const STOCK_TONE: Record<StockLevel, Tone> = { out: "bad", low: "warn", good: "ok" };

export function TypeBadge({ type }: { type: InventoryItemType }) {
  const { t } = useAppPreferences();
  return (
    <StatusChip tone={type === "asset" ? "info" : "neu"} dot={false} size="sm">
      {type === "asset" ? t.assets.badges.asset : t.assets.badges.consumable}
    </StatusChip>
  );
}

export function StockChip({ level }: { level: StockLevel }) {
  const { t } = useAppPreferences();
  const label: Record<StockLevel, string> = { out: t.consumables.out, low: t.consumables.low, good: t.consumables.good };
  return <StatusChip tone={STOCK_TONE[level]}>{label[level]}</StatusChip>;
}

/** جدول العرض الموحّد (تقديمي فقط) — يتلقّى الصفوف المفلترة جاهزة من الصفحة. */
export const UnifiedInventoryTable = memo(function UnifiedInventoryTable({
  rows,
  loading,
  returnTo,
  selected,
  onToggle,
  onToggleAll,
  onQuickView,
  onClearFilters,
}: {
  rows: UnifiedRow[];
  loading: boolean;
  returnTo: string;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  onQuickView: (row: UnifiedRow) => void;
  onClearFilters?: () => void;
}) {
  const { t } = useAppPreferences();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const h = t.assets.headers;
  const lu = t.assets.listUx;
  const selectedVisible = rows.filter((r) => selected.has(r.key)).length;
  const empty = (
    <EmptyState
      compact
      icon={SearchX}
      title={t.assets.emptyFiltered}
      action={onClearFilters ? <Button variant="outline" size="sm" onClick={onClearFilters}>{t.common.clearFilters}</Button> : undefined}
    />
  );
  return (
    <>
      <div className="divide-y divide-line md:hidden">
        {loading ? (
          Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="animate-pulse p-4">
              <div className="h-4 w-28 rounded bg-sunk" />
              <div className="mt-3 h-3 w-48 rounded bg-sunk" />
            </div>
          ))
        ) : rows.length === 0 ? empty : isDesktop ? null : rows.map((r) => (
          <Link
            key={r.key}
            href={withInventoryReturnTo(r.href, returnTo)}
            prefetch={false}
            className="block p-4 transition-colors hover:bg-surface-2 active:bg-sunk"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <EquipmentPhoto asset={r.equipment ?? { name: r.name, category: { name: r.categoryLabel } }} templateId={r.type === "consumable" ? "consumable" : undefined} />
                <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tag text-[13px] font-medium text-brand-ink">{r.code}</span>
                  <TypeBadge type={r.type} />
                </div>
                <p className="mt-1 truncate text-sm font-semibold text-fg">{r.name}</p>
                <p className="mt-1 truncate text-xs text-muted">{r.categoryLabel} · {r.location}</p>
                </div>
              </div>
              <div className="shrink-0">
                {r.type === "asset" && r.assetStatus ? <StatusBadge status={r.assetStatus} /> : r.stock ? <StockChip level={r.stock} /> : null}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-fg-2">{r.holderOrQty || "—"}</span>
              <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-brand-ink">
                <Eye aria-hidden="true" className="h-3.5 w-3.5" /> {t.common.view}
              </span>
            </div>
          </Link>
        ))}
      </div>
      <div tabIndex={0} className="hidden overflow-x-auto md:block">
        <table className="ui-table">
          <thead>
            <tr>
              <th className="w-11">
                <SelectCheckbox
                  label={lu.selectAll}
                  checked={rows.length > 0 && selectedVisible === rows.length}
                  indeterminate={selectedVisible > 0 && selectedVisible < rows.length}
                  disabled={loading || rows.length === 0}
                  onChange={onToggleAll}
                />
              </th>
              <th>{h.tagOrCode}</th><th>{h.name}</th><th>{h.type}</th><th>{h.category}</th>
              <th>{h.status}</th><th>{h.location}</th><th>{h.holderOrQty}</th><th>{h.company}</th>
              <th className="w-12"><span className="sr-only">{lu.actions}</span></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`sk-${i}`} className="animate-pulse">
                  <td colSpan={10}><div className="h-4 w-full rounded bg-sunk" /></td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr><td colSpan={10}>{empty}</td></tr>
            ) : (
              isDesktop ? rows.map((r) => {
                const checked = selected.has(r.key);
                const href = withInventoryReturnTo(r.href, returnTo);
                return (
                  <tr key={r.key} aria-selected={checked || undefined}>
                    <td>
                      <SelectCheckbox label={interpolate(lu.selectRow, { tag: r.code })} checked={checked} onChange={() => onToggle(r.key)} />
                    </td>
                    <td className="whitespace-nowrap"><span className="tag font-medium text-brand-ink">{r.code}</span></td>
                    <td className="max-w-[280px]">
                      <div className="flex items-center gap-3">
                        <EquipmentPhoto asset={r.equipment ?? { name: r.name, category: { name: r.categoryLabel } }} templateId={r.type === "consumable" ? "consumable" : undefined} />
                        <Link href={href} prefetch={false} className="min-w-0 truncate font-semibold text-fg hover:text-brand-ink">{r.name}</Link>
                      </div>
                    </td>
                    <td><TypeBadge type={r.type} /></td>
                    <td className="text-fg-2">{r.categoryLabel}</td>
                    <td>
                      {r.type === "asset" && r.assetStatus ? <StatusBadge status={r.assetStatus} /> : r.stock ? <StockChip level={r.stock} /> : "—"}
                    </td>
                    <td className="text-fg-2">{r.location}</td>
                    <td className={r.type === "consumable" ? "font-semibold tabular-nums text-fg" : r.holderOrQty === "—" ? "text-muted" : "text-fg"}>{r.holderOrQty || "—"}</td>
                    <td className="text-fg-2">{r.company}</td>
                    <td className="pe-2">
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={interpolate(lu.quickView, { name: r.name })} onClick={() => onQuickView(r)}>
                        <Eye aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              }) : null
            )}
          </tbody>
        </table>
      </div>
    </>
  );
});
