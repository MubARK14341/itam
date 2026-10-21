"use client";

// اختيار متعدد لقائمة المخزون — تصدير وطباعة محلية بلا تعديل بيانات.

import { useEffect, useRef } from "react";
import { Download, Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { interpolate } from "@/lib/i18n";

/** Native checkbox with an accessible name and an optional indeterminate state. */
export function SelectCheckbox({
  label, checked, indeterminate = false, disabled, onChange,
}: {
  label: string; checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 cursor-pointer rounded border-line-strong accent-brand disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

/** Bulk bar shown in place of the toolbar while rows are selected. */
export function InventoryBulkBar({
  count, onExport, onClear, printCount = 0, printBlocked = false, onPrint,
}: {
  count: number; onExport: () => void; onClear: () => void;
  printCount?: number; printBlocked?: boolean; onPrint?: () => void;
}) {
  const { t } = useAppPreferences();
  const lu = t.assets.listUx;
  return (
    <div role="group" aria-label={lu.bulkLabel} className="flex min-h-[62px] flex-wrap items-center gap-2 border-b border-line bg-brand-soft px-3.5 py-3">
      <span role="status" className="text-sm font-semibold tabular-nums text-brand-ink">
        {interpolate(lu.selectedCount, { count })}
      </span>
      <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-line-strong" />
      <Button type="button" variant="outline" size="sm" onClick={onExport}>
        <Download aria-hidden="true" className="h-4 w-4" />{lu.exportSelected}
      </Button>
      {onPrint && printCount > 0 && <Button type="button" variant="outline" size="sm" onClick={onPrint} disabled={printBlocked}>
        <Printer aria-hidden="true" className="h-4 w-4" />{interpolate(lu.printSelected, { count: printCount })}
      </Button>}
      {printBlocked && <span role="status" className="text-xs text-muted">{lu.printMissingQr}</span>}
      <div className="flex-1" />
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        <X aria-hidden="true" className="h-4 w-4" />{lu.clearSelection}
      </Button>
    </div>
  );
}
