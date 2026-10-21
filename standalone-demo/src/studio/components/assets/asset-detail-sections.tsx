"use client";

// أقسام تبويبات صفحة تفاصيل الأصل (Ledger). عرض فقط — نفس البيانات والاستدعاءات التي كانت في الصفحة.

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeftRight, CircleDot, LogIn, LogOut, Paperclip, Plus, RefreshCw, Trash2, Upload, Wrench,
  type LucideIcon,
} from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusChip } from "@/components/ui/status-chip";
import type { ToastState } from "@/components/ui/toast";
import { RequestStatusBadge } from "@/components/requests/request-status-badge";
import { formatSAR, formatDate } from "@/lib/format";
import { PRIORITY_TONE, STAGE_TONE, toneChipClass, type Tone } from "@/lib/tone";
import type { AssetStatus } from "@/lib/types";
import type { Dict, Lang } from "@/lib/i18n";
import { uploadAssetAttachment } from "@/lib/queries";
import { computeDepreciation, computeEndOfLife, pickRule, type DepreciationRule, type EndOfLifeStatus } from "@/lib/depreciation";
import { getTemplateByCategoryOrSection } from "@/lib/asset-type-templates";

/** قسم داخل لوحة تبويب: عنوان h3 + إجراءات اختيارية، مع فاصل علوي بين الأقسام المتتالية. */
export function PanelSection({
  title, meta, actions, children, className = "",
}: { title?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`border-t border-line px-5 py-5 first:border-t-0 ${className}`}>
      {(title || actions || meta) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {title && <h3 className="font-display text-[15px] font-semibold text-fg">{title}</h3>}
            {meta && <span className="text-xs text-muted">{meta}</span>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function InfoGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">{children}</dl>;
}

export function Info({ label, value, mono, muted }: { label: string; value?: ReactNode; mono?: boolean; muted?: boolean }) {
  const empty = value === undefined || value === null || value === "";
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 break-words text-[13.5px] ${muted || empty ? "text-muted" : "font-medium text-fg"} ${mono ? "tag" : ""}`}>{empty ? "—" : value}</dd>
    </div>
  );
}

function Empty({ text, icon }: { text: string; icon?: LucideIcon }) {
  return <EmptyState compact icon={icon} title={text} />;
}

// ---------- الحركات ----------
const MOVE_META: Record<string, { icon: LucideIcon; tone: Tone }> = {
  create: { icon: Plus, tone: "neu" },
  assign: { icon: LogOut, tone: "res" },
  return: { icon: LogIn, tone: "ok" },
  transfer: { icon: ArrowLeftRight, tone: "info" },
  status_change: { icon: RefreshCw, tone: "warn" },
  dispose: { icon: Trash2, tone: "bad" },
};

export function Movements({ rows, t, lang }: { rows: any[]; t: Dict; lang: Lang }) {
  const MT = t.assetDetail.movements;
  const mtLabel: Record<string, string> = { create: MT.create, assign: MT.assign, return: MT.return, transfer: MT.transfer, status_change: MT.status_change, dispose: MT.dispose };
  if (!rows.length) return <Empty text={MT.empty} icon={ArrowLeftRight} />;
  return (
    <ol className="flex flex-col">
      {rows.map((m, i) => {
        const meta = MOVE_META[m.movement_type] ?? { icon: CircleDot, tone: "neu" as Tone };
        const Icon = meta.icon;
        return (
          <li key={m.id} className="relative flex gap-3.5 pb-5 last:pb-0">
            {i < rows.length - 1 && <span aria-hidden="true" className="absolute bottom-0.5 start-4 top-9 w-px bg-line-strong" />}
            <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${toneChipClass(meta.tone)}`}>
              <Icon aria-hidden="true" className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1 leading-relaxed">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] font-semibold text-fg">{mtLabel[m.movement_type] ?? m.movement_type}</span>
                {m.from_status && (
                  <StatusChip tone="neu" dot={false} size="sm">
                    {t.status[m.from_status as AssetStatus]} ← {t.status[m.to_status as AssetStatus]}
                  </StatusChip>
                )}
              </div>
              {(m.to_loc || m.to_emp) && (
                <div className="text-[12.5px] text-muted">
                  {m.to_loc && <span>{MT.to} {m.to_loc.name_ar ?? m.to_loc.name}</span>}
                  {m.to_loc && m.to_emp && " · "}
                  {m.to_emp && <span>{m.to_emp.full_name_ar ?? m.to_emp.full_name}</span>}
                </div>
              )}
            </div>
            <span className="shrink-0 whitespace-nowrap pt-1.5 text-xs tabular-nums text-muted">{formatDate(m.created_at, lang)}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- الصيانة ----------
export function Maint({ rows, canWrite, canSeeCost, onEdit, t, lang }: { rows: any[]; canWrite: boolean; canSeeCost: boolean; onEdit: (r: any) => void; t: Dict; lang: Lang }) {
  const tm = t.assetDetail.maint;
  if (!rows.length) return <Empty text={tm.empty} icon={Wrench} />;
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((m) => (
        <li key={m.id} className="rounded-xl border border-line px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={STAGE_TONE[m.workflow_stage]}>{t.stage[m.workflow_stage as keyof typeof t.stage] ?? (m.workflow_stage ?? "—")}</StatusChip>
            {m.priority && <StatusChip tone={PRIORITY_TONE[m.priority]} size="sm">{tm.priority} {t.priority[m.priority as keyof typeof t.priority] ?? m.priority}</StatusChip>}
            {m.problem_type && <StatusChip tone="neu" dot={false} size="sm">{t.problemType[m.problem_type as keyof typeof t.problemType] ?? m.problem_type}</StatusChip>}
            <span className="text-xs text-muted">{t.mtype[m.type as keyof typeof t.mtype] ?? m.type}</span>
            <div className="flex-1" />
            {canWrite && <button type="button" onClick={() => onEdit(m)} className={buttonClass("ghost", "sm", "text-brand-ink")}>{t.common.edit}</button>}
          </div>
          <p className="mt-2 text-[13.5px] font-semibold text-fg">{m.problem_description ?? "—"}</p>
          {m.action_taken && <p className="mt-1 text-[12.5px] text-fg-2">{tm.action}{m.action_taken}</p>}
          {m.final_summary && <p className="mt-1 text-[12.5px] text-fg-2">{tm.finalSummary}{m.final_summary}</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted">
            <span>{tm.reported} {formatDate(m.reported_at, lang)}</span>
            {m.reporter && <span>{tm.reporter}{m.reporter.full_name_ar ?? m.reporter.full_name}</span>}
            {canSeeCost && <span>{tm.cost} {formatSAR(m.cost, lang)}</span>}
            {canSeeCost && m.invoice_number && <span>{tm.invoice}<bdi dir="ltr">{m.invoice_number}</bdi></span>}
            {m.completed_at && <span>{tm.closed} {formatDate(m.completed_at, lang)}</span>}
            <span>{tm.lastUpdate} {formatDate(m.updated_at, lang)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------- العُهد ----------
export function Assigns({ rows, t, lang }: { rows: any[]; t: Dict; lang: Lang }) {
  const ta = t.assetDetail.assigns;
  if (!rows.length) return <Empty text={ta.empty} />;
  return (
    <ul className="divide-y divide-line">
      {rows.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <span className="text-[13.5px] font-semibold text-fg">{a.employee?.full_name_ar ?? a.employee?.full_name ?? "—"}</span>
            <div className="text-xs tabular-nums text-muted">{ta.assigned} {formatDate(a.assigned_at, lang)}{a.returned_at ? ` · ${ta.returned} ${formatDate(a.returned_at, lang)}` : ""}</div>
          </div>
          <StatusChip tone={a.status === "active" ? "res" : "neu"} size="sm">
            {a.status === "active" ? ta.active : ta.returnedBadge}
          </StatusChip>
        </li>
      ))}
    </ul>
  );
}

// تتبّع الأصل في الطلبات: عدّادات (خروج/رجوع غير سليم/آخر حالة) + سجل الطلبات التي خرج فيها.
export function RequestTracking({ asset, rows, t, lang }: { asset: any; rows: any[]; t: Dict; lang: Lang }) {
  const tk = t.assetDetail.tracking;
  const condLabel = (c: string | null) => (c ? ((t.requests.cond as Record<string, string>)[c] ?? c) : tk.none);
  const partyOf = (r: any) => r.beneficiary_type === "employee"
    ? ((lang === "ar" ? r.beneficiary_employee?.full_name_ar : null) ?? r.beneficiary_employee?.full_name ?? "—")
    : (r.customer?.name ?? r.customer_name_snapshot ?? "—");
  const metrics: [string, string, boolean][] = [
    [tk.timesOut, String(asset?.times_checked_out ?? 0), true],
    [tk.unsoundReturns, String(asset?.unsound_return_count ?? 0), true],
    [tk.lastReturnCond, condLabel(asset?.last_return_condition ?? null), false],
    [tk.lastOut, asset?.last_out_at ? formatDate(asset.last_out_at, lang) : tk.none, false],
    [tk.lastReturnAt, asset?.last_return_at ? formatDate(asset.last_return_at, lang) : tk.none, false],
  ];
  return (
    <div>
      <dl className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 xl:grid-cols-5">
        {metrics.map(([label, value, big]) => (
          <div key={label} className="min-w-0 bg-surface px-4 py-3">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className={`mt-1 truncate tabular-nums text-fg ${big ? "font-display text-[22px] font-semibold leading-7" : "text-[13.5px] font-semibold"}`}>{value}</dd>
          </div>
        ))}
      </dl>
      {rows.length === 0 ? <Empty text={tk.historyEmpty} /> : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/requests/${r.id}`} className="font-mono text-[13px] font-medium text-brand-ink [unicode-bidi:isolate] hover:underline" dir="ltr">{r.request_number}</Link>
                <RequestStatusBadge status={r.status} />
              </div>
              <div className="mt-0.5 text-xs tabular-nums text-muted">
                {partyOf(r)}
                {r.delivered_at ? ` · ${tk.deliveredAt} ${formatDate(r.delivered_at, lang)}` : ""}
                {r.returned_at ? ` · ${tk.returnedAt} ${formatDate(r.returned_at, lang)}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- المرفقات الأخرى ----------
export function Attachments({ assetId, rows, onChange, setToast, canWrite, t, lang }: { assetId: string; rows: any[]; onChange: () => void; setToast: (t: ToastState) => void; canWrite: boolean; t: Dict; lang: Lang }) {
  const tat = t.assetDetail.attachments;
  const [busy, setBusy] = useState(false);
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true);
    const error = await uploadAssetAttachment(assetId, file, "other");
    if (error) {
      setBusy(false);
      setToast({ type: "error", message: tat.uploadError + error });
      return;
    }
    setBusy(false); setToast({ type: "success", message: tat.uploaded }); onChange();
  }
  return (
    <div>
      {canWrite && (
        <label className={buttonClass("outline", "sm", `mb-4 ${busy ? "pointer-events-none opacity-60" : ""}`)}>
          <Upload aria-hidden="true" className="h-4 w-4" /> {busy ? tat.uploading : tat.upload}
          <input type="file" className="hidden" onChange={upload} disabled={busy} />
        </label>
      )}
      {!rows.length ? <Empty text={tat.empty} icon={Paperclip} /> : (
        <ul className="divide-y divide-line">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center gap-2 py-2.5 text-[13.5px] text-fg">
              <Paperclip aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 truncate">{a.file_name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted">· {formatDate(a.created_at, lang)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- الإهلاك والعمر التشغيلي ----------
// شارة حالة العمر التشغيلي (غير مالية) — نشط/قريب الانتهاء/منتهٍ.
function eolStatusLabel(status: EndOfLifeStatus, td: any): string {
  return status === "ended" ? td.eol.ended : status === "expiring_soon" ? td.eol.expiring : td.eol.active;
}
const EOL_TONE: Record<EndOfLifeStatus, Tone> = { ended: "bad", expiring_soon: "warn", active: "ok", na: "neu" };

function lifecycleFor(asset: any, deprRules: DepreciationRule[]) {
  const tmplId = getTemplateByCategoryOrSection(
    asset.category?.name, asset.category?.name_ar,
    (asset.special_attributes?.section as string | undefined) ?? null,
    asset.name, asset.serial_number, asset.special_attributes,
  );
  const rule = pickRule(deprRules, asset.category_id, tmplId, asset.company_id);
  const eol = computeEndOfLife(asset.purchase_date, rule);
  return { rule, eol };
}

function EolLine({ eol, t, lang }: { eol: ReturnType<typeof computeEndOfLife>; t: Dict; lang: Lang }) {
  const td = t.depreciation;
  const remainLabel = eol.remainingDays != null
    ? (eol.remainingDays > 0 ? `${eol.remainingDays} ${td.days}` : td.eol.ended)
    : "—";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusChip tone={EOL_TONE[eol.status]}>{eolStatusLabel(eol.status, td)}</StatusChip>
      <span className="text-[13px] tabular-nums text-fg-2">{td.remaining}: {remainLabel} · {td.endOfLifeDate}: {formatDate(eol.endOfLifeDate, lang)}</span>
    </div>
  );
}

/** للمخوّلين ماليًا فقط: القيمة الحالية + نهاية العمر (نفس الحساب السابق). */
export function FinancialPanel({ asset, deprRules, t, lang }: { asset: any; deprRules: DepreciationRule[]; t: Dict; lang: Lang }) {
  const td = t.depreciation;
  const { rule, eol } = lifecycleFor(asset, deprRules);
  const d = computeDepreciation(asset.purchase_cost, asset.purchase_date, rule);
  if (!d.applicable && !eol.applicable) {
    return <PanelSection title={td.sectionTitle}><p className="text-[13px] text-muted">{td.notApplicable}</p></PanelSection>;
  }
  return (
    <PanelSection title={td.sectionTitle} actions={<StatusChip tone="neu" dot={false} size="sm">{t.assetDetail.ledger.financialBadge}</StatusChip>}>
      {d.applicable && (
        <dl className="mb-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          <div className="bg-surface px-4 py-3.5">
            <dt className="text-[12.5px] font-medium text-fg-2">{td.purchaseValue}</dt>
            <dd className="mt-1 font-display text-[22px] font-semibold leading-7 tabular-nums text-fg">{formatSAR(d.purchaseCost, lang)}</dd>
            <dd className="text-xs tabular-nums text-muted">{formatDate(asset.purchase_date, lang)}</dd>
          </div>
          <div className="bg-surface px-4 py-3.5">
            <dt className="text-[12.5px] font-medium text-fg-2">{td.currentValue}</dt>
            <dd className="mt-1 font-display text-[22px] font-semibold leading-7 tabular-nums text-brand-ink">{formatSAR(d.currentValue, lang)}</dd>
            <dd className="text-xs tabular-nums text-muted">{td.age}: {d.ageYears.toFixed(1)} {td.years}</dd>
          </div>
          <div className="bg-surface px-4 py-3.5">
            <dt className="text-[12.5px] font-medium text-fg-2">{td.accumulated}</dt>
            <dd className="mt-1 font-display text-[22px] font-semibold leading-7 tabular-nums text-fg">{formatSAR(d.accumulatedDepreciation, lang)}</dd>
            <dd className="text-xs tabular-nums text-muted">{td.rate}: {`${Math.round(d.annualRate * 10) / 10}%`}</dd>
          </div>
        </dl>
      )}
      {eol.applicable && <EolLine eol={eol} t={t} lang={lang} />}
    </PanelSection>
  );
}

/** لغير المخوّلين ماليًا: حالة العمر التشغيلي فقط — بلا أي قيمة مالية. */
export function OperationalLife({ asset, deprRules, t, lang }: { asset: any; deprRules: DepreciationRule[]; t: Dict; lang: Lang }) {
  const { eol } = lifecycleFor(asset, deprRules);
  if (!eol.applicable) return null;
  return (
    <PanelSection title={t.depreciation.operationalLife}>
      <EolLine eol={eol} t={t} lang={lang} />
    </PanelSection>
  );
}
