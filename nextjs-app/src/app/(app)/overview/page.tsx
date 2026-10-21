"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import { ArrowUpLeft, BarChart3, Boxes, ChevronLeft, History, ScanLine, type LucideIcon } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { buttonClass } from "@/components/ui/button";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { useFeatureExposure } from "@/components/providers/feature-exposure-provider";
import { ASSET_STATUS_TONE } from "@/lib/tone";
import { REPORT_TAB_FEATURE_KEYS } from "@/lib/feature-exposure";
import { KpiBand } from "@/components/ui/kpi-band";
import { getAssetStatusCounts } from "@/lib/queries";
import { interpolate } from "@/lib/i18n";
import type { AssetStatus } from "@/lib/types";

const STATUS_VIEWS: AssetStatus[] = ["available", "reserved", "in_maintenance"];

// نظرة عامة للقراءة فقط (viewer/auditor): أعداد الأصول حسب الحالة (عدّ فقط، بلا صفوف ولا أعمدة مالية) + وجهات سريعة.
export default function OverviewPage() {
  const router = useRouter();
  const { t } = useAppPreferences();
  const { isVisible } = useFeatureExposure();
  const ov = t.dashboard.ledger.overview;
  // نفس قاعدة الشريط الجانبي: التقارير تظهر فقط إذا ظهر لها تبويب واحد على الأقل (إظهار تدريجي).
  const reportsVisible = REPORT_TAB_FEATURE_KEYS.some((key) => isVisible(key));
  type Counts = NonNullable<Awaited<ReturnType<typeof getAssetStatusCounts>>["counts"]>;
  const [counts, setCounts] = useState<Counts | null>(null);
  const [countsFailed, setCountsFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getAssetStatusCounts().then((r) => {
      if (!alive) return;
      setCounts(r.counts);
      setCountsFailed(Boolean(r.error));
    });
    return () => { alive = false; };
  }, []);
  const pct = (n: number) => (counts && counts.total > 0 ? Math.round((n / counts.total) * 100) : 0);

  const destinations: { key: string; href: string; label: string; hint: string; icon: LucideIcon }[] = [
    { key: "assets", href: "/assets", label: t.nav.assets, hint: ov.assetsHint, icon: Boxes },
    ...(reportsVisible ? [{ key: "reports", href: "/reports", label: t.nav.reports, hint: ov.reportsHint, icon: BarChart3 }] : []),
    ...(isVisible("activity.page") ? [{ key: "activity", href: "/activity", label: t.nav.activity, hint: ov.activityHint, icon: History }] : []),
    ...(isVisible("scan.search") ? [{ key: "scan", href: "/scan", label: t.nav.scan, hint: ov.scanHint, icon: ScanLine }] : []),
  ];
  const cols = destinations.length >= 4 ? "lg:grid-cols-4" : destinations.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        eyebrow={<StatusChip tone="neu" size="sm">{ov.readOnly}</StatusChip>}
        title={t.nav.overview}
        description={ov.description}
        actions={reportsVisible ? (
          <Link href="/reports" prefetch={false} {...prefetchIntentProps("/reports", router.prefetch)} className={buttonClass("primary", "md")}>
            {ov.openReports}
            <ArrowUpLeft aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />
          </Link>
        ) : undefined}
      />

      {countsFailed ? (
        <p role="status" className="mb-5 rounded-card border border-warn/30 bg-warn-soft px-4 py-3 text-[13px] text-fg-2">{ov.countsUnavailable}</p>
      ) : (
        <KpiBand
          label={ov.kpiLabel}
          className="mb-5"
          items={[
            { key: "total", label: ov.totalActive, value: counts ? counts.total : "—", hint: ov.totalHint, href: "/assets" },
            ...STATUS_VIEWS.map((status) => ({
              key: status,
              label: t.status[status],
              value: counts ? counts[status] : "—",
              tone: ASSET_STATUS_TONE[status],
              hint: counts ? interpolate(ov.shareOf, { pct: pct(counts[status]) }) : undefined,
              href: `/assets?status=${status}`,
            })),
          ]}
        />
      )}

      <section aria-labelledby="overview-destinations" className="mb-5">
        <h2 id="overview-destinations" className="sr-only">{ov.destinations}</h2>
        <div className={`grid grid-cols-1 gap-5 sm:grid-cols-2 ${cols}`}>
          {destinations.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.key} href={item.href} prefetch={false} {...prefetchIntentProps(item.href, router.prefetch)} className="group flex min-w-0 flex-col gap-3 rounded-card bg-surface p-6 transition-colors hover:bg-surface-2">
                <span className="inline-flex h-9 w-9 items-center justify-center text-muted">
                  <Icon aria-hidden="true" className="h-[18px] w-[18px]" />
                </span>
                <span className="font-display text-[17px] font-semibold text-fg">{item.label}</span>
                <span className="text-[13px] leading-5 text-muted">{item.hint}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <Card className="overflow-hidden">
        <CardHeader id="overview-status" title={ov.statusTitle} description={ov.statusDesc}
          actions={<Link href="/assets" prefetch={false} {...prefetchIntentProps("/assets", router.prefetch)} className="text-[13px] font-semibold text-brand-ink hover:underline">{ov.allAssets}</Link>} />
        <ul aria-labelledby="overview-status" className="divide-y divide-line">
          {STATUS_VIEWS.map((status) => (
            <li key={status}>
              <Link href={`/assets?status=${status}`} prefetch={false} {...prefetchIntentProps(`/assets?status=${status}`, router.prefetch)} className="flex min-h-12 items-center gap-3 px-5 py-2.5 transition-colors hover:bg-surface-2 max-md:min-h-14">
                <StatusChip tone={ASSET_STATUS_TONE[status]}>{t.status[status]}</StatusChip>
                <span className="min-w-0 flex-1">
                  <span aria-hidden="true" className="block h-1.5 max-w-xs overflow-hidden rounded-full bg-sunk">
                    <span className={`block h-full rounded-full ${ASSET_STATUS_TONE[status] === "ok" ? "bg-ok" : ASSET_STATUS_TONE[status] === "res" ? "bg-res" : "bg-warn"}`} style={{ width: `${counts ? pct(counts[status]) : 0}%` }} />
                  </span>
                </span>
                <span className="font-display text-[15px] font-semibold tabular-nums text-fg">{counts ? counts[status] : "—"}</span>
                <ChevronLeft aria-hidden="true" className="h-4 w-4 shrink-0 text-muted ltr:rotate-180" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
