"use client";

// Shared Studio settings presentation; operational state remains with each section.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";

/** Native checkbox for filters, dialog flags and capability matrix cells. */
export const checkboxClass = "h-4 w-4 shrink-0 rounded border-line-strong accent-brand disabled:opacity-40";

/** Filter/toolbar strip inside a section card. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2/50 px-5 py-4 sm:px-6">{children}</div>;
}

export function CheckboxFilter({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 text-[13px] font-medium text-fg-2 max-md:min-h-11">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={checkboxClass} />
      {label}
    </label>
  );
}

/**
 * Setting row with a visual switch. Semantics stay a native checkbox (visually hidden, focusable);
 * the track/thumb are presentation only and follow the checkbox state via `peer`.
 */
export function SwitchRow({
  label, hint, checked, onChange, disabled, icon: Icon, ariaLabel,
}: {
  label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void;
  disabled?: boolean; icon?: LucideIcon; ariaLabel?: string;
}) {
  return (
    <label className={`flex items-center gap-3 border-b border-line py-3.5 last:border-b-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      {Icon && (
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-sunk text-fg-2">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] text-muted">{hint}</span>}
      </span>
      <span className="relative inline-flex h-5 w-9 shrink-0">
        <input
          type="checkbox"
          aria-label={ariaLabel}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span aria-hidden="true" className="absolute inset-0 rounded-full bg-muted transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand-ink peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface peer-disabled:opacity-50" />
        <span aria-hidden="true" className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-surface transition-transform peer-checked:translate-x-4 peer-disabled:opacity-80 rtl:peer-checked:-translate-x-4" />
      </span>
    </label>
  );
}

const CALLOUT_TONE = {
  info: "bg-res-soft text-res",
  warn: "bg-warn-soft text-warn",
  neutral: "bg-sunk text-fg-2",
} as const;

export function Callout({
  tone = "neutral", icon: Icon, title, children, role,
}: {
  tone?: keyof typeof CALLOUT_TONE; icon?: LucideIcon; title?: ReactNode; children?: ReactNode; role?: string;
}) {
  return (
    <div role={role} className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-[13px] leading-6 ${CALLOUT_TONE[tone]}`}>
      {Icon && <Icon aria-hidden="true" className="mt-1 h-4 w-4 shrink-0" />}
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** Small section heading inside a settings card. */
export function SubHeading({ children, id }: { children: ReactNode; id?: string }) {
  return <h3 id={id} className="font-display text-sm font-semibold text-fg">{children}</h3>;
}

export function ActiveChip({ active, activeLabel, inactiveLabel }: { active: boolean; activeLabel: string; inactiveLabel: string }) {
  return <StatusChip tone={active ? "ok" : "neu"}>{active ? activeLabel : inactiveLabel}</StatusChip>;
}

/** Loading / empty row for a `ui-table`. */
export function TableMessage({ colSpan, loading, children }: { colSpan: number; loading?: boolean; children?: ReactNode }) {
  const { t } = useAppPreferences();
  return (
    <tr>
      <td colSpan={colSpan} className="!h-auto py-10 text-center text-[13px] text-muted">
        {loading ? <Spinner label={t.common.loading} /> : children}
      </td>
    </tr>
  );
}

export function SectionLoading() {
  const { t } = useAppPreferences();
  return (
    <div className="ui-surface flex items-center justify-center p-10">
      <Spinner label={t.common.loading} />
    </div>
  );
}

/**
 * Sticky "unsaved changes" bar — shown only while the local draft differs from the loaded value.
 * Uses the section's existing save handler; discard restores the loaded snapshot locally.
 */
export function UnsavedChangesBar({
  show, onDiscard, onSave, busy, saveLabel,
}: {
  show: boolean; onDiscard: () => void; onSave: () => void; busy?: boolean; saveLabel: ReactNode;
}) {
  const { t } = useAppPreferences();
  const tl = t.settings.ledger;
  if (!show) return null;
  return (
    <div
      role="region"
      aria-label={tl.unsavedTitle}
      className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 shadow-modal animate-fade-in-up"
    >
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-warn-soft text-warn">
        <TriangleAlert aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <p className="text-sm font-semibold text-fg">{tl.unsavedTitle}</p>
        <p className="text-[12.5px] text-muted">{tl.unsavedHint}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" onClick={onDiscard} disabled={busy}>{tl.discard}</Button>
        <Button type="button" onClick={onSave} disabled={busy}>{saveLabel}</Button>
      </div>
    </div>
  );
}

/** Shallow comparison of two flat settings objects (draft vs loaded). */
export function differs<T extends object>(a: T, b: T): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (ra[k] !== rb[k]) return true;
  return false;
}
