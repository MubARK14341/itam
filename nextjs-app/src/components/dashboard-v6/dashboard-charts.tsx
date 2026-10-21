"use client";

import { useState } from "react";
import Link from "next/link";
import { prefetchIntentProps } from "@/components/shell/route-prefetch";
import { useRouter } from "next/navigation";
import { TrendingUp } from "lucide-react";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { interpolate } from "@/lib/i18n";
import type { AssetStatusPoint, RequestTrendDay, WidgetResult } from "@/lib/dashboard/dashboard-types";
import { DashboardSection, DASHBOARD_LINK, DASHBOARD_META, DASHBOARD_SURFACE, DASHBOARD_TITLE, LtrText } from "@/components/dashboard-v6/dashboard-ui";
import { WidgetEmpty, WidgetError } from "@/components/dashboard-v6/widget-state";
import { ChartErrorBoundary } from "@/components/dashboard-v6/chart-error-boundary";
import { requestSeriesPoints } from "@/components/dashboard-v6/chart-geometry";

type Series = "both" | "created" | "completed";

const SERIES_BAR: Record<"created" | "completed", string> = {
  created: "bg-brand",
  completed: "bg-brand-2",
};

const CHART_CARD = `${DASHBOARD_SURFACE} flex min-w-0 break-inside-avoid flex-col p-5`;

/** "2026-09-27" → "27/9" (Latin digits, rendered inside an LTR axis). */
function shortDay(date: string): string {
  const [, month, day] = date.split("-");
  return month && day ? `${Number(day)}/${Number(month)}` : date;
}

