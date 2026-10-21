"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, inputClass } from "@/components/ui/form";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

export type ReportFilterState = {
  category: string; status: string; location: string; department: string; company: string; from: string; to: string;
};

type Option = { value: string; label: string };

/** Studio filter panel for the asset-scoped report tabs. */
export function ReportFilters({
  value, onChange, onClear, count, options,
}: {
  value: ReportFilterState;
  onChange: (key: keyof ReportFilterState) => (v: string) => void;
  onClear: () => void;
  count: number;
  options: { categories: Option[]; statuses: Option[]; locations: Option[]; departments: Option[]; companies: Option[] };
}) {
  const { t } = useAppPreferences();
  const rep = t.reports;
  const noFilters = Object.values(value).every((v) => !v);
  const selects: { key: keyof ReportFilterState; label: string; placeholder: string; options: Option[] }[] = [
    { key: "category", label: t.assets.headers.category, placeholder: t.assets.allCategories, options: options.categories },
    { key: "status", label: t.assets.headers.status, placeholder: t.assets.allStatuses, options: options.statuses },
    { key: "location", label: t.assets.headers.location, placeholder: t.assets.allLocations, options: options.locations },
    { key: "department", label: t.registration.department, placeholder: t.dashboard.filters.allDepartments, options: options.departments },
    { key: "company", label: t.assets.headers.company, placeholder: rep.allCompanies, options: options.companies },
  ];
  return (
    <section aria-label={rep.filtersTitle} className="ui-surface flex flex-col gap-5 p-5 print:hidden sm:p-6">
      <h2 className="font-display text-lg font-semibold text-fg">{rep.filtersTitle}</h2>
      <div className="flex flex-wrap items-end gap-4">
        {selects.map((s) => (
          <div key={s.key} className="min-w-[9rem] flex-1">
            <Select label={s.label} value={value[s.key]} onChange={onChange(s.key)} placeholder={s.placeholder} options={s.options} />
          </div>
        ))}
        <label className="flex min-w-[9rem] flex-1 flex-col gap-2 text-xs font-medium text-fg-2">
          {rep.ledger.from}
          <input type="date" value={value.from} onChange={(e) => onChange("from")(e.target.value)} aria-label={rep.purchaseFrom} title={rep.purchaseFrom} dir="ltr" className={inputClass} />
        </label>
        <label className="flex min-w-[9rem] flex-1 flex-col gap-2 text-xs font-medium text-fg-2">
          {rep.ledger.to}
          <input type="date" value={value.to} onChange={(e) => onChange("to")(e.target.value)} aria-label={rep.purchaseTo} title={rep.purchaseTo} dir="ltr" className={inputClass} />
        </label>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={noFilters} className="shrink-0 text-brand-ink">
          {rep.ledger.clearFilters}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-start gap-1.5">
          <Info aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          {rep.filtersScope} · {rep.dateRangeHelper}
        </span>
        <span><b className="font-semibold tabular-nums text-fg">{count}</b> {rep.filtersNote}</span>
      </div>
    </section>
  );
}
