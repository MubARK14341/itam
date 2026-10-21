"use client";

import { useCallback, useTransition } from "react";
import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { ArrowUpLeft, RefreshCw } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { formatDate, formatDateTime } from "@/lib/format";
import type { DashboardCommandCenterData, DashboardDataStatus } from "@/lib/dashboard/dashboard-types";
import { LtrText } from "@/components/dashboard-v6/dashboard-ui";
import { PriorityNow } from "@/components/dashboard-v6/priority-now";
import { KpiGrid } from "@/components/dashboard-v6/kpi-grid";
import { DashboardCharts } from "@/components/dashboard-v6/dashboard-charts";
import { RecentActivity } from "@/components/dashboard-v6/recent-activity";

const STATUS_DOT: Record<DashboardDataStatus, string> = {
  complete: "bg-ok",
  partial: "bg-warn",
  stale: "bg-warn",
};

export function DashboardCommandCenter({ data }: { data: DashboardCommandCenterData }) {
  const router = useRouter();
  const { t, lang } = useAppPreferences();
  const copy = t.dashboard.v6;
  const [refreshing, startRefresh] = useTransition();

  const refresh = useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

  const subtitle = (copy.subtitleByRole as Record<string, string>)[data.viewer.role] ?? t.dashboard.subtitle;
  const primaryLabel = (copy.hero.primary as Record<string, string>)[data.viewer.role] ?? copy.hero.primary.admin;

  return (
    <div
      className="dashboard-command-center mx-auto min-w-0 max-w-[1600px] space-y-5 pb-6"
      aria-busy={refreshing}
    >
      <header className="dashboard-hero items-end rounded-none border-0 bg-transparent p-0 sm:p-0">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
            <LtrText>{formatDate(data.metadata.generatedAt, lang)}</LtrText>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[data.metadata.status]}`} />
              {copy.hero.dataStatus}: {copy.hero.statuses[data.metadata.status]}
            </span>
            <span aria-hidden="true">·</span>
            <span>{copy.hero.updated}: <LtrText>{formatDateTime(data.metadata.updatedAt, lang)}</LtrText></span>
          </p>
          <h1 className="mt-2 font-display text-[27px] font-semibold leading-[1.5] tracking-tight text-fg sm:text-[32px]">{copy.title}</h1>
          <p className="mt-1 text-sm text-fg-2">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={refresh} disabled={refreshing}>
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />{refreshing ? copy.hero.refreshing : t.common.refresh}
          </Button>
          <Link href="/alerts" prefetch={false} {...prefetchIntentProps("/alerts", router.prefetch)} className={buttonClass("primary", "md")}>
            {primaryLabel}
            <ArrowUpLeft aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />
          </Link>
        </div>
      </header>
      <KpiGrid result={data.kpis} onRetry={refresh} />
      <div className="dashboard-overview grid min-w-0 items-start gap-6 2xl:grid-cols-[340px_minmax(0,1fr)]">
        <PriorityNow result={data.priorities} onRetry={refresh} />
        <DashboardCharts requestTrend={data.requestTrend} assetStatus={data.assetStatus} onRetry={refresh} />
      </div>
      <RecentActivity result={data.activity} onRetry={refresh} />
    </div>
  );
}
