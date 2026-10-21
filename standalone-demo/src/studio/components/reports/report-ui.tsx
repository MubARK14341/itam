"use client";

// Studio building blocks for the Reports page: section cards, KPI band with financial cells,
// CSS bar visuals (div bars sized from existing numbers) and segmented toggles.
// Presentation only — every number shown here is computed by the page.

import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Lock, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { ASSET_STATUS_TONE, TONE_TEXT, type Tone } from "@/lib/tone";
import type { AssetStatus } from "@/lib/types";
import type { FinancialMetric } from "@/lib/financial-truth";
import { formatDateTime } from "@/lib/format";

export const TONE_BG: Record<Tone, string> = {
  ok: "bg-ok", res: "bg-res", warn: "bg-warn", bad: "bg-bad", info: "bg-brand", neu: "bg-muted",
};

/** On-screen amount (Latin digits in both locales). CSV exports keep their own formatter in the page. */
export function formatFinancialDisplay(value: number, currency: string, lang: string) {
  return new Intl.NumberFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export function financialTableValue(metric: FinancialMetric, incompleteLabel: string, lang: string) {
  if (metric.state !== "available" || metric.value == null || metric.currency == null) {
    return `${incompleteLabel} (${metric.coveragePct}%)`;
  }
  return formatFinancialDisplay(metric.value, metric.currency, lang);
}

/** Small "financial · managers only" marker next to money figures (they only render for financial roles). */
export function FinTag({ short = false }: { short?: boolean }) {
  const { t } = useAppPreferences();
  const copy = t.reports.ledger;
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-sunk px-2 text-[11px] font-semibold text-fg-2" title={copy.financialTag}>
      <Lock aria-hidden="true" className="h-3 w-3" />
      {short ? copy.financialTagShort : copy.financialTag}
    </span>
  );
}

// ---------- section card ----------
export function ReportCard({
  id, title, description, actions, children, flush = false, className = "",
}: {
  id: string; title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode;
  flush?: boolean; className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`ui-surface flex flex-col ${flush ? "overflow-hidden" : ""} ${className}`}>
      <div className={`flex flex-wrap items-start justify-between gap-4 px-5 sm:px-6 ${flush ? "pb-5 pt-6" : "pt-6"}`}>
        <div className="min-w-0">
          <h2 id={id} className="font-display text-lg font-semibold text-fg">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 pt-0.5">{actions}</div>}
      </div>
      {flush ? <div className="border-t border-line">{children}</div> : <div className="px-5 pb-6 pt-5 sm:px-6">{children}</div>}
    </section>
  );
}

export function ReportEmpty({ icon, title, description, action }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <EmptyState compact icon={icon} title={title} description={description} action={action} />;
}

// ---------- KPI band ----------
export type ReportKpi =
  | { key: string; label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; href?: string; wide?: boolean; metric?: undefined }
  | { key: string; label: string; metric: FinancialMetric; wide?: boolean };

const KPI_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 2xl:grid-cols-6",
};

/**
 * One white summary panel with responsive metric cells. Financial cells keep the
 * data-financial-* hooks used by the e2e suite.
 */
export function ReportKpiBand({ items, label }: { items: ReportKpi[]; label: string }) {
  const cols = KPI_COLS[items.length] ?? "grid-cols-2 lg:grid-cols-4";
  return (
    <section aria-label={label} className="ui-surface overflow-hidden p-2 sm:p-3">
      <div className={`grid gap-2 ${cols}`}>
        {items.map((item) => (item.metric
          ? <FinancialKpiCell key={item.key} label={item.label} metric={item.metric} wide={item.wide} />
          : <KpiCell key={item.key} item={item} />))}
      </div>
    </section>
  );
}

const CELL = "flex min-w-0 flex-col gap-1.5 rounded-control px-4 py-4 sm:px-5";

function KpiCell({ item }: { item: Extract<ReportKpi, { metric?: undefined }> }) {
  const router = useRouter();
  const body = (
    <>
      <span className={`font-display text-[28px] font-medium leading-9 tabular-nums ${item.tone ? TONE_TEXT[item.tone] : "text-fg"}`}>{item.value}</span>
      <span className="text-xs font-medium text-muted">{item.label}</span>
      {item.hint && <span className="text-[12.5px] text-muted">{item.hint}</span>}
    </>
  );
  const span = item.wide ? "col-span-2 sm:col-span-1" : "";
  return item.href ? (
    <Link href={item.href} prefetch={false} {...prefetchIntentProps(item.href, router.prefetch)} className={`${CELL} ${span} text-fg transition-colors hover:bg-surface-2`}>{body}</Link>
  ) : (
    <div className={`${CELL} ${span}`}>{body}</div>
  );
}

