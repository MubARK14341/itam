"use client";

import { useMemo } from "react";
import { Layers, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { computePoolStats, groupAssetsByPool } from "@/lib/pools";

export interface PoolCard {
  id: string; name: string; name_ar: string | null;
  category: { name: string; name_ar: string | null } | null;
  company: { name: string } | null;
}

// قسم «مجموعات الأصول» أعلى /assets — بطاقات إحصائية + فلترة الجدول بالضغط.
// قراءة فقط لكل معتمد؛ لا بيانات مالية.
export function AssetPoolsCards({ pools, assets, activePool, onSelect, onClear }: {
  pools: PoolCard[];
  assets: { pool_id?: string | null; status?: string | null }[];
  activePool: string;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const { t, lang } = useAppPreferences();
  const tp = t.pools;
  const byPool = useMemo(() => groupAssetsByPool(assets), [assets]);
  const nm = (o: { name: string; name_ar?: string | null } | null | undefined) =>
    o ? (lang === "ar" ? (o.name_ar ?? o.name) : o.name) : null;

  return (
    <Card className="mb-4 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Layers className="h-4 w-4 text-accent" />{tp.section}
        </h2>
        {activePool && (
          <button onClick={onClear} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
            <X className="h-3.5 w-3.5" />{tp.clearFilter}
          </button>
        )}
      </div>

      {pools.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400 dark:text-slate-500">{tp.empty}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pools.map((p) => {
            const stats = computePoolStats(byPool.get(p.id) ?? []);
            const active = activePool === p.id;
            return (
              <button key={p.id} onClick={() => onSelect(p.id)}
                className={`rounded-xl border p-4 text-start transition ${
                  active
                    ? "border-accent bg-accent/5 ring-1 ring-accent"
                    : "border-slate-200 bg-white hover:border-accent/40 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800/50"
                }`}>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">{nm(p) ?? "—"}</h3>
                    <p className="truncate text-xs text-slate-400 dark:text-slate-500">
                      {[nm(p.category), p.company?.name].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-lg bg-accent/10 px-2.5 py-1 text-center text-accent">
                    <span className="block text-base font-bold leading-none">{stats.total}</span>
                    <span className="block text-[10px]">{tp.totalShort}</span>
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5 text-center">
                  <Stat label={tp.available} value={stats.available} tone="text-emerald-600 dark:text-emerald-400" />
                  <Stat label={tp.reserved} value={stats.reserved} tone="text-amber-600 dark:text-amber-400" />
                  <Stat label={tp.maintenance} value={stats.maintenance} tone="text-orange-600 dark:text-orange-400" />
                  <Stat label={tp.utilization} value={`${stats.utilizationPct}%`} tone="text-accent" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-1 py-1.5 dark:bg-slate-800/50">
      <div className={`text-sm font-bold leading-none ${tone}`}>{value}</div>
      <div className="mt-1 truncate text-[10px] text-slate-400 dark:text-slate-500" title={label}>{label}</div>
    </div>
  );
}
