"use client";

import { useT } from "@/components/providers/app-preferences-provider";
import { interpolate } from "@/lib/i18n";
import type { CompletenessResult } from "@/lib/asset-completeness";

const TIER_TEXT: Record<CompletenessResult["tier"], string> = {
  high: "text-ok",
  mid: "text-warn",
  low: "text-bad",
};
const TIER_BAR: Record<CompletenessResult["tier"], string> = {
  high: "bg-ok",
  mid: "bg-warn",
  low: "bg-bad",
};

/** شارة نسبة اكتمال ملف الأصل: نسبة ملوّنة (أخضر/أصفر/أحمر) + شريط تقدّم + tooltip بالنواقص. */
export function CompletenessBadge({ result }: { result: CompletenessResult }) {
  const { t } = useT();
  const c = t.assets.completion;
  const fieldLabels = t.assetTemplateFields as Record<string, string>;

  if (result.total === 0) {
    return <span className="text-xs text-muted" title={c.noData}>—</span>;
  }

  const shown = result.missingKeys.slice(0, 6).map((k) => fieldLabels[k] ?? k);
  const extra = result.missingKeys.length - shown.length;
  const tooltip =
    result.missingKeys.length === 0
      ? c.allComplete
      : c.missingPrefix + shown.join(c.listSep) + (extra > 0 ? " " + interpolate(c.andMore, { count: extra }) : "");

  return (
    <div className="inline-flex items-center gap-2" title={tooltip}>
      <span className="block h-1.5 w-14 overflow-hidden rounded-full bg-sunk">
        <span className={`block h-full rounded-full ${TIER_BAR[result.tier]}`} style={{ width: `${result.pct}%` }} />
      </span>
      <span dir="ltr" className={`text-xs font-semibold tabular-nums ${TIER_TEXT[result.tier]}`}>
        {result.pct}%
      </span>
    </div>
  );
}