function FinancialKpiCell({ label, metric, wide }: { label: string; metric: FinancialMetric; wide?: boolean }) {
  const { t, lang } = useAppPreferences();
  const copy = t.reports.financialTruth;
  const available = metric.state === "available" && metric.value != null && metric.currency;
  const value = available
    ? formatFinancialDisplay(metric.value as number, metric.currency as string, lang)
    : metric.state === "forbidden" ? copy.restricted : copy.incomplete;
  return (
    <div
      data-financial-metric={label}
      data-financial-state={metric.state}
      data-financial-coverage={metric.coveragePct}
      className={`${CELL} ${wide ? "col-span-2 sm:col-span-1" : ""}`}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-fg-2">{label}</span>
        <FinTag short />
      </span>
      <span className={available
        ? "font-display text-[24px] font-semibold leading-8 tabular-nums text-fg [overflow-wrap:anywhere]"
        : "font-display text-[15px] font-semibold leading-6 text-warn"}
      >
        {value}
      </span>
      <span className="flex items-start gap-1.5 text-xs text-muted">
        <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${available ? "bg-ok" : "bg-warn"}`} />
        <span className="min-w-0">
          <span className="tabular-nums">{copy.coverage}: <b className={`font-semibold ${available ? "text-ok" : "text-warn"}`}>{metric.coveragePct}%</b></span>
          {" · "}{copy.asOf}: <span className="tabular-nums">{formatDateTime(metric.asOf, lang)}</span>
          {" · "}{copy.currency}: <span dir="ltr" className="[unicode-bidi:isolate]">{metric.currency ?? "—"}</span>
          <span className="block tabular-nums">
            {copy.used}: {metric.usedRecords} · {copy.excluded}: {metric.excludedRecords} · {copy.threshold}: {metric.thresholdPct}%
          </span>
        </span>
      </span>
    </div>
  );
}

// ---------- CSS bar visuals ----------
export type BarRow = { key: string; label: string; n: number; tone?: Tone; display?: ReactNode };

/** Horizontal bars: label · track · value. Widths are relative to the largest row. */
export function BarRows({ rows, tone = "info", ariaLabel, emptyText, labelWidth = "7rem" }: {
  rows: BarRow[]; tone?: Tone; ariaLabel: string; emptyText: string; labelWidth?: string;
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-[13px] text-muted">{emptyText}</p>;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const summary = rows.map((r) => `${r.label} ${r.n}`).join(", ");
  return (
    <div role="img" aria-label={`${ariaLabel}: ${summary}`} className="flex flex-col gap-5">
      {rows.map((r) => (
        <div key={r.key} className="grid items-center gap-3 text-[13px]" style={{ gridTemplateColumns: `minmax(0, ${labelWidth}) minmax(0, 1fr) auto` }}>
          <span className="truncate text-fg-2" title={r.label}>{r.label}</span>
          <span className="block h-2 overflow-hidden rounded-full bg-sunk">
            <span className={`block h-full rounded-full ${TONE_BG[r.tone ?? tone]}`} style={{ width: `${Math.max(r.n > 0 ? 2 : 0, Math.round((r.n / max) * 100))}%` }} />
          </span>
          <span className="min-w-[2rem] text-end font-semibold tabular-nums text-fg">{r.display ?? r.n}</span>
        </div>
      ))}
    </div>
  );
}

export type StackRow = { key: string; label: string; total: number; segments: { key: string; n: number; tone: Tone; label: string }[] };

/** Stacked horizontal bars (e.g. category split by status) with share of the grand total. */
export function StackedRows({ rows, grandTotal, ariaLabel, emptyText }: {
  rows: StackRow[]; grandTotal: number; ariaLabel: string; emptyText: string;
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-[13px] text-muted">{emptyText}</p>;
  const max = Math.max(1, ...rows.map((r) => r.total));
  const summary = rows.map((r) => `${r.label} ${r.total}`).join(", ");
  return (
    <div role="img" aria-label={`${ariaLabel}: ${summary}`} className="flex flex-col divide-y divide-line">
      {rows.map((r) => (
        <div
          key={r.key}
          title={`${r.label}: ${r.segments.map((s) => `${s.label} ${s.n}`).join(" · ")}`}
          className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)_auto_2.75rem] items-center gap-3 py-4 text-[13px] sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto_2.75rem]"
        >
          <span className="truncate text-fg-2">{r.label}</span>
          <span className="flex h-3 overflow-hidden rounded-full bg-sunk">
            {r.segments.map((s) => (
              <span key={s.key} className={TONE_BG[s.tone]} style={{ width: `${(s.n / max) * 100}%` }} />
            ))}
          </span>
          <span className="min-w-[2rem] text-end font-semibold tabular-nums text-fg">{r.total}</span>
          <span className="text-end text-xs tabular-nums text-muted">{grandTotal ? Math.round((r.total / grandTotal) * 100) : 0}%</span>
        </div>
      ))}
    </div>
  );
}

/** Vertical columns in chronological (LTR) order — e.g. monthly trend. */
export function ColumnBars({ rows, ariaLabel, emptyText }: { rows: [string, number][]; ariaLabel: string; emptyText: string }) {
  if (rows.length === 0) return <p className="py-6 text-center text-[13px] text-muted">{emptyText}</p>;
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const summary = rows.map(([k, n]) => `${k} ${n}`).join(", ");
  const grid = { gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` };
  return (
    <div role="img" aria-label={`${ariaLabel}: ${summary}`} dir="ltr" className="flex flex-col gap-2">
      <div className="grid h-44 items-end gap-2 border-b border-line-strong" style={grid}>
        {rows.map(([k, n]) => (
          <div key={k} title={`${k}: ${n}`} className="flex h-full flex-col items-center justify-end gap-1">
            <span className="text-[11.5px] font-medium tabular-nums text-fg-2">{n}</span>
            <span className="block w-full max-w-[30px] rounded-t bg-brand" style={{ height: `${Math.max(n > 0 ? 3 : 0, Math.round((n / max) * 100))}%` }} />
          </div>
        ))}
      </div>
      <div className="grid gap-2 text-center text-[11px] tabular-nums text-muted" style={grid}>
        {rows.map(([k]) => <span key={k} className="truncate font-mono">{k}</span>)}
      </div>
    </div>
  );
}

