"use client";

// زر «تجهيز طلب شراء» — يظهر في شعار قائمة عمل النواقص (?view=below_reorder).
// يجمع الأصناف الناقصة (نفس الشرط الموحد) بكمية مقترحة قابلة للتعديل، ويجمعها
// حسب المورد (طلب مسودة لكل مورد). لا يعرض أي أسعار لغير المصرح ماليًا —
// هذا الحوار لا يتعامل مع الأسعار إطلاقًا (تُضاف لاحقًا من صفحة الطلب للمصرح فقط).
// المخزون لا يتغير هنا — التوريد الفعلي يبقى عبر نافذة «توريد» الموجودة.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ShoppingCart } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/form";
import type { ToastState } from "@/components/ui/toast";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import {
  createPurchaseRequestsFromShortages, suggestedQuantity, type ShortageDraftItem,
} from "@/lib/purchase-requests";

export function PreparePurchaseRequestButton({ shortages, suppliers, onDone }: {
  shortages: any[];
  suppliers: { id: string; name: string; name_ar: string | null }[];
  onDone: (m: ToastState) => void;
}) {
  const { t } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const tp = t.purchaseRequests;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Record<string, { checked: boolean; qty: string }>>({});

  useEffect(() => {
    if (!open) return;
    const init: Record<string, { checked: boolean; qty: string }> = {};
    for (const s of shortages) init[s.id] = { checked: true, qty: String(suggestedQuantity(s)) };
    setSel(init);
  }, [open, shortages]);

  const supplierName = (id: string | null) => {
    const s = suppliers.find((x) => x.id === id);
    return s ? (s.name_ar ?? s.name) : tp.noSupplier;
  };

  const chosen = useMemo(
    () => shortages.filter((s) => sel[s.id]?.checked && Number(sel[s.id]?.qty) > 0),
    [shortages, sel],
  );

  // معاينة التجميع حسب المورد
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of chosen) {
      const k = s.supplier_id ?? "";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [chosen]);

  if (!isVisible("purchaseRequests.page")) return null;

  async function submit() {
    const items: ShortageDraftItem[] = chosen.map((s) => ({
      consumable_id: s.id,
      supplier_id: s.supplier_id ?? null,
      quantity: Math.max(1, Math.trunc(Number(sel[s.id].qty))),
    }));
    if (!items.length) return;
    setBusy(true);
    const { numbers, error } = await createPurchaseRequestsFromShortages(items);
    setBusy(false);
    setOpen(false);
    onDone(error
      ? { type: "error", message: tp.createError + error }
      : { type: "success", message: tp.created.replace("{numbers}", numbers.join("، ")) });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover"
      >
        <ShoppingCart className="h-3.5 w-3.5" />{tp.prepare}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} size="2xl" title={tp.prepareTitle}
        footer={<>
          <Link href="/purchase-requests" className="me-auto text-xs font-medium text-secondary hover:text-secondary-hover">{tp.viewAll}</Link>
          <Button variant="outline" onClick={() => setOpen(false)}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={busy || chosen.length === 0}>
            {busy ? t.common.saving : tp.createDrafts.replace("{n}", String(groups.size))}
          </Button>
        </>}>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{tp.prepareHint}</p>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {shortages.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
              <input
                type="checkbox"
                checked={sel[s.id]?.checked ?? false}
                onChange={(e) => setSel((p) => ({ ...p, [s.id]: { checked: e.target.checked, qty: p[s.id]?.qty ?? "1" } }))}
                className="h-4 w-4 rounded accent-indigo-600"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{s.name}</p>
                <p className="text-[11px] text-slate-400" dir="rtl">
                  {tp.stockNow}: <span dir="ltr">{s.quantity_on_hand}</span> · {tp.reorderAt}: <span dir="ltr">{s.reorder_level}</span> · {supplierName(s.supplier_id ?? null)}
                </p>
              </div>
              <input
                className={`${inputClass} w-20 text-center`}
                dir="ltr" inputMode="numeric"
                value={sel[s.id]?.qty ?? ""}
                onClick={(e) => e.preventDefault()}
                onChange={(e) => setSel((p) => ({ ...p, [s.id]: { checked: p[s.id]?.checked ?? true, qty: e.target.value } }))}
              />
            </label>
          ))}
        </div>
        {groups.size > 1 && (
          <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
            {tp.groupNote.replace("{n}", String(groups.size))}
          </p>
        )}
      </Dialog>
    </>
  );
}
