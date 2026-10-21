"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Field, Select, inputClass } from "@/components/ui/form";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import type { AssetTemplate, TemplateField } from "@/lib/asset-type-templates";

type Values = Record<string, string>;

interface Props {
  template: AssetTemplate;
  values: Values;
  onChange: (key: string, value: string) => void;
  canSeeFinancial: boolean;
  canWrite: boolean;
  /** قابل للطي (افتراضي true). يبدأ مفتوحًا. */
  collapsible?: boolean;
  defaultOpen?: boolean;
}

/**
 * عارض الحقول الديناميكية للنماذج (إضافة/تعديل). يحترم الصلاحيات:
 *  - الحقول المالية تظهر فقط عند canSeeFinancial.
 *  - الحقول الحساسة تظهر فقط عند canWrite (مخفية عن viewer/auditor).
 * كل القيم نصّية في الواجهة وتُحوَّل لنوعها عند الحفظ عبر buildSpecialAttributesForSave.
 */
export function AssetDynamicFields({
  template,
  values,
  onChange,
  canSeeFinancial,
  canWrite,
  collapsible = true,
  defaultOpen = true,
}: Props) {
  const { t } = useAppPreferences();
  const ui = t.assetTemplates.ui;
  const fieldLabels = t.assetTemplateFields as Record<string, string>;
  const optionLabels = t.assetTemplateOptions as Record<string, string>;
  const [open, setOpen] = useState(defaultOpen);

  const visibleFields = useMemo(
    () =>
      template.fields.filter((f) => {
        if (f.financial && !canSeeFinancial) return false;
        if (f.sensitive && !canWrite) return false;
        return true;
      }),
    [template, canSeeFinancial, canWrite],
  );

  if (visibleFields.length === 0) return null;

  const label = (key: string) => fieldLabels[key] ?? key;

  const renderField = (f: TemplateField) => {
    const val = values[f.key] ?? "";
    const helper = f.helperKey ? fieldLabels[f.helperKey] : undefined;
    const full = f.type === "textarea";

    let control: React.ReactNode;
    if (f.type === "select") {
      control = (
        <Select
          value={val}
          onChange={(v) => onChange(f.key, v)}
          placeholder={ui.none}
          options={(f.options ?? []).map((o) => ({ value: o.value, label: optionLabels[o.labelKey] ?? o.value }))}
        />
      );
    } else if (f.type === "boolean") {
      control = (
        <Select
          value={val}
          onChange={(v) => onChange(f.key, v)}
          placeholder={ui.none}
          options={[
            { value: "true", label: ui.yes },
            { value: "false", label: ui.no },
          ]}
        />
      );
    } else if (f.type === "textarea") {
      control = (
        <textarea
          className={`${inputClass} resize-none`}
          rows={2}
          value={val}
          onChange={(e) => onChange(f.key, e.target.value)}
        />
      );
    } else {
      control = (
        <input
          className={inputClass}
          type={f.type === "date" ? "date" : "text"}
          inputMode={f.type === "number" ? "decimal" : undefined}
          dir={f.ltr ? "ltr" : undefined}
          value={val}
          onChange={(e) => onChange(f.key, e.target.value)}
        />
      );
    }

    return (
      <div key={f.key} className={full ? "sm:col-span-2" : undefined}>
        <Field label={label(f.key)} required={f.required} hint={helper}>
          {control}
        </Field>
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-fg-2">
          {ui.typeFieldsTitle}
          <span className="ms-2 text-xs font-normal text-muted">
            {t.assetTemplates[template.id].label}
          </span>
        </p>
        {collapsible && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-brand-ink hover:bg-sunk max-md:min-h-11"
          >
            {open ? <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />}
            {open ? ui.hideFields : ui.showFields}
          </button>
        )}
      </div>
      {open && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{visibleFields.map(renderField)}</div>}
    </div>
  );
}