// ---------- segmented toggle (2–4 mutually exclusive views) ----------
export function SegToggle<K extends string>({ label, value, onChange, options }: {
  label: string; value: K; onChange: (key: K) => void; options: { key: K; label: string; count?: number }[];
}) {
  return (
    <div role="group" aria-label={label} className="ui-seg">
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)} className="ui-seg-item">
          {o.label}
          {o.count !== undefined && <span className="text-[11.5px] tabular-nums text-muted">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Scope note + tab-level controls row that opens every non-executive tab. */
export function TabToolbar({ note, children }: { note: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-[38px] flex-wrap items-center justify-between gap-3">
      <p className="text-[13px] text-muted">{note}</p>
      {children}
    </div>
  );
}

// ---------- asset helpers (presentation-side derivations of rows the page already computed) ----------
export type AssetGroup = { label: string; items: any[] };

export const ASSET_STATUS_ORDER: AssetStatus[] = ["available", "reserved", "in_maintenance"];

export function statusCounts(items: any[]): [AssetStatus, number][] {
  const c: Record<string, number> = {};
  for (const a of items) c[a.status] = (c[a.status] ?? 0) + 1;
  return (Object.entries(c) as [AssetStatus, number][]).sort((a, b) => b[1] - a[1]);
}

/** Group → stacked status bar row. */
export function stackRowOf(g: AssetGroup, statusLabel: (s: AssetStatus) => string): StackRow {
  const counts = new Map(statusCounts(g.items));
  return {
    key: g.label,
    label: g.label,
    total: g.items.length,
    segments: ASSET_STATUS_ORDER.map((s) => ({ key: s, n: counts.get(s) ?? 0, tone: ASSET_STATUS_TONE[s], label: statusLabel(s) })),
  };
}

export function StatusLegend({ statusLabel }: { statusLabel: (s: AssetStatus) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-3.5 text-xs text-fg-2">
      {ASSET_STATUS_ORDER.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${TONE_BG[ASSET_STATUS_TONE[s]]}`} />
          {statusLabel(s)}
        </span>
      ))}
    </div>
  );
}

/** Simple ranked list inside a card (label · value). */
export function RankList({ rows, emptyText }: { rows: { key: string; label: ReactNode; value: ReactNode }[]; emptyText: string }) {
  if (rows.length === 0) return <p className="py-6 text-center text-[13px] text-muted">{emptyText}</p>;
  return (
    <ul className="-my-2 divide-y divide-line">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-3 py-2 text-[13px]">
          <span className="min-w-0 truncate text-fg-2">{r.label}</span>
          <span className="shrink-0 font-semibold tabular-nums text-fg">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
