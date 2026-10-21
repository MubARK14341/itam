"use client";

// العمود الجانبي لنموذج إضافة أصل (Ledger): معاينة حيّة للملصق + مؤشّر اكتمال الملف.
// عرض فقط — الوسم ورمز QR يتولّدان عند الحفظ؛ هنا مربّع QR نائب بلا مكتبة توليد جديدة.

import { Check, QrCode } from "lucide-react";
import { StatusChip } from "@/components/ui/status-chip";
import { EquipmentPhoto } from "@/components/assets/equipment-photo";
import type { EquipmentAsset } from "@/lib/equipment-photos";
import type { TemplateId } from "@/lib/asset-type-templates";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { interpolate } from "@/lib/i18n";
import { COMPLETION_LOW_THRESHOLD, COMPLETION_MID_THRESHOLD } from "@/lib/asset-completeness";
import type { Tone } from "@/lib/tone";

export type CompletenessGroup = { key: string; label: string; filled: number; total: number; requiredMissing: boolean };

export function NewAssetAside({
  label, name, sub, groups, missing, equipment, templateId,
}: {
  label: string; name: string; sub: string; groups: CompletenessGroup[]; missing: string[];
  equipment?: EquipmentAsset; templateId?: TemplateId;
}) {
  const { t } = useAppPreferences();
  const L = t.assetForm.ledger;
  const filled = groups.reduce((n, g) => n + g.filled, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  const tier: "high" | "mid" | "low" = pct >= COMPLETION_MID_THRESHOLD ? "high" : pct >= COMPLETION_LOW_THRESHOLD ? "mid" : "low";
  const tone: Record<typeof tier, Tone> = { high: "ok", mid: "warn", low: "bad" };
  const bar: Record<typeof tier, string> = { high: "bg-ok", mid: "bg-warn", low: "bg-bad" };
  const displayName = name || L.previewNoName;

  return (
    <aside aria-label={label} className="flex min-w-0 flex-col gap-3.5 lg:sticky lg:top-4">
      <EquipmentPhoto asset={equipment} templateId={templateId} size="stage" />
      <section aria-labelledby="new-asset-preview-title" className="ui-surface flex flex-col gap-3 px-[18px] py-4">
        <h2 id="new-asset-preview-title" className="font-display text-sm font-semibold text-fg">{L.previewTitle}</h2>
        <div
          role="img"
          aria-label={interpolate(L.previewAria, { tag: L.previewTagPending, name: displayName })}
          className="flex items-center gap-3 rounded-[10px] border border-line-strong bg-surface p-3"
        >
          <span className="inline-flex h-[72px] w-[72px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong bg-surface-2 text-muted">
            <QrCode aria-hidden="true" className="h-7 w-7" />
          </span>
          <div className="min-w-0 leading-snug">
            <div className="font-mono text-[13px] text-muted">{L.previewTagPending}</div>
            <div className={`truncate text-[13px] font-semibold ${name ? "text-fg" : "text-muted"}`}>{displayName}</div>
            {sub && <div className="truncate text-[11.5px] text-muted">{sub}</div>}
          </div>
        </div>
        <p className="text-xs text-muted">{L.qrPlaceholder}</p>
      </section>

      <section aria-labelledby="new-asset-completeness-title" className="ui-surface flex flex-col gap-3 px-[18px] py-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="new-asset-completeness-title" className="font-display text-sm font-semibold text-fg">{L.completenessTitle}</h2>
          <StatusChip tone={tone[tier]} size="sm">{L.tiers[tier]}</StatusChip>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[34px] font-semibold leading-none tabular-nums text-fg" dir="ltr">{pct}%</span>
          <span className="text-[13px] tabular-nums text-muted">{interpolate(L.completenessCount, { filled, total })}</span>
        </div>
        <span
          role="progressbar"
          aria-label={L.completenessTitle}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="block h-2 overflow-hidden rounded-full bg-sunk"
        >
          <span className={`block h-full rounded-full transition-[width] duration-200 ${bar[tier]}`} style={{ width: `${pct}%` }} />
        </span>
        <ul className="flex flex-col">
          {groups.map((g) => {
            const done = g.total > 0 && g.filled >= g.total;
            return (
              <li key={g.key} className="flex items-center gap-2.5 border-t border-line py-2 text-[13px] first:border-t-0">
                <span aria-hidden="true" className={`inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full ${done ? "tone-ok" : g.requiredMissing ? "tone-bad" : "bg-sunk text-muted"}`}>
                  {done ? <Check className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                </span>
                <span className="min-w-0 flex-1 text-fg-2">
                  {g.label}
                  {g.requiredMissing && <span className="text-xs font-semibold text-bad"> · {L.requiredMissing}</span>}
                </span>
                <span className="text-[12.5px] tabular-nums text-muted" dir="ltr">{g.filled}/{g.total}</span>
              </li>
            );
          })}
        </ul>
        {missing.length > 0 && (
          <p className="text-xs leading-relaxed text-muted">{t.assets.completion.missingPrefix}{missing.join(t.assets.completion.listSep)}</p>
        )}
      </section>
    </aside>
  );
}
