"use client";

// جدول «الأصول فقط» في صفحة المخزون — تقديمي فقط؛ الصفوف مفلترة مسبقًا في الصفحة.

import Link from "next/link";
import { Eye, Plus, RefreshCw, SearchX, Boxes } from "lucide-react";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AssetTemplateBadge } from "@/components/assets/asset-template-badge";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import { CompletenessBadge } from "@/components/assets/completeness-badge";
import { SelectCheckbox } from "@/components/assets/inventory-selection";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { computeCompleteness } from "@/lib/asset-completeness";
import { ASSET_POOLS_UI_VISIBLE } from "@/lib/asset-pools-visibility";
import { withInventoryReturnTo } from "@/lib/inventory-navigation";
import type { AssetViewKey } from "@/lib/alert-predicates";
import { interpolate } from "@/lib/i18n";
import type { AssetInventoryRow } from "@/lib/types";

export function AssetListTable({
  rows, hasAnyRows, loading, returnTo, view, fin, write, canFixStatus, canAdd, anyFilter, onClearFilters,
  selected, onToggle, onToggleAll, onQuickView,
}: {
  rows: AssetInventoryRow[];
  hasAnyRows: boolean;
  loading: boolean;
  returnTo: string;
  view: AssetViewKey | null;
  fin: boolean;
  write: boolean;
  canFixStatus: boolean;
  canAdd: boolean;
  anyFilter: boolean;
  onClearFilters: () => void;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  onQuickView: (row: AssetInventoryRow) => void;
}) {
  const { t, lang } = useAppPreferences();
  const h = t.assets.headers;
  const lu = t.assets.listUx;
  const colCount = ASSET_POOLS_UI_VISIBLE ? 12 : 11;
  const selectedVisible = rows.filter((r) => selected.has(`a:${r.id}`)).length;
  const byLang = (ar: string | null | undefined, en: string | null | undefined) =>
    (lang === "en" ? (en ?? ar) : (ar ?? en)) ?? "—";

  return (
    <div tabIndex={0} className="overflow-x-auto">
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
            <th>{h.tag}</th><th>{h.name}</th><th>{h.category}</th><th>{h.model}</th>
            <th>{h.status}</th><th>{h.location}</th><th>{h.holder}</th><th>{h.company}</th>
            {ASSET_POOLS_UI_VISIBLE && <th>{t.pools.colHeader}</th>}
            <th>{h.completion}</th>
            <th><span className="sr-only">{lu.actions}</span></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            // هيكل تحميل (skeleton) بدل صف نص واحد — يمنع ظهور الصفحة «شبه فارغة» أثناء الجلب (M7)
            Array.from({ length: 8 }).map((_, i) => (
              <tr key={`sk-${i}`} className="animate-pulse">
                <td colSpan={colCount}><div className="h-4 w-full rounded bg-sunk" /></td>
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr><td colSpan={colCount}>
              {!hasAnyRows ? (
                <EmptyState
                  compact
                  icon={Boxes}
                  title={t.assets.emptyNone}
                  action={canAdd ? (
                    <Link href="/assets/new" className={buttonClass("primary", "md")}>
                      <Plus aria-hidden="true" className="h-4 w-4" /> {t.assets.add}
                    </Link>
                  ) : undefined}
                />
              ) : (
                <EmptyState
                  compact
                  icon={SearchX}
                  title={t.assets.emptyFiltered}
                  description={anyFilter ? t.assets.activeFiltersLabel : undefined}
                  action={anyFilter ? <Button variant="outline" size="sm" onClick={onClearFilters}>{t.common.clearFilters}</Button> : undefined}
                />
              )}
            </td></tr>
          ) : (
            rows.map((r) => {
              const key = `a:${r.id}`;
              const checked = selected.has(key);
              return (
                <tr key={r.id} aria-selected={checked || undefined}>
                  <td>
                    <SelectCheckbox label={interpolate(lu.selectRow, { tag: r.asset_tag ?? r.name ?? "" })} checked={checked} onChange={() => onToggle(key)} />
                  </td>
                  <td className="whitespace-nowrap"><span className="tag font-medium text-brand-ink">{r.asset_tag}</span></td>
                  <td className="min-w-[180px]">
                    <div className="flex items-center gap-3">
                      <EquipmentPhoto asset={r} />
                      <div className="flex min-w-0 flex-col items-start gap-1">
                        <Link href={withInventoryReturnTo(`/assets/${r.id}`, returnTo)} prefetch={false} className="font-semibold text-fg hover:text-brand-ink">{r.name ?? "—"}</Link>
                        <AssetTemplateBadge asset={r} />
                      </div>
                    </div>
                  </td>
                  {/* (I18N-2) اختيار عمود الاسم حسب اللغة النشطة — عرض فقط، لا ترجمة لبيانات القاعدة */}
                  <td className="text-fg-2">{byLang(r.category?.name_ar, r.category?.name)}</td>
                  <td className="text-fg-2">{r.model ? `${r.model.brand} ${r.model.model_name}` : "—"}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="text-fg-2">{byLang(r.location?.name_ar, r.location?.name)}</td>
                  <td className={r.holder ? "text-fg" : "text-muted"}>{byLang(r.holder?.full_name_ar, r.holder?.full_name)}</td>
                  <td className="text-fg-2">{r.company?.name ?? "—"}</td>
                  {ASSET_POOLS_UI_VISIBLE && (
                    <td>
                      {r.pool ? (
                        <span className="ui-chip tone-info">{r.pool?.name_ar ?? r.pool?.name}</span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                  )}
                  <td>
                    <CompletenessBadge result={computeCompleteness(r, { canSeeFinancial: fin, canWrite: write })} />
                  </td>
                  <td className="pe-2">
                    <div className="flex items-center justify-end gap-1">
                      {/* إجراء مباشر حسب قائمة العمل — طبقة عرض فوق شرط الدور (canWrite) لا بديلًا عنه */}
                      {view === "maintenance_attention" && canFixStatus && (
                        <Link href={`/assets/${r.id}?action=status`} prefetch={false} className={buttonClass("ghost", "sm", "whitespace-nowrap text-ok")}>
                          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> {t.workQueue.actions.fixStatus}
                        </Link>
                      )}
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={interpolate(lu.quickView, { name: r.name ?? r.asset_tag ?? "" })} onClick={() => onQuickView(r)}>
                        <Eye aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