function RequestChart({
  result,
  onRetry,
}: {
  result: WidgetResult<RequestTrendDay[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6.charts.request;
  const ledger = t.dashboard.ledger;
  const [series, setSeries] = useState<Series>("both");
  const [showTable, setShowTable] = useState(false);
  if (result.status === "error" || result.status === "empty") {
    return (
      <article className={`${CHART_CARD} studio-request-chart`}>
        <h3 className={DASHBOARD_TITLE}>{copy.title}</h3>
        <p className={`mt-1 ${DASHBOARD_META}`}>{copy.question}</p>
        <p className={`mb-4 mt-1 ${DASHBOARD_META}`}>{copy.period}</p>
        {result.status === "error"
          ? <WidgetError sources={result.unavailableSources} onRetry={onRetry} />
          : <WidgetEmpty />}
      </article>
    );
  }
  const rows = result.data;
  const created = rows.reduce((sum, row) => sum + row.created, 0);
  const completed = rows.reduce((sum, row) => sum + row.completed, 0);
  const labelStep = Math.max(1, Math.ceil(rows.length / 6));
  const summary = interpolate(copy.summary, { created, completed });
  const visibleSeries = (["created", "completed"] as const).filter((key) => series === "both" || series === key);
  const seriesOptions: { key: Series; label: string }[] = [
    { key: "both", label: ledger.all },
    { key: "created", label: copy.created },
    { key: "completed", label: copy.completed },
  ];
  return (
    <article className={`${CHART_CARD} studio-request-chart`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={DASHBOARD_TITLE}>{copy.title}</h3>
          <p className={`mt-0.5 ${DASHBOARD_META}`}>{copy.question}</p>
          <p className={`mt-0.5 ${DASHBOARD_META}`}>{copy.period} · {summary}</p>
        </div>
        <div role="group" aria-label={ledger.series} className="ui-seg print:hidden">
          {seriesOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={series === option.key}
              onClick={() => setSeries(option.key)}
              className="dashboard-interactive ui-seg-item"
            >
              {option.key !== "both" && <span aria-hidden="true" className={`h-2 w-2 rounded-full ${SERIES_BAR[option.key]}`} />}
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div role="img" aria-label={`${copy.title}. ${summary}`} dir="ltr" className="mt-5 min-w-0 print:hidden">
        <svg aria-hidden="true" viewBox="0 0 600 176" preserveAspectRatio="none" className="h-44 w-full overflow-visible">
          {[12, 62, 111, 160].map((y) => <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="rgb(var(--line))" strokeDasharray="4 5" />)}
          {visibleSeries.map((key) => {
            const points = requestSeriesPoints(rows, key);
            const color = key === "created" ? "rgb(var(--brand))" : "rgb(var(--brand-2))";
            return <g key={key}>
              <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
              {points.split(" ").filter(Boolean).map((point, index) => {
                const [cx, cy] = point.split(",");
                return <circle key={rows[index].date} cx={cx} cy={cy} r="3" fill={color}>
                  <title>{interpolate(ledger.chartTip, { date: rows[index].date, created: rows[index].created, completed: rows[index].completed })}</title>
                </circle>;
              })}
            </g>;
          })}
        </svg>
        <div className="mt-1.5 flex min-w-0 gap-px overflow-hidden text-[11px] tabular-nums text-muted sm:gap-1">
          {rows.map((row, index) => (
            <span key={row.date} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-start">
              {index % labelStep === 0 ? shortDay(row.date) : ""}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap gap-4 text-xs text-fg-2">
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-brand" aria-hidden="true" />{copy.created} <LtrText className="text-muted">{created}</LtrText></span>
          <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-brand-2" aria-hidden="true" />{copy.completed} <LtrText className="text-muted">{completed}</LtrText></span>
        </div>
        <button
          type="button"
          aria-pressed={showTable}
          onClick={() => setShowTable((value) => !value)}
          className="dashboard-interactive ui-button ui-button-ghost ui-button-sm min-h-11 md:min-h-9"
        >
          {ledger.showTable}
        </button>
      </div>
      <div
        className={showTable
          ? "mt-3 max-h-56 overflow-auto rounded-control border border-line print:max-h-none print:overflow-visible"
          : "sr-only print:not-sr-only print:mt-4"}
        {...(showTable ? { tabIndex: 0, role: "region", "aria-label": t.dashboard.v6.charts.alternative } : {})}
      >
        <table className="ui-table min-w-[20rem] text-xs">
          <caption className="px-3 py-2 text-start text-xs font-semibold text-fg-2">{t.dashboard.v6.charts.alternative}</caption>
          <thead className="sticky top-0 print:static">
            <tr>
              <th scope="col">{copy.date}</th>
              <th scope="col" className="text-end">{copy.created}</th>
              <th scope="col" className="text-end">{copy.completed}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date}>
                <td className="h-9"><LtrText>{row.date}</LtrText></td>
                <td className="h-9 text-end"><LtrText>{row.created}</LtrText></td>
                <td className="h-9 text-end"><LtrText>{row.completed}</LtrText></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Link href="/reports?tab=requests" prefetch={false} {...prefetchIntentProps("/reports?tab=requests", router.prefetch)} className={`dashboard-interactive mt-2 self-start ${DASHBOARD_LINK}`}>{copy.open}</Link>
    </article>
  );
}

const ASSET_BAR: Record<AssetStatusPoint["status"], string> = {
  available: "bg-ok",
  reserved: "bg-res",
  in_maintenance: "bg-warn",
};

function AssetChart({
  result,
  onRetry,
}: {
  result: WidgetResult<AssetStatusPoint[]>;
  onRetry: () => void;
}) {
  const router = useRouter();
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6.charts.assets;
  if (result.status === "error" || result.status === "empty") {
    return (
      <article className={CHART_CARD}>
        <h3 className={DASHBOARD_TITLE}>{copy.title}</h3>
        <p className={`mt-1 ${DASHBOARD_META}`}>{copy.question}</p>
        <p className={`mb-4 mt-1 ${DASHBOARD_META}`}>{copy.period}</p>
        {result.status === "error"
          ? <WidgetError sources={result.unavailableSources} onRetry={onRetry} />
          : <WidgetEmpty />}
      </article>
    );
  }
  const total = result.data.reduce((sum, point) => sum + point.count, 0);
  const breakdown = result.data.map((point) => `${copy.statuses[point.status]} ${point.count}`).join("، ");
  return (
    <article className={CHART_CARD}>
      <h3 className={DASHBOARD_TITLE}>{copy.title}</h3>
      <p className={`mt-0.5 ${DASHBOARD_META}`}>{copy.question}</p>
      <p className={`mt-0.5 ${DASHBOARD_META}`}>{copy.period}</p>
      <div className="relative mx-auto mt-5 h-44 w-44 shrink-0" role="img" aria-label={`${copy.title}: ${breakdown}`}>
        <svg aria-hidden="true" viewBox="0 0 120 120" className="h-full w-full -rotate-90">
          <circle cx="60" cy="60" r="48" fill="none" stroke="rgb(var(--sunk))" strokeWidth="12" />
          {result.data.map((point, index) => {
            const circumference = 2 * Math.PI * 48;
            const start = result.data.slice(0, index).reduce((sum, value) => sum + value.count, 0);
            const length = total > 0 ? (point.count / total) * circumference : 0;
            const colors = { available: "--ok", reserved: "--res", in_maintenance: "--warn" };
            return <circle key={point.status} cx="60" cy="60" r="48" fill="none" stroke={`rgb(var(${colors[point.status]}))`} strokeWidth="12"
              strokeDasharray={`${length} ${circumference}`} strokeDashoffset={total > 0 ? -(start / total) * circumference : 0} />;
          })}
        </svg>
        <div aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center">
          <LtrText className="font-display text-[30px] font-semibold leading-none text-fg">{total}</LtrText>
          <span className="mt-2 text-xs text-muted">{t.dashboard.ledger.activeAssets}</span>
        </div>
      </div>
      <table className="mt-3 w-full border-collapse text-[13.5px]">
        <caption className="sr-only print:not-sr-only print:pb-2 print:text-start print:text-xs print:font-semibold">{t.dashboard.v6.charts.alternative}</caption>
        <thead className="sr-only print:not-sr-only">
          <tr>
            <th scope="col" className="py-2 text-start text-xs font-semibold text-muted">{copy.status}</th>
            <th scope="col" className="py-2 text-end text-xs font-semibold text-muted">{copy.count}</th>
            <th scope="col" className="py-2 text-end text-xs font-semibold text-muted">{copy.percentage}</th>
          </tr>
        </thead>
        <tbody>
          {result.data.map((point) => (
            <tr key={point.status} className="border-t border-line first:border-t-0">
              <td className="py-0.5">
                <Link href={point.href} prefetch={false} {...prefetchIntentProps(point.href, router.prefetch)} className="dashboard-interactive inline-flex min-h-11 min-w-11 items-center gap-2.5 font-medium text-fg hover:text-brand-ink hover:underline">
                  <span className={`h-2 w-2 rounded-full ${ASSET_BAR[point.status]}`} aria-hidden="true" />
                  {copy.statuses[point.status]}
                </Link>
                <span className="hidden print:inline">{copy.statuses[point.status]}</span>
              </td>
              <td className="py-0.5 text-end font-semibold"><LtrText>{point.count}</LtrText></td>
              <td className="w-14 py-0.5 text-end text-muted"><LtrText>{point.percentage}%</LtrText></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link href="/assets" prefetch={false} {...prefetchIntentProps("/assets", router.prefetch)} className={`dashboard-interactive mt-auto self-start pt-2 ${DASHBOARD_LINK}`}>{copy.open}</Link>
    </article>
  );
}

function chartResetKey<T>(result: WidgetResult<T>): string {
  if (result.status === "error") {
    return `error:${result.unavailableSources.join(",")}`;
  }
  return `${result.status}:${result.updatedAt}`;
}

function ChartComponentFailure({
  title,
  question,
  sources,
  onRetry,
}: {
  title: string;
  question: string;
  sources: ["request_events"] | ["summary"];
  onRetry: () => void;
}) {
  return (
    <article className={CHART_CARD}>
      <h3 className={DASHBOARD_TITLE}>{title}</h3>
      <p className={`mb-4 mt-1 ${DASHBOARD_META}`}>{question}</p>
      <WidgetError sources={sources} onRetry={onRetry} />
    </article>
  );
}

export function DashboardCharts({
  requestTrend,
  assetStatus,
  onRetry,
}: {
  requestTrend: WidgetResult<RequestTrendDay[]>;
  assetStatus: WidgetResult<AssetStatusPoint[]>;
  onRetry: () => void;
}) {
  const { t } = useAppPreferences();
  const copy = t.dashboard.v6;
  return (
    <DashboardSection id="dashboard-charts-title" title={copy.sections.charts.title} description={copy.sections.charts.description} icon={TrendingUp} plain>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartErrorBoundary
          resetKey={chartResetKey(requestTrend)}
          fallback={(
            <ChartComponentFailure
              title={copy.charts.request.title}
              question={copy.charts.request.question}
              sources={["request_events"]}
              onRetry={onRetry}
            />
          )}
        >
          <RequestChart result={requestTrend} onRetry={onRetry} />
        </ChartErrorBoundary>
        <ChartErrorBoundary
          resetKey={chartResetKey(assetStatus)}
          fallback={(
            <ChartComponentFailure
              title={copy.charts.assets.title}
              question={copy.charts.assets.question}
              sources={["summary"]}
              onRetry={onRetry}
            />
          )}
        >
          <AssetChart result={assetStatus} onRetry={onRetry} />
        </ChartErrorBoundary>
      </div>
    </DashboardSection>
  );
}
